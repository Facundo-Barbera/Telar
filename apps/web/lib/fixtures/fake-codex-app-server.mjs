#!/usr/bin/env bun
// A scripted stand-in for `codex app-server`, used by codex-compact-wire.test.ts
// (thread/compact/start, via FAKE_CODEX_SCENARIO) and codex-turn-compact-wire.test.ts
// (thread/start + turn/start, via FAKE_CODEX_TURN_SCENARIO). It speaks just
// enough real JSON-RPC to drive runCodexCompact/runCodexTurn end to end
// through a REAL subprocess boundary (spawn, stdio framing, AsyncChannel)
// without touching the network or an actual ChatGPT/OpenAI account — the
// notification SEQUENCES it plays back for each scenario were copied
// verbatim (method names, item.type spelling, field names) from a live trace
// against a real `codex app-server` 0.145.0 process compacting a real
// thread. See codex-app-server.ts's comment on normalizeCodexAutoCompact and
// runCodexCompact for the trace itself.
import fs from "node:fs";
import readline from "node:readline";

const scenario = process.env.FAKE_CODEX_SCENARIO ?? "success";
const turnScenario = process.env.FAKE_CODEX_TURN_SCENARIO ?? "plain";
const rl = readline.createInterface({ input: process.stdin });

const write = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const notify = (method, params) => write({ jsonrpc: "2.0", method, params });

// REQUEST TAPE (story 13). When FAKE_CODEX_PARAMS_LOG names a file, every
// inbound request is appended to it as one JSON line. A test asserting on what
// the client SENDS cannot read it off the normalized event stream — the whole
// point of an injected `config.mcp_servers` is that it produces no event at
// all — so the assertion has to be made on the wire itself, on the far side of
// a real subprocess boundary. Append-only and synchronous so ordering is the
// wire's ordering, and off entirely (no file, no cost) when unset, which is
// every other test that uses this fixture.
const paramsLog = process.env.FAKE_CODEX_PARAMS_LOG;
const record = (msg) => {
  if (!paramsLog || !msg.method) return;
  fs.appendFileSync(paramsLog, JSON.stringify({ method: msg.method, params: msg.params ?? null }) + "\n");
};
// The ARGV is taped too, under a method name no JSON-RPC message can collide
// with. It is what lets a test assert where a secret did NOT go: `-c
// mcp_servers.<name>.env=...` on a command line is readable by `ps` to every
// process running as this user, so "not on the argv" is an assertion worth
// being able to make.
if (paramsLog) {
  fs.appendFileSync(paramsLog, JSON.stringify({ method: "@argv", params: { argv: process.argv.slice(1) } }) + "\n");
}

let threadId = null;
let turnId = "fake-turn-1";

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  record(msg);
  if (msg.method === "initialize") {
    write({ jsonrpc: "2.0", id: msg.id, result: {} });
    return;
  }
  if (msg.method === "initialized") return; // notification, no reply
  if (msg.method === "thread/resume") {
    threadId = msg.params?.threadId ?? "fake-thread";
    // The real ThreadResumeResponse carries the thread, and runCodexTurn reads
    // `startResult.thread.id` off it — runCodexCompact (the original caller of
    // this branch) ignores the result entirely, so adding the field serves the
    // resume path without changing anything the compact tests observe.
    write({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: threadId } } });
    return;
  }
  if (msg.method === "thread/compact/start") {
    threadId = msg.params?.threadId ?? threadId ?? "fake-thread";
    // ThreadCompactStartResponse is `Record<string, never>` per the real
    // generated bindings — an empty ack, same as runCodexCompact's own
    // comment describes.
    write({ jsonrpc: "2.0", id: msg.id, result: {} });
    // Real app-server behavior observed live: the ack comes back essentially
    // synchronously, then the notification sequence follows a beat later.
    setTimeout(() => playCompactScenario(), 5);
    return;
  }
  if (msg.method === "thread/start") {
    threadId = "fake-thread";
    write({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: threadId } } });
    return;
  }
  if (msg.method === "turn/start") {
    threadId = msg.params?.threadId ?? threadId ?? "fake-thread";
    write({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: turnId } } });
    setTimeout(() => playTurnScenario(), 5);
    return;
  }
  // Anything else (approval requests, etc.) — not exercised by this fixture.
});

