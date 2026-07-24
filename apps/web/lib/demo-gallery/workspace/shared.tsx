// LANE: workspace (CONCEPT) — tiny shared chips for the three mockups.
// Follows the app's quiet-color law: hue lives on the icon only, chips stay
// neutral outlines (see components/looms/status.tsx for the production rule).
import {
  CheckIcon,
  CircleDotIcon,
  ListTodoIcon,
  MessageSquareIcon,
  WrenchIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { WsDeadline } from "./fixtures";

// A tool-use pill, the way agent surfaces render calls: quiet, mono, done-check.
// Shared by the master chat and the session mockup — the master reads external
// sources (Linear, whatever the workspace's MCP roster holds) the same way a
// session reads the task store.
export function ToolPill({ call }: { call: string }) {
  return (
    <div className="flex justify-start pl-9">
      <span className="flex items-center gap-1.5 rounded-full border border-border bg-muted/30 px-2.5 py-1 font-mono text-[10px] text-muted-foreground">
        <WrenchIcon className="size-3" />
        {call}
        <CheckIcon className="size-3 text-muted-foreground/60" />
      </span>
    </div>
  );
}

// v1 has no integration enum — provenance is whatever label describes how the
// thing got in ("note", "pasted transcript", "chat"). Plain text, no icon set.
export function ProvenanceTag({ label }: { label: string }) {
  return (
    <span className="inline-flex shrink-0 items-center rounded border border-border/60 px-1 py-0.5 font-mono text-[9px] text-muted-foreground/60">
      {label}
    </span>
  );
}

// Deadlines are data with provenance: external ones render solid, self-imposed
// ones dashed — and self-deadlines that slid carry their count (the witness,
// not an alarm).
export function DeadlineChip({ deadline }: { deadline: WsDeadline }) {
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

// Expert triage verdict — where this item should be executed.
export function VerdictChip({ verdict }: { verdict: "session" | "loom" }) {
  return (
    <span className="inline-flex shrink-0 items-center rounded-full bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] text-foreground/80">
      → {verdict}
    </span>
  );
}

export function ProjectChip({
  name,
  mirrored,
}: {
  name?: string;
  mirrored?: string;
}) {
  if (!name)
    return (
      <span className="inline-flex shrink-0 items-center rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/70">
        floating
      </span>
    );
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

// The Workspace surface's internal nav: chat is the front door, the queue is
// the drawer behind it. One surface, two tabs — how the "other elements" are
// reached without the queue pretending to be a top-level destination.
export function WorkspaceTabs({ active }: { active: "chat" | "queue" }) {
  const tab = (key: "chat" | "queue", label: string, Icon: typeof ListTodoIcon) => (
    <span
      className={cn(
        "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs",
        active === key
          ? "bg-muted font-medium text-foreground"
          : "text-muted-foreground",
      )}
    >
      <Icon className="size-3.5" />
      {label}
    </span>
  );
  return (
    <div className="flex items-center gap-0.5 rounded-lg border border-border p-0.5">
      {tab("chat", "Chat", MessageSquareIcon)}
      {tab("queue", "Queue", ListTodoIcon)}
    </div>
  );
}
