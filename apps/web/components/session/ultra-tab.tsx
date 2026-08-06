"use client";

// THE FULL-PANE ULTRA VIEW — the rail's detail, without the 240px budget.
//
// THE RAIL STAYS THE GLANCEABLE INDEX AND THIS IS WHAT IT OPENS. `ultra-rail.tsx`
// is `w-60` and stays `w-60`; a run card is a summary plus a click target, and
// everything that wants room to breathe — a phase's agent rows at readable size,
// an agent's actual prose, the narrator, the returned value, the script — lives
// here instead, in the same reading column Main and the sub-agent tabs use.
//
// NO SESSION HOOK, NO CONTEXT, NO FETCH FOR ANYTHING THE PROJECTION ALREADY HAS.
// Everything arrives as props, because this renders from inside a registered
// item kind's renderer and AD-12 makes that renderer a pure function of
// (payload, view). `RunSnapshot` already carries state/spend/phases/narrator/
// progress from the SAME `useUltraRuns(sessionId)` map the rail reads, and the
// three on-demand readers are `ultra-run-views.tsx`'s — shared with the rail,
// not a second copy. There is no new hook, no second poll and no second
// EventSource anywhere in this file.
//
// NO BUDGET UI (NFR-UW-7 / story 4.2 AC9): a spend readout and nothing else. No
// meter, no ceiling, no percentage, no reserved headroom, no fabricated
// agents-total and no denominator the engine cannot back. `agentsDone` is
// ABSENT rather than `0` until a journal has been read, and absent renders
// nothing — NOT SOURCED ⇒ NOT RENDERED.

import { useEffect, useState } from "react";
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  SquareIcon,
  TriangleAlertIcon,
} from "lucide-react";
import {
  STATE_LABEL,
  ULTRA_STATE_TONE,
  ULTRA_TONE_CLASS,
} from "@/components/session/ultra-anchor";
import {
  AgentTranscript,
  Result,
  ScriptTab,
} from "@/components/session/ultra-run-views";
import {
  AGENT_STATUS_LABEL,
  agentModelLabel,
  agentRunStatus,
  agentTokenTotal,
  anchorControls,
  anchorSpend,
  type AgentRow,
  type AgentRunStatus,
  type RunSnapshot,
} from "@/lib/ultra-runs";
import { fmtTokens } from "@/lib/format";
import type { SpendProvider } from "@/lib/spend-readout";
import { cn } from "@/lib/utils";

// NO NARRATOR HERE ANY MORE. The pane used to carry a fixed-height window of
// the run's `log()` lines. It was removed on an owner ruling after reading a
// real run: the lines are a script author's debug prints, they duplicate what
// the phase/agent rows already say, and a box that is mostly empty and
// occasionally cryptic reads as broken rather than as informative. The
// projection still computes `run.narrator` — the rail's own use is untouched
// and nothing was deleted from `lib/ultra-runs.ts`.

// ── the breadcrumb ──────────────────────────────────────────────────────────

