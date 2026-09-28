import type { EngineEvent, Item, Task, Turn } from "@telar/engine-client";
import { inStartOrder, projectJournal, type JournalTurn } from "@/platform/engine/journal";

/**
 * `projectJournal` folded per run and cached against the identity of that run's slice, so a streamed
 * chunk re-folds only its own turn. The partition itself is incremental: the journal is append-only.
 * Returned turns are shared with the previous call, so nothing downstream may mutate one.
 */
export type JournalProjector = (turns: Turn[], items: Item[], events: EngineEvent[], tasks?: Task[]) => JournalTurn[];

type Tabs = readonly { url: string; title: string }[];

/** A run's slice and its fold. The count matters: event slices are appended to in place. */
type ProjectedRun = {
  row: Turn | undefined;
  items: readonly Item[];
  tasks: readonly Task[];
  events: readonly EngineEvent[];
  eventCount: number;
  out: JournalTurn;
};

type Slice = { runId: string; row: Turn | undefined; runItems: readonly Item[]; runTasks: readonly Task[]; runEvents: readonly EngineEvent[]; out?: JournalTurn };

type Partition = {
  heldTurns?: readonly Turn[];
  heldItems?: readonly Item[];
  heldTasks?: readonly Task[];
  heldEvents?: readonly EngineEvent[];
  consumed: number;
  rowOf: Map<string, Turn>;
  itemsOf: Map<string, Item[]>;
  tasksOf: Map<string, Task[]>;
  eventsOf: Map<string, EngineEvent[]>;
  /** The fold files a delta under its ITEM's run, so the partition does too. */
  runOfItem: Map<string, string>;
  /** The tab set in force before each `browser.state.changed` event. */
  previousTabs: Map<number, Tabs | undefined>;
  carry: Map<string, { url: string; title: string }[]>;
  /** Runs the fold knows at each point of the walk: `turn.accepted` extends it as events are read. */
  live: Set<string>;
  order: string[];
};

const NO_ITEMS: readonly Item[] = [];
const NO_TASKS: readonly Task[] = [];
const NO_EVENTS: readonly EngineEvent[] = [];

/** Whether `next` begins with the first `count` entries of `previous`, by identity. */
function extendsPrefix(previous: readonly EngineEvent[], next: readonly EngineEvent[], count: number): boolean {
  if (next.length < count || previous.length < count) return false;
  for (let index = 0; index < count; index += 1) if (previous[index] !== next[index]) return false;
  return true;
}

/** The same rows by identity, even in a copied array. */
function sameRows<T>(previous: readonly T[] | undefined, next: readonly T[]): boolean {
  if (previous === next) return true;
  if (previous === undefined || previous.length !== next.length) return false;
  for (let index = 0; index < next.length; index += 1) if (previous[index] !== next[index]) return false;
  return true;
}

// The envelope's run, plus the row's own run for item, task and delta events, since the fold files by the row.
// An event in two buckets is a no-op in the one whose turn it does not name.
function runsTouched(event: EngineEvent, runOfItem: ReadonlyMap<string, string>): string[] {
  const envelope = event.runId;
  const both = (owner: string | undefined): string[] => {
    if (!owner) return envelope ? [envelope] : [];
    if (!envelope || envelope === owner) return [owner];
    return [envelope, owner];
  };
  switch (event.type) {
    case "turn.accepted":
      return both(event.turn.runId);
    case "item.started":
    case "item.updated":
    case "item.completed":
    case "turn.plan.updated":
      return both(event.item.runId);
    case "task.started":
    case "task.progress":
    case "task.completed":
      return both(event.task.runId);
    case "content.delta":
      return both(runOfItem.get(event.itemId));
    default:
      return envelope ? [envelope] : [];
  }
}

function pushTo<T>(map: Map<string, T[]>, key: string, value: T): void {
  const held = map.get(key);
  if (held) held.push(value);
  else map.set(key, [value]);
}

function partitionRows(state: Partition, turns: Turn[], items: Item[], tasks: Task[]): boolean {
  const turnsMoved = !sameRows(state.heldTurns, turns);
  if (turnsMoved) {
    state.rowOf = new Map(turns.map((turn) => [turn.runId, turn]));
    state.heldTurns = turns;
  }
  if (!sameRows(state.heldItems, items)) {
    state.itemsOf = new Map();
    for (const item of items) {
      pushTo(state.itemsOf, item.runId, item);
      state.runOfItem.set(item.id, item.runId);
    }
    state.heldItems = items;
  }
  if (!sameRows(state.heldTasks, tasks)) {
    state.tasksOf = new Map();
    for (const task of tasks) pushTo(state.tasksOf, task.runId, task);
    state.heldTasks = tasks;
  }
  return turnsMoved;
}

