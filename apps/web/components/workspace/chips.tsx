// The Workspace surface's chip grammar — a production port of
// lib/demo-gallery/workspace/shared.tsx, FROZEN by ui-contract.md §5. Ported
// rather than imported: demo-gallery components are read-only design source
// and are never wired into a production surface (that directory's own rule
// 7), so every class name here is copied by hand rather than by a shared
// import.
//
// "IN SYNC" MEANS THE GRAMMAR, NOT THE CLASS STRINGS, and after the token sweep
// below it can only mean that: the demo still reads `rounded border-border/60
// text-[9px]` where this file reads `rounded-md border-border/70 text-[10px]`.
// That is not drift to be repaired — the prototype is the source of GEOMETRY
// and grammar (which chip is solid, which is dashed, what suffix it carries),
// never of the radius, type or colour scale, and where the two disagree the
// app's scale wins. Re-porting a chip means re-reading the demo for its shape
// and then spelling it in the app's vocabulary.
//
// THE QUIET-COLOR LAW: hue lives on an icon only; chip containers stay neutral
// outlines. VerdictChip's `bg-primary/10` is the one sanctioned exception —
// the app's own semantic-neutral primary tint (components/looms/status.tsx's
// header states the general rule), not a status hue.
//
// TOKEN SWEEP (this pass): the GRAMMAR is frozen — which chip renders solid vs
// dashed, which suffix it carries, what `floating` means — and none of it
// moved. What moved is the SCALE the grammar is drawn on, to the app's token
// idiom: bare `rounded` (an off-scale 0.25rem the demo source used) became
// `rounded-md`, the 9px provenance label became `text-[10px]` (the app's
// smallest mono step), `border-border/60` became `border-border/70` (the
// documented internal-divider step) and `text-foreground/80` became
// `text-foreground`. Every chip still renders identically on every surface,
// which is the invariant ui-contract.md §"Cross-surface invariants" 1 protects
// — it is satisfied by this being the ONE module all of them import, so a
// scale change here is by construction the same change everywhere.
import Link from "next/link";
import {
  CheckIcon,
  CircleDotIcon,
  ListTodoIcon,
  MessageSquareIcon,
  WrenchIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { Deadline, ItemVerdict } from "@telar/core";

// A tool-use pill, the way agent surfaces render calls elsewhere in the app.
export function ToolPill({ call }: { call: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/30 px-2.5 py-1 font-mono text-[10px] text-muted-foreground">
      <WrenchIcon className="size-3" />
      {call}
      <CheckIcon className="size-3 text-muted-foreground/60" />
    </span>
  );
}

// v1 has no integration enum — provenance is whatever free-form label
// describes how the thing got in (NFR-OW-12). Plain text, no icon set.
export function ProvenanceTag({ label }: { label: string }) {
  return (
    <span className="inline-flex shrink-0 items-center rounded-md border border-border/70 px-1 py-0.5 font-mono text-[10px] text-muted-foreground/60">
      {label}
    </span>
  );
}

// Deadlines are data with provenance: external ones render solid, self-imposed
// ones dashed — and a self-deadline that slid carries its count (a witness,
// never an alarm — NFR-OW-11 bans comparing or scheduling on it).
export function DeadlineChip({ deadline }: { deadline: Deadline }) {
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

// Expert triage verdict — where this item should be executed. Advisory only
// (item-model.md: "informs the handoff choice, does not perform it").
export function VerdictChip({ verdict }: { verdict: ItemVerdict }) {
  return (
    <span className="inline-flex shrink-0 items-center rounded-full bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] text-foreground">
      → {verdict}
    </span>
  );
}

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

// The Workspace surface's internal nav: chat is the front door (story 5.3),
// the queue is the drawer behind it. "chat" has no page to link to yet, so it
// renders inert rather than as a dead link — a real href would be a promise
// this story does not keep.
// The segmented control's geometry is the demo's; the STATES are the app's —
// `transition-colors` + `hover:bg-muted/60` is the hover convention every
// reference surface uses (ultra-rail's RunCard/DoneRow, subagent-rail's rows),
// and the active tab carries `aria-current` so the treatment is not the only
// thing announcing it.
export function WorkspaceTabs({ active }: { active: "chat" | "queue" }) {
  const base =
    "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors";
  const on = "bg-muted font-medium text-foreground";
  const off = "text-muted-foreground";
  return (
    <div className="flex items-center gap-0.5 rounded-lg border border-border p-0.5">
      <span
        aria-disabled="true"
        title="Chat arrives in a later story"
        className={cn(base, active === "chat" ? on : off, "cursor-not-allowed opacity-60")}
      >
        <MessageSquareIcon className="size-3.5" />
        Chat
      </span>
      <Link
        href="/workspace"
        aria-current={active === "queue" ? "page" : undefined}
        className={cn(
          base,
          active === "queue" ? on : cn(off, "hover:bg-muted/60 hover:text-foreground"),
        )}
      >
        <ListTodoIcon className="size-3.5" />
        Queue
      </Link>
    </div>
  );
}
