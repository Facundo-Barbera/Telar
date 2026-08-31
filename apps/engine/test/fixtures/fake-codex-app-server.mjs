#!/usr/bin/env bun
// A scripted stand-in for `codex app-server`, driven through a REAL subprocess
// boundary by codex-driver.test.ts via CODEX_BIN.
//
// COPIED FROM apps/web_old/lib/fixtures/fake-codex-app-server.mjs and extended.
// The value carried over is the part that cannot be re-derived: every method
// name, item.type spelling and field name below was taken from a live trace
// against a real `codex app-server` 0.145.0. What was DROPPED is the
// `thread/compact/start` machinery and its scenarios — Telar's `TurnDriver`
// runs turns, and an on-demand compaction is a session operation with no
// caller here. Auto-compaction MID-TURN is kept, because a turn can hit it.
//
// WHAT WAS ADDED, and why each one is a test that could not otherwise exist:
//   · server→client REQUESTS with real correlation (`ask`), so an approval is
//     answered over the wire rather than mocked — and so a scenario can prove
//     the client kept reading stdout WHILE an approval was outstanding.
//   · a RESPONSE tape (`@response`), so a test can assert what the client
//     replied — including the `-32601` an unknown method must get, which
//     produces no observation at all and is therefore invisible from the
//     event stream.
//   · the request tape (`@argv`, methods and params) from the original, which
//     is how "the secret is not on the argv" stays assertable.
import fs from "node:fs";
import readline from "node:readline";

const scenario = process.env.FAKE_CODEX_TURN_SCENARIO ?? "plain";
const rl = readline.createInterface({ input: process.stdin });

const write = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const notify = (method, params) => write({ jsonrpc: "2.0", method, params });

// REQUEST TAPE. When FAKE_CODEX_PARAMS_LOG names a file, every inbound message
// is appended to it as one JSON line. A test asserting on what the client SENDS
// cannot read it off the observation stream — the whole point of, say, an
// omitted `dynamicTools` is that it produces no event at all — so the assertion
// has to be made on the wire, on the far side of the subprocess boundary.
// Append-only and synchronous so ordering is the wire's ordering, and off
// entirely (no file, no cost) when unset.
const paramsLog = process.env.FAKE_CODEX_PARAMS_LOG;
const tape = (entry) => {
  if (paramsLog) fs.appendFileSync(paramsLog, JSON.stringify(entry) + "\n");
};
// The ARGV is taped under a method name no JSON-RPC message can collide with.
// It is what lets a test assert where config did NOT go: an argv is readable by
// `ps` to every process running as this user.
tape({ method: "@argv", params: { argv: process.argv.slice(1) } });

const ROOT_THREAD = "fake-thread";
const CHILD_THREAD = "fake-child-thread";
const turnId = "fake-turn-1";
let threadId = ROOT_THREAD;

let nextRequestId = 1000;
const waiting = new Map();
/** The `steer` scenario parks on this until a turn/steer arrives. The flag
 *  covers the race where the steer lands BEFORE the scenario starts waiting —
 *  the driver's pump fires the moment turn/start answers, and playTurn runs a
 *  beat later. */
let steerReceived;
let steerArrived = false;

/** A server→client REQUEST. Resolves with the client's raw reply envelope. */
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextRequestId++;
    waiting.set(id, resolve);
    write({ jsonrpc: "2.0", id, method, params });
  });

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);

  // A REPLY to something this fixture asked for.
  if (msg.method === undefined && msg.id !== undefined) {
    tape({ method: "@response", params: { id: msg.id, result: msg.result ?? null, error: msg.error ?? null } });
    const resolve = waiting.get(msg.id);
    if (resolve) {
      waiting.delete(msg.id);
      resolve(msg);
    }
    return;
  }

  tape({ method: msg.method, params: msg.params ?? null });

  if (msg.method === "initialize") {
    write({ jsonrpc: "2.0", id: msg.id, result: {} });
    return;
  }
  if (msg.method === "initialized") return; // a notification: nothing is owed
  if (msg.method === "thread/start") {
    threadId = ROOT_THREAD;
    write({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: threadId } } });
    return;
  }
  if (msg.method === "thread/resume") {
    threadId = msg.params?.threadId ?? ROOT_THREAD;
    write({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: threadId } } });
    return;
  }
  if (msg.method === "turn/start") {
    write({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: turnId } } });
    // The real app-server acks essentially synchronously and the notification
    // sequence follows a beat later.
    setTimeout(() => void playTurn(), 5);
    return;
  }
  // Send now, mid-turn: the client injects a user message into the RUNNING
  // turn. Real shape per the rust-v0.149.1 protocol source — the response
  // names the turn the message landed in.
  if (msg.method === "turn/steer") {
    write({ jsonrpc: "2.0", id: msg.id, result: { turnId } });
    steerArrived = true;
    steerReceived?.();
    return;
  }
  // Anything else is answered so a mistake here reads as a failed request
  // rather than as a hang.
  if (msg.id !== undefined) {
    write({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `fixture does not implement ${msg.method}` } });
  }
});

