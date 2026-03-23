import type { Env } from "../types";

const KV_KEY = "last_check_timestamp";

export async function getLastCheckTimestamp(env: Env) {
  const value = await env.KV.get(KV_KEY);
  if (value) return value;

  return new Date(Date.now() - 30 * 60 * 1000).toISOString();
}

export async function updateLastCheckTimestamp(env: Env, timestamp: string) {
  await env.KV.put(KV_KEY, timestamp);
}
