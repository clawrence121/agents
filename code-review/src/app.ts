import { FlueWorker } from "@flue/cloudflare/worker";
import type { AppEnv, ReviewParams } from "./env.ts";

const ALLOWED_REPOS = new Set(["amp-lifetimely", "amp-merchant-insights"]);

const app = new FlueWorker<AppEnv>({ gatewayKVBinding: "GATEWAY_KV" });

// GitHub webhook endpoint
app.post("/webhook", async (c) => {
  const rawBody = await c.req.text();
  const signature = c.req.header("x-hub-signature-256") ?? "";
  const event = c.req.header("x-github-event") ?? "";

  const valid = await verifyWebhookSignature(
    c.env.GITHUB_WEBHOOK_SECRET,
    rawBody,
    signature,
  );
  if (!valid) {
    return c.text("Invalid signature", 401);
  }

  const body = JSON.parse(rawBody);

  if (event === "issue_comment") {
    return handleCommentTrigger(c.env, body);
  }

  if (event !== "pull_request") {
    return c.text("Ignored: not a pull_request event", 200);
  }

  const action: string = body.action;
  const pr = body.pull_request;

  if (!pr) {
    return c.text("Ignored: no pull_request payload", 200);
  }

  const repoName: string = body.repository.name;
  if (!ALLOWED_REPOS.has(repoName)) {
    return c.text(`Ignored: repo ${repoName} not in allow list`, 200);
  }

  const prAuthor: string = pr.user?.login ?? "";
  if (prAuthor === "dependabot[bot]") {
    return c.text("Ignored: dependabot PR", 200);
  }

  // Only trigger on:
  // 1. PR opened
  // 2. PR marked ready for review (was draft, now isn't)
  // 3. clawrence121's review requested
  const isOpened = action === "opened" && !pr.draft;
  const isReadyForReview = action === "ready_for_review";
  const isMyReviewRequested =
    action === "review_requested" &&
    body.requested_reviewer?.login === "clawrence121";

  if (!isOpened && !isReadyForReview && !isMyReviewRequested) {
    return c.text(`Ignored: action ${action}`, 200);
  }
  const params: ReviewParams = {
    owner: body.repository.owner.login,
    repo: repoName,
    prNumber: pr.number,
    headSha: pr.head.sha,
    title: pr.title,
    author: pr.user.login,
    htmlUrl: pr.html_url,
  };

  const instanceId = `review-${params.repo}-${params.prNumber}-${params.headSha.slice(0, 12)}`;
  try {
    await c.env.REVIEW_WORKFLOW.create({ id: instanceId, params });
  } catch (e) {
    if (e instanceof Error && e.message.includes("already exists")) {
      return c.json({ instanceId, deduplicated: true }, 200);
    }
    throw e;
  }

  return c.json({ instanceId }, 202);
});

// Manual trigger endpoint
app.get("/trigger", async (c) => {
  const owner = c.req.query("owner") ?? "ampecommerce";
  const repo = c.req.query("repo");
  const pr = c.req.query("pr");

  if (!repo || !pr) {
    return c.text("Missing repo or pr query params", 400);
  }

  const prNumber = Number(pr);
  if (!Number.isFinite(prNumber)) {
    return c.text("Invalid pr number", 400);
  }

  // Fetch PR metadata from GitHub API
  const prData = await fetchPRMetadata(c.env, owner, repo, prNumber);
  if (!prData) {
    return c.text("Failed to fetch PR metadata", 500);
  }

  const instanceId = `review-${repo}-${prNumber}-${Date.now()}`;
  await c.env.REVIEW_WORKFLOW.create({ id: instanceId, params: prData });

  return c.json({ instanceId }, 202);
});

async function handleCommentTrigger(env: AppEnv, body: any): Promise<Response> {
  const action: string = body.action;
  const comment: string = body.comment?.body ?? "";
  const issue = body.issue;
  const repoName: string = body.repository.name;

  const isTrigger =
    action === "created" &&
    issue?.pull_request &&
    comment.includes("@clawrence121") &&
    comment.includes("run code-review");

  if (!isTrigger) {
    return new Response("Ignored: not a review trigger comment", { status: 200 });
  }

  if (!ALLOWED_REPOS.has(repoName)) {
    return new Response(`Ignored: repo ${repoName} not in allow list`, { status: 200 });
  }

  const owner: string = body.repository.owner.login;
  const commentId: number = body.comment.id;

  // Delete the trigger comment to avoid confusion
  await deleteComment(env, owner, repoName, commentId);

  const prData = await fetchPRMetadata(env, owner, repoName, issue.number);
  if (!prData) {
    return new Response("Failed to fetch PR metadata", { status: 500 });
  }

  const instanceId = `review-${repoName}-${issue.number}-${commentId}`;
  try {
    await env.REVIEW_WORKFLOW.create({ id: instanceId, params: prData });
  } catch (e) {
    if (e instanceof Error && e.message.includes("already exists")) {
      return Response.json({ instanceId, deduplicated: true }, { status: 200 });
    }
    throw e;
  }

  return Response.json({ instanceId }, { status: 202 });
}

async function deleteComment(
  env: AppEnv,
  owner: string,
  repo: string,
  commentId: number,
): Promise<void> {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/issues/comments/${commentId}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "code-review-worker",
      },
    },
  );
  if (!res.ok) {
    console.error(`Failed to delete comment ${commentId}: ${res.status}`);
  }
}

async function fetchPRMetadata(
  env: AppEnv,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<ReviewParams | null> {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
    {
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "code-review-worker",
      },
    },
  );

  if (!res.ok) {
    console.error(`GitHub API error (${res.status}): ${await res.text()}`);
    return null;
  }

  const pr = (await res.json()) as {
    number: number;
    title: string;
    user: { login: string };
    html_url: string;
    head: { sha: string };
  };

  return {
    owner,
    repo,
    prNumber: pr.number,
    headSha: pr.head.sha,
    title: pr.title,
    author: pr.user.login,
    htmlUrl: pr.html_url,
  };
}

async function verifyWebhookSignature(
  secret: string,
  payload: string,
  signatureHeader: string,
): Promise<boolean> {
  if (!signatureHeader.startsWith("sha256=")) {
    return false;
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payload),
  );

  const expected = Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const received = signatureHeader.slice("sha256=".length);

  if (expected.length !== received.length) {
    return false;
  }

  // Constant-time comparison
  let result = 0;
  for (let i = 0; i < expected.length; i++) {
    result |= expected.charCodeAt(i) ^ received.charCodeAt(i);
  }
  return result === 0;
}

export { Sandbox } from "@cloudflare/sandbox";
export { ReviewWorkflow } from "./workflow.ts";
export default app;
