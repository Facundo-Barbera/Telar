"use client";

import { useState } from "react";
import { ChevronRightIcon, ExternalLinkIcon, FileCodeIcon } from "lucide-react";
import type { GitHubReviewThread, GitHubThreadReplyResult, GitHubThreadResolveResult } from "@telar/engine-client";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { PanelDivider } from "@/ui/panel";
import { Spinner } from "@/ui/spinner";
import { Textarea } from "@/ui/textarea";
import { fmtAgo } from "@/ui/format";
import { applyThreadReply, applyThreadResolve, hunkTail, PENDING_REPLY_URL, threadAnchor, threadsByFile } from "../github-forge";
import { cn } from "@/ui/utils";
import { exactTime } from "../model";
import { GitHubAvatar } from "./github-avatar";
import { Markdown, READING_MEASURE } from "./markdown";
import { ReactionRow, type ReactHandler } from "./reactions";

export type ThreadActions = {
  reply: (threadId: string, body: string) => Promise<GitHubThreadReplyResult>;
  resolve: (threadId: string, resolved: boolean) => Promise<GitHubThreadResolveResult>;
};

type Comment = GitHubReviewThread["comments"][number];

const HUNK_LINE: Record<"add" | "del" | "ctx", string> = {
  add: "tint-success text-foreground",
  del: "tint-destructive text-foreground",
  ctx: "text-muted-foreground",
};
const HUNK_MARK: Record<"add" | "del" | "ctx", string> = { add: "+", del: "−", ctx: " " };

function ThreadComment({ comment, onReact }: { comment: Comment; onReact?: ReactHandler }) {
  const pending = comment.url.startsWith(PENDING_REPLY_URL);
  return (
    <div data-pending={pending || undefined} className={cn("min-w-0 px-2 py-1.5", pending && "opacity-60")}>
      <div className="mb-1 flex min-w-0 items-center gap-1.5 text-3xs text-muted-foreground">
        <GitHubAvatar {...(comment.author ? { login: comment.author } : {})} {...(comment.authorAvatar ? { src: comment.authorAvatar } : {})} className="size-4" />
        <span className="min-w-0 truncate font-medium text-foreground">{pending ? "you" : (comment.author ?? "someone")}</span>
        {comment.authorAssociation && comment.authorAssociation !== "NONE" && (
          <Badge variant="outline" className="shrink-0 px-1 py-0 text-4xs font-normal">
            {comment.authorAssociation.toLowerCase()}
          </Badge>
        )}
        {pending ? (
          <span className="flex shrink-0 items-center gap-1">
            <Spinner className="size-2.5" /> sending
          </span>
        ) : (
          <>
            <span className="shrink-0 tabular-nums" title={exactTime(comment.createdAt)}>
              {fmtAgo(comment.createdAt)}
            </span>
            <a
              href={comment.url}
              target="_blank"
              rel="noreferrer"
              aria-label="Open this review comment on GitHub"
              className="ml-auto shrink-0 rounded p-0.5 transition-colors hover:text-foreground"
            >
              <ExternalLinkIcon className="size-2.5" />
            </a>
          </>
        )}
      </div>
      <Markdown>{comment.body}</Markdown>
      {!pending && (
        <ReactionRow reactions={comment.reactions} {...(onReact && comment.subjectId ? { onReact: onReact.bind(null, comment.subjectId) } : {})} />
      )}
    </div>
  );
}

