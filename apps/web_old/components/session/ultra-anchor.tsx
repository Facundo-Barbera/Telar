"use client";

// Story 4.2 — THE `ultra:run-anchor` ITEM KIND.
//
// A run is a SIDE QUEST, NOT A WINDOW (`ui-contract.md` §2): one compact
// fixed-height tool-style row in the transcript, with the conversation
// continuing beneath it. "Tool-style" is a claim about `tool-step.tsx`'s visual
// register — the bordered card, the truncating one-line detail, the 92% reading
// column — and NOT a licence to render the run as a tool call.
//
// ────────────────────────────────────────────────────────────────────────────
// WHY THE RENDERER IS WRITTEN INLINE, IN THIS EXACT DECLARATION SHAPE. This is
// load-bearing and there are FOUR ways to get it wrong, all of which compile and
// three of which leave the guard GREEN.
//
// `packages/core/test/invariants.test.ts`'s INV-8b2 proves a registered kind's
// renderer reads nothing from ambient context (AD-12's purity rule). It does so
// by extracting the renderer's source with a BRACE MATCH from a
// `: ItemKind<…> = {` declaration. So:
//
//   1. `render: someTopLevelFn` — the brace match ends at the object literal, so
//      the slice holds no hook-call text at all, `ambientContextScan` returns []
//      and the invariant passes over the exact violation it exists to catch.
//      NOT HYPOTHETICAL: `renderAgentBucket`, the top-level function story 3.1
//      deleted, was precisely that shape.
//   2. `const k: ItemKind = { … }` — the extractor's pattern requires the
//      GENERIC `<`, so a bare annotation yields NO SLICE AT ALL.
//   3. `const k = { … } satisfies ItemKind<P>` — no `: ItemKind<` annotation
//      exists, so likewise no slice.
//   4. A file INV-8b2 does not scan. Its slices came from ONE file
//      (`session-view.tsx`); story 4.2 widened that set to include THIS file,
//      with a floor naming both kinds and a two-direction discriminator.
//
// Three of those four leave INV-8b2 green rather than red, because its
// anti-vacuity floor is satisfied by the existing `agentBucketKind` slice. A
// SILENT REMOVAL FROM AD-12 ENFORCEMENT is the failure mode, not a build break.
// So: `export const ultraRunAnchorKind: ItemKind<UltraAnchorPayload> = {` with
// the renderer INLINE, in this file, which INV-8b2 now scans — and INV-10 pins
// that this file declares exactly one kind.
// ────────────────────────────────────────────────────────────────────────────
//
// AD-12: THE RENDERER IS A PURE FUNCTION OF ITS ARGUMENTS AND READS NOTHING
// ELSE. `ItemRenderer` is `(payload, view) => ReactNode`; this leaf kind takes
// the PAYLOAD ALONE, because it has no nested items and no disclosure state, and
// a function of fewer parameters is assignable to that type.
// No fetch, no EventSource, no context, no sessionId. Every run figure
// arrives pre-projected in the payload, which `session-view.tsx` builds from
// `use-ultra-runs.ts`. The architecture's own adversarial review (finding A3)
// found the failure this prevents: a kind that reads live state from a React
// context can only render inside the adapter that provides it, so a transcript
// holding two such kinds can render neither.
//
// NO PLACEBO (hard rule 3). Everything rendered here has a source:
//   - `N done` and NO DENOMINATOR — nothing knows how many agents a script will
//     spawn, so `agentsTotal` is typed `undefined` and the denominator is simply
//     not drawn. That is a DECISION, not an oversight; `lib/ultra-runs.ts` says
//     why in one grep. AND NO NUMERATOR EITHER until the journal has been read:
//     `agentsDone` is ABSENT — not `0` — for a run this page has only ever seen
//     a manifest of (review round 1, B1).
//   - the sliver is a fraction of DECLARED PHASES and draws NOTHING when the
//     script declared none. Never an indeterminate bar, never a pulse. Its ROW is
//     reserved in the running form so its arrival cannot change the anchor's
//     height (AC2, review round 1, SF-5); its INK is not.
//   - the spend goes through `anchorSpend` → `spendReadout`. NO BUDGET UI
//     ANYWHERE (NFR-UW-7 / AC9): no meter, no ceiling, no percentage, no
//     reserved headroom.
//
// QUIET COLOUR (UX-DR10 / UX-DR11 / NFR-LR-24). Neutral outline card; hue on the
// ICON only; a NEUTRAL SPINNER for the running state, never a saturated pill.
// The demo gallery violates this throughout (`bg-sky-500/10 text-sky-300`,
// `border-indigo-500/25`, `animate-pulse`) — port its geometry, not its palette.
//
// ON NOT IMPORTING `components/looms/status.tsx`. `statusVisual`/`StatusBadge`
// take `GodStatusKind`/`WorkUnitState` — loom DOMAIN types — and an Ultra run
// state is neither; mapping one onto the other would make `stopped` render as
// somebody's `halted`. `TONE_ICON` is domain-free, but `components/session/**`
// has ZERO imports from `components/looms/**` today, and story 3.1 declined the
// identical import for `Marker` on the ground that it points a general surface at
// a domain module — recording instead that the right fix is lifting the tone
// tokens somewhere Track-neutral. This file follows that precedent: it honours
// the law, duplicates two Tailwind expressions, and joins the same recorded item.

