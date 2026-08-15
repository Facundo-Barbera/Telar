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
import { CheckIcon, CircleDotIcon, WrenchIcon } from "lucide-react";
import type { SpoolDeadline } from "@telar/engine-client";
import { cn } from "@/lib/utils";

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
