import { afterEach, describe, expect, test } from "bun:test";
import type { ProviderModel } from "@telar/engine-client";
import { STATE_VERSION } from "../../../platform/kernel";
import type { EngineStore } from "../../../state";
import { call, cleanUp, engine, wall } from "./test-helpers";

afterEach(cleanUp);

const row = (id: string, extra: Partial<ProviderModel> = {}): ProviderModel => ({
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

function withCatalogue(store: EngineStore): EngineStore {
  const models = [row("claude-opus-5-5[1m]", { isDefault: true }), row("claude-sonnet-5"), row("claude-haiku-4-5", { efforts: [] })];
  store.kernel.writeDocument(store.kernel.paths.modelCatalogues, {
    version: STATE_VERSION,
    entries: [{ catalogue: { driver: "claude", models, source: "provider", readAt: Date.now(), cliVersion: "2.1.300" }, cliVersion: "2.1.300" }],
  });
  return store;
}

describe("choosing a model for a session an agent starts", () => {
  test("a model and effort named at creation are what the session runs on", async () => {
    const { store, projectId } = engine();
    withCatalogue(store);
    const created = await call(wall(store), "sessions_create", { projectId, envMode: "local", model: "sonnet", effort: "medium" });
    expect(created.json!.model).toBe("claude-sonnet-5 at medium");
    expect(store.records.get(created.json!.id as string).model).toEqual({ instanceId: "claude", model: "claude-sonnet-5", effort: "medium" });
  });

  test("omitting both keeps today's session, with no model of its own", async () => {
    const { store, projectId } = engine();
    withCatalogue(store);
    const created = await call(wall(store), "sessions_create", { projectId, envMode: "local" });
    expect(created.json!.model).toBeUndefined();
    expect(store.records.get(created.json!.id as string).model).toBeUndefined();
  });

  test("a model the Mac does not offer is refused before anything is created", async () => {
    const { store, projectId } = engine();
    withCatalogue(store);
    const before = store.live.all().sessions.length;
    const refused = await call(wall(store), "sessions_create", { projectId, envMode: "worktree", model: "gpt-9" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('"gpt-9" is not a model claude offers. Offered: ');
    expect(refused.text).toContain("claude-haiku-4-5");
    expect(store.live.all().sessions.length).toBe(before);
  });

  test("a task can run one turn on another model or effort; a report cannot name one", async () => {
    const { store, projectId } = engine();
    withCatalogue(store);
    const tools = wall(store);
    const id = (await call(tools, "sessions_create", { projectId, envMode: "local", model: "claude-sonnet-5", effort: "medium" })).json!.id as string;

    await call(tools, "sessions_send", { sessionId: id, intent: "task", input: "review the diff", effort: "high" });
    expect(store.queries.turns(id).at(-1)!.model).toMatchObject({ model: "claude-sonnet-5", effort: "high" });
    expect(store.records.get(id).model?.effort).toBe("medium");

    const refused = await call(tools, "sessions_send", { sessionId: id, input: "fyi", model: "haiku" });
    expect(refused.text).toContain("model and effort apply only to intent: task");
    const wrong = await call(tools, "sessions_send", { sessionId: id, intent: "task", input: "search", model: "haiku", effort: "low" });
    expect(wrong.text).toContain("claude-haiku-4-5 takes no effort; omit it.");
  });
});

describe("sessions_capabilities", () => {
  test("answers the offer with tiers, and the calling session's own model and access", async () => {
    const { store, projectId } = engine();
    withCatalogue(store);
    const host = store.lifecycle.createSession({ projectId, title: "host" });
    const answer = await call(wall(store, { sessionId: host.id }), "sessions_capabilities");
    const json = answer.json as { you: Record<string, unknown>; providers: Array<{ instanceId: string; models: Array<{ id: string; tier?: number }> }> };
    expect(json.you).toMatchObject({ sessionId: host.id, driver: "claude", model: "claude-fable-5-1[1m]", tier: 4, access: host.runtimeMode });
    const tiers = new Map(json.providers.find((provider) => provider.instanceId === "claude")!.models.map((model) => [model.id, model.tier]));
    expect(tiers.get("claude-sonnet-5")).toBe(2);
    expect(tiers.get("claude-haiku-4-5")).toBe(1);
    expect(tiers.has("claude-opus-4-8[1m]")).toBe(false);
  });

  test("its description never changes with the catalogue, so the tool list stays cacheable", () => {
    const { store } = engine();
    const before = wall(store).get("sessions_capabilities")!.description;
    withCatalogue(store);
    expect(wall(store).get("sessions_capabilities")!.description).toBe(before);
  });
});

describe("what a worker's run cost reaches its coordinator", () => {
  test("a result names the model, effort and tokens the run has spent", async () => {
    const { store, projectId } = engine();
    withCatalogue(store);
    const host = store.lifecycle.createSession({ projectId, title: "host" });
    const worker = (await call(wall(store, { sessionId: host.id }), "sessions_create", {
      projectId, envMode: "local", model: "claude-sonnet-5", effort: "medium", task: "fix the lint",
    })).json!.id as string;
    const run = store.queries.turns(worker).at(-1)!.runId;
    const claimToken = store.claims.claimTurn(worker, "worker_cost")!.claim!.token;
    store.turnLifecycle.markRunning(worker, run, claimToken);
    const usage = (input: number, output: number, cacheRead: number) => ({ kind: "usage", usage: { tokens: { input, output, cacheRead, cacheCreate: 2_000 } } });
    store.ingest.ingestObservations(worker, run, claimToken, [usage(1_000, 4_000, 600_000), usage(500, 6_000, 590_000)]);

    const { turn } = store.intake.submitAgentTurn(host.id, { runId: "run_result", input: "Lint fixed.", intent: "result" }, { sessionId: worker, runId: run, claimToken });
    expect(turn.agentNotice).toContain("Its run so far: claude-sonnet-5 at medium effort, 1.2M tokens (1.2M cache read, 4k cache write, 2k in, 10k out).");
  });
});

test("a cohort's closing notice carries each worker's spend on its line", async () => {
  const { store, projectId } = engine();
  withCatalogue(store);
  const host = store.lifecycle.createSession({ projectId, title: "host" });
  const tools = wall(store, { sessionId: host.id });
  const worker = (await call(tools, "sessions_create", { projectId, envMode: "local", model: "haiku", task: "find the callers" })).json!.id as string;
  await call(tools, "sessions_subscribe", { sessionIds: [worker] });
  const run = store.queries.turns(worker).at(-1)!.runId;
  const claimToken = store.claims.claimTurn(worker, "worker_cost")!.claim!.token;
  store.turnLifecycle.markRunning(worker, run, claimToken);
  store.ingest.ingestObservations(worker, run, claimToken, [{ kind: "usage", usage: { tokens: { input: 300, output: 700, cacheRead: 9_000, cacheCreate: 0 } } }]);

  store.intake.submitAgentTurn(host.id, { runId: "run_found", input: "Three callers.", intent: "result" }, { sessionId: worker, runId: run, claimToken });
  const closing = store.queries.turns(host.id).map((turn) => turn.notification?.body ?? "").find((body) => body.startsWith("[cohort done"));
  expect(closing).toContain(`${worker} "New session" — result (claude-haiku-4-5, 10k tokens (9k cache read, 0 cache write, 300 in, 700 out)): Three callers.`);
});