function ReplyBox({ draft, busy, onDraft, onSend }: { draft: string | undefined; busy: boolean; onDraft: (next: string | undefined) => void; onSend: () => void }) {
  if (draft === undefined) {
    return (
      <button
        type="button"
        onClick={() => onDraft("")}
        className="w-full rounded border border-border px-2 py-1 text-left text-3xs text-muted-foreground transition-colors hover:text-foreground"
      >
        Reply…
      </button>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <Textarea
        autoFocus
        value={draft}
        disabled={busy}
        placeholder="Reply to this thread. ⌘↩ sends."
        aria-label="Reply to this review thread"
        onChange={(event) => onDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            onSend();
          }
          if (event.key === "Escape" && !busy) onDraft(undefined);
        }}
        className="min-h-16 text-xs"
      />
      <div className="flex justify-end gap-1">
        <Button size="xs" variant="ghost" disabled={busy} onClick={() => onDraft(undefined)}>
          Cancel
        </Button>
        <Button size="xs" disabled={busy || !draft.trim()} onClick={onSend}>
          Reply
        </Button>
      </div>
    </div>
  );
}

function useThread(given: GitHubReviewThread, actions: ThreadActions | undefined) {
  // Local so a write redraws at once; a fresh read of the pull request wins.
  const [thread, setThread] = useState(given);
  const [source, setSource] = useState(given);
  if (source !== given) {
    setSource(given);
    setThread(given);
  }
  const [unfolded, setUnfolded] = useState(false);
  const [draft, setDraft] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string>();

  const flip = () => {
    if (!actions || busy) return;
    setBusy(true);
    setRefused(undefined);
    const resolved = !thread.isResolved;
    setUnfolded(!resolved);
    void applyThreadResolve({ current: thread, resolved, send: () => actions.resolve(thread.id, resolved), draw: setThread })
      .then(setRefused)
      .finally(() => setBusy(false));
  };

  const send = () => {
    const body = draft?.trim();
    if (!actions || busy || !body) return;
    setBusy(true);
    setRefused(undefined);
    void applyThreadReply({ current: thread, body, now: Date.now(), send: () => actions.reply(thread.id, body), draw: setThread })
      .then((said) => {
        setRefused(said);
        // The draft survives a refusal so the reply need not be typed again.
        if (!said) setDraft(undefined);
      })
      .finally(() => setBusy(false));
  };

  return { thread, unfolded, setUnfolded, draft, setDraft, busy, refused, flip, send };
}

