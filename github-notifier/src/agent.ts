import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { Env } from "./types";
import {
  hydratePullRequestNotifications,
  listGitHubNotifications,
  type HydratedPullRequestNotification,
} from "./tools/github";
import { sendSlackMessage } from "./tools/slack";
import { getLastCheckTimestamp, updateLastCheckTimestamp } from "./tools/storage";

interface NotificationDigest {
  generatedAt: string;
  since: string;
  threadCount: number;
  repos: string[];
  notifications: HydratedPullRequestNotification[];
}

export interface AgentRunResult {
  status: "sent" | "no_notifications";
  since: string;
  checkedAt: string;
  fetchedCount: number;
  relevantCount: number;
  slackMessage: string | null;
}

const SYSTEM_PROMPT = `You summarize pre-hydrated GitHub pull request notifications for Slack.

Rules:
- Use only the data provided. Do not invent missing details.
- Write a single concise Slack mrkdwn message.
- Lead with the most actionable items first.
- Use the "updateType" field (not "reason") to categorize each notification. updateType reflects what actually happened (e.g. "merged", "approved", "pushed", "commented"), while reason is just why GitHub sent the notification.
- Use bullet points and keep each bullet tight.
- Group naturally when useful, but do not force every notification into the message if it adds no value.
- If the digest is empty, return an empty string.`;

function buildDigest(
  since: string,
  checkedAt: string,
  notifications: HydratedPullRequestNotification[]
): NotificationDigest {
  return {
    generatedAt: checkedAt,
    since,
    threadCount: notifications.length,
    repos: [...new Set(notifications.map((notification) => notification.repo))],
    notifications,
  };
}

async function summarizeDigest(env: Env, digest: NotificationDigest) {
  const anthropic = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const result = await generateText({
    model: anthropic("claude-haiku-4-5-20251001"),
    system: SYSTEM_PROMPT,
    prompt: `Summarize this GitHub notification digest for Slack:\n\n${JSON.stringify(digest, null, 2)}`,
    temperature: 0,
  });

  return result.text.trim();
}

function buildFallbackSlackMessage(digest: NotificationDigest) {
  const bullets = digest.notifications.map((notification) => {
    const segments: string[] = [
      `*${notification.repo}* <${notification.pr.url}|#${notification.pr.number} ${notification.pr.title}>`,
      `(${notification.updateType})`,
    ];

    if (notification.recentActivity.reviews.length > 0) {
      segments.push(`${notification.recentActivity.reviews.length} review(s)`);
    }

    if (notification.recentActivity.issueComments.length > 0) {
      segments.push(`${notification.recentActivity.issueComments.length} comment(s)`);
    }

    if (notification.recentActivity.reviewComments.length > 0) {
      segments.push(`${notification.recentActivity.reviewComments.length} review comment(s)`);
    }

    if (notification.recentActivity.commits.length > 0) {
      segments.push(`${notification.recentActivity.commits.length} commit(s)`);
    }

    return `- ${segments.join(" - ")}`;
  });

  return [`GitHub updates since ${digest.since}:`, ...bullets].join("\n");
}

export async function runAgent(env: Env): Promise<AgentRunResult> {
  const since = await getLastCheckTimestamp(env);
  const checkedAt = new Date().toISOString();

  const notifications = await listGitHubNotifications(env, since);
  const hydratedNotifications = await hydratePullRequestNotifications(env, notifications, since);

  if (hydratedNotifications.length === 0) {
    await updateLastCheckTimestamp(env, checkedAt);
    return {
      status: "no_notifications",
      since,
      checkedAt,
      fetchedCount: notifications.length,
      relevantCount: 0,
      slackMessage: null,
    };
  }

  const digest = buildDigest(since, checkedAt, hydratedNotifications);
  const slackMessage = (await summarizeDigest(env, digest)) || buildFallbackSlackMessage(digest);

  await sendSlackMessage(env, slackMessage);
  await updateLastCheckTimestamp(env, checkedAt);

  return {
    status: "sent",
    since,
    checkedAt,
    fetchedCount: notifications.length,
    relevantCount: hydratedNotifications.length,
    slackMessage,
  };
}
