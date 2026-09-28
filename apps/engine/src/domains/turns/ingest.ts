import {
  isUnstatedEnding,
  TurnObservation as TurnObservationSchema,
  type Item,
  type Task,
  type Turn,
  type TurnObservation,
} from "@telar/engine-client";
import { assertId, EngineStateError, type Kernel } from "../../platform/kernel";
import type { OpenPrefixes, SessionItems, SessionQueue, SessionRecords, SessionTasks } from "../sessions";

type Projection = { items: Map<string, Item>; tasks: Map<string, Task>; itemsTouched: Set<string>; tasksTouched: boolean; turnTouched: boolean };
type TaskObservation = Extract<TurnObservation, { kind: "task.started" | "task.progress" | "task.completed" }>;

// Drops explicitly-undefined keys, so a spread patches rather than erases.
function definedOnly<T extends object>(value: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key as keyof T] = entry as T[keyof T];
  }
  return out;
}

// Only a route: both paths validate the whole batch with the same schema.
function isDeltaOnlyBatch(observations: unknown[]): boolean {
  if (!Array.isArray(observations) || observations.length === 0) return false;
  for (const observation of observations) {
    if ((observation as { kind?: unknown } | null)?.kind !== "content.delta") return false;
  }
  return true;
}

type IngestDeps = {
  records: SessionRecords;
  items: SessionItems;
  tasks: SessionTasks;
  prefixes: OpenPrefixes;
  readQueue: (sessionId: string) => SessionQueue;
  scanQueue: (sessionId: string) => SessionQueue;
  writeQueue: (sessionId: string, queue: SessionQueue) => void;
  requireRunningClaimFromQueue: (queue: SessionQueue, runId: string, claimToken: string) => Turn;
};

/** What a running turn reports, journalled and folded into the items, tasks and turn it touches. */
export class TurnIngest {
  constructor(
    private readonly kernel: Kernel,
    private readonly deps: IngestDeps,
  ) {}

  /** Journals what a worker saw. The worker mints nothing durable; a batch is validated whole before any of it is appended. */
  ingestObservations(sessionId: string, runId: string, claimToken: string, observations: unknown[]): { accepted: number } {
    if (isDeltaOnlyBatch(observations)) return this.ingestDeltas(sessionId, runId, claimToken, observations);
    return this.kernel.command("ingestObservations", () => this.ingestBatch(sessionId, runId, claimToken, observations));
  }

  // A delta-only batch writes no row, so it skips the transaction, the task read and the queue parse; same events, same order.
  private ingestDeltas(sessionId: string, runId: string, claimToken: string, observations: unknown[]): { accepted: number } {
    // First, and against the shared copy: the claim is checked before the batch
    // is validated, exactly as the command path checks it before parsing.
    const turn = this.deps.requireRunningClaimFromQueue(this.deps.scanQueue(sessionId), runId, claimToken);
    // THE SAME SCHEMA THE COMMAND PATH USES, not a narrower copy of the delta
    // member: one definition, so the two paths cannot drift on what they accept.
    const parsed = TurnObservationSchema.array().safeParse(observations);
    if (!parsed.success) throw new EngineStateError("invalid_request", "turn observations are invalid");
    for (const observation of parsed.data) {
      // `isDeltaOnlyBatch` is what chose this path; this is what tells the compiler.
      if (observation.kind !== "content.delta") continue;
      // The one thing the projection was read for. `journalObservation` drops a
      // delta whose item never opened, and so does this.
      if (!this.deps.items.has(sessionId, observation.itemId)) continue;
      const written = this.kernel.appendEvent(
        sessionId,
        { type: "content.delta", itemId: observation.itemId, stream: observation.stream, text: observation.text },
        turn.runId,
      );
      // #214: a reader arriving mid-reply still has to see the prefix.
      this.deps.prefixes.extend(sessionId, observation.itemId, observation.text, written.id);
    }
    return { accepted: parsed.data.length };
  }

  private ingestBatch(sessionId: string, runId: string, claimToken: string, observations: unknown[]): { accepted: number } {
    const queue = this.deps.readQueue(sessionId);
    const turn = this.deps.requireRunningClaimFromQueue(queue, runId, claimToken);
    const parsed = TurnObservationSchema.array().safeParse(observations);
    if (!parsed.success) throw new EngineStateError("invalid_request", "turn observations are invalid");
    const projection = { items: this.deps.items.read(sessionId), tasks: this.deps.tasks.read(sessionId), itemsTouched: new Set<string>(), tasksTouched: false, turnTouched: false };
    for (const observation of parsed.data) {
      this.journalObservation(sessionId, turn, observation, projection);
    }
    if (projection.itemsTouched.size > 0) this.deps.items.write(sessionId, projection.items, projection.itemsTouched);
    // Most batches carry no task at all — a rewrite per batch would be a file
    // write per streamed provider message for nothing. Same rule for the
    // queue: only a `provider.session` observation ever mutates the turn.
    if (projection.tasksTouched) this.deps.tasks.write(sessionId, projection.tasks);
    if (projection.turnTouched) this.deps.writeQueue(sessionId, queue);
    return { accepted: parsed.data.length };
  }

