/**
 * The Spool's chip grammar — ported from
 * `apps/web_old/components/workspace/chips.tsx`, itself a production port of the
 * demo gallery's `shared.tsx`. FROZEN by `ui-contract.md` §5.
 *
 * THIS IS THE ONE MODULE EVERY SPOOL SURFACE IMPORTS, and that is not tidiness:
 * cross-surface invariant 1 says deadline, verdict, project and provenance
 * render identically on the queue, in a packet, on the desk rail and inside a
 * session. Satisfying it by having ONE definition makes a change here the same
 * change everywhere by construction; satisfying it by care would mean four
 * copies and a promise.
 *
 * "IN SYNC" MEANS THE GRAMMAR, NOT THE CLASS STRINGS. The prototype is the
 * source of GEOMETRY and grammar — which chip is solid, which is dashed, what
 * suffix it carries — never of the radius, type or colour scale. Where the two
 * disagree the app's scale wins.
 *
 * THE QUIET-COLOR LAW: hue lives on an icon only; chip containers stay neutral
 * outlines. The one sanctioned exception was `VerdictChip`'s `bg-primary/10` —
 * the app's own semantic-neutral primary tint rather than a status hue — and it
 * left with the verdict. Nothing here is tinted today.
 */
import { useState } from "react";
import { CheckIcon, CircleDotIcon, PinIcon, WrenchIcon } from "lucide-react";
import type { SpoolDeadline, SpoolPin } from "@telar/engine-client";
import { subjectColorVar } from "@/components/spool/subject-color";
import { formatDay } from "@/lib/spool-today";
import { cn } from "@/lib/utils";

/**
 * A SUBJECT'S IDENTITY DOT — loops §8.2, one definition site like every chip.
 *
 * It paints exactly one thing: the hue the USER gave the subject, through the
 * pure token→var helper — WHOSE, never how urgent. It takes no item, no
 * state and no date, so it cannot be recruited as a status light; absent or
 * unknown renders the helper's neutral grey, because an uncoloured subject is
 * an ordinary subject. Slightly larger than the 1.5 `bg-spool` room mark
 * (identity must be tellable from the band mark at a glance) and never more:
 * a dot, not a badge.
 */
export function SubjectDot({ color, className }: { color?: string | null; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("size-2 shrink-0 rounded-full", className)}
      style={{ backgroundColor: subjectColorVar(color) }}
    />
  );
}

/**
 * THE CHECKBOX — `docs/spool-loops.md` §9, the hand's own close, one
 * definition site like every piece of the grammar so it renders identically
 * on a stance row, a board card, a calendar line and the packet face.
 *
 * ROUND, because the app's feel is rounded and the gesture it copies is
 * Reminders': click, it's done. ONE GESTURE — the click calls `onToggle`
 * directly; no dialog, no confirmation, because §9.2 says "bureaucracy after
 * a checkbox is how trackers die" and closing is idempotent and reversible.
 * The tick paints OPTIMISTICALLY (local state, replaced when the snapshot
 * reloads and the row leaves the active slice) so the hand sees the mark the
 * instant it moves.
 *
 * QUIET BY LAW: the ring is a hairline, the tick is the neutral foreground —
 * no state hue, no fill from the tint vocabulary. Done is a fact, not an
 * alarm, and neither is not-done.
 */
export function CloseCheckbox({
  closed,
  label,
  onToggle,
  className,
}: {
  closed: boolean;
  /** Accessible name — "Close “Call María”" / "Reopen “Call María”". */
  label: string;
  onToggle: () => void;
  className?: string;
}) {
  const [ticked, setTicked] = useState(closed);
  // Derived-state adjustment, render-phase (the React-documented pattern):
  // when the store's own answer arrives via props, it wins over the optimism.
  const [wasClosed, setWasClosed] = useState(closed);
  if (closed !== wasClosed) {
    setWasClosed(closed);
    setTicked(closed);
  }
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={ticked}
      aria-label={label}
      title={label}
      onClick={(event) => {
        // The row behind this is usually a click target of its own — the tick
        // must not also open the packet.
        event.stopPropagation();
        setTicked((t) => !t);
        onToggle();
      }}
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-full border outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        ticked ? "border-foreground/50" : "border-border hover:border-foreground/40",
        className,
      )}
    >
      {ticked && <CheckIcon className="size-3 text-foreground" aria-hidden />}
    </button>
  );
}

