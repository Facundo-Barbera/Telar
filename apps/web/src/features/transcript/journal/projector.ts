import { type EngineEvent,type Item,type Task,type Turn } from "@telar/engine-client";
import { inStartOrder } from "./arrivals";
import { projectJournal } from "./fold";
import type { JournalTurn } from "./types";

export type JournalProjector = (turns: Turn[], items: Item[], events: EngineEvent[], tasks?: Task[]) => JournalTurn[];

/** A run's slice, and the fold it produced. Compared by identity — plus a
 *  count, because the event slices are APPENDED to in place rather than
 *  rebuilt, so their reference alone cannot say whether anything arrived. */
type ProjectedRun = {
  row: Turn | undefined;
  items: readonly Item[];
  tasks: readonly Task[];
  events: readonly EngineEvent[];
  eventCount: number;
  out: JournalTurn;
};

const NO_ITEMS: readonly Item[] = [];
const NO_TASKS: readonly Task[] = [];
const NO_EVENTS: readonly EngineEvent[] = [];

/** Whether `next` begins with the first `count` entries of `previous`, by
 *  identity. A journal is append-only, so this is the ordinary case — and it is
 *  what lets a tick partition only what arrived. */
function extendsPrefix(previous: readonly EngineEvent[], next: readonly EngineEvent[], count: number): boolean {
  if (next.length < count || previous.length < count) return false;
  for (let index = 0; index < count; index += 1) if (previous[index] !== next[index]) return false;
  return true;
}

function sameRows<T>(previous: readonly T[] | undefined, next: readonly T[]): boolean {
  if (previous === next) return true;
  if (previous === undefined || previous.length !== next.length) return false;
  for (let index = 0; index < next.length; index += 1) if (previous[index] !== next[index]) return false;
  return true;
}

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

type Slice = { runId: string; row: Turn | undefined; runItems: readonly Item[]; runTasks: readonly Task[]; runEvents: readonly EngineEvent[]; out: JournalTurn | undefined };

function foldSlices(slices: Slice[], whole: Map<string, JournalTurn> | undefined, previousTabs: ReadonlyMap<number, readonly { url: string; title: string }[] | undefined>) {
  const next = new Map<string, ProjectedRun>();
  const projected: JournalTurn[] = [];
  for (const slice of slices) {
    const folded =
      slice.out ??
      whole?.get(slice.runId) ??
      projectJournal(slice.row ? [slice.row] : [], slice.runItems as Item[], slice.runEvents as EngineEvent[], slice.runTasks as Task[], previousTabs).find(
        (turn) => turn.runId === slice.runId,
      );
    // A run named only by rows the fold drops produces nothing, as in the whole-journal fold.
    if (!folded) continue;
    next.set(slice.runId, { row: slice.row, items: slice.runItems, tasks: slice.runTasks, events: slice.runEvents, eventCount: slice.runEvents.length, out: folded });
    projected.push(folded);
  }
  return { next, projected };
}

export function createJournalProjector(): JournalProjector {
  let folds = new Map<string, ProjectedRun>();

  // The partition, kept between calls and rebuilt only where its inputs moved.
  let heldTurns: readonly Turn[] | undefined;
  let heldItems: readonly Item[] | undefined;
  let heldTasks: readonly Task[] | undefined;
  let heldEvents: readonly EngineEvent[] | undefined;
  let consumed = 0;

  let rowOf = new Map<string, Turn>();
  let itemsOf = new Map<string, Item[]>();
  let tasksOf = new Map<string, Task[]>();
  let eventsOf = new Map<string, EngineEvent[]>();
  /** Where a delta's text belongs: the fold files a row under the run its ITEM
   *  names, so a delta has to be partitioned the same way. */
  const runOfItem = new Map<string, string>();
  /** The tab set in force before each `browser.state.changed` event. */
  let previousTabs = new Map<number, readonly { url: string; title: string }[] | undefined>();
  let carry = new Map<string, { url: string; title: string }[]>();
  let live = new Set<string>();
  let order: string[] = [];

  return (turns, items, events, tasks = []) => {
    const turnsMoved = !sameRows(heldTurns, turns);
    if (turnsMoved) {
      rowOf = new Map(turns.map((turn) => [turn.runId, turn]));
      heldTurns = turns;
    }
    if (!sameRows(heldItems, items)) {
      itemsOf = new Map();
      for (const item of items) {
        const held = itemsOf.get(item.runId);
        if (held) held.push(item);
        else itemsOf.set(item.runId, [item]);
        runOfItem.set(item.id, item.runId);
      }
      heldItems = items;
    }
    if (!sameRows(heldTasks, tasks)) {
      tasksOf = new Map();
      for (const task of tasks) {
        const held = tasksOf.get(task.runId);
        if (held) held.push(task);
        else tasksOf.set(task.runId, [task]);
      }
      heldTasks = tasks;
    }

    if (turnsMoved || heldEvents === undefined || !extendsPrefix(heldEvents, events, consumed)) {
      eventsOf = new Map();
      previousTabs = new Map();
      carry = new Map();
      live = new Set(rowOf.keys());
      order = [...rowOf.keys()];
      consumed = 0;
    }
    for (let index = consumed; index < events.length; index += 1) {
      const event = events[index]!;
      if (event.type === "turn.accepted" && !live.has(event.turn.runId)) {
        live.add(event.turn.runId);
        order.push(event.turn.runId);
      }
      if (event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") {
        runOfItem.set(event.item.id, event.item.runId);
      }
      for (const runId of runsTouched(event, runOfItem)) {
        const held = eventsOf.get(runId);
        if (held) held.push(event);
        else eventsOf.set(runId, [event]);
      }
      // The carry advances only on an event the fold could FILE, which is the
      // rule `projectJournal` applies by returning before it writes.
      if (event.type === "browser.state.changed" && event.runId && live.has(event.runId)) {
        previousTabs.set(event.id, carry.get(event.sessionId));
        carry.set(event.sessionId, event.tabs);
      }
    }
    consumed = events.length;
    heldEvents = events;

    const slices = order.map((runId) => {
      const row = rowOf.get(runId);
      const runItems = itemsOf.get(runId) ?? NO_ITEMS;
      const runTasks = tasksOf.get(runId) ?? NO_TASKS;
      const runEvents = eventsOf.get(runId) ?? NO_EVENTS;
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

    const whole =
      slices.length > 1 && slices.every((slice) => slice.out === undefined)
        ? new Map(projectJournal(turns, items, events, tasks).map((turn) => [turn.runId, turn]))
        : undefined;

    // Rebuilt rather than pruned, so a run that left the window takes its cache entry with it.
    const { next, projected } = foldSlices(slices, whole, previousTabs);
    folds = next;
    return inStartOrder(projected);
  };
}
