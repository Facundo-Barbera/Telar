import type { EngineClient, EngineEvent, Session, SessionDiff, SessionSettleEnded, Subscription } from "@telar/engine-client";
import type { SessionsCapability } from "../../sessions-tools/tools";
import type { EngineStore } from "../../state";

type Capability = SessionsCapability;
type Query = Capability["query"];
type Result<F extends (...args: never[]) => unknown> = Awaited<ReturnType<F>>;
type ClaimProof = { runId: string; claimToken: string };

/** The session a turn speaks for; `proof` is read at call time because the capability outlives its turn. */
export type SessionIdentity = { sessionId: string; proof: () => ClaimProof };

/** The EngineClient verbs the sessions capability speaks. `EngineClient` satisfies it; the daemon passes a store adapter. */
export type SessionsPort = {
  liveSessions(options: { all?: boolean }): ReturnType<Capability["list"]>;
  createSession(input: Parameters<Capability["create"]>[0] & { origin: "session"; ceilingFrom?: string }): Promise<{ session: Session }>;
  submitAgentTurn(
    sessionId: string,
    input: Parameters<Capability["send"]>[1] & { proof?: ClaimProof & { sessionId: string } },
  ): ReturnType<Capability["send"]>;
  events(sessionId: string, after: number, limit?: number): Promise<{ events: EngineEvent[] }>;
  stopSession(sessionId: string, by: "agent"): ReturnType<Capability["stop"]>;
  settleSession(sessionId: string, settled: boolean): Promise<{ session: Session; ended?: SessionSettleEnded }>;
  sessionDiff(sessionId: string): Promise<{ diff: SessionDiff }>;
  subscribe(subscriber: string, input: Parameters<Capability["subscribe"]>[1]): Promise<{ subscription: Subscription }>;
  unsubscribe(id: string, input: { subscriberSessionId: string }): Promise<{ removed: boolean }>;
  subscriptions(subscriber: string): Promise<{ subscriptions: Subscription[] }>;
  subscribeCohort(
    subscriber: string,
    input: Parameters<NonNullable<Capability["subscribeCohort"]>>[1],
  ): Promise<{ cohort: Result<NonNullable<Capability["subscribeCohort"]>> }>;
  cohorts(subscriber: string): Promise<{ cohorts: Result<NonNullable<Capability["cohorts"]>> }>;
  resolveRequest(
    sessionId: string,
    requestId: string,
    input: Parameters<Capability["resolveRequest"]>[2] & { resolvedBy: "session" },
  ): Promise<{ request: Result<Capability["resolveRequest"]> }>;
  findSessions: Query["find"];
  sessionOutline: Query["outline"];
  turnAnswer: Query["answer"];
  runItems: Query["steps"];
  runItem(sessionId: string, runId: string, step: number | string, options: { maxChars: number }): ReturnType<Query["step"]>;
  grepSession: Query["grep"];
};

/** The reads each deployment answers its own way, kept as they are pending an owner decision. */
export type SessionsReads = Pick<Capability, "status" | "requests" | "turn" | "putSchedule"> & { cursor: NonNullable<Capability["cursor"]> };

/** How many settled turns a run lookup searches before reading the whole history. */
const RECENT_TURN_LOOKUP = 20;

/** Over HTTP: windowed snapshots, so a long session is not shipped whole for one turn. */
export function windowedReads(client: Pick<EngineClient, "session">): SessionsReads {
  return {
    cursor: async (id) => (await client.session(id, { turns: 1 })).cursor ?? 0,
    status: async (id, options) => {
      if (options?.recent !== undefined) {
        const window = await client.session(id, { turns: options.recent });
        if (window.page?.total !== undefined) return { session: window.session, turns: window.turns, turnCount: window.page.total };
      }
      const snapshot = await client.session(id);
      return { session: snapshot.session, turns: snapshot.turns };
    },
    turn: async (id, runId) => {
      const window = await client.session(id, { turns: RECENT_TURN_LOOKUP });
      const found = window.turns.find((candidate) => candidate.runId === runId);
      if (found || window.page?.more === false) return found;
      return (await client.session(id)).turns.find((candidate) => candidate.runId === runId);
    },
    // Every open request rides every windowed page, so one turn is enough.
    requests: async (id) => (await client.session(id, { turns: 1 })).requests,
  };
}

/** In-process: every turn with the held notifications, every request, and scheduling. */
export function storeReads(store: EngineStore): SessionsReads {
  return {
    cursor: async (id) => store.eventCursor(id),
    status: async (id) => ({ session: store.getSession(id), turns: store.turns(id), pendingNotifications: store.pendingNotifications(id) }),
    requests: async (id) => store.requests(id),
    putSchedule: async (input) => store.putSchedule({ ...input, rule: input.rule as never }),
  };
}

