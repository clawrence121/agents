import type { FlueRuntime } from "@flue/cloudflare";
import * as v from "valibot";
import type { AppEnv, ReviewParams } from "./env.ts";
import { sendSlackMessage } from "./slack.ts";

const reviewResultSchema = v.object({
  summary: v.pipe(
    v.string(),
    v.description("One short sentence — what does this PR do and is it good to go?"),
  ),
  findings: v.array(
    v.object({
      severity: v.pipe(
        v.picklist(["critical", "warning", "suggestion"]),
        v.description("Severity level of the finding"),
      ),
      file: v.pipe(
        v.string(),
        v.description("File path where the finding applies"),
      ),
      line: v.pipe(
        v.optional(v.number()),
        v.description(
          "Line number in the new version of the file where the finding applies. Omit for file-level findings.",
        ),
      ),
      description: v.pipe(
        v.string(),
        v.description("One terse sentence — say what to change, not what the code currently does"),
      ),
    }),
  ),
  verdict: v.pipe(
    v.picklist(["approve", "request-changes", "comment"]),
    v.description(
      "Overall verdict: approve if no issues, request-changes for critical/warning issues, comment for suggestions only",
    ),
  ),
});

type ReviewResult = v.InferOutput<typeof reviewResultSchema>;

export async function runReview(
  flue: FlueRuntime["client"],
  env: AppEnv,
  params: ReviewParams,
): Promise<ReviewResult> {
  const pr = `${params.owner}/${params.repo}#${params.prNumber}`;
  console.log(`[review] Starting skill execution for ${pr}`);

  const result = await flue.skill("review.md", {
    args: {
      owner: params.owner,
      repo: params.repo,
      prNumber: params.prNumber,
      title: params.title,
      author: params.author,
      htmlUrl: params.htmlUrl,
    },
    result: reviewResultSchema,
  });

  console.log(
    `[review] Skill complete for ${pr}: verdict=${result.verdict}, findings=${result.findings.length}`,
  );

  const reviewUrl = await createGitHubDraftReview(env, params, result);
  console.log(`[review] Draft review created: ${reviewUrl}`);

  await sendSlackNotification(env, params, result, reviewUrl);
  console.log(`[review] Slack notification sent for ${pr}`);

  return result;
}


function formatReviewBody(
  result: ReviewResult,
  fileLevelFindings: ReviewResult["findings"],
): string {
  const lines: string[] = [result.summary];

  if (fileLevelFindings.length > 0) {
    lines.push("");
    for (const f of fileLevelFindings) {
      lines.push(`- **${f.file}**: ${f.description}`);
    }
  }

  return lines.join("\n");
}

function formatCommentBody(
  finding: ReviewResult["findings"][number],
): string {
  return finding.description;
}

interface GitHubReviewComment {
  path: string;
  body: string;
  line: number;
  side: "LEFT" | "RIGHT";
}

/**
 * Parse a unified diff to extract valid right-side line numbers per file.
 * These are the only lines GitHub will accept for inline review comments.
 */
function parseDiffLineMap(diff: string): Map<string, Set<number>> {
  const fileLines = new Map<string, Set<number>>();
  let currentFile: string | null = null;
  let rightLine = 0;

  for (const line of diff.split("\n")) {
    // New file in diff: "diff --git a/path b/path"
    if (line.startsWith("diff --git ")) {
      const match = line.match(/diff --git a\/.+ b\/(.+)/);
      currentFile = match ? match[1] : null;
      if (currentFile) fileLines.set(currentFile, new Set());
      continue;
    }

    // Hunk header: "@@ -old,count +new,count @@"
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      rightLine = Number.parseInt(hunkMatch[1], 10);
      continue;
    }

    if (!currentFile) continue;
    const lineSet = fileLines.get(currentFile);
    if (!lineSet) continue;

    if (line.startsWith("+")) {
      // Added line — valid on RIGHT side
      lineSet.add(rightLine);
      rightLine++;
    } else if (line.startsWith("-")) {
      // Removed line — doesn't advance right-side counter
    } else if (line.startsWith(" ")) {
      // Context line — valid on RIGHT side
      lineSet.add(rightLine);
      rightLine++;
    }
    // Ignore everything else (empty lines between hunks, "\ No newline at end of file", etc.)
  }

  return fileLines;
}

