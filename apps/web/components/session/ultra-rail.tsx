"use client";

// THE SUB-AGENT RAIL'S WORKFLOWS SECTION — a GLANCEABLE INDEX, and nothing else.
//
// WHAT THIS IS FOR, after the owner read a real run in it: "which runs exist,
// and what is running right now". That is the whole job. Everything that wants
// reading rather than glancing — phases, an agent's prose, the returned value,
// the script, Stop/Resume — lives in the full-pane tab this index OPENS
// (`ultra-tab.tsx`). This file used to carry all of it inside 240px: nested
// disclosure, a fixed-height narrator window, a `<pre>` of the result and a
// second one of the script, all at `text-[10px]`. It was unreadable at that
// size and it duplicated a surface that renders the same things properly.
//
// THE WHOLE CARD IS THE CLICK TARGET. It used to be a chevron and a name, with
// the pane-opening affordance a separate small control beside them — so the
// obvious click (the run's name) did the least useful thing (inline disclosure)
// and opening the pane required aiming. There is now ONE gesture on a run: open
// it.
//
// EVERY DECISION IS IN `lib/ultra-runs.ts`, NOT HERE. Which agent rows exist,
// which phase an agent belongs to, whether an agent is live — all projected and
// all tested. What is left here is layout, because there is no DOM harness in
// this repo to prove layout with.
//
// THE RAIL IS `w-60` IN PRODUCTION (240px) and stays `w-60`. Everything here
// fits 240px minus `p-2`, which is why every variable-width child carries
// `min-w-0` + `truncate` and why the chips are `text-[10px]`.
//
// QUIET COLOUR: the tone table lives in `ultra-anchor.tsx` and is imported
// rather than re-derived (ONE mapping table, in one module, never per
// component).
//
// NO BUDGET UI (NFR-UW-7 / AC9), and now no spend readout at all: a run's cost
// is in the pane and in the session's own total, and the same number printed in
// three places is three places for it to disagree.

import { Shimmer } from "@/components/ai-elements/shimmer";
import {
  STATE_LABEL,
  ULTRA_STATE_TONE,
  ULTRA_TONE_CLASS,
} from "@/components/session/ultra-anchor";
import { type AgentRow, type RunSnapshot } from "@/lib/ultra-runs";
import { cn } from "@/lib/utils";

/** AC-U1 — THE `block` TOKEN IS THE WHOLE FIX, and it is not cosmetic.
 *  `Shimmer` hard-codes `relative inline-block` on its root (`shimmer.tsx`), and
 *  an inline-block whose `truncate` forces `white-space: nowrap` is sized by CSS
 *  shrink-to-fit — whose preferred MINIMUM width is the full unwrapped text. So
 *  the box never becomes narrower than its content, `overflow: hidden` never has
 *  anything to clip, and a live agent's label spills clean across the 240px
 *  rail. `block` wins the display group through `cn`'s twMerge, so the box takes
 *  the row's width and `truncate` can do its job.
 *
 *  STILL LOAD-BEARING AFTER THE SIMPLIFICATION. The one-line result snippet this
 *  class was written for is gone from the rail, but the running-agent LABEL that
 *  replaced it is the same hazard in the same 240px column: variable-width text
 *  inside a `Shimmer`, and the running rows are exactly the ones that shimmer.
 *
 *  WHY NOT FIX `shimmer.tsx`: `inline-block` is the correct shared default. The
 *  shimmering overlay is `absolute inset-0` and needs a positioned box with a
 *  real size, and every OTHER call site is either an `as="span"` beside text or
 *  a flex child — where flex blockification neutralises the quirk and the
 *  default is invisible.
 *
 *  RESIDUAL, recorded and not chased: the overlay copy carries no `truncate` of
 *  its own, so at the ellipsis the travelling bright band clips hard instead of
 *  fading into "…". Sub-pixel, and fixing it means changing the shared root. */
export const LIVE_SNIPPET_CLASS = "block min-w-0 truncate text-[10px]";

type Props = {
  /** This session's runs, newest-first, already projected. */
  runs: readonly RunSnapshot[];
  /** The run currently occupying the MAIN PANE, if any — `activeTab`'s run id,
   *  resolved by the owner. The rail never holds its own copy of "what is
   *  open"; it renders the owner's. */
  activeRunId: string | null;
  /** Open this run as a full-pane tab. The rail is the glanceable INDEX; the
   *  detail lives in the pane the index opens. */
  onOpen: (runId: string) => void;
};

export function UltraRail({ runs, activeRunId, onOpen }: Props) {
  if (runs.length === 0) return null;
  const liveCount = runs.filter((r) => r.state === "running").length;
  return (
    <div className="flex flex-col border-b border-border">
      <div className="flex items-center gap-1.5 px-3 py-2">
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
          Workflows
        </span>
        {liveCount > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-1.5 font-mono text-[10px] text-foreground">
            <Shimmer as="span" className="text-[9px] leading-none">
              ●
            </Shimmer>
            {liveCount}
          </span>
        )}
        <span className="ml-auto font-mono text-[10px] text-muted-foreground/60">{runs.length}</span>
      </div>
      <div className="flex max-h-80 flex-col gap-1 overflow-y-auto px-2 pb-2">
        {runs.map((run) => (
          <RunCard
            key={run.runId}
            run={run}
            active={activeRunId === run.runId}
            onOpen={() => onOpen(run.runId)}
          />
        ))}
      </div>
    </div>
  );
}

// ── one run: a name, a state, and who is working ────────────────────────────

function RunCard({
  run,
  active,
  onOpen,
}: {
  run: RunSnapshot;
  active: boolean;
  onOpen: () => void;
}) {
  const tone = ULTRA_STATE_TONE[run.state];
  // The projection already decided which agents are live and which phase each
  // belongs to; the index needs only the flat list of the ones still working.
  const running: AgentRow[] = run.phases.flatMap((p) => p.agents.filter((a) => a.live));
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={active ? "true" : undefined}
      title={`Open ${run.name}`}
      className={cn(
        // THE WHOLE CARD, not a chevron: a 240px rail has no room to spend on
        // aiming, and there is only one thing to do with a run here.
        "flex w-full min-w-0 flex-col gap-1 rounded-md border px-2 py-2 text-left transition-colors hover:bg-muted/60",
        active && "border-primary/40 bg-muted/40",
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span className={cn("shrink-0 text-[10px] leading-none", ULTRA_TONE_CLASS[tone])} aria-hidden>
          ●
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">
          {run.name}
        </span>
        {active && <span className="shrink-0 text-[10px] text-primary">Here</span>}
      </div>
      <div className="flex min-w-0 items-center gap-1.5 pl-3">
        <span className={cn("shrink-0 text-[10px]", ULTRA_TONE_CLASS[tone])}>
          {STATE_LABEL[run.state]}
        </span>
        {running.length > 0 && (
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground/60">
            {running.length} working
          </span>
        )}
      </div>
      {/* WHO IS WORKING — the one detail this index keeps, because it is the
          only thing that changes minute to minute and the only reason to look
          at a running workflow at all. Settled agents are not listed: the pane
          lists them, and a rail that grows a row per finished agent stops being
          glanceable by the end of the first phase. */}
      {running.length > 0 && (
        <div className="flex min-w-0 flex-col gap-0.5 pl-3">
          {running.map((a) => (
            <Shimmer key={a.ordinal} as="div" className={LIVE_SNIPPET_CLASS}>
              {a.label ?? `agent ${a.ordinal}`}
            </Shimmer>
          ))}
        </div>
      )}
    </button>
  );
}