// Modelled on `SubagentBanner` and deliberately NOT reusing it: that component
// takes a `RailStatus` (running|done|error), which has no honest home for
// `stopped` — the fourth Ultra state, and the one that grows a Resume
// affordance. Squeezing it in would read a stopped run as done or as a failure.
// The four-state table in `ultra-anchor.tsx` is the one correct source and is
// imported rather than re-derived.
export function UltraTabBanner({ run, onBack }: { run: RunSnapshot; onBack: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  const tone = ULTRA_STATE_TONE[run.state];
  return (
    <div className="flex items-center gap-1.5 rounded-lg border border-border bg-muted/40 px-2.5 py-1.5 text-xs">
      <button
        type="button"
        onClick={onBack}
        aria-label="Back to main conversation"
        className="-mx-1 inline-flex shrink-0 items-center gap-0.5 rounded-md px-1 py-0.5 font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <ChevronLeftIcon className="size-3.5" />
        Main
      </button>
      <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/40" />
      <span className={cn("shrink-0 text-[10px] leading-none", ULTRA_TONE_CLASS[tone])} aria-hidden>
        ●
      </span>
      <span className="min-w-0 flex-1 truncate font-medium text-foreground">Viewing {run.name}</span>
      <span className="shrink-0 text-[11px] text-muted-foreground">{STATE_LABEL[run.state]}</span>
      <kbd className="hidden shrink-0 rounded border border-border px-1 font-mono text-[10px] text-muted-foreground/60 sm:inline">
        Esc
      </kbd>
    </div>
  );
}

// ── the pane ────────────────────────────────────────────────────────────────

export type UltraTabViewProps = {
  run: RunSnapshot;
  /** for `spendReadout()`. Supplied by the adapter, which hard-codes `"claude"`
   *  because the Ultra MCP server exists only on that branch — a Codex value
   *  here would render a fabricated figure. */
  provider: SpendProvider;
  onStop: () => void;
  /** disables Stop between the click and the next manifest snapshot */
  busy: boolean;
  /** THE SHELL'S OWN disclosure map, threaded down as props. Using it rather
   *  than local state is what keeps the enclosing renderer pure: `isOpen`/
   *  `setOpen` are shell-provided VIEW STATE, not ambient context, and the shell
   *  exists to provide exactly this. Multi-open, like the shell's tool rows —
   *  each agent independently, not the rail's single `openOrdinal`. */
  isOpen: (renderKey: string, fallback?: boolean) => boolean;
  setOpen: (renderKey: string, open: boolean) => void;
};

export function UltraTabView({
  run,
  provider,
  onStop,
  busy,
  isOpen,
  setOpen,
}: UltraTabViewProps) {
  const [tab, setTab] = useState<"run" | "script">("run");
  const tone = ULTRA_STATE_TONE[run.state];
  const spend = anchorSpend(provider, run.spendUsd);
  // The TESTED rule (`lib/ultra-runs.ts`), never a local re-derivation — the
  // rail re-derived it once and that was one decision in two places.
  const controls = anchorControls(run);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border px-3 py-2">
        <span className={cn("shrink-0 text-xs leading-none", ULTRA_TONE_CLASS[tone])} aria-hidden>
          ●
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-sm text-foreground">{run.name}</span>
        <span className={cn("shrink-0 text-xs", ULTRA_TONE_CLASS[tone])}>
          {STATE_LABEL[run.state]}
        </span>
        {/* ABSENT, NEVER `0 done`. A run whose journal has not been read knows
            nothing about its agents, and a wrong number stated as fact is worse
            than no number. */}
        {run.agentsDone !== undefined && (
          <span className="shrink-0 font-mono text-xs text-muted-foreground">
            {run.agentsDone} settled
          </span>
        )}
        <span className="shrink-0 font-mono text-xs text-muted-foreground" title={spend.title}>
          {spend.text}
        </span>
        {controls.canStop && (
          <button
            type="button"
            disabled={busy}
            onClick={onStop}
            title="Stop this run"
            className="inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
          >
            <SquareIcon className="size-3" />
            Stop
          </button>
        )}
        {/* NO RESUME AFFORDANCE (owner ruling). A user may STOP a workflow and
            may never start, resume or modify one — a run is the agent's to
            drive, and a human hand on the throttle mid-flight is how a script's
            own ordering assumptions get violated. `anchorControls.canResume`
            still exists and is still tested: the PORT can resume (that is how a
            crashed run is recovered), and only this surface declines to offer
            it. */}
      </div>

      {run.error && (
        <div className="flex min-w-0 items-start gap-1.5 rounded-lg border border-destructive/40 px-3 py-2 text-xs text-destructive">
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 break-words">{run.error}</span>
        </div>
      )}

      <div className="flex gap-1">
        {(["run", "script"] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cn(
              "rounded px-2 py-0.5 text-xs transition-colors",
              tab === t ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60",
            )}
          >
            {t === "run" ? "Run" : "Script"}
          </button>
        ))}
      </div>

      {tab === "run" ? (
        <>
          {run.phases.map((group) => (
            // The unphased group's title is the empty string (`UNPHASED`), so
            // the key is PREFIXED rather than defaulted: a bare
            // `group.title || "unphased"` collides with a real phase actually
            // named "unphased", and a separator character here is how this repo
            // has shipped a NUL byte four times.
            <div key={`phase:${group.title}`} className="min-w-0">
              {group.title && (
                <div className="mb-1 min-w-0 truncate px-0.5 text-xs font-medium uppercase tracking-wider text-muted-foreground/70">
                  {group.title}
                </div>
              )}
              <div className="flex min-w-0 flex-col gap-0.5">
                {group.agents.map((agent) => (
                  <WideAgentRow
                    key={agent.ordinal}
                    runId={run.runId}
                    agent={agent}
                    provider={provider}
                    isOpen={isOpen}
                    setOpen={setOpen}
                  />
                ))}
              </div>
            </div>
          ))}
          {run.state === "done" && (
            <div className="min-w-0">
              <div className="mb-1 px-0.5 text-xs font-medium uppercase tracking-wider text-muted-foreground/70">
                Result
              </div>
              <Result runId={run.runId} className="max-h-[40rem]" />
            </div>
          )}
        </>
      ) : (
        <ScriptTab runId={run.runId} className="max-h-[48rem]" />
      )}
    </div>
  );
}

// ── one agent, at readable size ─────────────────────────────────────────────