  /** One observation → at most one journal record, plus its projection edit. */
  private journalObservation(
    sessionId: string,
    turn: Turn,
    observation: TurnObservation,
    projection: Projection,
  ): void {
    const at = this.kernel.now();
    const items = projection.items;
    if (observation.kind === "usage") {
      this.kernel.appendEvent(sessionId, { type: "usage.updated", usage: observation.usage }, turn.runId);
      return;
    }
    if (observation.kind === "runtime.warning") {
      // Touches no projection: it is a line in the journal about the runtime,
      // not a row, a task or a turn field. Stamped with the run so the
      // transcript shows it where it happened.
      this.kernel.appendEvent(sessionId, { type: "runtime.warning", message: observation.message }, turn.runId);
      return;
    }
    if (observation.kind === "content.delta") {
      // Deltas do NOT touch the projection. An item's stored text is filled in
      // by the `item.completed` that closes it; folding every token into
      // items.json would rewrite the whole document per token.
      if (!items.has(observation.itemId)) return;
      const written = this.kernel.appendEvent(
        sessionId,
        { type: "content.delta", itemId: observation.itemId, stream: observation.stream, text: observation.text },
        turn.runId,
      );
      this.deps.prefixes.extend(sessionId, observation.itemId, observation.text, written.id);
      return;
    }
    if (observation.kind === "item.completed") {
      const existing = items.get(observation.itemId);
      if (!existing) return;
      const item: Item = {
        ...existing,
        status: observation.status,
        completedAt: at,
        ...(observation.detail ? { detail: observation.detail } : {}),
      };
      items.set(item.id, item);
      projection.itemsTouched.add(item.id);
      this.kernel.appendEvent(sessionId, { type: "item.completed", item }, turn.runId);
      // The text lives in `detail` from here on, so the accumulator's copy is
      // dead weight. This is what bounds the map: one entry per OPEN item.
      this.deps.prefixes.drop(sessionId, observation.itemId);
      return;
    }
    if (observation.kind === "provider.session") {
      turn.providerSessionId = observation.providerSessionId;
      projection.turnTouched = true;
      this.deps.records.touch(sessionId, at, observation.providerSessionId);
      return;
    }
    if (observation.kind === "browser.state") {
      // No projection: a browser's tabs are LIVE state, not durable history.
      // Replaying them from a week-old journal would describe pages that are
      // long gone, so this rides the stream and nothing else.
      this.kernel.appendEvent(
        sessionId,
        { type: "browser.state.changed", provider: observation.provider, tabs: observation.tabs },
        turn.runId,
      );
      return;
    }
    if (observation.kind === "display.opened") {
      this.kernel.appendEvent(
        sessionId,
        { type: "display.opened", path: observation.path, ...(observation.title ? { title: observation.title } : {}) },
        turn.runId,
      );
      return;
    }
    if (observation.kind === "prompt.drafted") {
      this.kernel.appendEvent(
        sessionId,
        {
          type: "prompt.drafted",
          promptId: observation.promptId,
          title: observation.title,
          ...(observation.forSessionId ? { forSessionId: observation.forSessionId } : {}),
        },
        turn.runId,
      );
      return;
    }
    if (observation.kind === "task.started" || observation.kind === "task.progress" || observation.kind === "task.completed") {
      this.foldTask(sessionId, turn, observation, projection, at);
      return;
    }
    const seed = observation.item;
    const started = observation.kind === "item.started";
    const item: Item = {
      id: seed.id,
      runId: turn.runId,
      sessionId,
      status: "inProgress",
      detail: seed.detail,
      startedAt: started ? at : (items.get(seed.id)?.startedAt ?? at),
      ...(seed.title ? { title: seed.title } : {}),
      ...(seed.taskId ? { taskId: seed.taskId } : {}),
      ...(seed.providerRefs ? { providerRefs: seed.providerRefs } : {}),
    };
    items.set(item.id, item);
    projection.itemsTouched.add(item.id);
    const written = this.kernel.appendEvent(sessionId, { type: started ? "item.started" : "item.updated", item }, turn.runId);
    // AN ITEM THAT JUST OPENED HAS NO EARLIER DELTAS, which is the only moment
    // the accumulator can know it holds the whole prefix. Every later extend
    // inherits that; an entry born any other way is rebuilt on read.
    if (started) this.deps.prefixes.remember(sessionId, item.id, { text: "", through: written.id, sealed: true });
  }