async function createGitHubDraftReview(
  env: AppEnv,
  params: ReviewParams,
  result: ReviewResult,
): Promise<string> {
  // Fetch the PR diff to determine valid line positions for inline comments
  const diffRes = await fetch(
    `https://api.github.com/repos/${params.owner}/${params.repo}/pulls/${params.prNumber}`,
    {
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github.v3.diff",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "code-review-worker",
      },
    },
  );

  if (!diffRes.ok) {
    console.warn(
      `[review] Failed to fetch diff (${diffRes.status}), all comments will be file-level`,
    );
  }

  const diffText = diffRes.ok ? await diffRes.text() : "";
  const validLines = parseDiffLineMap(diffText);

  console.log(
    `[review] Diff parsed: ${validLines.size} files with valid line positions`,
  );

  // Split findings into inline-valid and file-level
  const inlineComments: GitHubReviewComment[] = [];
  const fileLevelFindings: ReviewResult["findings"] = [];

  for (const f of result.findings) {
    const fileValid = validLines.get(f.file);
    if (f.line != null && fileValid?.has(f.line)) {
      inlineComments.push({
        path: f.file,
        body: formatCommentBody(f),
        line: f.line,
        side: "RIGHT",
      });
    } else {
      if (f.line != null) {
        const reason = fileValid
          ? `line ${f.line} not in diff hunk`
          : `file not in diff`;
        console.log(
          `[review] ${f.file}: ${reason}, adding to body`,
        );
      }
      fileLevelFindings.push(f);
    }
  }

  console.log(
    `[review] Creating draft review: ${inlineComments.length} inline comments, ${fileLevelFindings.length} body-level findings`,
  );

  const body = formatReviewBody(result, fileLevelFindings);

  // Omitting `event` creates a PENDING (draft) review that the user can edit and submit
  const reviewPayload = {
    commit_id: params.headSha,
    body,
    comments: inlineComments,
  };

  const res = await githubApi(
    env,
    `repos/${params.owner}/${params.repo}/pulls/${params.prNumber}/reviews`,
    reviewPayload,
  );

  if (!res.ok) {
    const errorText = await res.text();
    console.error(
      `[review] Draft review creation failed (${res.status}): ${errorText}`,
    );
    console.error(
      `[review] Review payload: ${JSON.stringify({ ...reviewPayload, body: body.slice(0, 100) + "..." })}`,
    );
    throw new Error(
      `Failed to create draft review (${res.status}): ${errorText}`,
    );
  }

  const review = (await res.json()) as { html_url: string };
  return review.html_url;
}

async function githubApi(
  env: AppEnv,
  path: string,
  body: unknown,
): Promise<Response> {
  return fetch(`https://api.github.com/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "code-review-worker",
    },
    body: JSON.stringify(body),
  });
}

async function sendSlackNotification(
  env: AppEnv,
  params: ReviewParams,
  result: ReviewResult,
  reviewUrl: string,
): Promise<void> {
  const verdictEmoji =
    result.verdict === "approve"
      ? ":white_check_mark:"
      : result.verdict === "request-changes"
        ? ":x:"
        : ":speech_balloon:";

  const findingCounts = [];
  const critical = result.findings.filter((f) => f.severity === "critical").length;
  const warnings = result.findings.filter((f) => f.severity === "warning").length;
  const suggestions = result.findings.filter((f) => f.severity === "suggestion").length;

  if (critical > 0) findingCounts.push(`:red_circle: ${critical} critical`);
  if (warnings > 0) findingCounts.push(`:large_yellow_circle: ${warnings} warning${warnings > 1 ? "s" : ""}`);
  if (suggestions > 0) findingCounts.push(`:bulb: ${suggestions} suggestion${suggestions > 1 ? "s" : ""}`);

  const lines: string[] = [
    `${verdictEmoji} *Code Review: <${params.htmlUrl}|${params.repo}#${params.prNumber}>*`,
    `_${params.title}_ by ${params.author}`,
    "",
    result.summary,
  ];

  if (findingCounts.length > 0) {
    lines.push("", findingCounts.join("  ·  "));
  }

  lines.push("", `<${reviewUrl}|:pencil: Open draft review to edit and submit>`);

  await sendSlackMessage(env, lines.join("\n"));
}