function ReviewThreadCard({ thread: given, onReact, actions }: { thread: GitHubReviewThread; onReact?: ReactHandler; actions?: ThreadActions }) {
  const { thread, unfolded, setUnfolded, draft, setDraft, busy, refused, flip, send } = useThread(given, actions);
  const anchor = threadAnchor(thread);
  const folded = thread.isResolved && !unfolded;
  const span = anchor.from !== undefined && anchor.to !== undefined ? anchor.to - anchor.from + 1 : 1;
  const lines = anchor.label === "file" ? [] : hunkTail(thread.diffHunk, span);
  const canFlip = actions && (thread.isResolved ? thread.viewerCanUnresolve : thread.viewerCanResolve);

  return (
    <div data-thread={thread.id} className="w-full min-w-0 overflow-hidden rounded-md border border-border bg-card">
      <div className={cn("flex min-w-0 items-center gap-1.5 border-b border-border bg-muted/40 px-2 py-1 text-3xs text-muted-foreground", folded && "border-b-0")}>
        <button
          type="button"
          aria-expanded={!folded}
          disabled={!thread.isResolved}
          onClick={() => setUnfolded((was) => !was)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left disabled:cursor-default"
        >
          {thread.isResolved && <ChevronRightIcon className={cn("size-3 shrink-0 transition-transform", !folded && "rotate-90")} />}
          <span className="shrink-0 font-mono text-foreground">{anchor.label}</span>
          {anchor.outdated && (
            <Badge variant="outline" className="shrink-0 px-1 py-0 text-4xs font-normal">
              outdated
            </Badge>
          )}
          {thread.isResolved && (
            <Badge variant="outline" className="shrink-0 border-success/40 px-1 py-0 text-4xs font-normal text-success">
              resolved{thread.resolvedBy ? ` by ${thread.resolvedBy}` : ""}
            </Badge>
          )}
          {folded && (
            <span className="min-w-0 truncate">
              {thread.comments[0]?.author ?? "someone"}: {thread.comments[0]?.body.split("\n")[0]}
            </span>
          )}
        </button>
        {canFlip && (
          <button
            type="button"
            disabled={busy}
            onClick={flip}
            title={thread.isResolved ? "Reopen this conversation" : "Mark this conversation as settled"}
            className="shrink-0 rounded px-1 transition-colors hover:text-foreground disabled:opacity-60"
          >
            {thread.isResolved ? "Unresolve" : "Resolve"}
          </button>
        )}
      </div>
      {refused && folded && (
        <p role="status" className="px-2 py-1 text-3xs leading-snug text-destructive">
          {refused}
        </p>
      )}
      {!folded && (
        <>
          {lines.length > 0 && (
            <pre className="overflow-x-auto border-b border-border bg-card py-0.5 font-mono text-3xs leading-relaxed">
              {lines.map((line, index) => (
                <div key={index} className={cn("flex px-2", HUNK_LINE[line.kind])}>
                  <span aria-hidden className="w-3 shrink-0 select-none opacity-60">
                    {HUNK_MARK[line.kind]}
                  </span>
                  <span className="whitespace-pre">{line.text || " "}</span>
                </div>
              ))}
            </pre>
          )}
          <div className="flex flex-col divide-y divide-border">
            {thread.comments.map((comment) => (
              <ThreadComment key={comment.url} comment={comment} {...(onReact ? { onReact } : {})} />
            ))}
            {thread.moreComments > 0 && (
              <p className="px-2 py-1 text-3xs text-muted-foreground">
                {thread.moreComments} more {thread.moreComments === 1 ? "reply" : "replies"} on GitHub.
              </p>
            )}
            {actions && thread.viewerCanReply && (
              <div className="px-2 py-1.5">
                <ReplyBox draft={draft} busy={busy} onDraft={setDraft} onSend={send} />
              </div>
            )}
          </div>
          {refused && (
            <p role="status" className="border-t border-border px-2 py-1 text-3xs leading-snug text-destructive">
              {refused}
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** Line-bound review conversations, grouped by file. Resolved threads fold to one line; a failed read says so. */
export function ReviewThreadsBlock({
  threads,
  more,
  onReact,
  actions,
}: {
  threads?: readonly GitHubReviewThread[];
  more: number;
  onReact?: ReactHandler;
  actions?: ThreadActions;
}) {
  if (threads === undefined) {
    return <p className="px-3 pb-2 text-3xs leading-snug text-muted-foreground">The review comments on lines of the diff could not be read.</p>;
  }
  if (threads.length === 0) return null;
  const open = threads.filter((thread) => !thread.isResolved).length;
  const label = `${threads.length} review ${threads.length === 1 ? "thread" : "threads"}${open < threads.length ? ` · ${threads.length - open} resolved` : ""}`;
  return (
    <>
      <PanelDivider label={label} />
      {more > 0 && (
        <p className="px-3 pb-2 text-3xs leading-snug text-muted-foreground">
          {more} older {more === 1 ? "thread is" : "threads are"} not shown — open it on GitHub for all of them.
        </p>
      )}
      <div className="flex flex-col gap-3 px-3 pb-3">
        {threadsByFile(threads).map((file) => (
          <section key={file.path} className={cn("flex w-full min-w-0 flex-col gap-1.5 self-center", READING_MEASURE)}>
            <h4 className="flex min-w-0 items-center gap-1 text-3xs text-muted-foreground" title={file.path}>
              <FileCodeIcon className="size-3 shrink-0" />
              <span className="min-w-0 truncate font-mono [direction:rtl]">
                <bdi>{file.path}</bdi>
              </span>
            </h4>
            {file.threads.map((thread) => (
              <ReviewThreadCard key={thread.id} thread={thread} {...(onReact ? { onReact } : {})} {...(actions ? { actions } : {})} />
            ))}
          </section>
        ))}
      </div>
    </>
  );
}
