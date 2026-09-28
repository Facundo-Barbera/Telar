import { BotIcon, ClockIcon, TerminalIcon } from "lucide-react";
import { pluginEnabled, readProjectPlugins, type TurnState } from "@telar/engine-client";
import type { JournalTask, JournalTurn } from "@/platform/engine";
import { insertReference } from "@/features/composer";

const terminal: Record<Exclude<TurnState, "queued" | "claimed" | "running">, string> = {
  completed: "Completed",
  failed: "Failed",
  stopped: "Stopped",
  ambiguous: "Needs recovery decision",
  discarded: "Discarded after recovery decision",
  steering: "Sending into the running turn",
  steered: "Sent into the running turn",
};

// Unpinning clears the override rather than writing "settled", which would shelve the session.
export function pinToggleOverride(settledOverride: "settled" | "active" | null | undefined): "active" | null {
  return settledOverride === "active" ? null : "active";
}

export function describeTurnState(state: TurnState): { label: string; tone: "active" | "done" | "attention" | "danger" | "muted" } {
  if (state === "queued") return { label: "Queued", tone: "active" };
  if (state === "claimed") return { label: "Claimed", tone: "active" };
  if (state === "running") return { label: "Streaming", tone: "active" };
  if (state === "completed") return { label: terminal.completed, tone: "done" };
  if (state === "failed") return { label: terminal.failed, tone: "danger" };
  if (state === "ambiguous") return { label: terminal.ambiguous, tone: "attention" };
  if (state === "stopped") return { label: terminal.stopped, tone: "muted" };
  if (state === "steering") return { label: terminal.steering, tone: "active" };
  if (state === "steered") return { label: terminal.steered, tone: "done" };
  return { label: terminal.discarded, tone: "muted" };
}

export function cockpitPlugins(project: Parameters<typeof readProjectPlugins>[0] | undefined): string[] {
  if (!project) return [];
  const { plugins } = readProjectPlugins(project);
  return Object.keys(plugins.entries)
    .filter((id) => pluginEnabled(plugins, id))
    .sort();
}

/** Appends a menu or panel insert to the draft: a multi-line insert (a quote) is its own paragraph. */
export function appendToDraft(current: string, text: string): string {
  if (!current.trim()) return text;
  return text.includes("\n") ? `${current.replace(/\s+$/, "")}\n\n${text}` : insertReference(current, text, current.length).draft;
}

type RowTurn = Pick<JournalTurn, "runId" | "state" | "held" | "decidedForBackgroundWork" | "askedBy"> & {
  tasks: readonly Pick<JournalTask, "id">[];
};

// Background claims are not rows: each hides behind a host row (its spawner, else the nearest row) that renders its cards.
// A claim with no possible host stays a row so its card still has somewhere to render.
export function transcriptRows<T extends RowTurn>(transcript: readonly T[]): { shown: T[]; hostOf: Map<string, string> } {
  const visible = transcript.filter((turn) => (turn.state !== "queued" || turn.held) && turn.state !== "steering" && turn.state !== "steered");
  const rows = visible.filter((turn) => !turn.decidedForBackgroundWork);
  const hostOf = new Map<string, string>();
  for (const claim of visible) {
    if (!claim.decidedForBackgroundWork) continue;
    const at = visible.indexOf(claim);
    const spawner = claim.askedBy ? rows.find((turn) => turn.tasks.some((task) => task.id === claim.askedBy)) : undefined;
    const before = visible.slice(0, at).reverse().find((turn) => !turn.decidedForBackgroundWork);
    const after = visible.slice(at + 1).find((turn) => !turn.decidedForBackgroundWork);
    const host = spawner ?? before ?? after;
    if (host) hostOf.set(claim.runId, host.runId);
  }
  return { shown: visible.filter((turn) => !turn.decidedForBackgroundWork || !hostOf.has(turn.runId)), hostOf };
}

export function wakeUpLabel(task: JournalTask | undefined): { verb: string; Icon: typeof ClockIcon } {
  if (!task) return { verb: "Woke up on a background task", Icon: ClockIcon };
  const subject = task.kind === "agent" ? (task.role ? `${task.role} agent` : "Sub-agent") : "Background command";
  const Icon = task.kind === "agent" ? BotIcon : TerminalIcon;
  switch (task.state) {
    case "completed":
      return { verb: `${subject} ${task.kind === "agent" ? "finished" : "exited"}`, Icon };
    case "failed":
      return { verb: `${subject} failed`, Icon };
    case "stopped":
      return { verb: `${subject} was stopped`, Icon };
    default:
      return { verb: `${subject} reported`, Icon };
  }
}
