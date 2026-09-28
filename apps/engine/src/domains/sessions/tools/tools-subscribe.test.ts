import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { cleanUp, wall, engine, call } from "./test-helpers";

afterEach(cleanUp);

describe("subscribing and answering", () => {
  test("without a self there is nobody to wake: every subscribe mode refuses in words", async () => {
    const { store, projectId } = engine();
    const tools = wall(store);
    const target = store.lifecycle.createSession({ projectId, title: "a target" });
    for (const args of [{ sessionIds: [target.id] }, { cancel: "sub_x" }, {}]) {
      const refused = await call(tools, "sessions_subscribe", args);
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("no session to wake");
    }
  });

  test("a subscription wakes once", async () => {
    const { store, projectId } = engine();
    const host = store.lifecycle.createSession({ projectId, title: "coordinator" });
    const target = store.lifecycle.createSession({ projectId, title: "worker" });
    const tools = wall(store, { sessionId: host.id });
    await call(tools, "sessions_subscribe", { sessionIds: [target.id] });
    for (const runId of ["run_first", "run_second"]) {
      store.intake.submitTurn(target.id, { runId, input: "work" });
      const token = store.claims.claimTurn(target.id, "worker_one")!.claim!.token;
      store.turnLifecycle.markRunning(target.id, runId, token);
      store.turnLifecycle.completeTurn(target.id, runId, token, { text: "done" });
    }
    expect(store.subscriptions.subscriptionsFor(host.id)).toHaveLength(0);
    expect(store.queries.turns(host.id)).toHaveLength(1);
  });

  test("sessionIds subscribes a cohort, which is listed and removed by its id", async () => {
    const { store, projectId } = engine();
    const host = store.lifecycle.createSession({ projectId, title: "coordinator" });
    const one = store.lifecycle.createSession({ projectId, title: "one" });
    const two = store.lifecycle.createSession({ projectId, title: "two" });
    const tools = wall(store, { sessionId: host.id });
    const made = await call(tools, "sessions_subscribe", { sessionIds: [one.id, two.id], timeoutMinutes: 60 });
    expect(made.isError).toBe(false);
    expect(made.json!.id as string).toStartWith("coh_");
    expect(made.json!.note as string).toContain("ONE notification when all 2 are done");
    const again = await call(tools, "sessions_subscribe", { sessionIds: [two.id, one.id] });
    expect(again.json!.id).toBe(made.json!.id);
    expect(again.json!.note as string).toStartWith(`Already subscribed (${made.json!.id as string})`);
    const listed = await call(tools, "sessions_subscribe");
    expect(listed.json!.cohorts).toEqual([{ id: made.json!.id, expiresAt: made.json!.expiresAt, pending: [one.id, two.id], members: 2 }]);
    const removed = await call(tools, "sessions_subscribe", { cancel: made.json!.id });
    expect(removed.json!.removed).toBe(true);
    expect(store.subscriptions.cohortsFor(host.id)).toHaveLength(0);
    expect((await call(tools, "sessions_subscribe", { sessionIds: [] })).isError).toBe(true);
  });

  test("one mode per call: mixed arguments are refused in words and change nothing", async () => {
    const { store, projectId } = engine();
    const host = store.lifecycle.createSession({ projectId, title: "coordinator" });
    const target = store.lifecycle.createSession({ projectId, title: "worker" });
    const tools = wall(store, { sessionId: host.id });
    const made = await call(tools, "sessions_subscribe", { sessionIds: [target.id] });

    const both = await call(tools, "sessions_subscribe", { sessionIds: [target.id], cancel: made.json!.id });
    expect(both.isError).toBe(true);
    expect(both.text).toContain("not both");
    const timedCancel = await call(tools, "sessions_subscribe", { cancel: made.json!.id, timeoutMinutes: 5 });
    expect(timedCancel.isError).toBe(true);
    expect(timedCancel.text).toContain("cancel takes only the id");
    const timedList = await call(tools, "sessions_subscribe", { timeoutMinutes: 5 });
    expect(timedList.isError).toBe(true);
    expect(timedList.text).toContain("needs sessionIds");
    expect(store.subscriptions.cohortsFor(host.id).map((cohort) => cohort.id)).toEqual([made.json!.id as string]);

    const empty = await call(tools, "sessions_subscribe", { cancel: made.json!.id });
    expect(empty.json!.removed).toBe(true);
    expect((await call(tools, "sessions_subscribe")).json!.note).toBe("This session is not subscribed to anything.");
  });

  test("a peer cannot restart a human-stopped session or add to its history", async () => {
    const { store, projectId } = engine();
    const host = store.lifecycle.createSession({ projectId, title: "coordinator" });
    const peer = store.lifecycle.createSession({ projectId, title: "peer" });
    store.subscriptions.subscribe(host.id, { targetSessionId: peer.id });
    store.turnLifecycle.stopSession(host.id, "user");
    const tools = wall(store, { sessionId: peer.id });
    expect((await call(tools, "sessions_send", { intent: "task", sessionId: host.id, input: "another update" })).isError).toBe(true);
    store.intake.submitTurn(peer.id, { runId: "run_peer", input: "work" });
    const token = store.claims.claimTurn(peer.id, "worker_one")!.claim!.token;
    store.turnLifecycle.markRunning(peer.id, "run_peer", token);
    store.turnLifecycle.completeTurn(peer.id, "run_peer", token, { text: "done" });
    expect(store.queries.turns(host.id)).toHaveLength(0);
    store.intake.submitTurn(host.id, { runId: "run_human", input: "continue" });
    expect(store.records.get(host.id).agentMessagesBlocked).toBeUndefined();
    expect((await call(tools, "sessions_send", { intent: "task", sessionId: host.id, input: "fresh report" })).isError).not.toBe(true);
    expect(store.queries.turns(host.id)).toHaveLength(2);
  });

  test("subscribe, list, unsubscribe — a round trip that records nothing on either session", async () => {
    const { store, projectId } = engine();
    const host = store.lifecycle.createSession({ projectId, title: "the orchestrator" });
    const tools = wall(store, { sessionId: host.id });
    const target = store.lifecycle.createSession({ projectId, title: "a worker" });

    const subscribed = await call(tools, "sessions_subscribe", { sessionIds: [target.id] });
    expect(subscribed.isError).toBe(false);
    expect(subscribed.json).toMatchObject({ subscriberSessionId: host.id, members: [{ sessionId: target.id }] });
    expect(String(subscribed.json!.note)).toContain(`ONE notification when ${target.id} is done`);

    const listed = await call(tools, "sessions_subscribe");
    expect((listed.json!.cohorts as unknown[]).length).toBe(1);

    for (const id of [host.id, target.id]) {
      const stored = fs.readFileSync(path.join(store.paths.sessions, id, "session.json"), "utf8");
      expect(stored).not.toContain(id === host.id ? target.id : host.id);
    }

    const removed = await call(tools, "sessions_subscribe", { cancel: subscribed.json!.id });
    expect(removed.json!.removed).toBe(true);
    const again = await call(tools, "sessions_subscribe", { cancel: subscribed.json!.id });
    expect(again.isError).toBe(false);
    expect(again.json!.removed).toBe(false);
  });

  test("a peer's question is listed with its fields, and answering it is recorded as a session's", async () => {
    const { store, projectId } = engine();
    const host = store.lifecycle.createSession({ projectId, title: "the orchestrator" });
    const tools = wall(store, { sessionId: host.id });
    const target = store.lifecycle.createSession({ projectId, title: "a worker" });
    store.intake.submitTurn(target.id, { runId: "run_t", input: "go" });
    const token = store.claims.claimTurn(target.id, "worker_one")!.claim!.token;
    store.turnLifecycle.markRunning(target.id, "run_t", token);
    store.requestGate.open(target.id, "run_t", token, {
      requestId: "req_q",
      kind: "user_input",
      detail: { kind: "user_input", prompt: "Which database?", fields: [{ key: "db", label: "Database", kind: "choice", choices: ["postgres", "sqlite"] }] },
    });

    const listed = await call(tools, "sessions_requests", { sessionId: target.id });
    expect(listed.isError).toBe(false);
    const [request] = listed.json!.requests as Array<Record<string, unknown>>;
    expect(request).toMatchObject({ id: "req_q", kind: "user_input", prompt: "Which database?" });
    expect((request!.fields as Array<Record<string, unknown>>)[0]).toMatchObject({ key: "db", choices: ["postgres", "sqlite"] });

    const answered = await call(tools, "sessions_resolve_request", { sessionId: target.id, requestId: "req_q", decision: "accept", answers: { db: "postgres" } });
    expect(answered.isError).toBe(false);
    expect(answered.json!.resolvedBy).toBe("session");
    expect(store.requestGate.list(target.id)[0]).toMatchObject({ state: "resolved", decision: "accept", resolvedBy: "session", answers: { db: "postgres" } });
  });

  test("a secret pick is the user's alone — listed by origin only, refused to resolve", async () => {
    const { store, projectId } = engine();
    const host = store.lifecycle.createSession({ projectId, title: "the orchestrator" });
    const tools = wall(store, { sessionId: host.id });
    const target = store.lifecycle.createSession({ projectId, title: "a worker" });
    store.intake.submitTurn(target.id, { runId: "run_t", input: "go" });
    const token = store.claims.claimTurn(target.id, "worker_one")!.claim!.token;
    store.turnLifecycle.markRunning(target.id, "run_t", token);
    store.requestGate.open(target.id, "run_t", token, {
      requestId: "req_s",
      kind: "secret_access",
      detail: {
        kind: "secret_access",
        secret: { origin: "https://github.com", fields: [{ kind: "password" }], candidates: [{ id: "item_1", title: "GitHub", domain: "github.com" }] },
      },
    });

    const listed = await call(tools, "sessions_requests", { sessionId: target.id });
    expect(listed.text).toContain("https://github.com");
    expect(listed.text).not.toContain("item_1");
    const refused = await call(tools, "sessions_resolve_request", { sessionId: target.id, requestId: "req_s", decision: "accept" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("user's alone");
    expect(store.requestGate.list(target.id)[0]!.state).toBe("open");
  });
});
