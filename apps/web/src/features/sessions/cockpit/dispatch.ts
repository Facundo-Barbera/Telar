import type { NotificationDetail, NotificationEntry } from "@telar/engine-client";
import type { JournalItem, JournalTurn } from "@/platform/engine";
import { bareNotificationTurn, quotedMessage } from "@/features/transcript";

export type WorkerState = "working" | "finished" | "waiting" | "failed" | "stopped";

export type DispatchWorker = { sessionId: string; state: WorkerState; message?: string; title?: string; spent?: string };

export type DispatchBlock = { key: string; workers: DispatchWorker[]; ended?: "done" | "expired" };

export type DispatchPlan = {
  blocks: Map<string, DispatchBlock>;
  absorbed: Set<string>;
  covered: Set<string>;
  hidden: Set<string>;
  sessionIds: string[];
};

type Call = { name: string; input: Record<string, unknown>; output: string };

type Happening = { sessionId: string; state?: WorkerState; message?: string; title?: string; spent?: string; mustSee: boolean };

function calls(items: readonly JournalItem[], tool: string): Call[] {
  const named = new RegExp(`(^|__|\\.)${tool}$`);
  return items.flatMap((item) => {
    const call = "call" in item.detail ? item.detail.call : undefined;
    if (!call || !named.test(call.name)) return [];
    const input = call.input && typeof call.input === "object" ? (call.input as Record<string, unknown>) : {};
    const output = typeof call.output === "string" ? call.output : call.output === undefined ? "" : JSON.stringify(call.output);
    return [{ name: call.name, input, output }];
  });
}

export function sends(items: readonly JournalItem[]): { to?: string; intent?: string }[] {
  return calls(items, "sessions_send").map(({ input }) => ({
    ...(typeof input.sessionId === "string" ? { to: input.sessionId } : {}),
    ...(typeof input.intent === "string" ? { intent: input.intent } : {}),
  }));
}

function createdWithTask(call: Call): string[] {
  const tasked = Array.isArray(call.input.tasks) || (typeof call.input.task === "string" && call.input.task.length > 0);
  return tasked ? [...call.output.matchAll(/"id"\s*:\s*"(session_[^"]+)"/g)].map((match) => match[1]!) : [];
}

/** The sessions one turn sent out together: tasked, created with a task, or subscribed to as a cohort. */
function dispatchedFrom(items: readonly JournalItem[]): string[] {
  const tasked = [
    ...sends(items).flatMap((send) => (send.intent === "task" && send.to ? [send.to] : [])),
    ...calls(items, "sessions_create").flatMap(createdWithTask),
  ];
  const subscribed = calls(items, "sessions_subscribe").flatMap(({ input }) => (Array.isArray(input.sessionIds) ? input.sessionIds.filter((id): id is string => typeof id === "string") : []));
  const all = [...new Set([...tasked, ...subscribed])];
  return all.length > 1 ? all : [];
}

function entryState(entry: Pick<NotificationEntry, "kind" | "intent" | "wakeKind">): WorkerState | undefined {
  if (entry.intent === "result") return "finished";
  if (entry.intent === "blocker") return "waiting";
  if (entry.wakeKind === "turn_failed") return "failed";
  if (entry.wakeKind === "turn_stopped") return "stopped";
  return undefined;
}

function entryMustSee(entry: Pick<NotificationEntry, "kind" | "intent" | "wakeKind">): boolean {
  return entry.kind === "request" || entry.wakeKind === "request_opened" || entry.intent === "blocker" || entry.intent === "task";
}

function fromEntry(entry: NotificationEntry, cohortClose: boolean): Happening | undefined {
  if (!entry.sessionId) return undefined;
  const state = entryState(entry) ?? (cohortClose && entry.wakeKind === "turn_completed" ? "finished" : undefined);
  return {
    sessionId: entry.sessionId,
    ...(state ? { state } : {}),
    ...(entry.title ? { title: entry.title } : {}),
    ...(entry.spent ? { spent: entry.spent } : {}),
    mustSee: !cohortClose && entryMustSee(entry),
  };
}

function happeningsOf(detail: NotificationDetail, message?: string): Happening[] {
  if (detail.entries?.length) return detail.entries.flatMap((entry) => fromEntry(entry, Boolean(detail.cohortId)) ?? []);
  if (!detail.sessionId) return [];
  const peer = detail.kind === "peer_message";
  const said = peer ? (message ?? quotedMessage(detail.body)) : undefined;
  const state = entryState(detail) ?? (peer && detail.intent === "report" ? "working" : undefined);
  return [{
    sessionId: detail.sessionId,
    ...(state ? { state } : {}),
    ...(said ? { message: said } : {}),
    ...(detail.spent ? { spent: detail.spent } : {}),
    mustSee: entryMustSee(detail),
  }];
}

function openingMessage(turn: JournalTurn): string | undefined {
  return turn.sender?.sessionId && turn.sender.sessionId === turn.notification?.sessionId ? turn.prompt.trim() || undefined : undefined;
}

const SETTLED: ReadonlySet<WorkerState> = new Set(["finished", "failed", "stopped"]);

