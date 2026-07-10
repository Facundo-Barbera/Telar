"use client";

import { useCallback, useState } from "react";
import {
  CircleCheckIcon,
  CornerUpLeftIcon,
  GitCommitHorizontalIcon,
  HandIcon,
  Loader2Icon,
  PencilIcon,
  SearchCheckIcon,
  SendIcon,
  XIcon,
} from "lucide-react";
import type { Loom } from "@telar/core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

// §A (docs/loom-model.md): a Loom never marks itself finished. This panel is
// the owner's intervention surface for the three states where the loop hands
// back to a human — each renders a distinct posture, but they share the exact
// same three server-provenanced moves ("you"):
//   • Accept  → POST /accept  (no body)         → lands + commits → done
//   • Steer   → POST /steer   { directive }      → re-enters the verified loop
//   • Reject  → POST /reject  { feedback }        → re-enters the loop
// Accept auto-detects its kind server-side from loom.state: a clean accept of
// `ready`, or an AUDITED OWNER OVERRIDE of `needs-review`/`blocked` (the human
// touch stands in for a passing gate; the response carries acceptedOverride).
// Steer/Reject reveal an inline note field; both re-verify and can only land
// back in `ready`, never self-promote to done — the moat stays intact.

type Variant = "ready" | "needs-review" | "blocked";

// The three intervention states. `ready` is a clean sign-off; the other two
// are override/decision surfaces. Everything visual + copy lives here so the
// component body is one shared machine.
const VARIANTS: Record<
  Variant,
  {
    card: string; // border/tint/ring
    icon: typeof CircleCheckIcon;
    iconClass: string;
    headingClass: string;
    heading: string;
    badgeClass: string;
    badge: string;
    body: string;
    showAccept: boolean;
    acceptLabel: string;
    // Primary move that opens the note field: for `blocked` the owner ANSWERS a
    // surfaced question (posts to /steer); elsewhere it's a plain steer.
    steerLabel: string;
    steerIcon: typeof PencilIcon;
    noteLabel: string; // above the inline field when steering
    notePlaceholder: string;
    sendLabel: string;
  }