const item = (fields) => notify("item/started", { threadId, turnId, item: { status: "inProgress", ...fields } });
const done = (fields) => notify("item/completed", { threadId, turnId, item: { status: "completed", ...fields } });

/** The ordinary ending every scenario shares: one final agent message, then the
 *  turn completes. `text` is the FULL text of that message — Codex re-sends it
 *  on completion even when it already streamed every token as a delta, which is
 *  the double-count trap the driver has to guard. */
function finish(text = "done") {
  item({ type: "agentMessage", id: "item-final" });
  done({ type: "agentMessage", id: "item-final", text });
  notify("turn/completed", { threadId, turn: { id: turnId, status: "completed" } });
}

async function playTurn() {
  notify("turn/started", { threadId, turn: { id: turnId, status: "inProgress" } });

  switch (scenario) {
    case "plain": {
      item({ type: "agentMessage", id: "item-final" });
      notify("item/agentMessage/delta", { threadId, turnId, itemId: "item-final", delta: "hel" });
      notify("item/agentMessage/delta", { threadId, turnId, itemId: "item-final", delta: "lo" });
      // `total` is cumulative across the thread's whole history and would
      // double-count every earlier turn of a resumed session; `last` is the
      // per-turn truth. The two are deliberately far apart here.
      notify("thread/tokenUsage/updated", {
        threadId,
        tokenUsage: {
          last: {
            inputTokens: 120,
            cachedInputTokens: 30,
            cacheWriteInputTokens: 10,
            outputTokens: 45,
            reasoningOutputTokens: 12,
            totalTokens: 195,
          },
          total: { inputTokens: 9000, cachedInputTokens: 9000, outputTokens: 9000, totalTokens: 27000 },
          modelContextWindow: 400000,
        },
      });
      // A CHILD thread's usage, which belongs to that thread's own turn.
      notify("thread/tokenUsage/updated", {
        threadId: CHILD_THREAD,
        tokenUsage: { last: { inputTokens: 7777, outputTokens: 7777, totalTokens: 15554 }, modelContextWindow: 400000 },
      });
      finish("hello");
      return;
    }

    case "reasoning": {
      item({ type: "reasoning", id: "item-think" });
      notify("item/reasoning/textDelta", { threadId, turnId, itemId: "item-think", delta: "weighing " });
      notify("item/reasoning/textDelta", { threadId, turnId, itemId: "item-think", delta: "options" });
      // The completed reasoning item carries NO text — it never does.
      done({ type: "reasoning", id: "item-think" });
      finish("answer");
      return;
    }

    case "tools": {
      item({ type: "commandExecution", id: "item-cmd", command: "ls -la /tmp", cwd: "/tmp" });
      done({
        type: "commandExecution",
        id: "item-cmd",
        command: "ls -la /tmp",
        cwd: "/tmp",
        aggregatedOutput: "total 0\n",
        exitCode: 0,
      });
      done({
        type: "fileChange",
        id: "item-patch",
        changes: [
          { kind: "update", path: "src/a.ts" },
          { kind: "add", path: "src/b.ts" },
        ],
      });
      done({
        type: "mcpToolCall",
        id: "item-mcp",
        server: "linear",
        tool: "search",
        arguments: { query: "bug" },
        result: { issues: 2 },
      });
      done({ type: "webSearch", id: "item-web", query: "codex app-server protocol" });
      // An item type this driver has never heard of. It must still produce a
      // row: a silently missing row is worse than an ugly one.
      done({ type: "quantumEntanglement", id: "item-mystery", payload: { spooky: true } });
      finish();
      return;
    }

    case "declined": {
      item({ type: "commandExecution", id: "item-cmd", command: "rm -rf /" });
      notify("item/completed", {
        threadId,
        turnId,
        item: { type: "commandExecution", id: "item-cmd", command: "rm -rf /", status: "declined" },
      });
      finish();
      return;
    }

    case "failed-tool": {
      notify("item/completed", {
        threadId,
        turnId,
        item: { type: "commandExecution", id: "item-cmd", command: "false", aggregatedOutput: "boom", status: "failed" },
      });
      finish();
      return;
    }

    case "approval-command": {
      item({ type: "commandExecution", id: "item-cmd", command: "rm -rf /tmp/scratch", cwd: "/tmp" });
      const reply = ask("item/commandExecution/requestApproval", {
        threadId,
        turnId,
        itemId: "item-cmd",
        command: "rm -rf /tmp/scratch",
        cwd: "/tmp",
        reason: "writes outside the workspace",
      });
      // THE STREAM DOES NOT WAIT FOR THE HUMAN, and neither may the client.
      // These lines go out while the approval is still outstanding; a client
      // that awaited its approval handler inside its stdout reader would not
      // see them until the answer arrived — and the test's answer waits for
      // exactly these, so that client deadlocks instead of passing.
      item({ type: "agentMessage", id: "item-final" });
      notify("item/agentMessage/delta", { threadId, turnId, itemId: "item-final", delta: "ok" });
      const decision = (await reply).result?.decision;
      done({
        type: "commandExecution",
        id: "item-cmd",
        command: "rm -rf /tmp/scratch",
        aggregatedOutput: `decision=${decision}`,
        status: decision === "accept" ? "completed" : "declined",
      });
      finish("ok");
      return;
    }

    // HOW CODEX ACTUALLY ASKS ABOUT AN MCP TOOL. Not an approval request at
    // all: an MCP *elicitation*, with the approval in `_meta` and the tool name
    // only in the prose. Transcribed from a logged turn against codex-cli
    // 0.145.0 — the shape was found by running one, not by reading a schema,
    // because no schema calls this an approval.
    case "mcp-elicitation": {
      const reply = ask("mcpServer/elicitation/request", {
        threadId,
        turnId,
        serverName: "probe",
        mode: "form",
        _meta: {
          codex_approval_kind: "mcp_tool_call",
          persist: ["session", "always"],
          tool_description: "Answers pong.",
          tool_params: {},
          tool_params_display: [],
        },
        message: 'Allow the probe MCP server to run tool "ping"?',
        requestedSchema: { type: "object", properties: {} },
      });
      // `action`, not `decision` — the reply shape is MCP's, not Codex's.
      const action = (await reply).result?.action;
      done({
        type: "mcpToolCall",
        id: "item-mcp",
        server: "probe",
        tool: "ping",
        arguments: {},
        status: action === "accept" ? "completed" : "declined",
        ...(action === "accept"
          ? { result: { content: [{ type: "text", text: "pong" }] } }
          : { error: { message: "user rejected MCP tool call" } }),
      });
      finish(`action=${action}`);
      return;
    }

    // The SAME elicitation, but for Telar's own browser socket. The driver
    // must answer it itself — the socket's per-lease gate already asked the
    // engine — so this one must NOT reach `onRequest`.
    case "mcp-elicitation-telar": {
      const reply = ask("mcpServer/elicitation/request", {
        threadId,
        turnId,
        serverName: "telar-browser",
        mode: "form",
        _meta: {
          codex_approval_kind: "mcp_tool_call",
          persist: ["session", "always"],
          tool_description: "Drives the engine's browser.",
          tool_params: { url: "http://x" },
          tool_params_display: [],
        },
        message: 'Allow the telar-browser MCP server to run tool "browser_navigate"?',
        requestedSchema: { type: "object", properties: {} },
      });
      const action = (await reply).result?.action;
      done({
        type: "mcpToolCall",
        id: "item-mcp-telar",
        server: "telar-browser",
        tool: "browser_navigate",
        arguments: { url: "http://x" },
        status: action === "accept" ? "completed" : "declined",
        ...(action === "accept"
          ? { result: { content: [{ type: "text", text: "ok" }] } }
          : { error: { message: "user rejected MCP tool call" } }),
      });
      finish(`action=${action}`);
      return;
    }

    // A turn long enough to be steered: it finishes only once a turn/steer
    // has arrived, which is what makes the test deterministic.
    case "steer": {
      if (!steerArrived) {
        await new Promise((resolve) => {
          steerReceived = resolve;
        });
      }
      finish("steered");
      return;
    }

    case "approval-file": {
      const reply = ask("item/fileChange/requestApproval", {
        threadId,
        turnId,
        itemId: "item-patch",
        changes: [{ kind: "add", path: "src/new.ts" }],
        reason: "creates a file",
      });
      const decision = (await reply).result?.decision;
      done({ type: "fileChange", id: "item-patch", changes: [{ kind: "add", path: "src/new.ts" }] });
      finish(`decision=${decision}`);
      return;
    }

    case "approval-legacy": {
      // The pre-`item/*` spelling, still on the wire per the app-server's own
      // generated ServerRequest union — and answered in a DIFFERENT vocabulary
      // (`approved`/`denied`, not `accept`/`decline`). A client that knows only
      // one generation does not fail loudly; it stops answering.
      const reply = ask("execCommandApproval", {
        threadId,
        turnId,
        callId: "call-legacy-1",
        command: ["git", "push", "--force"],
        cwd: "/repo",
      });
      const decision = (await reply).result?.decision;
      finish(`decision=${decision}`);
      return;
    }

    case "unknown-request": {
      // A method this client has never heard of. The turn does not continue
      // until it is answered — which is what an unanswered server→client
      // request costs on the real app-server too, except there it is forever.
      await ask("thread/somethingNobodyImplemented", { threadId, turnId });
      finish();
      return;
    }

    case "plan": {
      notify("turn/plan/updated", {
        threadId,
        turnId,
        plan: [
          { step: "read the driver", status: "inProgress" },
          { step: "write the test", status: "pending" },
        ],
      });
      notify("turn/plan/updated", {
        threadId,
        turnId,
        plan: [
          { step: "read the driver", status: "completed" },
          { step: "write the test", status: "inProgress" },
        ],
      });
      finish();
      return;
    }

    case "auto-compact": {
      // Codex compacting its OWN context mid-turn, unprompted. Note what is
      // NOT here: a `thread/compacted` notification. It is deprecated and was
      // never once observed live, and waiting on it hung the legacy bridge
      // permanently — the completed `contextCompaction` item is the signal.
      item({ type: "contextCompaction", id: "item-compact" });
      done({ type: "contextCompaction", id: "item-compact" });
      finish();
      return;
    }

    case "error": {
      notify("error", { threadId, error: { message: "fake fatal failure" }, willRetry: false });
      notify("turn/completed", {
        threadId,
        turn: { id: turnId, status: "failed", error: { message: "fake fatal failure" } },
      });
      return;
    }

    case "error-retryable": {
      // The app-server says it will try again. Ending the turn here would fail
      // a turn that goes on to succeed.
      notify("error", { threadId, error: { message: "rate limited, retrying" }, willRetry: true });
      finish();
      return;
    }

    case "turn-failed": {
      notify("turn/completed", {
        threadId,
        turn: { id: turnId, status: "failed", error: { message: "model refused the turn" } },
      });
      return;
    }

    case "child-thread": {
      // A sub-agent's thread, announced and then producing its own items and
      // its own final message. None of that text is THIS turn's answer.
      notify("thread/started", { thread: { id: CHILD_THREAD, parentThreadId: ROOT_THREAD } });
      notify("item/started", {
        threadId: CHILD_THREAD,
        turnId: "child-turn",
        item: { type: "agentMessage", id: "child-msg", status: "inProgress" },
      });
      notify("item/agentMessage/delta", {
        threadId: CHILD_THREAD,
        turnId: "child-turn",
        itemId: "child-msg",
        delta: "child says hi",
      });
      notify("item/completed", {
        threadId: CHILD_THREAD,
        turnId: "child-turn",
        item: { type: "agentMessage", id: "child-msg", text: "child says hi", status: "completed" },
      });
      // The child's own turn ending must not end the parent's.
      notify("turn/completed", { threadId: CHILD_THREAD, turn: { id: "child-turn", status: "completed" } });
      finish("parent answer");
      return;
    }

    case "repeat-snapshot": {
      // The SAME item published twice. Codex re-publishes items as later
      // snapshots — every wait/send/close on a collab tool call touches its
      // item again — and a client that maps each snapshot to a row grows a
      // duplicate transcript.
      const patch = { type: "fileChange", id: "item-patch", changes: [{ kind: "update", path: "src/a.ts" }] };
      done(patch);
      done(patch);
      finish();
      return;
    }

    case "abandoned-item": {
      // A row the app-server opens and never closes. Left alone it spins in the
      // cockpit forever.
      item({ type: "commandExecution", id: "item-cmd", command: "sleep 100" });
      finish();
      return;
    }

    default:
      finish();
  }
}

// No process.exit(): a real app-server keeps the connection open regardless of
// what was asked, which is exactly the condition that turns a missing
// terminator into a silent hang rather than a clean failure.
