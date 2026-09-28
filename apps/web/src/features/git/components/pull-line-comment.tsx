"use client";

import { useEffect, useState } from "react";
import { ExternalLinkIcon } from "lucide-react";
import type { GitHubLineCommentInput, GitHubLineCommentResult, GitHubPullAnchor } from "@telar/engine-client";

import type { DiffScopeKind } from "../diff-scope";
import { anchorPullLines, applyLineComment, type AnchorAnswer, type LineCommentEntry, type PullLineAnchor, type SelectedLines } from "../pull-anchor";
import { Button } from "@/ui/button";
import { Spinner } from "@/ui/spinner";
import { Textarea } from "@/ui/textarea";
import { cn } from "@/ui/utils";

export type PullCommentContext = {
  read: () => Promise<GitHubPullAnchor>;
  scope: DiffScopeKind;
  ahead?: number;
  send: (input: GitHubLineCommentInput) => Promise<GitHubLineCommentResult>;
};

export function PullLineComment({ context, path, patch, range }: { context: PullCommentContext; path: string; patch: string; range: SelectedLines }) {
  const [read, setRead] = useState<{ answer?: AnchorAnswer; number?: number }>();
  useEffect(() => {
    let cancelled = false;
    void context
      .read()
      .then((anchor) => {
        if (cancelled) return;
        const answer = anchorPullLines({ scope: context.scope, anchor, ...(context.ahead === undefined ? {} : { ahead: context.ahead }), path, patch, range });
        setRead(answer ? { answer, ...(anchor.pull ? { number: anchor.pull.number } : {}) } : {});
      })
      .catch(() => {
        if (!cancelled) setRead({});
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!read?.answer) return null;
  return <PullLineCommentBody answer={read.answer} {...(read.number ? { number: read.number } : {})} send={context.send} />;
}

export function PullLineCommentBody({
  answer,
  number,
  send,
}: {
  answer: AnchorAnswer;
  number?: number;
  send: (input: GitHubLineCommentInput) => Promise<GitHubLineCommentResult>;
}) {
  const [draft, setDraft] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string>();
  const [entries, setEntries] = useState<readonly LineCommentEntry[]>([]);

  if ("reason" in answer) return <p className="mx-3 mb-2 text-2xs leading-snug text-muted-foreground">{answer.reason}</p>;
  const anchor: PullLineAnchor = answer.anchor;

  const submit = () => {
    const body = draft?.trim();
    if (busy || !body) return;
    setBusy(true);
    setRefused(undefined);
    void applyLineComment({ current: entries, body, now: Date.now(), send: () => send({ ...anchor, body }), draw: setEntries })
      .then((said) => {
        setRefused(said);
        if (!said) setDraft(undefined);
      })
      .finally(() => setBusy(false));
  };

  return (
    <div className="mx-3 mb-2 flex flex-col gap-1">
      {entries.map((entry) => (
        <div
          key={`${entry.at}:${entry.url ?? "pending"}`}
          data-pending={!entry.url || undefined}
          className={cn("rounded-md border border-border bg-card px-2 py-1.5 text-2xs", !entry.url && "opacity-60")}
        >
          <div className="mb-0.5 flex items-center gap-1.5 text-3xs text-muted-foreground">
            <span className="font-medium text-foreground">you</span>
            {entry.url ? (
              <a href={entry.url} target="_blank" rel="noreferrer" className="ml-auto flex items-center gap-1 transition-colors hover:text-foreground">
                on #{number ?? "?"} <ExternalLinkIcon className="size-2.5" />
              </a>
            ) : (
              <span className="flex items-center gap-1">
                <Spinner className="size-2.5" /> sending
              </span>
            )}
          </div>
          <p className="whitespace-pre-wrap">{entry.body}</p>
        </div>
      ))}
      {draft === undefined ? (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => setDraft("")}
            className="rounded-md border border-input px-2 py-0.5 text-2xs text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            Comment on the pull request{number ? ` #${number}` : ""}
          </button>
        </div>
      ) : (
        <>
          <Textarea
            autoFocus
            value={draft}
            disabled={busy}
            placeholder="Start a review thread on these lines. ⌘↩ sends."
            aria-label="Comment on these lines in the pull request"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                submit();
              }
              if (event.key === "Escape" && !busy) setDraft(undefined);
            }}
            className="min-h-16 text-xs"
          />
          <div className="flex justify-end gap-1">
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => setDraft(undefined)}>
              Cancel
            </Button>
            <Button size="xs" disabled={busy || !draft.trim()} onClick={submit}>
              Comment
            </Button>
          </div>
        </>
      )}
      {refused && (
        <p role="status" className="text-2xs leading-snug text-destructive">
          {refused}
        </p>
      )}
    </div>
  );
}