function playCompactScenario() {
  notify("turn/started", { threadId, turn: { id: turnId, status: "inProgress" } });
  if (scenario === "success") {
    notify("item/started", { item: { type: "contextCompaction", id: "item-1" }, threadId, turnId });
    notify("item/completed", { item: { type: "contextCompaction", id: "item-1" }, threadId, turnId });
    notify("turn/completed", { threadId, turn: { id: turnId, status: "completed" } });
  } else if (scenario === "turn-completed-fallback") {
    // item/started fires but item/completed never does — a future app-server
    // revision, or a race — exercising runCodexCompact's defensive
    // turn/completed branch instead of its primary item/completed one.
    notify("item/started", { item: { type: "contextCompaction", id: "item-1" }, threadId, turnId });
    notify("turn/completed", { threadId, turn: { id: turnId, status: "completed" } });
  } else if (scenario === "error") {
    // Exactly what a real unsupported-model rejection looked like live.
    notify("error", {
      error: { message: "fake compaction failure" },
      willRetry: false,
      threadId,
    });
    notify("turn/completed", {
      threadId,
      turn: { id: turnId, status: "failed", error: { message: "fake compaction failure" } },
    });
  } else if (scenario === "thread-compacted-only") {
    // The OLD (deprecated, never actually observed live) signal, alone — used
    // to prove the old code path is what this test suite would have caught:
    // a build that regresses to ONLY sending this can no longer complete a
    // compaction, and this fixture reproduces exactly that regression.
    notify("thread/compacted", { threadId, turnId });
  } else if (scenario === "wrong-item-then-error") {
    // An item/completed for a DIFFERENT item type lands first (unrelated
    // model activity sharing the same connection), then the compaction
    // actually fails. runCodexCompact must not treat the wrong item as its
    // own completion signal — if it did, this "error" would never be seen
    // and the generator would already have returned successfully.
    notify("item/completed", { item: { type: "agentMessage", id: "item-0" }, threadId, turnId });
    notify("error", {
      error: { message: "wrong-item-then-error failure" },
      willRetry: false,
      threadId,
    });
    notify("turn/completed", {
      threadId,
      turn: { id: turnId, status: "failed", error: { message: "wrong-item-then-error failure" } },
    });
  } else if (scenario === "item-only") {
    // The compaction's own item/completed, and NOTHING else after it — no
    // turn/completed at all. Proves the item check ends the compaction BY
    // ITSELF: a version of the check that can never match (e.g. compared
    // against the wrong literal) would fall through to "everything else,
    // keep waiting" forever, since there is no turn/completed fallback left
    // in this scenario to quietly cover for it.
    notify("item/completed", { item: { type: "contextCompaction", id: "item-1" }, threadId, turnId });
  }
  // No process.exit(): a real app-server keeps the connection open
  // regardless of what was asked, which is exactly the condition that made
  // the original bug a silent hang instead of a clean failure.
}

function playTurnScenario() {
  notify("turn/started", { threadId, turn: { id: turnId, status: "inProgress" } });
  if (turnScenario === "auto-compact-mid-turn") {
    // Codex compacting ITS OWN context mid-turn, unprompted — the auto path
    // handleItem's `item.type === "contextCompaction"` branch exists for.
    // Copied verbatim (method/item shape) from the same live trace as the
    // on-demand (runCodexCompact) path — auto-compaction surfaces as the
    // identical item type, just interleaved into an ordinary turn instead of
    // being the whole point of the connection.
    notify("item/started", { item: { type: "contextCompaction", id: "item-compact" }, threadId, turnId });
    notify("item/completed", { item: { type: "contextCompaction", id: "item-compact" }, threadId, turnId });
  }
  if (turnScenario === "mcp-startup-failed") {
    // COPIED VERBATIM (method, param names, error prose) from a live `codex
    // app-server` 0.145.0 that was handed an injected server whose name it
    // refuses. This is the ONLY place the failure appears: no `error`
    // notification, no turn failure, and the turn goes on to complete
    // normally — which is precisely why a driver that ignored this method
    // turned a dead server into silence.
    notify("mcpServer/startupStatus/updated", {
      threadId,
      name: "probesrv",
      status: "starting",
      error: null,
      failureReason: null,
    });
    notify("mcpServer/startupStatus/updated", {
      threadId,
      name: "probesrv",
      status: "failed",
      error:
        "MCP client for `probesrv` failed to start: MCP startup failed: handshaking with MCP server failed: connection closed: initialize response",
      failureReason: null,
    });
  }
  // Every turn scenario ends the same ordinary way: one final agentMessage,
  // then turn/completed — auto-compaction is a mid-turn EVENT, not something
  // that ends the turn itself.
  notify("item/started", { item: { type: "agentMessage", id: "item-final" }, threadId, turnId });
  notify("item/completed", {
    item: { type: "agentMessage", id: "item-final", text: "done" },
    threadId,
    turnId,
  });
  notify("turn/completed", { threadId, turn: { id: turnId, status: "completed" } });
}
