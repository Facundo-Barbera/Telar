"use client";

import { useState } from "react";
import { GitCommitHorizontalIcon } from "lucide-react";
import { EngineApiError } from "@/platform/engine";
import { Button } from "@/ui/button";
import { Spinner } from "@/ui/spinner";
import { cn } from "@/ui/utils";
import { api } from "../api";

/**
 * Commits the whole tree (`git add -A`), so `files` is the unfiltered count and, with `countIncomplete`,
 * only a floor. Held while a turn runs: a commit mid-write takes half a file.
 */
export function CommitBox({
  sessionId,
  suggestion,
  files,
  countIncomplete,
  busy,
  workspacePath,
  onCommitted,
}: {
  sessionId: string;
  suggestion: string;
  files: number;
  countIncomplete?: boolean;
  busy: boolean;
  workspacePath: string;
  onCommitted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState(suggestion);
  const [working, setWorking] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string }>();

  const commit = async () => {
    setWorking(true);
    setResult(undefined);
    try {
      const answer = await api.commitSessionWork(sessionId, message);
      setResult(
        answer.committed
          ? { ok: true, text: `Committed as ${answer.commit?.shortSha ?? "a new commit"}.` }
          : { ok: false, text: answer.reason ?? "git refused the commit." },
      );
      if (answer.committed) {
        setOpen(false);
        onCommitted();
      }
    } catch (cause) {
      setResult({ ok: false, text: cause instanceof EngineApiError ? cause.message : "The commit could not be sent." });
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="border-t border-border p-3">
      {result && (
        <p className={cn("mb-2 rounded-md px-2.5 py-1.5 text-2xs leading-snug", result.ok ? "tint-success text-success" : "bg-muted text-muted-foreground")}>
          {result.text}
        </p>
      )}
      {open ? (
        <div className="flex flex-col gap-2">
          <textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            rows={3}
            aria-label="Commit message"
            autoFocus
            className="w-full resize-none rounded-md border border-input bg-background p-2 text-xs outline-none focus-visible:border-ring"
          />
          <div className="flex items-center gap-2">
            <Button type="button" size="xs" disabled={working || !message.trim()} onClick={() => void commit()}>
              {working ? <Spinner className="size-3" /> : <GitCommitHorizontalIcon />}
              {countIncomplete ? "Commit everything in the checkout" : `Commit ${files} ${files === 1 ? "file" : "files"}`}
            </Button>
            <Button type="button" size="xs" variant="ghost" disabled={working} onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={busy || (files === 0 && !countIncomplete)}
          title={busy ? "A turn is running — the agent may be mid-write" : undefined}
          onClick={() => {
            setMessage(suggestion);
            setOpen(true);
          }}
        >
          <GitCommitHorizontalIcon />
          Commit everything…
        </Button>
      )}
      <p className="mt-2 text-2xs leading-snug text-muted-foreground">
        Staging, branch switching and discarding are absent — irreversible next to a running agent. Use a terminal in{" "}
        <span className="break-all font-mono">{workspacePath}</span>.
      </p>
    </div>
  );
}
