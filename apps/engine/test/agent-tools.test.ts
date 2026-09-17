/**
 * THE AGENT'S WALL, ITS GATE, AND THE SEND THAT CANNOT LAND TWICE (#531).
 *
 * What must not drift:
 *
 *   - the wall is exactly 21 tools, and none of them is a shell, a file or a
 *     browser — absent, not disabled;
 *   - the gate is argument-aware: a task is asked about, a report is not;
 *   - reads are never gated, because a gate on a read teaches people to click
 *     through gates;
 *   - one tool call id produces one run id, so a retried `sessions_send`
 *     replays at the store rather than queueing a second turn.
 */
import { expect, test } from "bun:test";
import { collectTools, toolInputSchema } from "../src/mcp-socket";
import { sessionsTools, type SessionsCapability } from "../src/sessions-tools/tools";
import { agentQueryTools, agentToolSpecs, collectAgentTools, type AgentQueryCapability } from "../src/agent/tools";
import { AGENT_SELF_ID } from "../src/agent/identity";
import { approvalRequest, needsApproval } from "../src/agent/approval";
import type { NotesCapability } from "../src/notes-tools/tools";
import type { Session, Turn } from "@telar/engine-client";

/* ------------------------------------------------------------------ *
 * The gate.
 * ------------------------------------------------------------------ */

test("a task and a blocker are asked about; a report and a result are not", () => {
  expect(needsApproval({ name: "sessions_send", args: { intent: "task" } })).toBe(true);
  expect(needsApproval({ name: "sessions_send", args: { intent: "blocker" } })).toBe(true);
  expect(needsApproval({ name: "sessions_send", args: { intent: "report" } })).toBe(false);
  expect(needsApproval({ name: "sessions_send", args: { intent: "result" } })).toBe(false);
  // The wall's own default is `report`, so an absent intent is not gated.
  expect(needsApproval({ name: "sessions_send", args: {} })).toBe(false);
});

test("the four other effectful calls are gated by name", () => {
  for (const name of ["sessions_create", "sessions_stop", "sessions_resolve_request", "notes_delete"]) {
    expect(needsApproval({ name, args: {} })).toBe(true);
  }
});

test("every read on both walls is ungated", () => {
  const reads = [
    "sessions_list", "sessions_read", "sessions_status", "sessions_diff", "sessions_requests",
    "sessions_subscriptions", "sessions_subscribe", "sessions_unsubscribe", "sessions_settle",
    "sessions_find", "sessions_outline", "sessions_answer",
    "notes_projects", "notes_list", "notes_read", "notes_write",
  ];
  for (const name of reads) expect(needsApproval({ name, args: {} })).toBe(false);
});

test("the ask names the call it is about, so a surface need not re-derive it", () => {
  const request = approvalRequest({ name: "sessions_send", args: { sessionId: "session_x", intent: "task", input: "do the thing" } }, "call_1");
  expect(request.tool).toBe("sessions_send");
  expect(request.toolCallId).toBe("call_1");
  expect(request.args.sessionId).toBe("session_x");
  expect(request.reason).toContain("assigns work");
});

/* ------------------------------------------------------------------ *
 * The wall.
 * ------------------------------------------------------------------ */

const noSessions = (): SessionsCapability => ({
  self: { sessionId: AGENT_SELF_ID },
  list: async () => ({ sessions: [], projects: [] }),
  create: async () => ({}) as Session,
  send: async () => ({ turn: {} as Turn, replayed: false }),
  read: async () => [],
  status: async () => ({ session: {} as Session, turns: [] }),
  stop: async () => ({ stopped: 0 }) as never,
  settle: async () => ({}) as Session,
  diff: async () => ({}) as never,
  subscribe: async () => ({}) as never,
  unsubscribe: async () => false,
  subscriptions: async () => [],
  requests: async () => [],
  resolveRequest: async () => ({}) as never,
});

const noNotes = (): NotesCapability => ({
  projects: async () => [],
  list: async () => [],
  read: async () => null,
  create: async () => ({}) as never,
  update: async () => null,
  remove: async () => false,
});

