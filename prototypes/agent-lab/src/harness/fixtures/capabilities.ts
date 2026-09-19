/**
 * THE TWO PORTS, OVER THE FIXTURE ENGINE.
 *
 * `SessionsCapability` and `NotesCapability` are the engine's own types,
 * imported from the engine's own source. Nothing in `apps/engine` is edited or
 * copied: the walls are built over these exactly as the daemon builds them over
 * the store and the worker builds them over `EngineClient`.
 *
 * `self` IS WHAT MAKES THE AGENT A PEER RATHER THAN A SESSION. The built-in
 * Agent this lab is grounding has no Telar session of its own (issue #528's
 * whole premise), so there is no `sessionId` to hand the subscription tools.
 * The fixture gives it one anyway — a synthetic `agentSessionId` that exists
 * only as a subscriber — and the report says where that would have to come from
 * for real.
 */
import type { SessionsCapability } from "../../../../../apps/engine/src/sessions-tools/tools";
import type { NotesCapability } from "../../../../../apps/engine/src/notes-tools/tools";
import type { FixtureEngine } from "./engine";

/** The id the Agent subscribes AS. Not a Telar session: a name a wake is
 *  addressed to, which is all a subscription needs. */
export const AGENT_SUBSCRIBER_ID = "agent_builtin";

export function fixtureSessionsCapability(engine: FixtureEngine, options: { self?: { sessionId: string } } = {}): SessionsCapability {
  const self = options.self ?? { sessionId: AGENT_SUBSCRIBER_ID };
  return {
    self,
    async list(listOptions) {
      const all = engine.liveSessions();
      const unsettled = all.filter((session) => session.settledOverride !== "settled");
      const sessions = listOptions?.settled ? all : unsettled;
      return {
        sessions,
        projects: engine.projects,
        settledCount: all.length - unsettled.length,
      };
    },
    async create(input) {
      return engine.createSession(input);
    },
    async send(sessionId, input) {
      return engine.send(sessionId, input);
    },
    async read(sessionId, after, readOptions) {
      const events = engine.journal(sessionId).filter((event) => event.id > after);
      return typeof readOptions?.limit === "number" ? events.slice(0, readOptions.limit) : events;
    },
    async cursor(sessionId) {
      const events = engine.journal(sessionId);
      return events.length ? events[events.length - 1].id : 0;
    },
    async status(sessionId) {
      return { session: engine.session(sessionId), turns: engine.turns(sessionId) };
    },
    async stop(sessionId) {
      return engine.stop(sessionId);
    },
    async settle(sessionId, settled) {
      return engine.settle(sessionId, settled);
    },
    async diff(sessionId) {
      return engine.diff(sessionId);
    },
    async subscribe(subscriberSessionId, input) {
      return engine.subscribe(subscriberSessionId, input);
    },
    async unsubscribe(subscriptionId, subscriberSessionId) {
      return engine.unsubscribe(subscriptionId, subscriberSessionId);
    },
    async subscriptions(subscriberSessionId) {
      return engine.subscriptions(subscriberSessionId);
    },
    async requests(sessionId) {
      return engine.requests(sessionId);
    },
    async resolveRequest(sessionId, requestId, input) {
      return engine.resolveRequest(sessionId, requestId, input);
    },
  };
}

export function fixtureNotesCapability(engine: FixtureEngine, options: { self?: { projectId: string } } = {}): NotesCapability {
  const self = options.self ?? { projectId: engine.projects[0].id };
  return {
    self,
    async projects() {
      return engine.projects;
    },
    async list(projectId) {
      const notes = engine.notes(projectId);
      return [...notes].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
    },
    async read(noteId) {
      return engine.findNote(noteId);
    },
    async create(projectId, input) {
      return engine.writeNote(projectId, { ...input, author: "session" });
    },
    async update(projectId, noteId, patch) {
      return engine.updateNote(projectId, noteId, patch);
    },
    async remove(projectId, noteId) {
      return engine.removeNote(projectId, noteId);
    },
  };
}
