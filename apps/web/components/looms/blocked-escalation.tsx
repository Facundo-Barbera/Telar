"use client";

import { useCallback, useMemo, useState } from "react";
import { HandIcon, Loader2Icon, WrenchIcon } from "lucide-react";
// Client-safety: type-only from @telar/core (this is a "use client" file).
import type { Loom } from "@telar/core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

// The "Orchestrator requires help" surface for a loom parked in `blocked`
// (M10.4). Distinct from the amber "needs you"
// (needs-review) framing: this is a QUESTION the orchestrator can't
// guess, not a deliverable to review — so it wears the orange `blocked`
// language (StateBadge already colors blocked orange).
//
// Split into reusable pieces so M11.3's conversational escalation surface
// (discuss-escalation.tsx) can LEAD with the park explanation + a "Discuss with
// the orchestrator" chat and keep the quick form as the secondary "I already
// know the command" path:
//   • ParkExplanation  — the read-only header + the parked question + what it tried.
//   • BlockedAnswerForm — the answer-&-resume form (POST /block/answer).
//   • BlockedEscalation — the original full-page composition (unchanged behavior).

// The read-only park explanation: WHY the loop stopped and WHAT it already
// tried. Pure presentation; carries no form state.
export function ParkExplanation({ loom }: { loom: Loom }) {
  return (
    <>
      <div className="flex items-start gap-2.5 px-1">
        <HandIcon className="mt-0.5 size-5 shrink-0 text-orange-400" />
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <h2 className="font-heading text-sm font-medium text-orange-300">
              Orchestrator requires help
            </h2>
            <Badge className="bg-orange-500/15 font-mono text-[10px] text-orange-400">
              blocked
            </Badge>
          </div>
          <p className="max-w-[62ch] text-sm text-muted-foreground">
            The orchestrator paused BEFORE spending on the build — it can't stand
            up a way to verify this work and won't guess. Talk it through below,
            or answer directly; either way it persists the recipe (so it never
            asks again) and resumes.
          </p>
        </div>
      </div>

      {/* The narrative ask the loop parked on. */}
      <Card className="border-l-2 border-l-orange-500/60 bg-orange-500/[0.04]">
        <CardContent className="flex flex-col gap-1.5">
          <span className="font-mono text-[10px] uppercase tracking-wide text-orange-400/70">
            The question
          </span>
          <p className="text-sm leading-relaxed text-orange-100/90">
            {loom.blockedQuestion ??
              "How do I run this app so verification can drive it?"}
          </p>
        </CardContent>
      </Card>

      {/* What it already tried — the machine-facing reason the lane is unviable. */}
      {loom.blockedReason && (
        <Card>
          <CardContent className="flex flex-col gap-1.5">
            <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground/70">
              Here's what it already tried
            </span>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {loom.blockedReason}
            </p>
          </CardContent>
        </Card>
      )}
    </>
  );
}

// The answer-&-resume form: verifyCommand (the M11 strategy answer) / devCommand /
// runbook → POST /api/looms/[id]/block/answer. Uses the post()/busy/
// telar:refresh + SSE-driven-unmount shape: the answer → persist → re-dispatch
// round trip is server-authoritative, so we DO NOT optimistically clear state
// client-side — the page's SSE loop flips loom.state off "blocked" and unmounts
// this panel. The answerer identity (`by`) is bound server-side, NEVER sent.
export function BlockedAnswerForm({ loom }: { loom: Loom }) {
  const [devCommand, setDevCommand] = useState("");
  const [verifyCommand, setVerifyCommand] = useState("");
  const [runbook, setRunbook] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // At least one VIABILITY-MAKING field — mirrors answerBlocked's guard, which
  // rejects a runbook-only answer exactly like an empty one (isLaneViable never
  // reads the runbook, so it can't resume the loom alone).
  const canSubmit = useMemo(
    () => Boolean(devCommand.trim() || verifyCommand.trim()),
    [devCommand, verifyCommand],
  );

  const submit = useCallback(async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    // Only send non-blank fields — the server binds `by="you"` itself; the
    // answer identity is NEVER read from the body (the human-by moat).
    const body: { devCommand?: string; verifyCommand?: string; runbook?: string } = {};
    if (devCommand.trim()) body.devCommand = devCommand.trim();
    if (verifyCommand.trim()) body.verifyCommand = verifyCommand.trim();
    if (runbook.trim()) body.runbook = runbook.trim();
    try {
      const res = await fetch(`/api/looms/${loom.id}/block/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "Couldn't submit the answer.");
      }
      // Leave busy=true — the SSE "run" event flips the state and unmounts us.
      window.dispatchEvent(new Event("telar:refresh"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }, [loom.id, devCommand, verifyCommand, runbook, canSubmit]);

  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <WrenchIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="text-sm font-medium">Answer &amp; resume</span>
        </div>

        {/* M11 — the STRATEGY answer field: the strategy-derived ask requests a
            test/eval command for a library/CLI/DS deliverable, and this is the
            field that answer lands in (persisted as telar.yaml verifyCommand,
            never as devCommand — a test suite must never be auto-spun as a
            dev server). */}
        <label className="flex flex-col gap-1.5">
          <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground/70">
            verification command
          </span>
          <Input
            value={verifyCommand}
            onChange={(e) => setVerifyCommand(e.target.value)}
            placeholder="e.g. bun test"
            className="font-mono text-xs"
            disabled={busy}
          />
          <span className="text-[11px] text-muted-foreground">
            For a library/CLI/eval deliverable: a command whose exit code proves
            the work. Saved to <code className="font-mono">telar.yaml</code> —
            its exit code becomes the fail-closed verification gate.
          </span>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground/70">
            dev command
          </span>
          <Input
            value={devCommand}
            onChange={(e) => setDevCommand(e.target.value)}
            placeholder="e.g. bun run dev"
            className="font-mono text-xs"
            disabled={busy}
          />
          <span className="text-[11px] text-muted-foreground">
            For a runnable app: saved to <code className="font-mono">telar.yaml</code>{" "}
            so verification can bring the app up — this alone makes the lane viable.
          </span>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground/70">
            runbook (optional)
          </span>
          <Textarea
            value={runbook}
            onChange={(e) => setRunbook(e.target.value)}
            placeholder="How to drive it to verify this feature — log in, go to /dashboard, click New. Seed/login steps, test credentials, known-flaky areas…"
            rows={5}
            className="text-xs"
            disabled={busy}
          />
          <span className="text-[11px] text-muted-foreground">
            Saved to <code className="font-mono">.telar/runbook.md</code>{" "}
            (never committed) — the narrative for how to reach and verify the
            feature. Accompanies a command above; a runbook alone can&apos;t
            resume the loom.
          </span>
        </label>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            Answering persists the recipe and re-runs verification — the
            Verifier still gates completion.
          </p>
          <Button onClick={submit} disabled={busy || !canSubmit}>
            {busy && <Loader2Icon className="animate-spin" />}
            Answer &amp; resume
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// The original full-page composition (park explanation + the answer form).
// Retained for any caller that wants the plain form-only surface; the loom page
// now renders DiscussEscalation (which LEADS with the discuss chat and keeps
// this form as the secondary path).
export function BlockedEscalation({ loom }: { loom: Loom }) {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-4">
      <ParkExplanation loom={loom} />
      <BlockedAnswerForm loom={loom} />
    </div>
  );
}
