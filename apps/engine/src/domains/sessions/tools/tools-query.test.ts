import { afterEach, describe, expect, test } from "bun:test";
import { EngineStore } from "../../../state";
import { cleanUp, tmp, repo, openStores, wall, call } from "./test-helpers";

afterEach(cleanUp);

function queryEngine(): { store: EngineStore; projectId: string } {
  const projectRoot = repo();
  const store = new EngineStore(tmp("telar-sessions-query-"), () => Date.now());
  openStores.push(store);
  const project = store.projectRegistry.register({ name: "aurora", root: projectRoot });
  return { store, projectId: project.id };
}

function conversation(store: EngineStore, sessionId: string, runId: string, input: string, answer: string, items = 3): void {
  store.intake.submitTurn(sessionId, { runId, input });
  const token = store.claims.claimTurn(sessionId, "worker_one")!.claim!.token;
  store.turnLifecycle.markRunning(sessionId, runId, token);
  store.ingest.ingestObservations(
    sessionId,
    runId,
    token,
    Array.from({ length: items }, (_, step) => `${runId}_item_${step}`).flatMap((id, step) => [
      { kind: "item.started" as const, item: { id, title: `step ${step} of ${runId}`, detail: { type: "assistant_message" as const, text: "" } } },
      { kind: "item.completed" as const, itemId: id, status: "completed" as const, detail: { type: "assistant_message" as const, text: `body of step ${step}` } },
    ]),
  );
  store.turnLifecycle.completeTurn(sessionId, runId, token, { text: answer });
}