/**
 * THE SELECTION HOTSPOT — loops §10's selection model, one definition site
 * like every piece of the grammar so a stance row, a board card and a Done
 * row cannot drift apart.
 *
 * SQUARE WHERE THE CLOSE CHECKBOX IS ROUND — the two gestures must be
 * tellable apart at a glance, because they mean opposite ends of a verb:
 * the round tick IS the close (one gesture, §9.2), the square only GATHERS.
 * It renders exclusively while Select mode is up, so the ordinary room keeps
 * the checkbox as the row's one tick target and the two never compete for
 * the same click. Shift rides the click for range — the browser's own list
 * grammar — and is read here, once, for every surface.
 *
 * SELECTING WRITES NOTHING. This control touches no route; the action bar's
 * verbs are where the store is reached, and clearing a selection undoes
 * nothing because nothing was done.
 */
export function SelectHotspot({
  selected,
  label,
  onToggle,
  className,
}: {
  selected: boolean;
  /** Accessible name — "Select “Call María”". */
  label: string;
  onToggle: (shiftKey: boolean) => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={selected}
      aria-label={label}
      title={label}
      onClick={(event) => {
        // The row behind is a click target of its own — gathering must not
        // also open the packet.
        event.stopPropagation();
        onToggle(event.shiftKey);
      }}
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-[4px] border outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        selected ? "border-foreground/60 bg-muted" : "border-border hover:border-foreground/40",
        className,
      )}
    >
      {selected && <CheckIcon className="size-3 text-foreground" aria-hidden />}
    </button>
  );
}

/** A tool-use pill, the way agent surfaces render calls elsewhere in the app. */
export function ToolPill({ call }: { call: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/30 px-2.5 py-1 font-mono text-[10px] text-muted-foreground">
      <WrenchIcon className="size-3" />
      {call}
      <CheckIcon className="size-3 text-muted-foreground/60" />
    </span>
  );
}

/** v1 has no integration enum — provenance is whatever free-form label describes
 *  how the thing got in. Plain text, no icon set, nothing to switch on. */
export function ProvenanceTag({ label }: { label: string }) {
  return (
    <span className="inline-flex shrink-0 items-center rounded-md border border-border/70 px-1 py-0.5 font-mono text-[10px] text-muted-foreground/60">
      {label}
    </span>
  );
}

/**
 * Deadlines are data with provenance: external ones render solid, self-imposed
 * ones dashed — and a self-deadline that slid carries its count.
 *
 * A WITNESS, NEVER AN ALARM. Nothing compares this label to a clock, nothing
 * counts down, and nothing fires. The slip count is durable so the master can
 * say "you told yourself Friday, and it has slid twice" — which is a question,
 * not a notification.
 */
export function DeadlineChip({ deadline }: { deadline: SpoolDeadline }) {
  const self = deadline.kind === "self";
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground",
        self ? "border-dashed border-border" : "border-border bg-muted/40",
      )}
    >
      {deadline.label}
      {self && (
        <span className="text-muted-foreground/60">
          · self{deadline.slips ? ` · slid ×${deadline.slips}` : ""}
        </span>
      )}
    </span>
  );
}

/**
 * A PIN — the user's own day for an item, worn as a chip. §3.2 as amended
 * (2026-08-16): drawing a date the user stated is QUOTING, not shouting, so
 * the chip renders `formatDay`'s pure format of the stored `YYYY-MM-DD` and
 * nothing else — no countdown, no age, no state colour, whichever side of
 * today the day sits on.
 */
export function PinChip({ pinned }: { pinned: SpoolPin }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
      <PinIcon className="size-2.5 text-muted-foreground/60" />
      {formatDay(pinned.day)}
    </span>
  );
}

/** ABSENT IS `floating`, and floating is a valid resting state rather than a
 *  missing value — which is why this renders a word instead of nothing. */
export function ProjectChip({ name, mirrored }: { name?: string; mirrored?: string }) {
  if (!name) {
    return (
      <span className="inline-flex shrink-0 items-center rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/70">
        floating
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
      {name}
      {mirrored && (
        <span className="flex items-center gap-0.5 text-muted-foreground/60">
          <CircleDotIcon className="size-2.5" />
          {mirrored}
        </span>
      )}
    </span>
  );
}

// ── WHAT IS NOT HERE, AND WHY ───────────────────────────────────────────────
//
// TWO CHIPS FROM THE FROZEN GRAMMAR ARE MISSING, and both name a loom:
//
//   · `VerdictChip` rendered the expert's triage as `→ session` / `→ loom`, in
//     the one sanctioned tinted container. Half of what it could say names a
//     thing this app cannot do.
//   · `TrackingChip` rendered the sent-to-loom mark — how a woven row says it is
//     out at a loom WITHOUT saying it is done. It used `--info` and never
//     `--success`, deliberately: a green tick there would read as the acceptance
//     only a human can give.
//
// Cross-surface invariant 1 says these render identically on every surface. That
// is still true — they render on none. When looms land, both come back HERE and
// nowhere else, or the invariant turns from a property into a promise.