function apply(block: DispatchBlock, happening: Happening): void {
  const worker = block.workers.find((each) => each.sessionId === happening.sessionId);
  if (!worker) return;
  if (happening.title) worker.title = happening.title;
  if (happening.spent) worker.spent = happening.spent;
  if (happening.message) worker.message = happening.message;
  if (happening.state && !(SETTLED.has(worker.state) && happening.state === "working")) worker.state = happening.state;
}

/** Every arrival from a dispatched or cohort session folds into one block per dispatch, wherever it arrived from. */
export function planDispatches(turns: readonly JournalTurn[], activeRunId?: string): DispatchPlan {
  const plan: DispatchPlan = { blocks: new Map(), absorbed: new Set(), covered: new Set(), hidden: new Set(), sessionIds: [] };
  const named = new Set<string>();
  const memberOf = new Map<string, DispatchBlock>();
  const anchored = new Set<DispatchBlock>();
  const open = (key: string, sessionIds: string[]): DispatchBlock => {
    const block: DispatchBlock = { key, workers: sessionIds.map((sessionId) => ({ sessionId, state: "working" })) };
    for (const sessionId of sessionIds) memberOf.set(sessionId, block);
    return block;
  };
  const record = (anchor: string, happenings: Happening[]) => {
    const touched = new Set<DispatchBlock>();
    for (const each of happenings) {
      named.add(each.sessionId);
      const block = memberOf.get(each.sessionId);
      if (!block) continue;
      apply(block, each);
      touched.add(block);
    }
    for (const block of touched) {
      if (anchored.has(block)) continue;
      anchored.add(block);
      plan.blocks.set(anchor, block);
    }
    return { touched, represented: happenings.length > 0 && happenings.every((each) => !each.mustSee && memberOf.has(each.sessionId)) };
  };
  for (const turn of turns) {
    const detail = turn.notification;
    const happenings = detail ? happeningsOf(detail, openingMessage(turn)) : [];
    if (detail?.cohortId && happenings.length > 1) {
      const current = memberOf.get(happenings[0]!.sessionId);
      if (!current || happenings.some((each) => memberOf.get(each.sessionId) !== current)) open(detail.cohortId, happenings.map((each) => each.sessionId));
    }
    const { touched, represented } = record(turn.runId, happenings);
    if (detail?.cohortId && touched.size === 1) [...touched][0]!.ended = detail.summary.startsWith("[cohort expired") ? "expired" : "done";
    if (represented) {
      if (turn.runId !== activeRunId && turn.state === "completed" && bareNotificationTurn(turn)) plan.absorbed.add(turn.runId);
      else plan.covered.add(turn.runId);
    }
    const dispatched = dispatchedFrom(turn.items);
    if (dispatched.length > 0) open(turn.runId, dispatched);
    for (const id of dispatched) named.add(id);
    for (const item of turn.items) {
      if (item.detail.type !== "notification" || item.id === `notification_${turn.runId}`) continue;
      if (record(turn.runId, happeningsOf(item.detail.notification)).represented) plan.hidden.add(item.id);
    }
  }
  plan.sessionIds = [...named].sort();
  return plan;
}

function quietArrival(item: JournalItem): NotificationDetail | undefined {
  if (item.detail.type !== "notification") return undefined;
  const detail = item.detail.notification;
  return [detail, ...(detail.entries ?? [])].some((each) => entryMustSee(each) || each.wakeKind === "turn_failed") ? undefined : detail;
}

function asEntries(detail: NotificationDetail): NotificationEntry[] {
  if (detail.entries?.length) return detail.entries;
  const { kind, sessionId, runId, wakeKind, intent, summary } = detail;
  return [{ kind, summary, ...(sessionId ? { sessionId } : {}), ...(runId ? { runId } : {}), ...(wakeKind ? { wakeKind } : {}), ...(intent ? { intent } : {}) }];
}

/** A turn's items without the arrivals a block stands for, consecutive quiet ones folded into one row. */
export function arrivalsFolded(turn: JournalTurn, hidden: ReadonlySet<string>): JournalTurn {
  const opening = `notification_${turn.runId}`;
  const items: JournalItem[] = [];
  let changed = false;
  for (const item of turn.items) {
    if (hidden.has(item.id)) {
      changed = true;
      continue;
    }
    const detail = item.id === opening ? undefined : quietArrival(item);
    const previous = items.at(-1);
    const before = previous && previous.id !== opening ? quietArrival(previous) : undefined;
    if (!detail || !before) {
      items.push(item);
      continue;
    }
    const entries = [...asEntries(before), ...asEntries(detail)].slice(-50);
    items[items.length - 1] = { ...previous!, detail: { type: "notification", notification: { ...detail, entries, body: `${before.body}\n—\n${detail.body}`.slice(-8_000) } } };
    changed = true;
  }
  return changed ? { ...turn, items } : turn;
}

export function dispatchSummary(block: DispatchBlock): string {
  const count = (state: WorkerState) => block.workers.filter((worker) => worker.state === state).length;
  const parts = [
    `${block.workers.length} sessions`,
    count("finished") ? `${count("finished")} finished` : "",
    count("working") ? `${count("working")} working` : "",
    count("waiting") ? `${count("waiting")} waiting on you` : "",
    count("failed") ? `${count("failed")} failed` : "",
    count("stopped") ? `${count("stopped")} stopped` : "",
    block.ended === "expired" ? "stopped waiting" : "",
  ];
  return parts.filter(Boolean).join(" · ");
}
