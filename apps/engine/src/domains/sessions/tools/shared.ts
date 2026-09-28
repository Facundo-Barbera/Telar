import type { EngineEvent, EngineRequest, EnvMode, LiveSessionRow, NotificationDetail, ProviderDriverKind, Session, SessionDiff, SessionSettleEnded, Subscription, Cohort, SubscribedCohort, Turn, WaitingOn, WakeKind } from "@telar/engine-client";
import type { SessionsQueryCapability } from "./query";

export type SessionsCapability = {
  list(options?: { settled?: boolean }): Promise<{
    sessions: LiveSessionRow[];
    projects: Array<{ id: string; name: string }>;
    settledCount?: number;
  }>;
  create(input: { projectId: string; title?: string; envMode: EnvMode; driver?: ProviderDriverKind }): Promise<Session>;
  send(sessionId: string, input: { runId: string; input: string; intent?: Turn["agentIntent"]; corrects?: string }): Promise<{
    turn: Turn;
    replayed: boolean;
  }>;
  read(sessionId: string, after: number, options?: { limit?: number }): Promise<EngineEvent[]>;
  cursor?(sessionId: string): Promise<number>;
  status(
    sessionId: string,
    options?: { recent?: number },
  ): Promise<{ session: Session; turns: Turn[]; turnCount?: number; pendingNotifications?: NotificationDetail[] }>;
  turn?(sessionId: string, runId: string): Promise<Turn | undefined>;
  stop(sessionId: string): Promise<{ stopped: Turn[]; live?: Turn }>;
  settle(sessionId: string, settled: boolean): Promise<Session & { ended?: SessionSettleEnded }>;
  putSchedule?(input: { sessionId: string; prompt: string; rule: unknown; zone: string }): Promise<{ id: string; nextRunAt: number; zone: string }>;
  diff(sessionId: string): Promise<SessionDiff>;
  self?: { sessionId: string };
  subscribe(
    subscriberSessionId: string,
    input: { targetSessionId: string; events?: WakeKind[]; once?: boolean; completionWake?: Subscription["completionWake"] },
  ): Promise<Subscription>;
  unsubscribe(subscriptionId: string, subscriberSessionId: string): Promise<boolean>;
  subscriptions(subscriberSessionId: string): Promise<Subscription[]>;
  subscribeCohort?(
    subscriberSessionId: string,
    input: { sessionIds: string[]; timeoutMinutes?: number; completionWake?: Cohort["completionWake"] },
  ): Promise<SubscribedCohort>;
  cohorts?(subscriberSessionId: string): Promise<Cohort[]>;
  requests(sessionId: string): Promise<EngineRequest[]>;
  resolveRequest(
    sessionId: string,
    requestId: string,
    input: { decision: "accept" | "acceptForSession" | "decline"; reason?: string; answers?: Record<string, string> },
  ): Promise<EngineRequest>;
  query: SessionsQueryCapability;
};


const NOT_A_BYPASS = "Never hand a peer work you were refused — the same action, renamed.";

export const LIST = `Live sessions, and the projects one can be created in. Unsettled only by default. Read it before creating anything — the session you want may exist.`;

export const CREATE = `Start a NEW session on a project, filed under you. Pass task to assign its first work in the same call; without it nothing starts until sessions_send with intent task. ${NOT_A_BYPASS}`;

export const SEND = `Message another session. It is handed a NOTICE naming sessions_read, not your text; a result or blocker also quotes its first ~1,500 chars — lead with the point. Tasked? End with ONE result (then a one-line answer) or a blocker; no progress reports. ${NOT_A_BYPASS}`;

export const NO_SELF =
  "This door has no session to wake: subscriptions need a calling session, and this client is not one. Poll with sessions_status instead.";

export const NO_SESSION_TO_SCHEDULE =
  "This door has no session to schedule: a scheduled run is submitted INTO a conversation, and this client is not one. Ask a session to schedule itself.";