> = {
  ready: {
    card: "border-l-emerald-500/60 bg-emerald-500/[0.04] ring-emerald-500/20",
    icon: CircleCheckIcon,
    iconClass: "text-emerald-400",
    headingClass: "text-emerald-300",
    heading: "Verified — awaiting your acceptance",
    badgeClass: "bg-emerald-500/15 text-emerald-400",
    badge: "ready",
    body: "Every required thread is done, hard gates are green, and the critic panel's blocker lenses cleared. The loop finished the work while you were gone — it has shipped nothing as done without you. Accepting is your call, not a formality.",
    showAccept: true,
    acceptLabel: "Accept",
    steerLabel: "Steer",
    steerIcon: PencilIcon,
    noteLabel: "Add a directive — the loop re-verifies and lands back in ready.",
    notePlaceholder:
      "e.g. 'For a declined card, use the “try another card” copy.'",
    sendLabel: "Send directive",
  },
  "needs-review": {
    card: "border-l-amber-500/60 bg-amber-500/[0.04] ring-amber-500/20",
    icon: SearchCheckIcon,
    iconClass: "text-amber-400",
    headingClass: "text-amber-300",
    heading: "Couldn't independently verify — your review",
    badgeClass: "bg-amber-500/15 text-amber-400",
    badge: "needs review",
    body: "The loop couldn't independently verify this — no executable check ran to prove it. Review the deliverable below, then accept it (an override — your call, not a passing gate), steer it, or send it back.",
    showAccept: true,
    acceptLabel: "Accept (override)",
    steerLabel: "Steer",
    steerIcon: PencilIcon,
    noteLabel: "Add a directive — the loop re-verifies and lands back in ready.",
    notePlaceholder:
      "e.g. 'Add a Playwright check that actually drives the checkout.'",
    sendLabel: "Send directive",
  },
  blocked: {
    card: "border-l-orange-500/60 bg-orange-500/[0.04] ring-orange-500/20",
    icon: HandIcon,
    iconClass: "text-orange-400",
    headingClass: "text-orange-300",
    heading: "Paused for a decision — answer to resume",
    badgeClass: "bg-orange-500/15 text-orange-400",
    badge: "blocked",
    body: "The loop paused on a decision it won't guess. Answer it and the thread resumes — the rest of the weave kept running around it.",
    showAccept: false,
    acceptLabel: "",
    steerLabel: "Answer & resume",
    steerIcon: SendIcon,
    noteLabel: "Your answer becomes the directive — the thread resumes with it.",
    notePlaceholder: "e.g. 'Use Stripe test mode; the sandbox keys are in .env.'",
    sendLabel: "Answer & resume",
  },
};

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

  // Self-gated like SpecBundle: safe to mount unconditionally. Renders only
  // for the three states where the loop hands back to the owner — `ready`
  // (clean sign-off), `needs-review` and `blocked` (override / decision).
  if (
    loom.state !== "ready" &&
    loom.state !== "needs-review" &&
    loom.state !== "blocked"
  ) {
    return null;
  }

  const v = VARIANTS[loom.state as Variant];
  const Icon = v.icon;
  const SteerIcon = v.steerIcon;

  // Evidence to surface for a needs-review override: the latest attempt's
  // verdict (summary + files it touched) so the owner reviews what actually
  // landed before overriding. Guarded — an early/odd loom may have neither.
  const latest = loom.attempts.at(-1);
  const verdict = latest?.verdict ?? null;
  const files = verdict?.files_touched ?? [];
  // For `blocked`, the surfaced question is stored on loom.error.
  const question = loom.state === "blocked" ? loom.error : null;

  return (
    <Card className={cn("border-l-2", v.card)}>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-start gap-2.5">
          <Icon className={cn("mt-0.5 size-5 shrink-0", v.iconClass)} />
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "font-heading text-sm font-medium",
                  v.headingClass,
                )}
              >
                {v.heading}
              </span>
              <Badge className={cn("font-mono text-[10px]", v.badgeClass)}>
                {v.badge}
              </Badge>
            </div>
            <p className="max-w-[60ch] text-xs leading-relaxed text-muted-foreground">
              {v.body}
            </p>
          </div>
        </div>

        {/* blocked: the exact question the loop parked on. */}
        {question && (
          <div className="rounded-md border border-orange-500/20 bg-orange-500/[0.05] px-3 py-2 text-xs leading-relaxed text-orange-200/90">
            {question}
          </div>
        )}

        {/* needs-review: the deliverable to review before overriding. */}
        {loom.state === "needs-review" && verdict && (
          <div className="flex flex-col gap-2 rounded-md bg-muted/30 p-2.5 ring-1 ring-border">
            <p className="text-xs leading-snug text-foreground/80">
              {verdict.summary}
            </p>
            {files.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {files.map((f) => (
                  <Badge
                    key={f}
                    variant="outline"
                    className="max-w-full px-1.5 py-0 font-mono text-[10px]"
                  >
                    <span className="truncate">{f}</span>
                  </Badge>
                ))}
              </div>
            )}
          </div>
        )}

        {error && <p className="text-xs text-destructive">{error}</p>}

        <div className="flex flex-wrap items-center gap-2">
          {/* Accept keeps the muted-emerald tint in every variant; the label
              (and the server's acceptedOverride flag) marks the override. */}
          {v.showAccept && (
            <Button
              onClick={accept}
              disabled={busy}
              className="border border-emerald-500/30 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 focus-visible:ring-emerald-500/50"
            >
              {accepting && <Loader2Icon className="animate-spin" />}
              {v.acceptLabel}
            </Button>
          )}
          <Button
            variant="outline"
            onClick={() => openMode("steer")}
            disabled={busy}
            aria-pressed={mode === "steer"}
          >
            <SteerIcon />
            {v.steerLabel}
          </Button>
          <Button
            variant="outline"
            onClick={() => openMode("reject")}
            disabled={busy}
            aria-pressed={mode === "reject"}
          >
            {loom.state === "ready" ? <XIcon /> : <CornerUpLeftIcon />}
            {loom.state === "ready" ? "Reject" : "Send back"}
          </Button>
        </div>

        {mode && (
          <div className="flex flex-col gap-2 border-t border-border/60 pt-3">
            <label className="text-xs text-muted-foreground">
              {mode === "steer"
                ? v.noteLabel
                : "What needs to change? The loop reworks it and re-verifies."}
            </label>
            <Textarea
              autoFocus
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={sending}
              placeholder={
                mode === "steer"
                  ? v.notePlaceholder
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
                {mode === "steer" ? v.sendLabel : "Send feedback"}
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