import { Loader2Icon, PlayIcon, SquareIcon, TriangleAlertIcon, WorkflowIcon } from "lucide-react";
import type { ItemKind } from "@/components/conversation/registry";
import {
  ULTRA_ANCHOR_KIND,
  anchorControls,
  anchorShape,
  anchorSpend,
  type UltraAnchorPayload,
  type UltraRunState,
} from "@/lib/ultra-runs";
import { cn } from "@/lib/utils";

// ONE MAPPING TABLE, IN ONE MODULE, NEVER PER COMPONENT (§5.6-T19's closing
// paragraph). The rail and the dock read the same table.
//
// `stopped` is `attention` and NOT `danger`, deliberately: it is the state that
// grows a Resume affordance and is therefore waiting on a human, which is what
// `attention` means everywhere else in this app — and it keeps `danger`
// exclusively for a real failure, which the quiet-colour law's own parenthetical
// ("and, for a real failure, the label") depends on.
export type UltraTone = "done" | "attention" | "danger" | "active";

export const ULTRA_STATE_TONE: Record<UltraRunState, UltraTone> = {
  running: "active",
  done: "done",
  failed: "danger",
  stopped: "attention",
};

// The two expressions duplicated from `components/looms/status.tsx`'s
// `TONE_ICON`, for the reason in the header, now spelled with the shared
// state-token vocabulary (`--success` / `--warning`) rather than raw Tailwind
// ramps — the tokens already adapt to dark mode, so the `dark:` fork this
// pairing used to need collapses to a single class.
export const ULTRA_TONE_CLASS: Record<UltraTone, string> = {
  done: "text-success",
  attention: "text-warning",
  danger: "text-destructive",
  // NEUTRAL, and that is the law rather than a palette choice: active work gets
  // a neutral spinner, never a saturated hue.
  active: "text-foreground",
};

// Exported for the full-pane tab, which needs the SAME four-state vocabulary.
// `subagent-rail.tsx`'s `RailStatus` is three states (running|done|error) and
// has no honest home for `stopped` — reusing it there would silently read a
// stopped run as done or as a failure.
export const STATE_LABEL: Record<UltraRunState, string> = {
  running: "running",
  done: "done",
  failed: "failed",
  // "cancelled", NOT "stopped" (owner ruling). The core state name stays
  // `stopped` — this is the projection's word for it, and the two need not
  // match. What a human wants to know is that the run ended because someone
  // ended it, which is categorically different from the failure it used to be
  // reported as (see signals.ts's isAbortError for the other half of that fix).
  stopped: "cancelled",
};

/** Stops a control's click from reaching the anchor's own focus handler.
 *  §5.6-T19 item 14: DO NOT NEST INTERACTIVES. The demo's anchor is a `<button>`
 *  containing a `<span role="button">`; this container is a plain div carrying
 *  `role="button"` and the two controls inside it are real `<button>`s. */