  private foldTask(
    sessionId: string,
    turn: Turn,
    observation: TaskObservation,
    projection: Projection,
    at: number,
  ): void {
    const seed = observation.task;
    // By contract id, then by provider id: a later turn mints a new contract id for the same task.
    const known =
      projection.tasks.get(seed.id) ??
      (seed.providerTaskId ? [...projection.tasks.values()].find((task) => task.providerTaskId === seed.providerTaskId) : undefined);
    const settled = known !== undefined && (known.state === "completed" || known.state === "failed" || known.state === "stopped");
    // The first ending is the ending, unless nobody stated it (`isUnstatedEnding`): then only a worse outcome may replace it.
    const corrected = settled && isUnstatedEnding(known) && (seed.state === "failed" || seed.state === "stopped");
    const kept = settled && !corrected;
    const state = kept ? known.state : seed.state;
    const terminal = state === "completed" || state === "failed" || state === "stopped";
    // A settled task is re-announced only when a report adds something; a summary arriving after the close is folded in silently.
    if (kept) {
      const additions = definedOnly(seed);
      const changed = Object.entries(additions)
        .filter(([key, value]) => !(key === "id" || key === "state" || key === "kind" || key === "providerTaskId") && JSON.stringify(known[key as keyof Task]) !== JSON.stringify(value))
        .map(([key]) => key);
      if (changed.length === 0) return;
      const onlySummary = changed.every((key) => key === "resultText" || key === "usage" || key === "outputFile");
      if (onlySummary) {
        projection.tasks.set(known.id, { ...known, ...definedOnly(seed), id: known.id, kind: known.kind, state: known.state, runId: known.runId, startedAt: known.startedAt, updatedAt: at });
        projection.tasksTouched = true;
        return;
      }
    }
    const task: Task = {
      ...known,
      ...definedOnly(seed),
      // The row's own id, when a provider-id match found one: the later
      // turn's minted id names the same shell and must not open a second row.
      id: known?.id ?? seed.id,
      // The first classification stands: a later turn's seam may know nothing and default to "agent".
      kind: known?.kind ?? seed.kind,
      state,
      sessionId,
      // A background task belongs to the turn that STARTED it even after that
      // turn settles, which is the whole meaning of background.
      runId: known?.runId ?? turn.runId,
      startedAt: known?.startedAt ?? at,
      updatedAt: at,
      ...(settled ? { completedAt: known.completedAt ?? at } : terminal ? { completedAt: at } : {}),
    };
    projection.tasks.set(task.id, task);
    projection.tasksTouched = true;
    // The EVENT follows the state, not the message that carried it (the
    // driver's rule again): a late progress line about a settled task is
    // announced as its completion, not as a resumption.
    const announced = observation.kind === "task.started" ? "task.started" : terminal ? "task.completed" : "task.progress";
    this.kernel.appendEvent(
      sessionId,
      announced === "task.progress"
        ? { type: "task.progress", task, ...(observation.kind === "task.progress" && observation.message ? { message: observation.message } : {}) }
        : { type: announced, task },
      turn.runId,
    );
  }

  /** Task reports between turns fold onto rows the store already has; a report for an unknown row is dropped. */
  reportSessionTasks(sessionId: string, workerId: string, observations: unknown[]): { accepted: number } {
    return this.kernel.command("reportSessionTasks", () => {
      assertId(workerId, "worker id");
      this.deps.records.require(sessionId);
      const parsed = TurnObservationSchema.array().safeParse(observations);
      if (!parsed.success) throw new EngineStateError("invalid_request", "task observations are invalid");
      const tasks = this.deps.tasks.read(sessionId);
      const projection = { items: this.deps.items.read(sessionId), tasks, itemsTouched: new Set<string>(), tasksTouched: false, turnTouched: false };
      let accepted = 0;
      for (const observation of parsed.data) {
        if (observation.kind === "runtime.warning") {
          this.kernel.appendEvent(sessionId, { type: "runtime.warning", message: observation.message });
          accepted += 1;
          continue;
        }
        if (observation.kind !== "task.started" && observation.kind !== "task.progress" && observation.kind !== "task.completed") continue;
        const seed = observation.task;
        const known =
          tasks.get(seed.id) ?? (seed.providerTaskId ? [...tasks.values()].find((task) => task.providerTaskId === seed.providerTaskId) : undefined);
        if (!known) continue;
        // `journalObservation` takes the owning turn only for its runId.
        this.journalObservation(sessionId, { runId: known.runId } as Turn, observation, projection);
        accepted += 1;
      }
      if (projection.tasksTouched) {
        this.deps.tasks.write(sessionId, projection.tasks);
        this.deps.records.touch(sessionId, this.kernel.now());
      }
      return { accepted };
    });
  }
}