function WideAgentRow({
  runId,
  agent,
  provider,
  isOpen,
  setOpen,
}: {
  runId: string;
  agent: AgentRow;
  provider: SpendProvider;
  isOpen: (renderKey: string, fallback?: boolean) => boolean;
  setOpen: (renderKey: string, open: boolean) => void;
}) {
  const key = `agent:${agent.ordinal}`;
  const open = isOpen(key, false);
  const label = agent.label ?? `agent ${agent.ordinal}`;
  // `Model Name Context·effort`, resolved through the product's own registry —
  // never the bare alias the script typed. `model·effort` when effort is
  // present, model ALONE when it is not: never a chip whose second half is a
  // guess. Both decisions live in `lib/ultra-runs.ts`, where tests drive them.
  const modelName = agentModelLabel(agent.model);
  const chip = modelName ? (agent.effort ? `${modelName}·${agent.effort}` : modelName) : "—";
  // TOKENS, NOT MONEY (owner ruling). `undefined` means the provider reported
  // no usage — rendered as a dash, because a confident `0` would claim the
  // agent consumed nothing when the truth is that nothing was measured.
  const tokens = agentTokenTotal(agent);
  const status = agentRunStatus(agent);
  const failed = status === "failed";
  return (
    <div className="min-w-0 rounded-md border">
      {/* THE MINIMUM AND NOTHING ELSE (owner ruling): a state dot, who it is,
          what it ran on, what it cost. The one-line `snippet` preview that used
          to sit under every row is GONE — twenty rows of clipped mid-sentence
          prose is noise, and the prose it was clipping is one click away in
          full. What a row must answer at a glance is "did this agent finish,
          and did it cost anything"; anything more is the transcript's job. */}
      <button
        type="button"
        onClick={() => setOpen(key, !open)}
        aria-expanded={open}
        title={open ? "Hide this agent's transcript" : "Show this agent's full transcript"}
        className="flex w-full min-w-0 items-center gap-2 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-muted/60"
      >
        <ChevronDownIcon
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground/60 transition-transform",
            !open && "-rotate-90",
          )}
        />
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground/60">
          {agent.ordinal}
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-sm",
            failed ? "text-destructive" : "text-foreground",
          )}
        >
          {label}
        </span>
        {/* EVERY SLOT BELOW IS PRESENT ON EVERY ROW AND FIXED IN WIDTH, which is
            the whole point of this trailing group. Before, each slot rendered
            only when it had a value, so the model chip sat in a different place
            on every line depending on whether that agent happened to have a cost
            yet — the columns visibly danced as a run progressed. A row now
            reserves its space and fills it with a placeholder, so nothing moves
            when a figure arrives. `tabular-nums` keeps the digits themselves
            from changing the width as they change value. */}
        <AgentStatusBar status={status} />
        {/* NAMED, because it sits inches from a chip reading `Claude Sonnet 1M`
            and the two numbers share a unit without sharing a meaning: this one
            is a lifetime sum across the agent's turns, that one is a per-turn
            ceiling. Unlabelled, a large figure here reads as a blown window. */}
        <span
          title={
            tokens === undefined
              ? "No usage reported for this agent"
              : "Input + output tokens across this agent's turns — a running total, not context occupancy"
          }
          className="w-20 shrink-0 text-right font-mono text-[10px] tabular-nums text-muted-foreground"
        >
          {tokens === undefined ? "—" : `${fmtTokens(tokens)} tok`}
        </span>
        <span className="w-32 shrink-0 truncate rounded border px-1 text-right text-[10px] text-muted-foreground">
          {chip}
        </span>
      </button>
      {open && (
        <div className="px-2 pb-2">
          {/* A STANDARD WINDOW, NOT A FREE ONE (owner ruling). `max-h` let each
              transcript take whatever height its content wanted, so opening a
              chatty agent and a terse one produced wildly different boxes and
              the rows below jumped by hundreds of pixels. A FIXED height with
              its own scroll means the page geometry is the same whichever agent
              you open, and the only thing that changes is what is inside. */}
          <AgentTranscript runId={runId} ordinal={agent.ordinal} className="h-96" />
        </div>
      )}
    </div>
  );
}

// ── the status bar ──────────────────────────────────────────────────────────

// One per agent, ALWAYS RENDERED, always the same width — a row with no status
// yet is exactly the row that most needs to say so ("not started"). The tone
// table is the same four-state vocabulary the run header uses, so a stopped
// run's terminated agents cannot read as a failure they never had.
const STATUS_TONE: Record<AgentRunStatus, string> = {
  "not-started": "bg-muted-foreground/25",
  running: "bg-foreground/70",
  done: "bg-foreground/40",
  failed: "bg-destructive/70",
};

function AgentStatusBar({ status }: { status: AgentRunStatus }) {
  return (
    <span className="flex w-24 shrink-0 items-center gap-1.5" title={AGENT_STATUS_LABEL[status]}>
      <span
        aria-hidden
        className={cn(
          "h-1 w-6 shrink-0 rounded-full",
          STATUS_TONE[status],
          status === "running" && "animate-pulse",
        )}
      />
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-[10px]",
          status === "failed" ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {AGENT_STATUS_LABEL[status]}
      </span>
    </span>
  );
}

