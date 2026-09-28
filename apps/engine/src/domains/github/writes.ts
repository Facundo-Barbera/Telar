import { withSessionMarker } from "./attribution";
import type { GitHubCommentRefusal, GitHubCommentResult, GitHubMergeMethod, GitHubMergeRefusal, GitHubMergeResult, GitHubReaction, GitHubReactionContent, GitHubReactionResult, GitHubThreadReplyResult, GitHubThreadResolveResult } from "@telar/engine-client";
import { readPull } from "./detail";
import { bodyRefusal, type GhResult, type GhRunner, login, text } from "./gh";
import { reactions, reviewComment } from "./threads";

export function classifyMergeFailure(result: GhResult): { refusal: GitHubMergeRefusal; message?: string } {
  const text = `${result.stderr}\n${result.stdout}`.toLowerCase();
  const message = result.stderr.trim() || result.stdout.trim();
  const carry = message ? { message } : {};
  if (text.includes("head branch was modified") || text.includes("head sha") || text.includes("match-head-commit")) {
    return { refusal: "head_moved", ...carry };
  }
  if (text.includes("already merged") || text.includes("is closed") || text.includes("not open")) {
    return { refusal: "not_open", ...carry };
  }
  if (
    text.includes("must have") ||
    text.includes("permission") ||
    text.includes("not accessible") ||
    text.includes("http 403") ||
    text.includes("write access")
  ) {
    return { refusal: "not_permitted", ...carry };
  }
  if (text.includes("not allowed") || text.includes("is not enabled")) {
    return { refusal: "method_not_allowed", ...carry };
  }
  if (text.includes("branch policy") || text.includes("protected") || text.includes("required") || text.includes("blocked")) {
    return { refusal: "blocked", ...carry };
  }
  if (text.includes("not mergeable") || text.includes("merge conflict") || text.includes("cannot be cleanly created")) {
    return { refusal: "conflicted", ...carry };
  }
  return { refusal: "failed", ...carry };
}

const CONFLICTING = "CONFLICTING";

export async function mergePull(
  gh: GhRunner,
  cwd: string,
  input: { number: number; method: GitHubMergeMethod; expectedHeadOid: string },
  now: () => number = Date.now,
): Promise<GitHubMergeResult> {
  const before = await readPull(gh, cwd, input.number, now);
  if (!("pull" in before)) {
    return before.unavailable === "not_found"
      ? { merged: false, refusal: "not_open", message: `There is no pull request #${input.number} in this repository.` }
      : { merged: false, refusal: "failed", ...(before.message ? { message: before.message } : {}) };
  }
  const pull = before.pull;
  if (pull.state.toUpperCase() !== "OPEN") {
    return {
      merged: false,
      refusal: "not_open",
      message: pull.mergedAt ? `#${pull.number} was already merged.` : `#${pull.number} is ${pull.state.toLowerCase()}.`,
    };
  }
  if (pull.isDraft) {
    return { merged: false, refusal: "blocked", message: `#${pull.number} is still a draft. Mark it ready for review first.` };
  }
  if (pull.mergeable.toUpperCase() === CONFLICTING) {
    return { merged: false, refusal: "conflicted", message: `#${pull.number} conflicts with ${pull.baseRefName ?? "its base branch"}.` };
  }
  if (pull.mergeStateStatus.toUpperCase() === "BLOCKED") {
    return {
      merged: false,
      refusal: "blocked",
      message: `GitHub is blocking #${pull.number}: a required review or a required check is not satisfied.`,
    };
  }
  if (pull.headRefOid && pull.headRefOid !== input.expectedHeadOid) {
    return {
      merged: false,
      refusal: "head_moved",
      message: `A commit landed on ${pull.headRefName ?? "the head branch"} after this page was read.`,
    };
  }

  const merge = await gh(cwd, [
    "pr",
    "merge",
    String(input.number),
    `--${input.method}`,
    "--match-head-commit",
    input.expectedHeadOid,
  ]);
  if (merge.status !== 0) {
    const failure = classifyMergeFailure(merge);
    return { merged: false, ...failure };
  }
  const after = await readPull(gh, cwd, input.number, now);
  if ("pull" in after) return { merged: true, pull: after.pull };
  return { merged: true, pull: { ...pull, state: "MERGED", mergedAt: now(), readAt: now() } };
}

