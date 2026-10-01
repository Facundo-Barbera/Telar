// The sessions wall over a real `EngineStore` and a real git repository. No worker
// is registered, so a submitted turn is never claimed unless a test claims it.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderModel } from "@telar/engine-client";
import { STATE_VERSION } from "../../../platform/kernel";
import { EngineStore } from "../../../state";
import { sessionsTools, type SessionsCapability } from "..";
import { sessionsCapability, storeReads, storeSessionsPort } from "../capability";

function knownClaudeDefault(directory: string): string {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
  return directory;
}

const roots: string[] = [];
export const tmp = (prefix: string): string => {
  const directory = knownClaudeDefault(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(directory);
  return directory;
};

/** Closed before their directory is removed. */
export const openStores: EngineStore[] = [];

export function cleanUp(): void {
  for (const store of openStores.splice(0)) store.kernel.executionStore.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
}

export function repo(): string {
  const root = tmp("telar-sessions-repo-");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@telar.local");
  git("config", "user.name", "Telar Test");
  fs.writeFileSync(path.join(root, "README.md"), "hello\n");
  git("add", "-A");
  git("commit", "-qm", "initial");
  return root;
}

export type Registered = {
  name: string;
  description: string;
  shape: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<{ content: unknown[]; isError?: boolean }>;
};

/** The daemon's own capability; the socket test's parity assertion keeps the two in step. */
export function capabilityOver(store: EngineStore, self?: { sessionId: string }): SessionsCapability {
  return {
    ...(self ? { self } : {}),
    list: async () => store.live.all(),
    create: async (input) => store.requestPath.createSession({ ...input, origin: "session" }),
    send: async (sessionId, input) => store.requestPath.submitAgentTurn(sessionId, input),
    read: async (sessionId, after) => store.queries.readEvents(sessionId, after),
    capabilities: async () => store.sessionCapabilities(self?.sessionId),
    status: async (sessionId) => ({
      session: store.records.get(sessionId),
      turns: store.queries.turns(sessionId),
      pendingNotifications: store.wakes.pendingNotifications(sessionId),
    }),
    stop: async (sessionId) => store.turnLifecycle.stopSession(sessionId, "agent"),
    settle: async (sessionId, settled) => {
      const session = store.lifecycle.updateSession(sessionId, { settledOverride: settled ? "settled" : "active" });
      if (!settled) return session;
      const ended = await store.settler.endLeftovers(sessionId);
      return { ...store.records.get(sessionId), ended };
    },
    diff: async (sessionId) => store.workspaceReads.sessionDiff(sessionId),
    subscribe: async (subscriber, input) => store.subscriptions.subscribe(subscriber, input),
    unsubscribe: async (id, subscriber) => store.subscriptions.unsubscribe(id, subscriber),
    subscriptions: async (subscriber) => store.subscriptions.subscriptionsFor(subscriber),
    subscribeCohort: async (subscriber, input) => store.subscriptions.subscribeCohort(subscriber, input),
    cohorts: async (subscriber) => store.subscriptions.cohortsFor(subscriber),
    requests: async (sessionId) => store.requestGate.list(sessionId),
    resolveRequest: async (sessionId, requestId, input) => store.requestGate.resolve(sessionId, requestId, { ...input, resolvedBy: "session" }),
    query: {
      find: async (search) => store.queries.findSessions(search),
      outline: async (sessionId, window) => store.queries.turnOutline(sessionId, window),
      answer: async (sessionId, options) => store.queries.turnAnswer(sessionId, options),
      steps: async (sessionId, runId) => ({ items: store.queries.runItems(sessionId, runId) }),
      step: async (sessionId, runId, step, maxChars) => store.queries.runItem(sessionId, runId, step, maxChars),
      grep: async (sessionId, pattern, window) => store.queries.grepSession(sessionId, pattern, window),
    },
  };
}

/** `diff` is the one member a test may replace, and only with the engine's own reader. */
export function wall(store: EngineStore, self?: { sessionId: string }, diff?: SessionsCapability["diff"]): Map<string, Registered> {
  const registered = new Map<string, Registered>();
  sessionsTools(
    (name, description, shape, run) => {
      registered.set(name, { name, description, shape, run });
      return { name };
    },
    { ...capabilityOver(store, self), ...(diff ? { diff } : {}) },
  );
  return registered;
}

/** A store on a fresh engine root with one registered project; `options` is the store's own. */
export function engine(options?: ConstructorParameters<typeof EngineStore>[2]): { store: EngineStore; projectId: string; projectRoot: string } {
  const projectRoot = repo();
  const store = new EngineStore(tmp("telar-sessions-state-"), Date.now, options);
  const project = store.projectRegistry.register({ name: "aurora", root: projectRoot });
  return { store, projectId: project.id, projectRoot };
}

export function orchestrator(store: EngineStore, projectId: string) {
  const parent = store.lifecycle.createSession({ projectId, title: "the orchestrator" });
  store.intake.submitTurn(parent.id, { runId: "run_parent", input: "dispatch" });
  const claimToken = store.claims.claimTurn(parent.id, "worker_one")!.claim!.token;
  store.turnLifecycle.markRunning(parent.id, "run_parent", claimToken);
  const tools = new Map<string, Registered>();
  sessionsTools(
    (name, description, shape, run) => {
      tools.set(name, { name, description, shape, run });
      return { name };
    },
    sessionsCapability(storeSessionsPort(store), { sessionId: parent.id, proof: () => ({ runId: "run_parent", claimToken }) }, storeReads(store)),
  );
  return { parent, tools };
}

const catalogueRow = (id: string, extra: Partial<ProviderModel> = {}): ProviderModel => ({
  id,
  label: id,
  isDefault: false,
  hidden: false,
  hiddenByUser: false,
  legacy: false,
  source: "provider",
  efforts: ["low", "medium", "high"],
  fastMode: false,
  ...extra,
});

export function withModelCatalogue(store: EngineStore): EngineStore {
  const models = [catalogueRow("claude-opus-5-5[1m]", { isDefault: true }), catalogueRow("claude-sonnet-5"), catalogueRow("claude-haiku-4-5", { efforts: [] })];
  store.kernel.writeDocument(store.kernel.paths.modelCatalogues, {
    version: STATE_VERSION,
    entries: [{ catalogue: { driver: "claude", models, source: "provider", readAt: Date.now(), cliVersion: "2.1.300" }, cliVersion: "2.1.300" }],
  });
  return store;
}

/** The JSON a tool answered with, or the error text when it refused. */
export async function call(tools: Map<string, Registered>, name: string, args: Record<string, unknown> = {}) {
  const tool = tools.get(name);
  if (!tool) throw new Error(`no tool named ${name} on the wall`);
  const result = await tool.run(args);
  const text = (result.content[0] as { text: string }).text;
  return { isError: result.isError === true, text, json: result.isError ? undefined : (JSON.parse(text) as Record<string, unknown>) };
}