/** The store behind the daemon's socket, shaped like the client so both doors share one capability. */
export function storeSessionsPort(store: EngineStore): SessionsPort {
  return {
    liveSessions: async (options) => store.liveSessionRows(options),
    createSession: async (input) => ({ session: await store.createSessionAsync(input) }),
    submitAgentTurn: async (id, { proof, ...input }) => store.submitAgentTurnAsync(id, input, proof),
    events: async (id, after, limit) => ({ events: store.readEvents(id, after, limit) }),
    stopSession: async (id, by) => store.stopSession(id, by),
    settleSession: async (id, settled) => {
      const session = store.updateSession(id, { settledOverride: settled ? "settled" : "active" });
      if (!settled) return { session };
      const ended = await store.endSessionLeftovers(id);
      return { session: store.getSession(id), ended };
    },
    sessionDiff: async (id) => ({ diff: await store.sessionDiffAsync(id) }),
    subscribe: async (subscriber, input) => ({ subscription: store.subscribe(subscriber, input) }),
    unsubscribe: async (id, { subscriberSessionId }) => ({ removed: store.unsubscribe(id, subscriberSessionId) }),
    subscriptions: async (subscriber) => ({ subscriptions: store.subscriptionsFor(subscriber) }),
    subscribeCohort: async (subscriber, input) => ({ cohort: store.subscribeCohort(subscriber, input) }),
    cohorts: async (subscriber) => ({ cohorts: store.cohortsFor(subscriber) }),
    resolveRequest: async (id, requestId, input) => ({ request: store.resolveRequest(id, requestId, input) }),
    findSessions: async (query) => store.findSessions(query),
    sessionOutline: async (id, window) => store.turnOutline(id, window),
    turnAnswer: async (id, options) => store.turnAnswer(id, options),
    runItems: async (id, runId) => ({ items: store.runItems(id, runId) }),
    runItem: async (id, runId, step, { maxChars }) => store.runItem(id, runId, step, maxChars),
    grepSession: async (id, pattern, window) => store.grepSession(id, pattern, window),
  };
}

/**
 * A session's door to other sessions. With an identity it names itself as `self`, caps what it
 * creates at its own mode (`ceilingFrom`) and proves each message with the live claim.
 */
export function sessionsCapability(port: SessionsPort, identity: SessionIdentity | undefined, reads: SessionsReads): SessionsCapability {
  return {
    ...(identity ? { self: { sessionId: identity.sessionId } } : {}),
    ...reads,
    list: (options) => port.liveSessions({ all: options?.settled === true }),
    create: async (input) =>
      (await port.createSession({ ...input, origin: "session", ...(identity ? { ceilingFrom: identity.sessionId } : {}) })).session,
    send: (id, input) => port.submitAgentTurn(id, identity ? { ...input, proof: { sessionId: identity.sessionId, ...identity.proof() } } : input),
    read: async (id, after, options) => (await port.events(id, after, options?.limit)).events,
    stop: (id) => port.stopSession(id, "agent"),
    settle: async (id, settled) => {
      const answer = await port.settleSession(id, settled);
      return answer.ended ? { ...answer.session, ended: answer.ended } : answer.session;
    },
    diff: async (id) => (await port.sessionDiff(id)).diff,
    subscribe: async (subscriber, input) => (await port.subscribe(subscriber, input)).subscription,
    unsubscribe: async (id, subscriber) => (await port.unsubscribe(id, { subscriberSessionId: subscriber })).removed,
    subscriptions: async (subscriber) => (await port.subscriptions(subscriber)).subscriptions,
    subscribeCohort: async (subscriber, input) => (await port.subscribeCohort(subscriber, input)).cohort,
    cohorts: async (subscriber) => (await port.cohorts(subscriber)).cohorts,
    resolveRequest: async (id, requestId, input) => (await port.resolveRequest(id, requestId, { ...input, resolvedBy: "session" })).request,
    query: {
      find: (search) => port.findSessions(search),
      outline: (id, window) => port.sessionOutline(id, window),
      answer: (id, options) => port.turnAnswer(id, options),
      steps: (id, runId) => port.runItems(id, runId),
      step: (id, runId, step, maxChars) => port.runItem(id, runId, step, { maxChars }),
      grep: (id, pattern, window) => port.grepSession(id, pattern, window),
    },
  };
}
