import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RequestDetail, RequestKind } from "@telar/engine-client";
import { EngineStore } from "../../state";
import { usageRoutes } from "./routes";

const homes: string[] = [];
const stores: EngineStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.kernel.executionStore.close();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

function running(purpose?: "usage-diagnosis") {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-diag-gate-"));
  homes.push(home);
  const store = new EngineStore(home, () => 100);
  stores.push(store);
  store.lifecycle.createSession({ id: "session_one", driver: "codex", ...(purpose ? { purpose } : {}) });
  store.intake.submitTurn("session_one", { runId: "run_one", input: "Diagnose" });
  const claim = store.claims.claimNextTurn("worker_one")!;
  store.turnLifecycle.markRunning("session_one", "run_one", claim.turn.claim!.token);
  let next = 0;
  const ask = (kind: RequestKind, detail: RequestDetail) =>
    store.requestGate.open("session_one", "run_one", claim.turn.claim!.token, { requestId: `request_${++next}`, kind, detail });
  return { store, claim, ask };
}

const call = (name: string): RequestDetail => ({ kind: "tool_call", call: { name, input: {} } });

test("a diagnosis claim runs in the engine's folder with nothing of the person's own", () => {
  const { store, claim } = running("usage-diagnosis");

  expect(claim).toMatchObject({ readOnly: true, projectRoot: store.paths.root });
  expect(claim.mcpServers).toBeUndefined();
  expect(claim.plugins).toBeUndefined();
  expect(claim.orientation).toBeUndefined();
});

test("the gate accepts only the diagnosis read tools and declines everything else without parking", () => {
  const { ask } = running("usage-diagnosis");

  expect(ask("tool_call", call("mcp__telar__usage_sql"))).toMatchObject({ state: "resolved", decision: "accept", resolvedBy: "policy" });
  expect(ask("tool_call", call("mcp__telar__usage_read"))).toMatchObject({ decision: "accept" });
  for (const [kind, detail] of [
    ["file_change", { kind: "file_change", change: { path: "projects.json", kind: "edit" } }],
    ["file_read", { kind: "file_read", read: { path: "provider-secrets.json" } }],
    ["command_execution", { kind: "command_execution", command: { command: "rm -rf ~" } }],
    ["tool_call", call("mcp__telar__sessions_send")],
    ["tool_call", call("mcp__someone__usage_read")],
    ["tool_call", call("WebFetch")],
    ["user_input", { kind: "user_input", prompt: "Which?", fields: [] }],
  ] as Array<[RequestKind, RequestDetail]>) {
    expect(ask(kind, detail)).toMatchObject({ state: "resolved", decision: "decline", resolvedBy: "policy" });
  }
});

test("an ordinary session keeps its runtime mode's own answers", () => {
  const { ask } = running();

  expect(ask("tool_call", call("mcp__telar__usage_sql"))).not.toMatchObject({ decision: "decline" });
});

test("a diagnosis session is kept off the rail and its shelf", () => {
  const { store } = running("usage-diagnosis");
  store.lifecycle.createSession({ id: "session_two", driver: "codex" });

  expect(store.live.rows({ all: true }).sessions.map((session) => session.id)).toEqual(["session_two"]);
  expect(store.live.rows({ shelf: true }).sessions).toEqual([]);
});

test("the read tools answer only a running diagnosis", async () => {
  const route = (store: EngineStore) => usageRoutes(store).find((candidate) => String(candidate.path).includes("usage-diagnosis"))!;
  const invoke = (store: EngineStore) =>
    route(store).handle({ params: ["session_one", "read"], body: { path: "." } } as never) as Promise<{ body: { text: string } }> | { body: { text: string } };

  const diagnosis = running("usage-diagnosis").store;
  expect((await invoke(diagnosis)).body.text).toContain("execution.sqlite");

  const ordinary = running().store;
  expect(() => invoke(ordinary)).toThrow(/running usage diagnosis/);
});
