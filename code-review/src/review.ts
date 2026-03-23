import type { FlueRuntime } from "@flue/cloudflare";
import * as v from "valibot";
import type { AppEnv, ReviewParams } from "./env.ts";
import { sendSlackMessage } from "./slack.ts";

const reviewResultSchema = v.object({
  summary: v.pipe(
    v.string(),
    v.description("1-2 sentence overall assessment of the PR"),
  ),
  findings: v.array(
    v.object({
      severity: v.pipe(
        v.picklist(["critical", "warning", "suggestion", "positive"]),
        v.description("Severity level of the finding"),
      ),
      file: v.pipe(
        v.string(),
        v.description("File path where the finding applies"),
      ),
      description: v.pipe(
        v.string(),
        v.description("Specific, actionable description of the finding"),
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

  const slackMessage = formatSlackMessage(params, result);
  await sendSlackMessage(env, slackMessage);

  console.log(
    `Review completed for ${params.owner}/${params.repo}#${params.prNumber}: ${result.verdict}`,
  );

  return result;
}

function formatSlackMessage(params: ReviewParams, result: ReviewResult): string {
  const verdictEmoji =
    result.verdict === "approve"
      ? ":white_check_mark:"
      : result.verdict === "request-changes"
        ? ":x:"
        : ":speech_balloon:";

  const lines: string[] = [
    `${verdictEmoji} *Code Review: <${params.htmlUrl}|${params.repo}#${params.prNumber}>*`,
    `_${params.title}_ by ${params.author}`,
    "",
    result.summary,
  ];

  const critical = result.findings.filter((f) => f.severity === "critical");
  const warnings = result.findings.filter((f) => f.severity === "warning");
  const suggestions = result.findings.filter((f) => f.severity === "suggestion");
  const positives = result.findings.filter((f) => f.severity === "positive");

  if (critical.length > 0) {
    lines.push("", ":red_circle: *Critical*");
    for (const f of critical) {
      lines.push(`- \`${f.file}\`: ${f.description}`);
    }
  }

  if (warnings.length > 0) {
    lines.push("", ":large_yellow_circle: *Warnings*");
    for (const f of warnings) {
      lines.push(`- \`${f.file}\`: ${f.description}`);
    }
  }

  if (suggestions.length > 0) {
    lines.push("", ":bulb: *Suggestions*");
    for (const f of suggestions) {
      lines.push(`- \`${f.file}\`: ${f.description}`);
    }
  }

  if (positives.length > 0) {
    lines.push("", ":star: *Positives*");
    for (const f of positives) {
      lines.push(`- \`${f.file}\`: ${f.description}`);
    }
  }

  return lines.join("\n");
}