const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

export const ultraRunAnchorKind: ItemKind<UltraAnchorPayload> = {
  id: ULTRA_ANCHOR_KIND,
  render: (payload) => {
    const { run, provider, onFocus, onStop, onResume, busy } = payload;
    // THE WHOLE SHAPE, from one function the projection tests can drive (AC2,
    // widened in review round 1). Nothing below branches on anything else that
    // changes the anchor's height.
    const shape = anchorShape(run);
    // AC5 proof 1's two affordance rules — and B2's `!pending` term with them —
    // now live in `anchorControls`, under the same tests as everything else this
    // file used to decide for itself. A control's existence is a decision, and a
    // decision that lives in a component ships unproven. They are SEPARATE from
    // `anchorShape` because these two buttons sit in a non-wrapping flex row, so
    // they change the anchor's width and never its height — and AC2's proof must
    // not have to be told which of its own fields to ignore.
    const controls = anchorControls(run);
    const tone = ULTRA_STATE_TONE[run.state];
    const spend = anchorSpend(provider, run.spendUsd);
    // AC5 proof 6 — the state rendered is the MANIFEST's, never an optimistic
    // local one. The agent can stop a run by tool call
    // (`mcp__ultra__ultra_stop`), and a button that optimistically set local
    // state and stopped listening would show a stale `running` for every
    // agent-initiated stop. `busy` disables the affordances between the click
    // and the next snapshot; it never fakes the state itself.
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={onFocus}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onFocus();
          }
        }}
        // `max-w-[92%]` is the one number worth carrying from the demo's
        // `ToolCard`: it is what makes this read as tool-style rather than as a
        // full-width panel. It is measured against the assistant bubble's
        // reading column because the anchor is a NESTED item, rendered through
        // the turn kind's `view.render(child)`.
        className={cn(
          "flex w-full max-w-[92%] cursor-pointer flex-col gap-1 rounded-lg border px-2 py-1.5 text-left",
          // The terminal collapse is a `transition-*`, NOT an `animate-in`:
          // every `animate-in`/`animate-out` utility is globally neutered in
          // this app's CSS (`globals.css`). `SubagentCard`'s mount transition is
          // the shipped precedent and this is its shape.
          "transition-colors duration-300 ease-out hover:bg-muted/40",
          "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
        )}
      >
        {/* ROW 1 — always present, and its content never wraps. */}
        <div className="flex min-w-0 items-center gap-1.5 text-xs">
          {run.state === "running" ? (
            <Loader2Icon className={cn("size-3.5 shrink-0 animate-spin", ULTRA_TONE_CLASS.active)} />
          ) : (
            <WorkflowIcon className={cn("size-3.5 shrink-0", ULTRA_TONE_CLASS[tone])} />
          )}
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] font-medium text-foreground">
            {run.name}
          </span>
          {/* A NEUTRAL OUTLINE, never a saturated fill. The gallery's
              `STATE_STYLE` is the thing not to copy.

              A PENDING RUN SAYS `launching`, NOT `running` (review B2). The
              badge is a claim about the run, and until the manifest lands this
              reader has no such claim to make — `pending` is the only thing it
              actually knows, and it is what the detail row below already says
              in its own words. */}
          <span className="shrink-0 rounded border px-1 py-0 text-[10px] text-muted-foreground">
            {run.pending ? "launching" : STATE_LABEL[run.state]}
          </span>
          {/* AC11 proof 3 — `N done` and NO DENOMINATOR. A denominator would
              have to be invented, and `ultra_status`'s `total` is a count of
              SETTLED agents, so `done/total` through that lens is always 1.0.

              AND NO NUMERATOR EITHER until the journal has been read (review
              B1). `agentsDone` is ABSENT — not zero — for a run this page has
              only ever seen a manifest of, because the manifest does not know.
              `0 done` for a run that settled five agents is the same fabricated
              figure the missing denominator refuses, pointed the other way. */}
          {run.agentsDone !== undefined && (
            <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
              {run.agentsDone} done
            </span>
          )}
          <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums" title={spend.title}>
            {spend.text}
          </span>
          {controls.canStop && (
            <button
              type="button"
              disabled={busy}
              onClick={(e) => {
                stop(e);
                onStop();
              }}
              className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
              title="Stop this run"
            >
              <SquareIcon className="size-3" />
            </button>
          )}
          {controls.canResume && (
            <button
              type="button"
              disabled={busy}
              onClick={(e) => {
                stop(e);
                onResume();
              }}
              className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
              title="Resume this run from its journal"
            >
              <PlayIcon className="size-3" />
            </button>
          )}
        </div>

        {/* ROW 2 — THE ONE PERMITTED HEIGHT CHANGE (AC2). It exists while
            running and is dropped exactly once, at terminal. There is no
            conditional row inside it and no list that grows with tick count, so
            the running form does not reflow as ticks arrive — which matters
            mechanically: `components/ai-elements/conversation.tsx` configures
            `StickToBottom` with `resize="smooth"`, so anything that grows
            mid-stream animates the WHOLE transcript (NFR-UW-11).
            "No conditional row inside it" was a CLAIM and not a fact until
            review round 1: the sliver below was conditional, and SF-5 is what it
            cost. It is now reserved. */}
        {shape.detail && (
          <div className="flex min-w-0 flex-col gap-1">
            <div className="min-w-0 truncate text-[11px] text-muted-foreground">
              {run.narrator.at(-1) ?? (run.pending ? "Launching…" : " ")}
            </div>
            {/* THE PHASE SLIVER — a fraction of DECLARED PHASES, never of money
                and never of agents. `Progress` is not used: it auto-renders its
                own track and indicator after `children` and its root adds
                `gap-3`, and it would read as a budget meter, which AC9 forbids.
                Two divs, one pixel.

                ITS ROW IS RESERVED AND ITS INK IS NOT (review round 1, SF-5).
                Drawing the track only when `run.progress` existed made the
                anchor GROW MID-RUN: `progress` is undefined for D8's pending
                payload and becomes defined when the first manifest lands, so
                `gap-1` + `h-px` = 5px arrived while running — a second height
                change AC2 forbids, and one the old `anchorForm` was
                structurally blind to because it read `state` alone.
                Reserved-and-invisible is what keeps BOTH rules: AC2 gets a
                constant running height, and AC11 proof 4 still gets "no sliver
                at all when the script declared no phases", because `opacity-0`
                draws nothing — no indeterminate bar, and no 0% pretending to be
                a measurement. */}
            {shape.sliver && (
              <div
                className={cn(
                  "h-px w-full overflow-hidden bg-border",
                  run.progress === undefined && "opacity-0",
                )}
                aria-hidden
              >
                <div
                  className="h-px bg-muted-foreground/60 transition-all duration-500 ease-out"
                  style={{
                    width: run.progress
                      ? `${Math.round((run.progress.seen / run.progress.declared) * 100)}%`
                      : "0%",
                  }}
                />
              </div>
            )}
          </div>
        )}

        {/* AC5 proof 4 — `failed` shows its terse terminal error, one line,
            truncated. It is present only on non-`done` runs, and it is part of
            the TERMINAL form, so it replaces the detail row rather than adding
            to it. */}
        {shape.errorRow && (
          <div className="flex min-w-0 items-center gap-1 text-[11px] text-destructive">
            <TriangleAlertIcon className="size-3 shrink-0" />
            <span className="min-w-0 truncate">{run.error}</span>
          </div>
        )}
        {/* `ItemRenderer` is `(payload, view) => ReactNode` and this renderer
            takes ONE argument, deliberately: a leaf kind with no nested items
            and no disclosure state of its own has nothing to do with `view`, and
            a function of fewer parameters is assignable to that type. The
            previous version referenced it as `{view.live && null}` — an
            expression that renders nothing in EITHER branch, which is dead
            scaffolding rather than an honest signature (review NH-2). */}
      </div>
    );
  },
};
