import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { WorkflowEntrypoint } from "cloudflare:workers";
import { getSandbox } from "@cloudflare/sandbox";
import { FlueRuntime } from "@flue/cloudflare";
import { anthropic, github } from "@flue/client/proxies";
import type { AppEnv, ReviewParams } from "./env.ts";
import { runReview } from "./review.ts";

export const proxies = {
  anthropic: anthropic(),
  github: github({
    policy: {
      base: "allow-read",
      allow: [
        { method: "POST", path: "/graphql" },
        { method: "POST", path: "/*/git-upload-pack" },
        { method: "GET", path: "/*/info/refs" },
      ],
    },
  }),
};

export class ReviewWorkflow extends WorkflowEntrypoint<AppEnv, ReviewParams> {
  async run(event: WorkflowEvent<ReviewParams>, step: WorkflowStep) {
    const params = event.payload;
    const sandbox = getSandbox(this.env.Sandbox, event.instanceId, {
      sleepAfter: "30m",
    });

    const flue = new FlueRuntime({
      sandbox,
      sessionId: event.instanceId,
      workdir: `/home/user/${params.repo}`,
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      gateway: {
        proxies: [
          proxies.anthropic({ apiKey: this.env.ANTHROPIC_API_KEY }),
          proxies.github({ token: this.env.GITHUB_TOKEN }),
        ],
        url: this.env.GATEWAY_URL,
        secret: this.env.GATEWAY_SECRET,
        kv: this.env.GATEWAY_KV,
      },
    });

    // Clone the repo before flue.setup() — OpenCode needs the workdir to exist.
    // Must pass GitHub token directly since proxies aren't configured yet.
    const cloneUrl = `https://x-access-token:${this.env.GITHUB_TOKEN}@github.com/${params.owner}/${params.repo}.git`;
    const workdir = `/home/user/${params.repo}`;

    await step.do(
      "clone",
      { timeout: "10 minutes", retries: { limit: 1, delay: "30 seconds" } },
      async () => {
        await sandbox.exec(`git clone --depth 50 ${cloneUrl} ${workdir}`);
        await sandbox.exec(
          `git fetch origin pull/${params.prNumber}/head:pr-branch`,
          { cwd: workdir },
        );
        await sandbox.exec("git checkout pr-branch", {
          cwd: workdir,
        });
        // Remove the token from the remote URL after clone
        await sandbox.exec(
          `git remote set-url origin https://github.com/${params.owner}/${params.repo}.git`,
          { cwd: workdir },
        );
      },
    );

    await step.do(
      "setup",
      { timeout: "20 minutes", retries: { limit: 1, delay: "30 seconds" } },
      async () => {
        await flue.setup();

        // Detect and install dependencies
        const lsResult = await flue.client.shell("ls package.json 2>/dev/null");
        if (lsResult.exitCode === 0) {
          const pnpmLock = await flue.client.shell(
            "ls pnpm-lock.yaml 2>/dev/null",
          );
          if (pnpmLock.exitCode === 0) {
            await flue.client.shell("pnpm install --frozen-lockfile");
          } else {
            await flue.client.shell("npm install");
          }
        }
      },
    );

    return step.do(
      "review",
      { timeout: "30 minutes", retries: { limit: 0, delay: 0 } },
      async () => runReview(flue.client, this.env, params),
    );
  }
}
