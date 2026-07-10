"use client";

import { useCallback, useState } from "react";
import {
  CircleCheckIcon,
  GitCommitHorizontalIcon,
  Loader2Icon,
  PencilIcon,
  XIcon,
} from "lucide-react";
import type { Loom } from "@telar/core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";

// §A (docs/loom-model.md): a Loom never marks itself finished — the verified
// loop lands in "ready" and waits for the owner. This is the sign-off moment.
// The owner has exactly three moves, all server-provenanced ("you"):
//   • Accept  → /accept, lands the work (now also commits) → done
//   • Steer   → /steer,  add a directive, re-enter the verified loop → queued
//   • Reject  → /reject, hand back feedback, re-enter the loop     → queued
// Steer/Reject reveal an inline note field; both re-verify and land back in
// "ready" (never self-promote to done — the moat stays intact).
export function AcceptancePanel({
  loom,
  onAccepted,
}: {
  loom: Loom;
  // Propagates the updated loom up so the god-view refreshes. Named for the
  // original accept flow; reused verbatim by steer/reject (each returns the
  // re-dispatched loom).
  onAccepted?: (loom: Loom) => void;
}) {
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Which inline note field is open, and the pending network op. Only one of
  // steer/reject can be open at a time; opening one closes the other.
  const [mode, setMode] = useState<"steer" | "reject" | null>(null);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);

  const busy = accepting || sending;

  const accept = useCallback(async () => {
    setAccepting(true);
    setError(null);
    try {
      const res = await fetch(`/api/looms/${loom.id}/accept`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error ?? "Couldn't accept the loom.");
      }
      onAccepted?.((data as { loom: Loom }).loom);
      window.dispatchEvent(new Event("telar:refresh"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setAccepting(false);
    }
  }, [loom.id, onAccepted]);

  const openMode = useCallback((next: "steer" | "reject") => {
    setError(null);
    setMode((cur) => (cur === next ? null : next));
    setNote("");
  }, []);

  // Steer POSTs { directive }, Reject POSTs { feedback }; both return
  // { ok, loom } and re-dispatch the loom (it leaves "ready" for "queued").
  const submitNote = useCallback(async () => {
    if (!mode) return;
    const text = note.trim();
    if (!text) return;
    const path = mode === "steer" ? "steer" : "reject";
    const body = mode === "steer" ? { directive: text } : { feedback: text };
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/looms/${loom.id}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        throw new Error(
          data.error ??
            (mode === "steer"
              ? "Couldn't send the directive."
              : "Couldn't send the feedback."),
        );
      }
      setMode(null);
      setNote("");
      onAccepted?.((data as { loom: Loom }).loom);
      window.dispatchEvent(new Event("telar:refresh"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }, [loom.id, mode, note, onAccepted]);

  // Self-gated like SpecBundle: safe to mount unconditionally, only ever
  // renders for a loom actually sitting in "ready".
  if (loom.state !== "ready") return null;

  return (
    <Card className="border-l-2 border-l-emerald-500/60 bg-emerald-500/[0.04] ring-emerald-500/20">
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-start gap-2.5">
          <CircleCheckIcon className="mt-0.5 size-5 shrink-0 text-emerald-400" />
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-2">
              <span className="font-heading text-sm font-medium text-emerald-300">
                Verified — awaiting your acceptance
              </span>
              <Badge className="bg-emerald-500/15 font-mono text-[10px] text-emerald-400">
                ready
              </Badge>
            </div>
            <p className="max-w-[60ch] text-xs leading-relaxed text-muted-foreground">
              Every required thread is done, hard gates are green, and the
              critic panel&apos;s blocker lenses cleared. The loop finished
              the work while you were gone — it has shipped nothing as done
              without you. Accepting is your call, not a formality.
            </p>
          </div>
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={accept}
            disabled={busy}
            className="border border-emerald-500/30 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 focus-visible:ring-emerald-500/50"
          >
            {accepting && <Loader2Icon className="animate-spin" />}
            Accept
          </Button>
          <Button
            variant="outline"
            onClick={() => openMode("steer")}
            disabled={busy}
            aria-pressed={mode === "steer"}
          >
            <PencilIcon />
            Steer
          </Button>
          <Button
            variant="outline"
            onClick={() => openMode("reject")}
            disabled={busy}
            aria-pressed={mode === "reject"}
          >
            <XIcon />
            Reject
          </Button>
        </div>

        {mode && (
          <div className="flex flex-col gap-2 border-t border-border/60 pt-3">
            <label className="text-xs text-muted-foreground">
              {mode === "steer"
                ? "Add a directive — the loop re-verifies and lands back in ready."
                : "What needs to change? The loop reworks it and re-verifies."}
            </label>
            <Textarea
              autoFocus
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={sending}
              placeholder={
                mode === "steer"
                  ? "e.g. 'For a declined card, use the “try another card” copy.'"
                  : "e.g. 'The empty state still flashes on first load — fix that.'"
              }
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  void submitNote();
                }
              }}
            />
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => void submitNote()}
                disabled={sending || !note.trim()}
              >
                {sending && <Loader2Icon className="animate-spin" />}
                {mode === "steer" ? "Send directive" : "Send feedback"}
              </Button>
              <span className="text-[11px] text-muted-foreground/70">
                ⌘↵ to send
              </span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Views-06 (docs mockup): the calm, non-invasive close of the loop. Shown once
// a loom reaches "done" — the only state acceptLoom can produce. If the work
// landed a commit we show the short sha; a clean tree / non-git accept has no
// `commit`, so we simply omit the sha. `by` is derived from the loom's
// "accepted" event upstream; falls back to "you" (the server-fixed acceptor).
export function DoneConfirmation({ loom, by }: { loom: Loom; by?: string }) {
  if (loom.state !== "done") return null;
  const who = by ?? "you";
  const sha = loom.commit ? loom.commit.slice(0, 7) : null;

  return (
    <Card className="border-l-2 border-l-border bg-muted/20">
      <CardContent className="flex items-center gap-2.5 py-3">
        <CircleCheckIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="text-xs text-muted-foreground">
          Accepted by <span className="font-medium text-foreground/80">{who}</span>
        </span>
        {sha && (
          <>
            <span className="text-muted-foreground/40">·</span>
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              landed
              <span className="flex items-center gap-1 font-mono text-foreground/70">
                <GitCommitHorizontalIcon className="size-3.5" />
                {sha}
              </span>
            </span>
          </>
        )}
      </CardContent>
    </Card>
  );
}
