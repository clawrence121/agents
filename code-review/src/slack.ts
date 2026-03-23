import type { AppEnv } from "./env";

export async function sendSlackMessage(env: AppEnv, text: string, blocks?: Array<Record<string, unknown>>) {
  const body: Record<string, unknown> = { text };
  if (blocks) body.blocks = blocks;

  const res = await fetch(env.SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Slack webhook failed (${res.status}): ${await res.text()}`);
  }
}
