"use client";

import { useCallback, useState } from "react";
import {
  CircleCheckIcon,
  CircleXIcon,
  CornerUpLeftIcon,
  GitCommitHorizontalIcon,
  HandIcon,
  Loader2Icon,
  PencilIcon,
  RotateCcwIcon,
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
// the owner's intervention surface for the states where the loop hands back to
// a human — each renders a distinct posture, but they share the same
// server-provenanced moves ("you"):
//   • Accept  → POST /accept  (no body)         → lands + commits → done
//   • Steer   → POST /steer   { directive }      → re-enters the verified loop
//   • Reject  → POST /reject  { feedback }        → re-enters the loop
//   • Resume  → POST /resume  (no body)          → no-feedback retry of the loop
// Accept auto-detects its kind server-side from loom.state: a clean accept of
// `ready`, or an AUDITED OWNER OVERRIDE of `needs-review`/`blocked` (the human
// touch stands in for a passing gate; the response carries acceptedOverride).
// Steer/Reject/Resume reveal (or fire) but all re-verify and can only land back
// in `ready`, never self-promote to done — the moat stays intact. `failed` is a
// dead-ended attempt: no Accept at all (the moat forbids blessing failure) —
// only Send back (reject with feedback) or Resume (retry as-is).

type Variant = "ready" | "needs-review" | "blocked" | "failed";

// The intervention states. `ready` is a clean sign-off; `needs-review`/`blocked`
// are override/decision surfaces; `failed` is a dead-end the owner re-runs or
// sends back. Everything visual + copy lives here so the component body is one
// shared machine.
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
    showSteer: boolean; // the note-opening steer/answer move (invalid from failed)
    showResume: boolean; // the no-feedback retry (only from failed)
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
    showSteer: true,
    showResume: false,
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
    showSteer: true,
    showResume: false,
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
    heading: "Orchestrator requires help",
    badgeClass: "bg-orange-500/15 text-orange-400",
    badge: "blocked",
    body: "The orchestrator can't stand up a way to verify this and won't guess. Give it a dev command and it persists the recipe (never asks again) and resumes.",
    showAccept: false,
    acceptLabel: "",
    showSteer: true,
    showResume: false,
    steerLabel: "Answer & resume",
    steerIcon: SendIcon,
    noteLabel: "A dev command makes the lane viable — it's saved to telar.yaml and the thread resumes.",
    notePlaceholder: "e.g. bun run dev",
    sendLabel: "Answer & resume",
  },
  failed: {
    card: "border-l-destructive/60 bg-destructive/[0.04] ring-destructive/20",
    icon: CircleXIcon,
    iconClass: "text-destructive",
    headingClass: "text-destructive",
    heading: "Dead-ended — send it back or retry",
    badgeClass: "bg-destructive/15 text-destructive",
    badge: "failed",
    body: "The loop couldn't land this — the attempt ran out of road. Send it back with corrective feedback, or resume it to re-run as-is. Either way it re-enters the verified loop; the moat means it can't reach done without a passing independent verify.",
    // No Accept: the moat forbids blessing a failure. Only send-back / retry.
    showAccept: false,
    acceptLabel: "",
    showSteer: false,
    showResume: true,
    steerLabel: "",
    steerIcon: PencilIcon,
    noteLabel: "",
    notePlaceholder: "",
    sendLabel: "",
  },
};

// The `ready` sign-off's AI account of WHAT was verified and WHY it's
// acceptable, sourced ONLY from prose the verification loop already wrote onto
// the loom — never fabricated client-side. Fallback order, most authoritative
// first:
//   1. the INDEPENDENT Verifier report summary (legacy single-verifier path)
//   2. a synthesis of the critic PANEL's per-lens summaries (no single
//      panelReport.summary exists, so we join the critics' prose)
//   3. the BUILDER's own Verdict summary (all that survives a gate-only loom)
// Null when the latest attempt carries no prose at all — the panel then keeps
// its static blurb as the graceful default. Reads the latest attempt because
// that's the one the `ready` state was reached on.
function deriveVerifiedSummary(
  loom: Loom,
): { text: string; sourceLabel: string } | null {
  const latest = loom.attempts.at(-1);
  if (!latest) return null;

  const verifier = latest.verifierReport?.summary?.trim();
  if (verifier) return { text: verifier, sourceLabel: "Independent verifier" };

  const lensLines = (latest.panelReport?.critics ?? [])
    .map((c) => c.summary?.trim())
    .filter((s): s is string => Boolean(s));
  if (lensLines.length > 0) {
    return { text: lensLines.join(" "), sourceLabel: "Critic panel" };
  }

  const builder = latest.verdict?.summary?.trim();
  if (builder) return { text: builder, sourceLabel: "Builder" };

  return null;
}