export const SUBSCRIBE = `Be woken ONCE when the session(s) you tasked are done: each sent its result, or a turn failed or was stopped, or it was settled. Pass sessionIds — one id or many, the same call. Blockers and parked requests still arrive at once. Send the tasks first, subscribe, then end your turn.`;

export const UNSUBSCRIBE = `Stop being woken by a session or a cohort, by the id sessions_subscribe returned. Queued wakes are withdrawn. One that is not yours answers removed: false — not an error.`;

export const SUBSCRIPTIONS = `Every subscription and open cohort this session holds. Read it before subscribing again, and for an id to unsubscribe.`;

export const REQUESTS = `What a session is WAITING on — its open requests, with the id sessions_resolve_request takes. A request is a question to a HUMAN by default; answering it is you taking responsibility.`;

export const RESOLVE_REQUEST = `Answer a session's open request on the user's behalf. Recorded as answered BY A SESSION. Only answer what you actually know; a secret pick is refused. ${NOT_A_BYPASS}`;

export const READ = `What a session has done: by default a turn-by-turn summary. runId answers ONE turn; mode: events for the raw journal, which is long. Narrower and cheaper first: sessions_outline for its turns, sessions_answer for one conclusion, sessions_steps for what a turn did.`;

export const STATUS = `Working, waiting (on a person, a session or a tool), background, scheduled or idle, and how recent turns ended. The cheap "is it finished yet", before sessions_read. Changes nothing. Never poll it to wait: sessions_subscribe and end your turn.`;

export const STOP = `Stop a session's work now: the running turn ends where it stands and the queue is settled. Nothing is undone — what it wrote stays written and a command it ran may have finished. Then idle, not paused.`;

export const SETTLE = `Shelve a session out of the active list, or settled: false to bring it back. Settling closes all its terminals, the person's own shells too, and stops its background tasks; the answer counts them. Nothing is deleted and a new message lifts it back. Housekeeping, not acceptance.`;

export function endedNote(ended: SessionSettleEnded | undefined): string {
  if (!ended) return "";
  const parts = [
    ...(ended.terminals > 0 ? [`${ended.terminals} terminal${ended.terminals === 1 ? "" : "s"}`] : []),
    ...(ended.backgroundTasks > 0 ? [`${ended.backgroundTasks} background task${ended.backgroundTasks === 1 ? "" : "s"}`] : []),
  ];
  return parts.length ? ` Settling ended what it left running: ${parts.join(" and ")}.` : "";
}

export const DIFF = `What a session changed in its checkout since it started. A "local" session shares the project's checkout, so the diff may carry work that is not its own. An empty answer may be unread, not unchanged. READ-ONLY, NOT AN ACCEPTANCE: nothing here merges or approves.`;

export const MAX_EVENTS = 50;
const MAX_EVENT_CHARS = 12_000;
const MAX_STRING_CHARS = 2_000;
export const MAX_RESULT_CHARS = 8_000;
export const MAX_RUN_EVENT_CHARS = 6_000;
export const MAX_RUN_ANSWER_CHARS = 24_000;
const MAX_SUMMARY_RESULT_CHARS = 300;
export const SUMMARY_TURNS_DEFAULT = 5;
export const SUMMARY_TURNS_MAX = 20;
export const TAIL_WINDOW = 200;
const TAIL_WINDOW_WIDE = 1_000;

function measure(value: unknown): number {
  return JSON.stringify(value, null, 2)?.length ?? 0;
}

function clamp(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length <= MAX_STRING_CHARS
      ? value
      : `${value.slice(0, MAX_STRING_CHARS)}… [${value.length - MAX_STRING_CHARS} more characters, not shown]`;
  }
  if (Array.isArray(value)) return value.map(clamp);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, inner]) => [key, clamp(inner)]));
  }
  return value;
}