describe("the six query tools", () => {
  test("each one answers its own question, from the projection rather than the journal", async () => {
    const { store, projectId } = queryEngine();
    const session = store.lifecycle.createSession({ projectId, title: "the appearance rework" });
    conversation(store, session.id, "run_1", "rework the appearance panel\nand a second line", "I finished the appearance rework.");
    const tools = wall(store);

    const found = await call(tools, "sessions_find", { q: "appearance" });
    const hits = found.json!.sessions as Array<{ id: string; why: string }>;
    expect(hits.map((hit) => hit.id)).toContain(session.id);
    expect(hits.find((hit) => hit.id === session.id)!.why).toContain("appearance");
    expect(["fts5", "like"]).toContain(found.json!.index as string);

    const outline = await call(tools, "sessions_outline", { sessionId: session.id });
    const turns = outline.json!.turns as Array<{ runId: string; input: string; answer: string; items: number; answerChars: number }>;
    expect(turns).toHaveLength(1);
    expect(turns[0]!.runId).toBe("run_1");
    expect(turns[0]!.input).toBe("rework the appearance panel");
    expect(turns[0]!.items).toBe(3);
    expect(turns[0]!.answerChars).toBe("I finished the appearance rework.".length);

    const answered = await call(tools, "sessions_answer", { sessionId: session.id });
    expect(answered.json!.text).toBe("I finished the appearance rework.");
    expect(answered.json!.runId).toBe("run_1");
    expect(answered.json!.more).toBe(false);
    expect(String(answered.json!.note)).toContain("That is the whole answer");

    const steps = await call(tools, "sessions_steps", { sessionId: session.id, runId: "run_1" });
    const rows = steps.json!.items as Array<{ index: number; id: string; title: string; bytes: number }>;
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.index)).toEqual([0, 1, 2]);
    expect(rows[0]!.title).toBe("step 0 of run_1");
    expect(rows.every((row) => row.bytes > 0)).toBe(true);
    expect(steps.json!.total).toBe(3);
    expect(steps.json!.more).toBe(false);

    const step = await call(tools, "sessions_step", { sessionId: session.id, runId: "run_1", step: 1 });
    expect(step.json!.index).toBe(1);
    expect(String(step.json!.text)).toContain("body of step 1");
    expect(step.json!.more).toBe(false);
    expect(String(step.json!.note)).toContain("That step, whole");

    const grepped = await call(tools, "sessions_grep", { sessionId: session.id, pattern: "body of step 2" });
    const matches = grepped.json!.matches as Array<{ id: number; context: string; type: string }>;
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]!.context).toContain("body of step 2");
  });

  test("a long run is paged by rows and by bytes, and the cursor skips nothing", async () => {
    const { store, projectId } = queryEngine();
    const session = store.lifecycle.createSession({ projectId });
    conversation(store, session.id, "run_long", "do a great many things", "done", 140);
    const tools = wall(store);

    const first = await call(tools, "sessions_steps", { sessionId: session.id, runId: "run_long" });
    const page = first.json!.items as Array<{ index: number }>;
    expect(page).toHaveLength(50);
    expect(first.json!.total).toBe(140);
    expect(first.json!.more).toBe(true);
    expect(first.json!.next).toBe(50);
    expect(String(first.json!.note)).toContain("after: 50");

    const seen = page.map((row) => row.index);
    let cursor = first.json!.next as number;
    for (let guard = 0; guard < 10; guard += 1) {
      const next = await call(tools, "sessions_steps", { sessionId: session.id, runId: "run_long", after: cursor });
      for (const row of next.json!.items as Array<{ index: number }>) seen.push(row.index);
      if (next.json!.more !== true) break;
      cursor = next.json!.next as number;
    }
    expect(seen).toEqual(Array.from({ length: 140 }, (_, index) => index));

    const widest = await call(tools, "sessions_steps", { sessionId: session.id, runId: "run_long", limit: 5_000 });
    expect((widest.json!.items as unknown[]).length).toBeLessThanOrEqual(140);
  });

  test("a step is addressed by index or by item id, and a step that is not there refuses readably", async () => {
    const { store, projectId } = queryEngine();
    const session = store.lifecycle.createSession({ projectId });
    conversation(store, session.id, "run_1", "ask", "answer");
    const tools = wall(store);

    const byIndex = await call(tools, "sessions_step", { sessionId: session.id, runId: "run_1", step: 2 });
    const byId = await call(tools, "sessions_step", { sessionId: session.id, runId: "run_1", step: byIndex.json!.id as string });
    expect(byId.json!.id).toBe(byIndex.json!.id);
    expect(byId.json!.index).toBe(2);

    const missing = await call(tools, "sessions_step", { sessionId: session.id, runId: "run_1", step: 99 });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("no such step");
    expect(missing.text).toContain("run_1");

    const nonsense = await call(tools, "sessions_step", { sessionId: session.id, runId: "run_1", step: -4 });
    expect(nonsense.isError).toBe(true);
    expect(nonsense.text).toContain("sessions_steps");
  });

  test("a step longer than the budget is clamped, marked, and says how to ask for more", async () => {
    const { store, projectId } = queryEngine();
    const session = store.lifecycle.createSession({ projectId });
    store.intake.submitTurn(session.id, { runId: "run_big", input: "write a lot" });
    const token = store.claims.claimTurn(session.id, "worker_one")!.claim!.token;
    store.turnLifecycle.markRunning(session.id, "run_big", token);
    const huge = "the body of one enormous step, said again and again. ".repeat(400);
    store.ingest.ingestObservations(session.id, "run_big", token, [
      { kind: "item.started", item: { id: "item_big", title: "a big step", detail: { type: "assistant_message", text: "" } } },
      { kind: "item.completed", itemId: "item_big", status: "completed", detail: { type: "assistant_message", text: huge } },
    ]);
    store.turnLifecycle.completeTurn(session.id, "run_big", token, { text: "done" });
    const tools = wall(store);

    const clamped = await call(tools, "sessions_step", { sessionId: session.id, runId: "run_big", step: 0, maxChars: 2_000 });
    expect(clamped.json!.more).toBe(true);
    expect(clamped.json!.totalChars as number).toBeGreaterThan(2_000);
    expect(String(clamped.json!.text)).toContain("more characters]");
    expect(String(clamped.json!.note)).toContain("Raise maxChars");

    const whole = await call(tools, "sessions_step", { sessionId: session.id, runId: "run_big", step: 0, maxChars: 64_000 });
    expect(whole.json!.more).toBe(false);
    expect(String(whole.json!.text)).not.toContain("more characters]");
  });

  test("grep pages newest first, and an empty search says so rather than looking like a small answer", async () => {
    const { store, projectId } = queryEngine();
    const session = store.lifecycle.createSession({ projectId });
    for (let lap = 0; lap < 6; lap += 1) conversation(store, session.id, `run_${lap}`, `lap ${lap}`, `could not take the index.lock on lap ${lap}`);
    const tools = wall(store);

    const page = await call(tools, "sessions_grep", { sessionId: session.id, pattern: "index.lock", limit: 2 });
    const matches = page.json!.matches as Array<{ id: number }>;
    expect(matches).toHaveLength(2);
    expect(page.json!.more).toBe(true);
    expect(matches[0]!.id).toBeGreaterThan(matches[1]!.id);
    expect(page.json!.next).toBe(matches[1]!.id);
    const older = await call(tools, "sessions_grep", { sessionId: session.id, pattern: "index.lock", limit: 2, before: page.json!.next as number });
    expect((older.json!.matches as Array<{ id: number }>)[0]!.id).toBeLessThan(page.json!.next as number);

    const nothing = await call(tools, "sessions_grep", { sessionId: session.id, pattern: "a phrase nobody ever wrote" });
    expect(nothing.json!.matches).toEqual([]);
    expect(String(nothing.json!.note)).toContain("substring match");
  });
});