export function AcceptancePanel({
  loom,
  onAccepted,
  allowAccept = true,
}: {
  loom: Loom;
  // Propagates the updated loom up so the god-view refreshes. Named for the
  // original accept flow; reused verbatim by steer/reject (each returns the
  // re-dispatched loom).
  onAccepted?: (loom: Loom) => void;
  // MOAT INTEGRITY: a woven ROOT must not blanket-override the whole weave to
  // done while its child Threads are still unresolved. The god-view passes false
  // to suppress the override-Accept (steer/reject/resume stay available) until
  // every Thread lands. Defaults true — a plain loom or an individual Thread is
  // always directly acceptable.
  allowAccept?: boolean;
}) {
  const [accepting, setAccepting] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Which inline note field is open, and the pending network op. Only one of
  // steer/reject can be open at a time; opening one closes the other.
  const [mode, setMode] = useState<"steer" | "reject" | null>(null);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);

  const busy = accepting || resuming || sending;

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

  // Resume: a no-body retry that re-enters the verified loop (POST /resume →
  // resumeLoom, valid from failed/needs-review/blocked). Mirrors accept's shape
  // — same optimistic onAccepted + refresh — but never lands `done`.
  const resume = useCallback(async () => {
    setResuming(true);
    setError(null);
    try {
      const res = await fetch(`/api/looms/${loom.id}/resume`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "Couldn't resume the loom.");
      }
      onAccepted?.((data as { loom: Loom }).loom);
      window.dispatchEvent(new Event("telar:refresh"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setResuming(false);
    }
  }, [loom.id, onAccepted]);

  const openMode = useCallback((next: "steer" | "reject") => {
    setError(null);
    setMode((cur) => (cur === next ? null : next));
    setNote("");
  }, []);

  // Steer POSTs { directive }, Reject POSTs { feedback }; both return
  // { ok, loom } and re-dispatch the loom (it leaves "ready" for "queued").
  // For `blocked` the "steer" move ANSWERS the escalation instead: it posts a
  // devCommand to the dedicated /block/answer route (steerLoom REFUSES blocked
  // — the /steer path is retired here). That route binds a HUMAN `by` server-
  // side and returns { ok } only, so the SSE loop (not onAccepted) drives the
  // unmount. The full answer surface — devCommand + runbook — is the page-level
  // BlockedEscalation panel; this rail is the compact devCommand fast-path.
  const submitNote = useCallback(async () => {
    if (!mode) return;
    const text = note.trim();
    if (!text) return;
    const isBlockedAnswer = mode === "steer" && loom.state === "blocked";
    const path = isBlockedAnswer
      ? "block/answer"
      : mode === "steer"
        ? "steer"
        : "reject";
    const body = isBlockedAnswer
      ? { devCommand: text }
      : mode === "steer"
        ? { directive: text }
        : { feedback: text };
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
              ? "Couldn't send the answer."
              : "Couldn't send the feedback."),
        );
      }
      setMode(null);
      setNote("");
      // /block/answer returns no loom — the SSE refresh flips the state.
      if (!isBlockedAnswer) onAccepted?.((data as { loom: Loom }).loom);
      window.dispatchEvent(new Event("telar:refresh"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }, [loom.id, loom.state, mode, note, onAccepted]);

  // Self-gated like SpecBundle: safe to mount unconditionally. Renders only for
  // the states where the loop hands back to the owner — `ready` (clean sign-off),
  // `needs-review`/`blocked` (override / decision), and `failed` (retry / send
  // back). Every other state is null.
  if (
    loom.state !== "ready" &&
    loom.state !== "needs-review" &&
    loom.state !== "blocked" &&
    loom.state !== "failed"
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
  // For `blocked`, the surfaced question is the dedicated narrative ask
  // (loom.blockedQuestion) — NOT the overloaded loom.error, so the two never
  // diverge (M10.4). The full answer surface is the page-level BlockedEscalation
  // panel; this right-rail copy is the at-a-glance version for a woven child.
  const question = loom.state === "blocked" ? loom.blockedQuestion : null;
  // For `failed`, surface the terminal reason (loom.error) so the owner sees WHY
  // before deciding to resume or send back.
  const failureReason = loom.state === "failed" ? loom.error : null;
  // For `ready`, the AI's prose account of what was verified — augments the
  // static heading/blurb; null falls back to the blurb alone.
  const verifiedSummary =
    loom.state === "ready" ? deriveVerifiedSummary(loom) : null;

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

        {/* ready: the AI's prose account of WHAT was verified and why it's
            acceptable — sourced from the loom's own verification record
            (verifier → panel synthesis → builder verdict), never authored
            here. Augments the heading; absent when the loom carries no prose. */}
        {verifiedSummary && (
          <div className="flex flex-col gap-1 rounded-md bg-emerald-500/[0.06] p-2.5 ring-1 ring-emerald-500/20">
            <span className="font-mono text-[10px] uppercase tracking-wide text-emerald-400/70">
              {verifiedSummary.sourceLabel}
            </span>
            <p className="text-xs leading-snug text-foreground/80">
              {verifiedSummary.text}
            </p>
          </div>
        )}

        {/* blocked: the exact question the loop parked on. */}
        {question && (
          <div className="rounded-md border border-orange-500/20 bg-orange-500/[0.05] px-3 py-2 text-xs leading-relaxed text-orange-200/90">
            {question}
          </div>
        )}

        {/* failed: the terminal reason, so the decision to retry/send back is informed. */}
        {failureReason && (
          <div className="rounded-md border border-destructive/25 bg-destructive/[0.06] px-3 py-2 text-xs leading-relaxed text-destructive">
            {failureReason}
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
              (and the server's acceptedOverride flag) marks the override.
              `allowAccept` gates it off for a woven root with unresolved
              Threads — the moat forbids a blanket override of the weave. */}
          {v.showAccept && allowAccept && (
            <Button
              onClick={accept}
              disabled={busy}
              className="border border-emerald-500/30 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 focus-visible:ring-emerald-500/50"
            >
              {accepting && <Loader2Icon className="animate-spin" />}
              {v.acceptLabel}
            </Button>
          )}
          {/* Resume (failed): a no-feedback retry — re-runs the loop as-is. It
              re-verifies, so it can only land back in ready, never done. */}
          {v.showResume && (
            <Button onClick={resume} disabled={busy}>
              {resuming ? <Loader2Icon className="animate-spin" /> : <RotateCcwIcon />}
              Resume
            </Button>
          )}
          {v.showSteer && (
            <Button
              variant="outline"
              onClick={() => openMode("steer")}
              disabled={busy}
              aria-pressed={mode === "steer"}
            >
              <SteerIcon />
              {v.steerLabel}
            </Button>
          )}
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