const noQueries = (): AgentQueryCapability => ({
  find: async () => ({ sessions: [], index: "like", more: false }),
  outline: async () => ({ turns: [], total: 0, more: false }),
  answer: async () => ({ runId: "run_1", sequence: 1, text: "", from: 0, totalChars: 0, more: false }),
});

test("the Agent's wall is the two walls plus the three query reads, and nothing else", () => {
  const names = collectAgentTools({ sessions: noSessions(), notes: noNotes(), query: noQueries() }).map((tool) => tool.name);
  expect(names).toEqual([
    "sessions_list", "sessions_create", "sessions_send", "sessions_read", "sessions_status",
    "sessions_stop", "sessions_settle", "sessions_diff", "sessions_subscribe", "sessions_unsubscribe",
    "sessions_subscriptions", "sessions_requests", "sessions_resolve_request",
    "sessions_find", "sessions_outline", "sessions_answer",
    "notes_projects", "notes_list", "notes_read", "notes_write", "notes_delete",
  ]);
  // ABSENT, not disabled: a model with no such tool says so.
  for (const forbidden of ["bash", "shell", "read_file", "write_file", "browser_navigate", "display_open", "warp"]) {
    expect(names).not.toContain(forbidden);
  }
});

/* ------------------------------------------------------------------ *
 * What the wall COSTS — #563 item 2.
 * ------------------------------------------------------------------ */

test("the bound tool array stays well under what it was, with every tool still on it", () => {
  const tools = collectAgentTools({ sessions: noSessions(), notes: noNotes(), query: noQueries() });
  const specs = agentToolSpecs(tools);
  expect(specs).toHaveLength(21);
  /**
   * 18,744 characters when #563 measured it, 11,584 now. A CEILING rather than
   * an equality: prose is allowed to move, and the thing that must not come
   * back is the tax — this array is resent on every lap of every turn, so a
   * sentence added here is a sentence paid for a hundred times a day.
   */
  expect(JSON.stringify(specs).length).toBeLessThan(12_000);
});

test("the model's copy drops the validator's bookkeeping and keeps every choice", () => {
  const tools = collectAgentTools({ sessions: noSessions(), notes: noNotes(), query: noQueries() });
  const bound = JSON.stringify(agentToolSpecs(tools));
  expect(bound).not.toContain("$schema");
  expect(bound).not.toContain("minLength");
  expect(bound).not.toContain("9007199254740991");
  // Names, enums, real bounds and `required` are what the model chooses from.
  expect(bound).toContain('"enum":["task","report","result","blocker"]');
  expect(bound).toContain('"required":["projectId","envMode"]');
  expect(bound).toContain('"maximum":50');
  // And the socket's own answer is untouched: other programs validate against it.
  expect(JSON.stringify(toolInputSchema(tools.find((tool) => tool.name === "sessions_send")!.shape))).toContain("$schema");
});

test("no rule was traded for the bytes", () => {
  const byName = new Map(collectAgentTools({ sessions: noSessions(), notes: noNotes(), query: noQueries() }).map((tool) => [tool.name, tool.description]));
  // The sentence the wall cannot enforce, on all three tools that could be bent
  // into it.
  for (const name of ["sessions_create", "sessions_send", "sessions_resolve_request"]) {
    expect(byName.get(name)).toContain("refused");
  }
  expect(byName.get("sessions_diff")).toContain("NOT AN ACCEPTANCE");
  expect(byName.get("sessions_settle")).toContain("not acceptance");
  expect(byName.get("sessions_requests")).toContain("taking responsibility");
  expect(byName.get("sessions_stop")).toContain("Nothing is undone");
  expect(byName.get("notes_delete")).toContain("the user wrote is theirs");
  expect(byName.get("sessions_list")).toContain("before creating");
});

test("a `self` of agent is what lets the subscription tools work at all", async () => {
  const withSelf = collectAgentTools({ sessions: noSessions(), notes: noNotes(), query: noQueries() });
  const withoutSelf = collectAgentTools({
    sessions: { ...noSessions(), self: undefined },
    notes: noNotes(),
    query: noQueries(),
  });
  const call = (tools: typeof withSelf) => tools.find((tool) => tool.name === "sessions_subscriptions")!.run({});
  expect((await call(withSelf)).isError).toBeUndefined();
  expect((await call(withoutSelf)).isError).toBe(true);
});