// Walked once and only forward, resuming where the last walk stopped. A replaced tail or moved `turns`
// restarts it: the run set seeds the tab carry, and a different seed can change an already-walked answer.
function partitionEvents(state: Partition, events: EngineEvent[], turnsMoved: boolean): void {
  if (turnsMoved || state.heldEvents === undefined || !extendsPrefix(state.heldEvents, events, state.consumed)) {
    state.eventsOf = new Map();
    state.previousTabs = new Map();
    state.carry = new Map();
    state.live = new Set(state.rowOf.keys());
    state.order = [...state.rowOf.keys()];
    state.consumed = 0;
  }
  for (let index = state.consumed; index < events.length; index += 1) {
    const event = events[index]!;
    if (event.type === "turn.accepted" && !state.live.has(event.turn.runId)) {
      state.live.add(event.turn.runId);
      state.order.push(event.turn.runId);
    }
    if (event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") {
      state.runOfItem.set(event.item.id, event.item.runId);
    }
    for (const runId of runsTouched(event, state.runOfItem)) pushTo(state.eventsOf, runId, event);
    // The carry advances only on an event the fold could FILE, which is the
    // rule `projectJournal` applies by returning before it writes.
    if (event.type === "browser.state.changed" && event.runId && state.live.has(event.runId)) {
      state.previousTabs.set(event.id, state.carry.get(event.sessionId));
      state.carry.set(event.sessionId, event.tabs);
    }
  }
  state.consumed = events.length;
  state.heldEvents = events;
}

function slicesOf(state: Partition, folds: ReadonlyMap<string, ProjectedRun>): Slice[] {
  return state.order.map((runId) => {
    const row = state.rowOf.get(runId);
    const runItems = state.itemsOf.get(runId) ?? NO_ITEMS;
    const runTasks = state.tasksOf.get(runId) ?? NO_TASKS;
    const runEvents = state.eventsOf.get(runId) ?? NO_EVENTS;
    const held = folds.get(runId);
    const reusable =
      held !== undefined &&
      held.row === row &&
      held.items === runItems &&
      held.tasks === runTasks &&
      held.events === runEvents &&
      held.eventCount === runEvents.length;
    return { runId, row, runItems, runTasks, runEvents, out: reusable ? held!.out : undefined };
  });
}

export function createJournalProjector(): JournalProjector {
  let folds = new Map<string, ProjectedRun>();
  const state: Partition = {
    consumed: 0,
    rowOf: new Map(),
    itemsOf: new Map(),
    tasksOf: new Map(),
    eventsOf: new Map(),
    runOfItem: new Map(),
    previousTabs: new Map(),
    carry: new Map(),
    live: new Set(),
    order: [],
  };

  return (turns, items, events, tasks = []) => {
    partitionEvents(state, events, partitionRows(state, turns, items, tasks));
    const slices = slicesOf(state, folds);

    // Nothing reusable (a companion snapshot replaced every row): one whole fold beats N one-turn folds.
    const whole =
      slices.length > 1 && slices.every((slice) => slice.out === undefined)
        ? new Map(projectJournal(turns, items, events, tasks).map((turn) => [turn.runId, turn]))
        : undefined;

    // Rebuilt rather than pruned, so a run that left the window takes its cache entry with it.
    const next = new Map<string, ProjectedRun>();
    const projected: JournalTurn[] = [];
    for (const slice of slices) {
      const folded =
        slice.out ??
        whole?.get(slice.runId) ??
        projectJournal(
          slice.row ? [slice.row] : [],
          slice.runItems as Item[],
          slice.runEvents as EngineEvent[],
          slice.runTasks as Task[],
          state.previousTabs,
        ).find((turn) => turn.runId === slice.runId);
      // A run named only by rows the fold drops (an item whose turn nobody sent)
      // produces nothing, exactly as the whole-journal fold does.
      if (!folded) continue;
      next.set(slice.runId, {
        row: slice.row,
        items: slice.runItems,
        tasks: slice.runTasks,
        events: slice.runEvents,
        eventCount: slice.runEvents.length,
        out: folded,
      });
      projected.push(folded);
    }
    folds = next;
    return inStartOrder(projected);
  };
}
