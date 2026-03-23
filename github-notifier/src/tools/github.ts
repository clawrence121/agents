import type { Env } from "../types";

const WATCHED_REPOS = new Set(["amp-lifetimely", "amp-merchant-insights"]);
const DEPENDABOT_LOGINS = new Set(["dependabot[bot]"]);

interface GitHubUser {
  login: string;
  type?: string;
}

interface NotificationApiThread {
  id: string;
  reason: string;
  subject: {
    title: string;
    url: string | null;
    type: string;
  };
  repository: {
    name: string;
    full_name: string;
  };
  updated_at: string;
  unread: boolean;
}

interface PullRequestApiResponse {
  number: number;
  title: string;
  state: string;
  merged: boolean;
  merged_at: string | null;
  html_url: string;
  url: string;
  user: GitHubUser;
  created_at: string;
  updated_at: string;
  draft: boolean;
  additions: number;
  deletions: number;
  changed_files: number;
  comments_url: string;
  review_comments_url: string;
  commits_url: string;
  requested_reviewers?: GitHubUser[];
}

interface IssueCommentApiResponse {
  user: GitHubUser;
  body: string;
  created_at: string;
  html_url: string;
}

interface ReviewCommentApiResponse {
  user: GitHubUser;
  body: string;
  created_at: string;
  html_url: string;
  path: string;
}

interface ReviewApiResponse {
  user: GitHubUser | null;
  state: string;
  body: string | null;
  submitted_at: string | null;
  html_url: string;
}

interface CommitApiResponse {
  sha: string;
  html_url: string;
  author: GitHubUser | null;
  commit: {
    message: string;
    author: {
      name: string;
      date: string;
    };
  };
}

export interface GitHubNotificationThread {
  id: string;
  reason: string;
  repo: string;
  type: string;
  title: string;
  subjectUrl: string | null;
  updatedAt: string;
  unread: boolean;
}

export interface HydratedPullRequestNotification {
  threadId: string;
  repo: string;
  reason: string;
  unread: boolean;
  updatedAt: string;
  title: string;
  subjectType: string;
  pr: {
    number: number;
    title: string;
    state: string;
    url: string;
    author: string;
    createdAt: string;
    updatedAt: string;
    mergedAt: string | null;
    draft: boolean;
    additions: number;
    deletions: number;
    changedFiles: number;
    requestedReviewers: string[];
  };
  recentActivity: {
    issueComments: Array<{
      author: string;
      body: string;
      at: string;
      url: string;
    }>;
    reviewComments: Array<{
      author: string;
      body: string;
      at: string;
      url: string;
      path: string;
    }>;
    reviews: Array<{
      author: string;
      state: string;
      body: string;
      at: string;
      url: string;
    }>;
    commits: Array<{
      sha: string;
      message: string;
      author: string;
      at: string;
      url: string;
    }>;
  };
}

function ghFetch(env: Env, url: string, init?: RequestInit) {
  return fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "github-notifier-worker",
      ...(init?.headers ?? {}),
    },
  });
}

