import { parseSessionAttribution, stripSessionMarker } from "./attribution";
import type { GitHubComment, GitHubReaction, GitHubReview, GitHubReviewComment, GitHubReviewThread } from "@telar/engine-client";
import { GitHubSubjectId } from "@telar/engine-client";
import { authorOf, avatar, epoch, type GhRunner, login, text } from "./gh";

export const MAX_THREAD_COMMENTS = 100;

type ThreadAuthor = { login?: string; avatarUrl?: string; reactions: GitHubReaction[]; subjectId?: string };

const THREAD_AUTHORS_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $last: Int!) {
  repository(owner: $owner, name: $name) {
    issueOrPullRequest(number: $number) {
      ... on Reactable { id reactionGroups { content viewerHasReacted users { totalCount } } }
      ... on Issue { comments(last: $last) { nodes { ...threadAuthor } } }
      ... on PullRequest { comments(last: $last) { nodes { ...threadAuthor } } }
    }
  }
}
fragment threadAuthor on IssueComment {
  id
  url
  author { __typename login avatarUrl }
  reactionGroups { content viewerHasReacted users { totalCount } }
}`;

function threadAuthorsArgv(number: number): string[] {
  return [
    "api",
    "graphql",
    "-F",
    "owner={owner}",
    "-F",
    "name={repo}",
    "-F",
    `number=${number}`,
    "-F",
    `last=${MAX_THREAD_COMMENTS}`,
    "-f",
    `query=${THREAD_AUTHORS_QUERY}`,
  ];
}

export function reactions(value: unknown): GitHubReaction[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const row = entry as { content?: unknown; viewerHasReacted?: unknown; users?: { totalCount?: unknown } | null };
    const content = text(row.content);
    const total = row.users?.totalCount;
    const count = typeof total === "number" && Number.isFinite(total) ? Math.trunc(total) : 0;
    if (!content || count <= 0) return [];
    return [{ content, count, viewerHasReacted: row.viewerHasReacted === true }];
  });
}

export type ThreadRead = { authors: Map<string, ThreadAuthor>; reactions?: GitHubReaction[]; subjectId?: string };

function subjectId(value: unknown): string | undefined {
  return GitHubSubjectId.safeParse(value).success ? (value as string) : undefined;
}

export function parseThread(stdout: string): ThreadRead {
  const byUrl = new Map<string, ThreadAuthor>();
  const parsed = JSON.parse(stdout) as {
    data?: { repository?: { issueOrPullRequest?: { id?: unknown; reactionGroups?: unknown; comments?: { nodes?: unknown } } | null } | null };
  };
  const thing = parsed.data?.repository?.issueOrPullRequest;
  const ownId = subjectId(thing?.id);
  const own = {
    ...(Array.isArray(thing?.reactionGroups) ? { reactions: reactions(thing.reactionGroups) } : {}),
    ...(ownId ? { subjectId: ownId } : {}),
  };
  const nodes = thing?.comments?.nodes;
  if (!Array.isArray(nodes)) return { authors: byUrl, ...own };
  for (const entry of nodes) {
    const node = entry as Record<string, unknown>;
    const url = text(node.url);
    if (!url) continue;
    const author = node.author as { login?: unknown; avatarUrl?: unknown } | null;
    const name = login(author);
    const face = text(author?.avatarUrl);
    const id = subjectId(node.id);
    byUrl.set(url, {
      ...(name ? { login: name } : {}),
      ...(face ? { avatarUrl: face } : {}),
      reactions: reactions(node.reactionGroups),
      ...(id ? { subjectId: id } : {}),
    });
  }
  return { authors: byUrl, ...own };
}

const MAX_REVIEW_THREADS = 100;
const MAX_THREAD_REPLIES = 50;

const REVIEW_THREADS_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $threads: Int!, $replies: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(last: $threads) {
        totalCount
        nodes {
          id path line startLine originalLine originalStartLine diffSide subjectType
          isResolved isOutdated resolvedBy { login }
          viewerCanResolve viewerCanUnresolve viewerCanReply
          comments(first: $replies) {
            totalCount
            nodes {
              id url body createdAt diffHunk authorAssociation
              author { __typename login avatarUrl }
              reactionGroups { content viewerHasReacted users { totalCount } }
            }
          }
        }
      }
    }
  }
}`;

