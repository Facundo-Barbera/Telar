import { expect, test } from "bun:test";
import type { DriverRequest } from "../../provider-contract";
import { deltas, replies, runTurn, useFakeCodex } from "../../../test/codex-harness";

useFakeCodex();

test("an approval is answered without stalling the stream behind it", async () => {
  const seenDelta = Promise.withResolvers<void>();
  let request: DriverRequest | undefined;
  const { result, observations } = runTurn("approval-command", {
    onRequest: async (incoming) => {
      request = incoming;
      await seenDelta.promise;
      return "accept";
    },
  });
  const poll = setInterval(() => {
    if (deltas(observations).length > 0) seenDelta.resolve();
  }, 5);
  try {
    await expect(result).resolves.toMatchObject({ text: "ok" });
  } finally {
    clearInterval(poll);
  }

  expect(request?.kind).toBe("command_execution");
  expect(request?.detail.kind === "command_execution" && request.detail.command).toEqual({
    command: "rm -rf /tmp/scratch",
    cwd: "/tmp",
  });
  expect(request?.toolUseId).toBe("item-cmd");
  expect(replies().at(-1)?.result).toEqual({ decision: "accept" });
});

test("a decline is spelled the way the item/* pair expects", async () => {
  const { result } = runTurn("approval-command", { onRequest: async () => "decline" });
  await result;
  expect(replies().at(-1)?.result).toEqual({ decision: "decline" });
});

test("acceptForSession is an accept to Codex — the widening is the engine's to record", async () => {
  const { result } = runTurn("approval-command", { onRequest: async () => "acceptForSession" });
  await result;
  expect(replies().at(-1)?.result).toEqual({ decision: "accept" });
});

test("the legacy approval pair is answered in the OTHER vocabulary", async () => {
  const { result } = runTurn("approval-legacy", { onRequest: async () => "accept" });
  await expect(result).resolves.toMatchObject({ text: "decision=approved" });
  expect(replies().at(-1)?.result).toEqual({ decision: "approved" });
});

test("the legacy pair's argv command is joined into one shell line", async () => {
  let request: DriverRequest | undefined;
  await runTurn("approval-legacy", {
    onRequest: async (incoming) => {
      request = incoming;
      return "decline";
    },
  }).result;
  expect(request?.detail.kind === "command_execution" && request.detail.command.command).toBe("git push --force");
  expect(replies().at(-1)?.result).toEqual({ decision: "denied" });
});

test("a file-change approval arrives as a file_change request, not a generic tool call", async () => {
  let request: DriverRequest | undefined;
  await runTurn("approval-file", {
    onRequest: async (incoming) => {
      request = incoming;
      return "accept";
    },
  }).result;
  expect(request?.kind).toBe("file_change");
  expect(request?.detail.kind === "file_change" && request.detail.change).toEqual({ path: "src/new.ts", kind: "create" });
});

test("a gate that throws declines, because the app-server has no deadline", async () => {
  const { result } = runTurn("approval-command", {
    onRequest: async () => {
      throw new Error("the engine went away");
    },
  });
  await result;
  expect(replies().at(-1)?.result).toEqual({ decision: "decline" });
});

test("a cancelled approval withdraws the whole turn after the decline is on the wire", async () => {
  const { result } = runTurn("approval-command", { onRequest: async () => "cancel" });
  await expect(result).rejects.toThrow("cancelled this turn");
});

test("with no gate wired, an approval is refused rather than left hanging", async () => {
  const { result } = runTurn("approval-command");
  await expect(result).resolves.toMatchObject({ text: "ok" });
  expect(replies().at(-1)?.error?.code).toBe(-32601);
});

test("a server request this client has never heard of is still answered", async () => {
  const { result } = runTurn("unknown-request");
  await expect(result).resolves.toMatchObject({ text: "done" });
  expect(replies().at(-1)?.error?.code).toBe(-32601);
});

test("a declined MCP approval answers in the elicitation's vocabulary, not the approval one", async () => {
  const seen: DriverRequest[] = [];
  await runTurn("mcp-elicitation", {
    onRequest: async (request) => {
      seen.push(request);
      return "decline";
    },
  }).result;

  expect(seen.map((request) => request.kind)).toEqual(["tool_call"]);
  expect(replies()[0]?.result).toEqual({ action: "decline" });
});

test("the app-server's requestUserInput becomes a user_input request, and the answers ride back by question id", async () => {
  const seen: DriverRequest[] = [];
  const { result } = runTurn("request-user-input", {
    onRequest: async (request) => {
      seen.push(request);
      return { decision: "accept", answers: { "q-color": "Blue" } };
    },
  });
  await expect(result).resolves.toMatchObject({ text: 'answered={"q-color":{"answers":["Blue"]}}' });
  expect(seen).toHaveLength(1);
  const detail = seen[0]!.detail;
  expect(detail.kind === "user_input" && detail.fields).toEqual([
    { key: "q-color", label: "Which color should the button be?", kind: "choice", choices: ["Red", "Blue"], required: true },
  ]);
});

test("Codex questions are SINGLE-select, so an array answer to one takes the first pick", async () => {
  const { result } = runTurn("request-user-input", {
    onRequest: async () => ({ decision: "accept", answers: { "q-color": ["Blue", "Red"] } }),
  });
  await expect(result).resolves.toMatchObject({ text: 'answered={"q-color":{"answers":["Blue"]}}' });
});

test("a declined requestUserInput answers an EMPTY map — the tool's own no-answer arm, not a hang", async () => {
  const { result } = runTurn("request-user-input", { onRequest: async () => "decline" });
  await expect(result).resolves.toMatchObject({ text: "answered={}" });
});

test("an accepted MCP approval carries the content field the protocol requires", async () => {
  await runTurn("mcp-elicitation", { onRequest: async () => "accept" }).result;
  expect(replies()[0]?.result).toEqual({ action: "accept", content: {} });
});

test("the browser socket's OWN elicitation is answered by the driver, never by the engine", async () => {
  const seen: DriverRequest[] = [];
  const { result, observations } = runTurn("mcp-elicitation-telar", {
    browserSocket: { url: "http://127.0.0.1:1234/v2/browser/mcp", token: "tok_abc" },
    onRequest: async (request) => {
      seen.push(request);
      return "decline";
    },
  });
  await result;
  expect(seen).toEqual([]);
  expect(replies()[0]?.result).toEqual({ action: "accept", content: {} });
  const row = observations.find((o) => o.kind === "item.completed" && o.status === "completed");
  expect(row?.kind === "item.completed" && row.detail?.type).toBe("browser_action");
  expect(row?.kind === "item.completed" && row.detail?.type === "browser_action" && row.detail.call.name).toBe(
    "mcp__telar-browser__browser_navigate",
  );
});

test("a `sessions_*` elicitation on the `telar` wall DOES reach the engine's gate — it carries no gate of its own", async () => {
  const seen: DriverRequest[] = [];
  const { result } = runTurn("mcp-elicitation-telar-sessions", {
    telarSocketLease: { url: "http://127.0.0.1:5678/v2/telar/mcp", token: "tok_s", generation: "g1" },
    onRequest: async (request) => {
      seen.push(request);
      return "decline";
    },
  });
  await expect(result).resolves.toMatchObject({ text: "action=decline" });
  expect(seen.map((request) => request.kind)).toEqual(["tool_call"]);
  expect(replies()[0]?.result).toEqual({ action: "decline" });
});