function truncate(text: string, maxLength: number) {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}...`;
}

function isAfter(timestamp: string | null | undefined, sinceMs: number) {
  if (!timestamp) return false;
  const value = Date.parse(timestamp);
  return Number.isFinite(value) && value > sinceMs;
}

function parseNextLink(linkHeader: string | null) {
  if (!linkHeader) return null;

  for (const part of linkHeader.split(",")) {
    const trimmed = part.trim();
    if (trimmed.includes('rel="next"')) {
      const match = trimmed.match(/<([^>]+)>/);
      return match?.[1] ?? null;
    }
  }

  return null;
}

async function fetchJson<T>(env: Env, url: string) {
  const res = await ghFetch(env, url);

  if (!res.ok) {
    throw new Error(`GitHub request failed (${res.status}) for ${url}: ${await res.text()}`);
  }

  return (await res.json()) as T;
}

async function fetchAllPages<T>(env: Env, url: string) {
  const results: T[] = [];
  let nextUrl: string | null = url;

  while (nextUrl) {
    const res = await ghFetch(env, nextUrl);
    if (!res.ok) {
      throw new Error(
        `GitHub request failed (${res.status}) for ${nextUrl}: ${await res.text()}`
      );
    }

    const page = (await res.json()) as T[];
    results.push(...page);
    nextUrl = parseNextLink(res.headers.get("link"));
  }

  return results;
}

function withQuery(url: string, query: Record<string, string | number | boolean | undefined>) {
  const nextUrl = new URL(url);

  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      nextUrl.searchParams.set(key, String(value));
    }
  }

  return nextUrl.toString();
}

export function isDependabotActor(login: string | null | undefined) {
  return login ? DEPENDABOT_LOGINS.has(login.toLowerCase()) : false;
}

export async function listGitHubNotifications(env: Env, since: string) {
  const notifications = await fetchAllPages<NotificationApiThread>(
    env,
    withQuery("https://api.github.com/notifications", {
      since,
      all: false,
      per_page: 50,
    })
  );

  return notifications
    .filter((notification) => WATCHED_REPOS.has(notification.repository.name))
    .map<GitHubNotificationThread>((notification) => ({
      id: notification.id,
      reason: notification.reason,
      repo: notification.repository.full_name,
      type: notification.subject.type,
      title: notification.subject.title,
      subjectUrl: notification.subject.url,
      updatedAt: notification.updated_at,
      unread: notification.unread,
    }));
}

function shouldIncludeHydratedThread(
  thread: GitHubNotificationThread,
  pr: PullRequestApiResponse,
  issueComments: HydratedPullRequestNotification["recentActivity"]["issueComments"],
  reviewComments: HydratedPullRequestNotification["recentActivity"]["reviewComments"],
  reviews: HydratedPullRequestNotification["recentActivity"]["reviews"],
  commits: HydratedPullRequestNotification["recentActivity"]["commits"],
  sinceMs: number
) {
  if (issueComments.length > 0 || reviewComments.length > 0 || reviews.length > 0 || commits.length > 0) {
    return true;
  }

  if (["review_requested", "mention", "assign", "approval_requested"].includes(thread.reason)) {
    return true;
  }

  if (isAfter(pr.merged_at, sinceMs) || isAfter(pr.created_at, sinceMs)) {
    return true;
  }

  return false;
}

export async function hydratePullRequestNotifications(
  env: Env,
  notifications: GitHubNotificationThread[],
  since: string
) {
  const sinceMs = Date.parse(since);
  const relevantNotifications = notifications.filter(
    (notification) => notification.type === "PullRequest" && notification.subjectUrl
  );

  const hydrated: HydratedPullRequestNotification[] = [];

  for (const notification of relevantNotifications) {
    const pr = await fetchJson<PullRequestApiResponse>(env, notification.subjectUrl as string);

    if (isDependabotActor(pr.user.login)) {
      continue;
    }

    const [issueCommentsResponse, reviewCommentsResponse, reviewsResponse, commitsResponse] =
      await Promise.all([
        fetchAllPages<IssueCommentApiResponse>(
          env,
          withQuery(pr.comments_url, { per_page: 100, since })
        ),
        fetchAllPages<ReviewCommentApiResponse>(
          env,
          withQuery(pr.review_comments_url, { per_page: 100 })
        ),
        fetchAllPages<ReviewApiResponse>(
          env,
          withQuery(`${pr.url}/reviews`, { per_page: 100 })
        ),
        fetchAllPages<CommitApiResponse>(env, withQuery(pr.commits_url, { per_page: 100 })),
      ]);

    const issueComments = issueCommentsResponse
      .filter((comment) => !isDependabotActor(comment.user.login) && isAfter(comment.created_at, sinceMs))
      .map((comment) => ({
        author: comment.user.login,
        body: truncate(comment.body, 500),
        at: comment.created_at,
        url: comment.html_url,
      }));

    const reviewComments = reviewCommentsResponse
      .filter((comment) => !isDependabotActor(comment.user.login) && isAfter(comment.created_at, sinceMs))
      .map((comment) => ({
        author: comment.user.login,
        body: truncate(comment.body, 500),
        at: comment.created_at,
        url: comment.html_url,
        path: comment.path,
      }));

    const reviews = reviewsResponse
      .filter((review) => !isDependabotActor(review.user?.login) && isAfter(review.submitted_at, sinceMs))
      .map((review) => ({
        author: review.user?.login ?? "unknown",
        state: review.state,
        body: truncate(review.body ?? "", 500),
        at: review.submitted_at as string,
        url: review.html_url,
      }));

    const commits = commitsResponse
      .filter((commit) => {
        const author = commit.author?.login ?? commit.commit.author.name;
        return !isDependabotActor(author) && isAfter(commit.commit.author.date, sinceMs);
      })
      .map((commit) => ({
        sha: commit.sha.slice(0, 7),
        message: truncate(commit.commit.message.split("\n")[0] ?? "", 120),
        author: commit.author?.login ?? commit.commit.author.name,
        at: commit.commit.author.date,
        url: commit.html_url,
      }));

    if (
      !shouldIncludeHydratedThread(
        notification,
        pr,
        issueComments,
        reviewComments,
        reviews,
        commits,
        sinceMs
      )
    ) {
      continue;
    }

    hydrated.push({
      threadId: notification.id,
      repo: notification.repo,
      reason: notification.reason,
      unread: notification.unread,
      updatedAt: notification.updatedAt,
      title: notification.title,
      subjectType: notification.type,
      pr: {
        number: pr.number,
        title: pr.title,
        state: pr.merged ? "merged" : pr.state,
        url: pr.html_url,
        author: pr.user.login,
        createdAt: pr.created_at,
        updatedAt: pr.updated_at,
        mergedAt: pr.merged_at,
        draft: pr.draft,
        additions: pr.additions,
        deletions: pr.deletions,
        changedFiles: pr.changed_files,
        requestedReviewers: (pr.requested_reviewers ?? []).map((reviewer) => reviewer.login),
      },
      recentActivity: {
        issueComments,
        reviewComments,
        reviews,
        commits,
      },
    });
  }

  return hydrated;
}
