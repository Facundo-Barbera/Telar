// The Workspace surface's chip grammar — a production port of
// lib/demo-gallery/workspace/shared.tsx, FROZEN by ui-contract.md §5. Ported
// rather than imported: demo-gallery components are read-only design source
// and are never wired into a production surface (that directory's own rule
// 7), so every class name here is copied by hand and must be kept in sync by
// eye, not by a shared import.
//
// THE QUIET-COLOR LAW: hue lives on an icon only; chip containers stay neutral
// outlines. VerdictChip's `bg-primary/10` is the one sanctioned exception —
// the app's own semantic-neutral primary tint (components/looms/status.tsx's
// header states the general rule), not a status hue.
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
    <span className="inline-flex shrink-0 items-center rounded border border-border/60 px-1 py-0.5 font-mono text-[9px] text-muted-foreground/60">
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
    <span className="inline-flex shrink-0 items-center rounded-full bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] text-foreground/80">
      → {verdict}
    </span>
  );
}

export function ProjectChip({ name, mirrored }: { name?: string; mirrored?: string }) {
  if (!name) {
    return (
      <span className="inline-flex shrink-0 items-center rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/70">
        floating
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
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
export function WorkspaceTabs({ active }: { active: "chat" | "queue" }) {
  const base = "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs";
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
      <Link href="/workspace" className={cn(base, active === "queue" ? on : off)}>
        <ListTodoIcon className="size-3.5" />
        Queue
      </Link>
    </div>
  );
}