export function classifyCommentFailure(result: GhResult): { refusal: GitHubCommentRefusal; message?: string } {
  const text = `${result.stderr}\n${result.stdout}`.toLowerCase();
  const message = result.stderr.trim() || result.stdout.trim();
  const carry = message ? { message } : {};
  if (text.includes("could not resolve to") || text.includes("not found")) return { refusal: "not_found", ...carry };
  if (
    text.includes("locked") ||
    text.includes("archived") ||
    text.includes("permission") ||
    text.includes("http 403") ||
    text.includes("write access")
  ) {
    return { refusal: "not_permitted", ...carry };
  }
  return { refusal: "failed", ...carry };
}

export function parseCommentUrl(stdout: string): string | undefined {
  const line = stdout
    .split(/\r?\n/)
    .map((each) => each.trim())
    .filter(Boolean)
    .at(-1);
  return line && /^https?:\/\//.test(line) ? line : undefined;
}

export async function commentOn(
  gh: GhRunner,
  cwd: string,
  input: { kind: "issue" | "pull"; number: number; body: string; sessionId: string },
): Promise<GitHubCommentResult> {
  const body = input.body.trim();
  const refused = bodyRefusal(body, "comment");
  if (refused) return { posted: false, refusal: "invalid_body", message: refused };
  let stamped: string;
  try {
    stamped = withSessionMarker(body, input.sessionId);
  } catch (error) {
    return { posted: false, refusal: "invalid_body", message: error instanceof Error ? error.message : String(error) };
  }

  const result = await gh(cwd, [input.kind === "pull" ? "pr" : "issue", "comment", String(input.number), "--body", stamped]);
  if (result.status !== 0) {
    const failure = classifyCommentFailure(result);
    return { posted: false, ...failure };
  }
  const url = parseCommentUrl(result.stdout);
  return { posted: true, url: url ?? `#${input.number}`, attribution: { sessionId: input.sessionId } };
}

const REACTION_GROUPS = "reactionGroups { content viewerHasReacted users { totalCount } }";

export function reactionArgv(input: { subjectId: string; content: GitHubReactionContent; react: boolean }): string[] {
  const mutation = input.react ? "addReaction" : "removeReaction";
  return [
    "api",
    "graphql",
    "-F",
    `subject=${input.subjectId}`,
    "-F",
    `content=${input.content}`,
    "-f",
    `query=mutation($subject: ID!, $content: ReactionContent!) { ${mutation}(input: { subjectId: $subject, content: $content }) { subject { ${REACTION_GROUPS} } } }`,
  ];
}

export function classifyGraphqlWriteFailure(result: GhResult): { refusal: "scope" | "not_permitted" | "not_found" | "failed"; message?: string } {
  const said = `${result.stderr}\n${result.stdout}`;
  const lower = said.toLowerCase();
  let message = result.stderr.trim().replace(/^gh:\s*/, "");
  try {
    const errors = (JSON.parse(result.stdout) as { errors?: { message?: unknown }[] }).errors;
    const first = errors?.map((error) => text(error.message)).find(Boolean);
    if (first) message = first;
  } catch {
  }
  const carry = message ? { message } : {};
  if (lower.includes("insufficient_scopes") || lower.includes("required scopes") || lower.includes("not been granted")) return { refusal: "scope", ...carry };
  if (lower.includes("could not resolve to a node") || lower.includes("not_found")) return { refusal: "not_found", ...carry };
  if (
    lower.includes("locked") ||
    lower.includes("archived") ||
    lower.includes("forbidden") ||
    lower.includes("not accessible") ||
    lower.includes("permission") ||
    lower.includes("http 403")
  ) {
    return { refusal: "not_permitted", ...carry };
  }
  return { refusal: "failed", ...carry };
}