/* ------------------------------------------------------------------ *
 * The query tools.
 * ------------------------------------------------------------------ */

test("the query tools clamp rather than refuse, and say when there is more", async () => {
  const asked: unknown[] = [];
  const capability: AgentQueryCapability = {
    find: async (query) => {
      asked.push(query);
      return { sessions: [{ id: "session_a", activity: "idle", updatedAt: 1, why: "the appearance rework" }], index: "fts5", more: true };
    },
    outline: async (_id, window) => {
      asked.push(window);
      return { turns: [], total: 0, more: false };
    },
    answer: async (_id, options) => {
      asked.push(options);
      return { runId: "run_1", sequence: 1, text: "ok", from: 0, totalChars: 2, more: false };
    },
  };
  const tools = collectTools(agentQueryTools as never, capability as never);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  const found = await byName.get("sessions_find")!.run({ q: "appearance", limit: 5_000 });
  expect((asked[0] as { limit: number }).limit).toBe(50);
  expect(String((found.content[0] as { text: string }).text)).toContain("Narrow with projectId");

  await byName.get("sessions_outline")!.run({ sessionId: "session_a", limit: 5_000 });
  expect((asked[1] as { limit: number }).limit).toBe(100);

  await byName.get("sessions_answer")!.run({ sessionId: "session_a", limit: 500_000 });
  expect((asked[2] as { limit: number }).limit).toBe(64_000);
});

test("a refusal from the store comes back as a sentence the model can read", async () => {
  const tools = collectTools(agentQueryTools as never, {
    ...noQueries(),
    outline: async () => {
      throw new Error("session does not exist");
    },
  } as never);
  const answer = await tools.find((tool) => tool.name === "sessions_outline")!.run({ sessionId: "session_gone" });
  expect(answer.isError).toBe(true);
  expect(String((answer.content[0] as { text: string }).text)).toContain("session does not exist");
});

/* ------------------------------------------------------------------ *
 * The send that cannot land twice.
 * ------------------------------------------------------------------ */

function sendWall(seen: string[]): ReturnType<typeof collectTools> {
  const capability: SessionsCapability = {
    ...noSessions(),
    send: async (_sessionId, input) => {
      seen.push(input.runId);
      return { turn: { runId: input.runId, state: "queued", agentDelivery: "wake" } as Turn, replayed: false };
    },
  };
  return collectTools(sessionsTools as never, capability as never);
}

test("two dispatches of the same tool call id produce one run id", async () => {
  const seen: string[] = [];
  const send = sendWall(seen).find((tool) => tool.name === "sessions_send")!;
  const args = { sessionId: "session_a", intent: "task", input: "do it" };
  await send.run(args, { toolCallId: "call_abc" });
  await send.run(args, { toolCallId: "call_abc" });
  expect(seen).toHaveLength(2);
  expect(seen[0]).toBe(seen[1]!);
  // Shaped like every other run id, so the store's own `Id` check passes.
  expect(seen[0]).toMatch(/^run_[0-9a-f]{32}$/);
});

test("a different tool call id is a different turn, even with identical arguments", async () => {
  const seen: string[] = [];
  const send = sendWall(seen).find((tool) => tool.name === "sessions_send")!;
  const args = { sessionId: "session_a", intent: "task", input: "do it" };
  await send.run(args, { toolCallId: "call_one" });
  await send.run(args, { toolCallId: "call_two" });
  expect(seen[0]).not.toBe(seen[1]!);
});

test("a call id with characters the store would refuse is still a valid run id", async () => {
  const seen: string[] = [];
  const send = sendWall(seen).find((tool) => tool.name === "sessions_send")!;
  await send.run({ sessionId: "session_a", input: "hi" }, { toolCallId: "call.with/odd:characters" });
  expect(seen[0]).toMatch(/^run_[0-9a-f]{32}$/);
});

test("no call id keeps the old behaviour — a fresh random id every time", async () => {
  const seen: string[] = [];
  const send = sendWall(seen).find((tool) => tool.name === "sessions_send")!;
  await send.run({ sessionId: "session_a", input: "hi" });
  await send.run({ sessionId: "session_a", input: "hi" });
  expect(seen[0]).not.toBe(seen[1]!);
});
