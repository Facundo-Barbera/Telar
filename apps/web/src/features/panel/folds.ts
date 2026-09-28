import type { BrowserSnapshot, EngineEvent, Item, Task, TaskState } from "@telar/engine-client";
import type { JournalTask } from "@/platform/engine";
import { browserScopeKey, LIVE_BROWSER_TAB, type BrowserState } from "./model";
import type { PanelTabInstance } from "./tabs";

/** Path → how many times the journal says this session wrote it. Keyed as the tool wrote it, usually absolute. */
export function journalWrites(items: readonly Item[]): Map<string, number> {
  const writes = new Map<string, number>();
  for (const item of items) {
    if (item.detail.type !== "file_change") continue;
    if (item.status === "declined" || item.status === "failed") continue;
    const path = item.detail.change.path;
    writes.set(path, (writes.get(path) ?? 0) + 1);
  }
  return writes;
}

export type BrowserStartState = { status: "idle" } | { status: "pending" } | { status: "error"; message: string };

export function describeBrowserStart(snapshot: Pick<BrowserSnapshot, "tabs" | "error" | "running">): BrowserStartState {
  if (snapshot.error) return { status: "error", message: snapshot.error };
  if (snapshot.tabs.length === 0) {
    return { status: "error", message: snapshot.running ? "The browser started but opened no page." : "The browser did not start." };
  }
  return { status: "idle" };
}

/** `browser.state.changed` carries the whole tab set, so folding it is a replace. */
export function latestBrowserState(events: readonly EngineEvent[]): BrowserState | undefined {
  let state: BrowserState | undefined;
  for (const event of events) {
    if (event.type === "browser.state.changed") state = { provider: event.provider, tabs: event.tabs };
  }
  return state;
}

/**
 * Has the agent driven the browser since `since`, past event id `after`? `since` keeps a replayed journal
 * from reopening a tab the person closed; only a completed browser call counts, never a refusal.
 */
export function agentBrowserActivity(events: readonly EngineEvent[], since: number, after: number): { acted: boolean; through: number } {
  let acted = false;
  let through = after;
  for (const event of events) {
    if (event.at < since || event.id <= after) continue;
    if (event.type === "browser.state.changed") {
      through = Math.max(through, event.id);
      if (event.tabs.length > 0) acted = true;
    } else if (event.type === "item.completed" && event.item.detail.type === "browser_action") {
      through = Math.max(through, event.id);
      if (event.item.status === "completed") acted = true;
    }
  }
  return { acted, through };
}

/** The native scope to destroy when a desktop Browser tab closes. */
export function browserScopeToRelease(sessionId: string, tab: PanelTabInstance | undefined): string | undefined {
  return tab?.kind === LIVE_BROWSER_TAB ? browserScopeKey(sessionId, tab.id) : undefined;
}

/** The nonce makes a repeat press on the same chip a new request. */
export type TaskFocus = { id: string; nonce: number };

const LIVE_TASK_STATES = new Set<TaskState>(["pending", "running", "waiting"]);

export function isLiveTask(task: Task): boolean {
  return LIVE_TASK_STATES.has(task.state);
}

type RosterSplit = { agents: JournalTask[]; processes: JournalTask[] };

/** Anything the engine did not mark `background` is presumed an agent. */
export function splitRoster(tasks: readonly JournalTask[]): RosterSplit {
  return {
    agents: tasks.filter((task) => task.kind !== "background"),
    processes: tasks.filter((task) => task.kind === "background"),
  };
}

export type TabBadge = { count: number; running: number; failed: number };

/** The count an Agents or Processes tab wears, or nothing for every other kind. */
export function tabBadge(kind: string, roster: RosterSplit): TabBadge | undefined {
  const side = kind === "agents" ? roster.agents : kind === "processes" ? roster.processes : undefined;
  if (!side?.length) return undefined;
  return { count: side.length, running: side.filter(isLiveTask).length, failed: side.filter((task) => task.state === "failed").length };
}
