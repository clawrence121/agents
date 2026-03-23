import type { Sandbox } from "@cloudflare/sandbox";

// Secrets and bindings that wrangler can't auto-detect.
// GATEWAY_URL is a plain var — auto-detected by wrangler types into Env.
export interface AppEnv {
  ANTHROPIC_API_KEY: string;
  GITHUB_TOKEN: string;
  GITHUB_WEBHOOK_SECRET: string;
  GATEWAY_SECRET: string;
  GATEWAY_URL: string;
  SLACK_WEBHOOK_URL: string;
  REVIEW_WORKFLOW: Workflow;
  GATEWAY_KV: KVNamespace;
  Sandbox: DurableObjectNamespace<Sandbox>;
}

export interface ReviewParams {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  title: string;
  author: string;
  htmlUrl: string;
}
