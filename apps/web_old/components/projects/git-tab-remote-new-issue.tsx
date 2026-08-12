"use client";

// NEW ISSUE modal — a title + body composer opened from the Remote list toolbar.
// Creating is HUMAN-triggered with explicit confirmation (Loom Doctrine): the
// user types, hits Create, and only then does the server POST `gh issue create`.
// The API echoes the created issue so the caller can jump straight to its detail.
//
// Uses the app's Dialog primitive (base-ui, portaled + viewport-clamped) so the
// overlay never depends on a transformed ancestor — per the hard-won UI rules.
import { useState } from "react";
import { LoaderCircleIcon, PlusIcon, TriangleAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { dispatchTelarRefresh } from "@/lib/telar-refresh";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { REMOTE_REASON_TEXT, type CreateIssueResult } from "./git-tab-shared";

export function NewIssueDialog({
  name,
  open,
  onOpenChange,
  onCreated,
}: {
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Receives the created issue number so the caller can jump to its detail.
  onCreated: (issueNumber: number) => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setTitle("");
    setBody("");
    setError(null);
    setBusy(false);
  };

  const change = (next: boolean) => {
    if (busy) return; // don't drop a write in flight
    if (!next) reset();
    onOpenChange(next);
  };

  const canCreate = title.trim().length > 0 && !busy;

  const create = async () => {
    if (!canCreate) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(name)}/git/remote/issues`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: title.trim(), body: body.trim() }),
        },
      );
      const data = (await res.json().catch(() => null)) as CreateIssueResult | null;
      if (!data) throw new Error(`Create failed (${res.status}).`);
      if (!data.connected) {
        setError(`Can't create — ${REMOTE_REASON_TEXT[data.reason]}.`);
        return;
      }
      if (!data.ok) {
        setError(data.error);
        return;
      }
      const created = data.issue.number;
      dispatchTelarRefresh({ domains: ["git"], project: name });
      reset();
      onOpenChange(false);
      onCreated(created);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New issue</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              Title
            </label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={busy}
              placeholder="Short, descriptive title"
              autoFocus
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              Description{" "}
              <span className="font-normal text-muted-foreground/60">
                (markdown, optional)
              </span>
            </label>
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              disabled={busy}
              placeholder="Leave a description…"
              className="min-h-28"
            />
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-1.5">
              <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-destructive" />
              <p className="font-mono text-[11px] break-words text-destructive/90">
                {error}
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => change(false)}
          >
            Cancel
          </Button>
          <Button size="sm" disabled={!canCreate} onClick={() => void create()}>
            {busy ? (
              <LoaderCircleIcon className="animate-spin" />
            ) : (
              <PlusIcon />
            )}
            Create issue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