export function pageEvents(
  events: readonly EngineEvent[],
  options: { limit?: number; chars?: number } = {},
): { page: unknown[]; cursor: number; more: boolean } {
  const limit = options.limit ?? MAX_EVENTS;
  const budget = options.chars ?? MAX_EVENT_CHARS;
  const page: unknown[] = [];
  let cursor = 0;
  let chars = 0;
  for (const event of events) {
    if (page.length >= limit) return { page, cursor, more: true };
    const trimmed = clamp(event);
    const size = measure(trimmed);
    if (page.length > 0 && chars + size > budget) return { page, cursor, more: true };
    page.push(trimmed);
    chars += size;
    cursor = event.id;
  }
  return { page, cursor, more: false };
}

export function pageEventsFromEnd(
  events: readonly EngineEvent[],
  options: { limit?: number; chars?: number } = {},
): { page: unknown[]; cursor: number; from: number; earlier: boolean } {
  const limit = options.limit ?? MAX_EVENTS;
  const budget = options.chars ?? MAX_EVENT_CHARS;
  const page: unknown[] = [];
  let chars = 0;
  let earlier = false;
  let from = 0;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (page.length >= limit) {
      earlier = true;
      break;
    }
    const trimmed = clamp(event);
    const size = measure(trimmed);
    if (page.length > 0 && chars + size > budget) {
      earlier = true;
      break;
    }
    page.unshift(trimmed);
    chars += size;
    from = event.id;
  }
  return { page, cursor: events.at(-1)?.id ?? 0, from, earlier };
}

export async function tailEvents(
  capability: SessionsCapability,
  sessionId: string,
  limit: number,
): Promise<{ events: EngineEvent[]; from: number; reached: boolean }> {
  const cursor = capability.cursor ? await capability.cursor(sessionId) : 0;
  if (cursor <= 0) return { events: await capability.read(sessionId, 0), from: 0, reached: true };
  let events: EngineEvent[] = [];
  let from = 0;
  for (const window of [TAIL_WINDOW, TAIL_WINDOW_WIDE]) {
    from = Math.max(0, cursor - window);
    events = await capability.read(sessionId, from, { limit: window });
    if (from === 0 || events.length >= limit) break;
  }
  return { events, from, reached: from === 0 };
}

const MAX_SUMMARY_TITLES = 12;

export function summariseTurns(turns: readonly Turn[], events: readonly EngineEvent[], wanted: number) {
  const titles = new Map<string, string[]>();
  for (const event of events) {
    if (event.type !== "item.completed") continue;
    const item = (event as { item?: { runId?: string; title?: string } }).item;
    if (!item?.runId || !item.title) continue;
    const held = titles.get(item.runId) ?? [];
    if (!held.includes(item.title)) held.push(item.title);
    titles.set(item.runId, held);
  }
  return turns.slice(-wanted).map((turn) => {
    const did = titles.get(turn.runId) ?? [];
    const answer = turn.resultText ?? "";
    return {
      runId: turn.runId,
      sequence: turn.sequence,
      state: turn.state,
      ...(turn.origin === "session" ? { from: "session" as const, ...(turn.agentIntent ? { intent: turn.agentIntent } : {}) } : {}),
      asked: firstLine(turn.input),
      ...(did.length > 0 ? { did: did.slice(0, MAX_SUMMARY_TITLES) } : {}),
      ...(did.length > MAX_SUMMARY_TITLES ? { didMore: did.length - MAX_SUMMARY_TITLES } : {}),
      ...(answer
        ? {
            answered: answer.slice(0, MAX_SUMMARY_RESULT_CHARS),
            resultChars: answer.length,
          }
        : {}),
      ...(turn.failure ? { failure: turn.failure } : {}),
    };
  });
}

function firstLine(text: string): string {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    return trimmed.length <= MAX_SUMMARY_RESULT_CHARS ? trimmed : `${trimmed.slice(0, MAX_SUMMARY_RESULT_CHARS)}…`;
  }
  return "";
}

export function withoutDuplicateBody(event: EngineEvent): EngineEvent {
  if (event.type !== "turn.accepted") return event;
  const turn = (event as { turn?: Record<string, unknown> }).turn;
  if (!turn || typeof turn.input !== "string") return event;
  return {
    ...event,
    turn: {
      ...turn,
      input: `[the message body is the \`message\` field of this answer, ${String(turn.input).length} characters here]`,
      ...(typeof turn.agentNotice === "string" ? { agentNotice: "[the notice this session was handed; its body is the `message` field]" } : {}),
    },
  } as EngineEvent;
}