function reviewThreadsArgv(number: number): string[] {
  return [
    "api",
    "graphql",
    "-F",
    "owner={owner}",
    "-F",
    "name={repo}",
    "-F",
    `number=${number}`,
    "-F",
    `threads=${MAX_REVIEW_THREADS}`,
    "-F",
    `replies=${MAX_THREAD_REPLIES}`,
    "-f",
    `query=${REVIEW_THREADS_QUERY}`,
  ];
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

export function reviewComment(entry: unknown): GitHubReviewComment | undefined {
  const node = entry as Record<string, unknown>;
  const url = text(node.url);
  if (!url) return undefined;
  const author = node.author as { avatarUrl?: unknown } | null;
  const name = login(author);
  const face = text(author?.avatarUrl);
  const id = subjectId(node.id);
  const association = text(node.authorAssociation);
  return {
    ...(name ? { author: name } : {}),
    ...(face ? { authorAvatar: face } : {}),
    ...(association ? { authorAssociation: association } : {}),
    body: text(node.body),
    createdAt: epoch(node.createdAt),
    url,
    reactions: reactions(node.reactionGroups),
    ...(id ? { subjectId: id } : {}),
  };
}

export function parseReviewThreads(stdout: string): { threads: GitHubReviewThread[]; more: number } | undefined {
  const parsed = JSON.parse(stdout) as {
    data?: { repository?: { pullRequest?: { reviewThreads?: { totalCount?: unknown; nodes?: unknown } } | null } | null };
  };
  const connection = parsed.data?.repository?.pullRequest?.reviewThreads;
  if (!connection || !Array.isArray(connection.nodes)) return undefined;
  const threads = connection.nodes.flatMap((entry): GitHubReviewThread[] => {
    const node = entry as Record<string, unknown>;
    const id = subjectId(node.id);
    const path = text(node.path);
    if (!id || !path) return [];
    const replies = node.comments as { totalCount?: unknown; nodes?: unknown } | null;
    const nodes = Array.isArray(replies?.nodes) ? replies.nodes : [];
    const comments = nodes.flatMap((comment) => {
      const parsed = reviewComment(comment);
      return parsed ? [parsed] : [];
    });
    if (comments.length === 0) return [];
    const total = positive(replies?.totalCount) ?? comments.length;
    const line = positive(node.line);
    const startLine = positive(node.startLine);
    const originalLine = positive(node.originalLine);
    const originalStartLine = positive(node.originalStartLine);
    const resolvedBy = login(node.resolvedBy);
    return [
      {
        id,
        path,
        ...(line ? { line } : {}),
        ...(startLine ? { startLine } : {}),
        ...(originalLine ? { originalLine } : {}),
        ...(originalStartLine ? { originalStartLine } : {}),
        ...(text(node.diffSide) ? { diffSide: text(node.diffSide) } : {}),
        ...(text(node.subjectType) ? { subjectType: text(node.subjectType) } : {}),
        isResolved: node.isResolved === true,
        isOutdated: node.isOutdated === true,
        ...(resolvedBy ? { resolvedBy } : {}),
        viewerCanResolve: node.viewerCanResolve === true,
        viewerCanUnresolve: node.viewerCanUnresolve === true,
        viewerCanReply: node.viewerCanReply === true,
        diffHunk: text((nodes[0] as Record<string, unknown> | undefined)?.diffHunk),
        comments,
        moreComments: Math.max(0, total - comments.length),
      },
    ];
  });
  const total = positive(connection.totalCount) ?? threads.length;
  return { threads, more: Math.max(0, total - connection.nodes.length) };
}

export async function readReviewThreads(gh: GhRunner, cwd: string, number: number): Promise<{ threads: GitHubReviewThread[]; more: number } | undefined> {
  const result = await gh(cwd, reviewThreadsArgv(number));
  if (result.status !== 0) return undefined;
  try {
    return parseReviewThreads(result.stdout);
  } catch {
    return undefined;
  }
}

export async function readThread(gh: GhRunner, cwd: string, number: number): Promise<ThreadRead> {
  const result = await gh(cwd, threadAuthorsArgv(number));
  if (result.status !== 0) return { authors: new Map() };
  try {
    return parseThread(result.stdout);
  } catch {
    return { authors: new Map() };
  }
}

function comment(entry: unknown, authors?: Map<string, ThreadAuthor>): GitHubComment | undefined {
  const row = entry as Record<string, unknown>;
  const url = text(row.url);
  if (!url) return undefined;
  const reason = text(row.minimizedReason);
  const body = text(row.body);
  const attribution = parseSessionAttribution(body);
  const known = authors?.get(url);
  const face = known ? known.avatarUrl : avatar(row.author, url);
  const name = login(row.author) ?? known?.login;
  return {
    ...(name ? { author: name } : {}),
    ...(face ? { authorAvatar: face } : {}),
    ...(text(row.authorAssociation) ? { authorAssociation: text(row.authorAssociation) } : {}),
    body: attribution ? stripSessionMarker(body) : body,
    createdAt: epoch(row.createdAt),
    minimized: row.isMinimized === true,
    ...(reason ? { minimizedReason: reason } : {}),
    url,
    ...(known ? { reactions: known.reactions } : {}),
    ...(known?.subjectId ? { subjectId: known.subjectId } : {}),
    ...(attribution ? { attribution } : {}),
  };
}

export function parseComments(value: unknown, authors?: Map<string, ThreadAuthor>): { comments: GitHubComment[]; olderComments: number } {
  if (!Array.isArray(value)) return { comments: [], olderComments: 0 };
  const all = value
    .flatMap((entry) => {
      const parsed = comment(entry, authors);
      return parsed ? [parsed] : [];
    })
    .sort((left, right) => left.createdAt - right.createdAt);
  if (all.length <= MAX_THREAD_COMMENTS) return { comments: all, olderComments: 0 };
  return { comments: all.slice(-MAX_THREAD_COMMENTS), olderComments: all.length - MAX_THREAD_COMMENTS };
}

export function parseReviews(value: unknown, url = ""): GitHubReview[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((entry) => {
      const row = entry as Record<string, unknown>;
      const state = text(row.state);
      if (!state) return [];
      return [
        {
          ...authorOf(row.author, url),
          state,
          body: text(row.body),
          submittedAt: epoch(row.submittedAt),
        },
      ];
    })
    .sort((left, right) => left.submittedAt - right.submittedAt);
}

export const STATUS_CONTEXT: Record<string, { status: string; conclusion?: string }> = {
  SUCCESS: { status: "COMPLETED", conclusion: "SUCCESS" },
  FAILURE: { status: "COMPLETED", conclusion: "FAILURE" },
  ERROR: { status: "COMPLETED", conclusion: "FAILURE" },
  PENDING: { status: "IN_PROGRESS" },
  EXPECTED: { status: "QUEUED" },
};