function parseReactionAnswer(stdout: string): GitHubReaction[] | undefined {
  const data = (JSON.parse(stdout) as { data?: Record<string, { subject?: { reactionGroups?: unknown } } | null> | null }).data;
  const answer = data?.addReaction ?? data?.removeReaction;
  const groups = answer?.subject?.reactionGroups;
  return Array.isArray(groups) ? reactions(groups) : undefined;
}

export async function reactOn(
  gh: GhRunner,
  cwd: string,
  input: { subjectId: string; content: GitHubReactionContent; react: boolean },
): Promise<GitHubReactionResult> {
  const result = await gh(cwd, reactionArgv(input));
  if (result.status !== 0) return { reacted: false, ...classifyGraphqlWriteFailure(result) };
  try {
    const now = parseReactionAnswer(result.stdout);
    if (now) return { reacted: true, reactions: now };
  } catch {
  }
  return { reacted: false, ...classifyGraphqlWriteFailure(result) };
}

const REVIEW_COMMENT_FIELDS =
  `id url body createdAt diffHunk authorAssociation author { __typename login avatarUrl } ${REACTION_GROUPS}`;

export function threadReplyArgv(threadId: string, body: string): string[] {
  return [
    "api",
    "graphql",
    "-F",
    `thread=${threadId}`,
    "-f",
    `body=${body}`,
    "-f",
    `query=mutation($thread: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $thread, body: $body }) { comment { ${REVIEW_COMMENT_FIELDS} } } }`,
  ];
}

export async function replyToThread(gh: GhRunner, cwd: string, input: { threadId: string; body: string }): Promise<GitHubThreadReplyResult> {
  const body = input.body.trim();
  const refused = bodyRefusal(body, "reply");
  if (refused) return { replied: false, refusal: "invalid_body", message: refused };
  const result = await gh(cwd, threadReplyArgv(input.threadId, body));
  if (result.status === 0) {
    try {
      const data = (JSON.parse(result.stdout) as { data?: { addPullRequestReviewThreadReply?: { comment?: unknown } | null } | null }).data;
      const comment = reviewComment(data?.addPullRequestReviewThreadReply?.comment);
      if (comment) return { replied: true, comment };
    } catch {
    }
  }
  return { replied: false, ...classifyGraphqlWriteFailure(result) };
}

function threadResolveArgv(threadId: string, resolved: boolean): string[] {
  const mutation = resolved ? "resolveReviewThread" : "unresolveReviewThread";
  return [
    "api",
    "graphql",
    "-F",
    `thread=${threadId}`,
    "-f",
    `query=mutation($thread: ID!) { ${mutation}(input: { threadId: $thread }) { thread { isResolved resolvedBy { login } viewerCanResolve viewerCanUnresolve } } }`,
  ];
}

export async function resolveThread(gh: GhRunner, cwd: string, input: { threadId: string; resolved: boolean }): Promise<GitHubThreadResolveResult> {
  const result = await gh(cwd, threadResolveArgv(input.threadId, input.resolved));
  if (result.status === 0) {
    try {
      const data = (JSON.parse(result.stdout) as { data?: Record<string, { thread?: Record<string, unknown> | null } | null> | null }).data;
      const thread = (data?.resolveReviewThread ?? data?.unresolveReviewThread)?.thread;
      if (thread && typeof thread.isResolved === "boolean") {
        const by = login(thread.resolvedBy);
        return {
          changed: true,
          isResolved: thread.isResolved,
          ...(by ? { resolvedBy: by } : {}),
          viewerCanResolve: thread.viewerCanResolve === true,
          viewerCanUnresolve: thread.viewerCanUnresolve === true,
        };
      }
    } catch {
    }
  }
  return { changed: false, ...classifyGraphqlWriteFailure(result) };
}
