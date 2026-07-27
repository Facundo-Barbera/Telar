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
// AD-12: THE RENDERER IS A PURE FUNCTION OF `(payload, view)` AND READS NOTHING
// ELSE. No fetch, no EventSource, no context, no sessionId. Every run figure
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
//     why in one grep.
//   - the sliver is a fraction of DECLARED PHASES and is absent when the script
//     declared none. Never an indeterminate bar, never a pulse.
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
  anchorForm,
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

// The two Tailwind expressions duplicated from `components/looms/status.tsx`'s
// `TONE_ICON`, for the reason in the header. `text-*-300` is DARK-ONLY and light
// mode is real here, so these are the `text-X-600 dark:text-X-400` pairs the
// original defines — the demo gallery is dark-only throughout and copying its
// classes ships a light-mode bug.
export const ULTRA_TONE_CLASS: Record<UltraTone, string> = {
  done: "text-emerald-600 dark:text-emerald-400",
  attention: "text-amber-600 dark:text-amber-400",
  danger: "text-destructive",
  // NEUTRAL, and that is the law rather than a palette choice: active work gets
  // a neutral spinner, never a saturated hue.
  active: "text-foreground",
};

const STATE_LABEL: Record<UltraRunState, string> = {
  running: "running",
  done: "done",
  failed: "failed",
  stopped: "stopped",
};

/** Stops a control's click from reaching the anchor's own focus handler.
 *  §5.6-T19 item 14: DO NOT NEST INTERACTIVES. The demo's anchor is a `<button>`
 *  containing a `<span role="button">`; this container is a plain div carrying
 *  `role="button"` and the two controls inside it are real `<button>`s. */
const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

export const ultraRunAnchorKind: ItemKind<UltraAnchorPayload> = {
  id: ULTRA_ANCHOR_KIND,
  render: (payload, view) => {
    const { run, provider, onFocus, onStop, onResume, busy } = payload;
    const form = anchorForm(run);
    const tone = ULTRA_STATE_TONE[run.state];
    const spend = anchorSpend(provider, run.spendUsd);
    // AC5 proof 1 — the Resume affordance appears for `stopped` and `failed` and
    // NOT for `done`. THAT IS A UI RULE, NOT A CORE RULE: `resumeUltraRun` does
    // not gate on state and will happily resume a `done` run and re-fire its
    // wake. Stated here so the next reader does not "fix" the UI to match the
    // port.
    const canResume = run.state === "stopped" || run.state === "failed";
    const canStop = run.state === "running";
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
              `STATE_STYLE` is the thing not to copy. */}
          <span className="shrink-0 rounded border px-1 py-0 text-[10px] text-muted-foreground">
            {STATE_LABEL[run.state]}
          </span>
          {/* AC11 proof 3 — `N done` and NO DENOMINATOR. A denominator would
              have to be invented, and `ultra_status`'s `total` is a count of
              SETTLED agents, so `done/total` through that lens is always 1.0. */}
          <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
            {run.agentsDone} done
          </span>
          <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums" title={spend.title}>
            {spend.text}
          </span>
          {canStop && (
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
          {canResume && (
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
            mid-stream animates the WHOLE transcript (NFR-UW-11). */}
        {form === "running" && (
          <div className="flex min-w-0 flex-col gap-1">
            <div className="min-w-0 truncate text-[11px] text-muted-foreground">
              {run.narrator.at(-1) ?? (run.pending ? "Launching…" : " ")}
            </div>
            {/* THE PHASE SLIVER — a fraction of DECLARED PHASES, never of money
                and never of agents. `Progress` is not used: it auto-renders its
                own track and indicator after `children` and its root adds
                `gap-3`, and it would read as a budget meter, which AC9 forbids.
                Two divs, one pixel. Absent entirely when the script declared no
                phases. */}
            {run.progress && (
              <div className="h-px w-full overflow-hidden bg-border" aria-hidden>
                <div
                  className="h-px bg-muted-foreground/60 transition-all duration-500 ease-out"
                  style={{
                    width: `${Math.round((run.progress.seen / run.progress.declared) * 100)}%`,
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
        {form === "terminal" && run.error && (
          <div className="flex min-w-0 items-center gap-1 text-[11px] text-destructive">
            <TriangleAlertIcon className="size-3 shrink-0" />
            <span className="min-w-0 truncate">{run.error}</span>
          </div>
        )}
        {/* `view` is part of the renderer contract and this leaf kind has no
            nested items and no disclosure state of its own — the anchor is
            fixed-height by AC2, so there is nothing to expand. Referenced so the
            signature stays honest rather than silently unused. */}
        {view.live && null}
      </div>
    );
  },
};
