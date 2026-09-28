import type { WorkerClaim } from "@telar/engine-client";
import { pluginToolModules } from "../plugins/bundled";
import { pluginCall } from "../plugins/tool-module";
import type { NotesCapability } from "../domains/notes";
import type { PromptsCapability } from "../prompts-tools/tools";
import { promptsForComposer } from "../prompts";
import { createDisplayCapability } from "../display/capability";
import { clientRunCapability } from "../run/client-capability";
import type { SessionsCapability } from "../provider-contract";
import type { WorkerClient } from "./options";
import type { TurnHost } from "./host";

/** How many settled turns `sessions_read { runId }` searches before reading the whole history. */
const RECENT_TURN_LOOKUP = 20;

type ClaimProof = { runId: string; claimToken: string };

/**
 * A session's door to other sessions, over the client. `proof` is read when `send` is called:
 * this object outlives the turn that built it, and the engine stamps the sender from the claim.
 */
function sessionsCapability(client: WorkerClient, sessionId: string, proof: () => ClaimProof): SessionsCapability {
  return {
    self: { sessionId },
    list: (options) => client.liveSessions({ all: options?.settled === true }),
    // `ceilingFrom` caps the new session's mode at this one's; the engine reads the mode itself.
    create: async (input) => (await client.createSession({ ...input, origin: "session", ceilingFrom: sessionId })).session,
    send: async (id, input) => {
      const accepted = await client.submitAgentTurn(id, { ...input, proof: { sessionId, ...proof() } });
      return { turn: accepted.turn, replayed: accepted.replayed };
    },
    read: async (id, after, options) => (await client.events(id, after, options?.limit)).events,
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
    stop: (id) => client.stopSession(id, "agent"),
    settle: async (id, settled) => {
      const answer = await client.settleSession(id, settled);
      return answer.ended ? { ...answer.session, ended: answer.ended } : answer.session;
    },
    diff: async (id) => (await client.sessionDiff(id)).diff,
    subscribe: async (subscriber, input) => (await client.subscribe(subscriber, input)).subscription,
    unsubscribe: async (id, subscriber) => (await client.unsubscribe(id, { subscriberSessionId: subscriber })).removed,
    subscriptions: async (subscriber) => (await client.subscriptions(subscriber)).subscriptions,
    subscribeCohort: async (subscriber, input) => (await client.subscribeCohort(subscriber, input)).cohort,
    cohorts: async (subscriber) => (await client.cohorts(subscriber)).cohorts,
    // Every open request rides every windowed page, so one turn is enough.
    requests: async (id) => (await client.session(id, { turns: 1 })).requests,
    resolveRequest: async (id, requestId, input) => (await client.resolveRequest(id, requestId, { ...input, resolvedBy: "session" })).request,
    query: {
      find: (search) => client.findSessions(search),
      outline: (id, window) => client.sessionOutline(id, window),
      answer: (id, options) => client.turnAnswer(id, options),
      steps: (id, runId) => client.runItems(id, runId),
      step: (id, runId, step, maxChars) => client.runItem(id, runId, step, { maxChars }),
      grep: (id, pattern, window) => client.grepSession(id, pattern, window),
    },
  };
}

/** The project's notebook; a read by id alone is answered within this project. */
function notesCapability(client: WorkerClient, projectId: string): NotesCapability {
  return {
    self: { projectId },
    projects: async () => (await client.listProjects()).projects.map((project) => ({ id: project.id, name: project.name })),
    list: async (id) => (await client.projectNotes(id)).notes,
    read: async (noteId) => {
      try {
        return { note: (await client.projectNote(projectId, noteId)).note, projectId };
      } catch {
        return null;
      }
    },
    create: async (id, input) => (await client.createProjectNote(id, { ...input, author: "session" })).note,
    update: async (id, noteId, patch) => {
      try {
        return (await client.updateProjectNote(id, noteId, patch)).note;
      } catch {
        return null;
      }
    },
    remove: async (id, noteId) => (await client.deleteProjectNote(id, noteId)).deleted,
  };
}

/** The prompt shelf. A draft reports itself so the cockpit hears now; a failed report is swallowed because the prompt landed. */
function promptsCapability(client: WorkerClient, projectId: string, sessionId: string, report: (observation: { kind: "prompt.drafted"; promptId: string; title: string; forSessionId?: string }) => Promise<unknown>): PromptsCapability {
  return {
    self: { projectId, sessionId },
    list: async () => promptsForComposer((await client.projectPrompts(projectId)).prompts, sessionId),
    create: async (input) => {
      const prompt = (await client.createProjectPrompt(projectId, { ...input, author: "session" })).prompt;
      await report({
        kind: "prompt.drafted",
        promptId: prompt.id,
        title: prompt.title,
        ...(prompt.sessionId ? { forSessionId: prompt.sessionId } : {}),
      }).catch(() => undefined);
      return prompt;
    },
    remove: async (promptId) => (await client.deleteProjectPrompt(projectId, promptId)).deleted,
  };
}

/** Each enabled plugin's capability by id; an id this binary does not bundle is looked for once, then absent. */
function pluginCapabilities(host: TurnHost, sessionId: string, enabled: string[] | undefined) {
  const unknown = (enabled ?? []).filter((id) => !host.pluginsLookedFor.has(id) && !pluginToolModules().some((module) => module.meta.id === id));
  if (unknown.length > 0) {
    for (const id of unknown) host.pluginsLookedFor.add(id);
    host.options.refreshPlugins?.();
  }
  return Object.fromEntries(
    pluginToolModules()
      .filter((module) => enabled?.includes(module.meta.id))
      .map((module) => [module.meta.id, module.capability(pluginCall(host.options.client, sessionId, module.meta.id))]),
  );
}

/** Everything the `telar` wall serves this turn, for the in-process server and the socket lease alike. */
export function telarCapabilities(host: TurnHost, claim: WorkerClaim, runId: string, claimToken: string) {
  const { client } = host.options;
  const { sessionId, projectId, projectRoot: cwd } = claim;
  const report = (observations: Parameters<WorkerClient["reportObservations"]>[3]) => client.reportObservations(sessionId, runId, claimToken, observations);
  const sessions = sessionsCapability(client, sessionId, () => host.liveClaims.get(sessionId) ?? { runId, claimToken });
  const notes = projectId ? notesCapability(client, projectId) : undefined;
  const prompts = projectId ? promptsCapability(client, projectId, sessionId, (observation) => report([observation])) : undefined;
  const plugins = pluginCapabilities(host, sessionId, claim.plugins);
  const display =
    cwd === undefined
      ? undefined
      : createDisplayCapability({ cwd, report: (observation) => report([{ kind: "display.opened", ...observation }]).then(() => undefined) });
  const run = projectId && cwd ? clientRunCapability(client, sessionId) : undefined;
  return {
    sessions,
    ...(notes ? { notes } : {}),
    ...(prompts ? { prompts } : {}),
    ...(display ? { display } : {}),
    ...(run ? { run } : {}),
    ...(Object.keys(plugins).length > 0 ? { plugins } : {}),
  };
}