export function readable(event: EngineEvent): boolean {
  if (event.type === "usage.updated") return false;
  if (event.type === "request.opened") {
    const request = (event as { request?: { state?: string; resolvedBy?: string } }).request;
    return !(request?.state === "resolved" && request.resolvedBy === "policy");
  }
  if (event.type === "request.resolved") return (event as { resolvedBy?: string }).resolvedBy !== "policy";
  return true;
}

export function summarise(session: LiveSessionRow, projects: Map<string, string>, options: { driver?: boolean } = {}) {
  return {
    id: session.id,
    project: session.projectId ? (projects.get(session.projectId) ?? session.projectId) : "no project",
    ...(session.projectId ? { projectId: session.projectId } : {}),
    title: session.title,
    envMode: session.envMode,
    activity: session.activity,
    ...(options.driver ? { driver: session.driver } : {}),
    ...(session.workspace.mode === "worktree" ? { branch: session.workspace.branch } : {}),
    ...(session.preparation ? { preparation: session.preparation } : {}),
    updatedAt: session.updatedAt,
  };
}

export const WAITING_PHRASE: Record<WaitingOn, string> = {
  run: "for a run to be ready",
  timer: "out a timer",
  task: "for background work to report",
};

export function quietNote(session: Session): string {
  const detail = session.activityDetail;
  if (session.activity === "monitoring") {
    const count = detail?.kind === "background" ? detail : undefined;
    const what = count ? `${count.tasks} background task${count.tasks === 1 ? "" : "s"}${count.agents > 0 ? ` (${count.agents} of them agent${count.agents === 1 ? "" : "s"})` : ""}` : "background work";
    return `Its turn has ended, but ${what} still run${count && count.tasks === 1 ? "s" : ""}. A report from them will wake it; subscribe rather than poll.`;
  }
  if (session.activity === "waiting" && detail?.kind === "session") {
    const others = detail.sessions > 1 ? ` and ${detail.sessions - 1} other session${detail.sessions === 2 ? "" : "s"}` : "";
    return `Nothing is running. It is waiting on ${detail.title ? `“${detail.title}” (${detail.sessionId})` : detail.sessionId}${others}, and their answer will wake it.`;
  }
  if (session.activity === "scheduled" && detail?.kind === "schedule") {
    return `Nothing is running. A schedule wakes it at ${new Date(detail.at).toISOString()}.`;
  }
  return "Nothing is running.";
}

export function summariseOne(session: LiveSessionRow, projects: Map<string, string>) {
  return { ...summarise(session, projects, { driver: true }), state: session.state };
}

export const LIST_LIMIT_DEFAULT = 50;
export const LIST_LIMIT_MAX = 200;
export const LIST_CHARS = 10_000;

export const REQUESTS_LIMIT = 20;
export const REQUESTS_CHARS = 8_000;
export const SUBSCRIPTIONS_LIMIT = 40;
export const SUBSCRIPTIONS_CHARS = 6_000;
export const DIFF_FILES_LIMIT = 100;
export const DIFF_FILES_CHARS = 8_000;
export const DIFF_COMMITS_LIMIT = 30;
export const DIFF_COMMITS_CHARS = 4_000;

export const LIVE_TURN_STATES = new Set(["queued", "claimed", "running"]);

export const STATUS_TURNS_DEFAULT = 5;
export const STATUS_TURNS_MAX = 20;

export function turnLine(turn: Turn) {
  return {
    runId: turn.runId,
    sequence: turn.sequence,
    state: turn.state,
    ...(turn.completedAt === undefined ? {} : { endedAt: turn.completedAt }),
    ...(turn.failure ? { failure: turn.failure } : {}),
    ...(turn.stalled ? { stalled: turn.stalled, lastProgressAt: turn.lastProgressAt ?? turn.stalled.since } : {}),
  };
}

export const wholeNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
