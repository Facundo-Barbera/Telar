import { expect, test } from "bun:test";
import type { AutoCompact } from "@telar/engine-client";
import { ProviderUnavailableError } from "../contract";
import { SteerMailbox } from "../../domains/turns";
import { clearWire, completed, deltas, mcp, PEER, runTurn, scratchPath, sent, started, useFakeCodex, wire } from "../../../test/codex-harness";

useFakeCodex();

const WINDOWS = new Map([
  ["gpt-6-sol", { context: 272_000, max: 872_000 }],
  ["gpt-5.5", { context: 272_000, max: 272_000 }],
]);
const LIMITS: AutoCompact = { mode: "limits", standard: 150_000, long: 400_000 };

test("a turn streams its text as deltas and does not double it on completion", async () => {
  const { result, observations } = runTurn("plain");
  await expect(result).resolves.toMatchObject({ text: "hello", providerSessionId: "fake-thread" });

  expect(deltas(observations).map((o) => (o.kind === "content.delta" ? o.text : ""))).toEqual(["hel", "lo"]);
  const messages = started(observations).filter((o) => o.kind === "item.started" && o.item.detail.type === "assistant_message");
  expect(messages).toHaveLength(1);
});

test("usage comes from tokenUsage.last, never .total, and carries no invented price", async () => {
  const { result, observations } = runTurn("plain");
  const resolved = await result;

  expect(resolved.usage).toEqual({
    tokens: { input: 120, output: 45, cacheRead: 30, cacheCreate: 10, reasoning: 12 },
    contextUsed: 195,
    contextMax: 400_000,
  });
  expect(resolved.usage && "costUsd" in resolved.usage).toBeFalse();
  expect(observations.filter((o) => o.kind === "usage")).toHaveLength(1);
});

test("a picked service tier reaches turn/start for that turn only, and no pick sends none", async () => {
  await runTurn("plain", { serviceTier: "priority" }).result;
  expect(sent("turn/start").serviceTierForTurn).toBe("priority");
  expect(sent("turn/start").serviceTier).toBeUndefined();
  expect(sent("thread/start").serviceTier).toBeUndefined();

  await runTurn("plain").result;
  const starts = wire().filter((entry) => entry.method === "turn/start");
  expect(starts.length).toBeGreaterThan(1);
  expect("serviceTierForTurn" in (starts.at(-1)!.params ?? {})).toBe(false);
});

test("turn/start sends the app-server's own input shape, snake_case field and all", async () => {
  await runTurn("plain", { prompt: "hello codex" }).result;
  expect(sent("turn/start").input).toEqual([{ type: "text", text: "hello codex", text_elements: [] }]);
});

test("the app-server is launched with exactly one argument and told everything else in params", async () => {
  await runTurn("plain").result;
  const argv = sent("@argv").argv as string[];
  expect(argv.slice(1)).toEqual(["app-server"]);
  expect(sent("initialize")).toEqual({
    clientInfo: { name: "telar", title: "Telar", version: "0.1.0" },
    capabilities: { experimentalApi: true, requestAttestation: false },
  });
});

test("empty capability fields are OMITTED, because an empty one is a different statement", async () => {
  await runTurn("plain").result;
  const params = sent("thread/start");
  expect("dynamicTools" in params).toBeFalse();
  expect("developerInstructions" in params).toBeFalse();
  expect("config" in params).toBeFalse();
  expect(params).toMatchObject({ cwd: "/tmp/project", model: "gpt-5.5" });
});

test("the long window and the login's limit ride the thread's config overlay (#587)", async () => {
  const readWindows = async () => WINDOWS;
  await runTurn("plain", { model: "gpt-6-sol[1m]", autoCompact: LIMITS, options: { readWindows } }).result;
  expect(sent("thread/start")).toMatchObject({ model: "gpt-6-sol", config: { model_context_window: 872_000, model_auto_compact_token_limit: 400_000 } });
  expect(sent("turn/start").model).toBe("gpt-6-sol");
});

test("the standard window takes the standard limit and pins no window", async () => {
  const readWindows = async () => WINDOWS;
  await runTurn("plain", { model: "gpt-6-sol", autoCompact: LIMITS, options: { readWindows } }).result;
  expect(sent("thread/start").config).toEqual({ model_auto_compact_token_limit: 150_000 });
});

test("a long row on a model with no long window runs its standard one", async () => {
  const readWindows = async () => WINDOWS;
  await runTurn("plain", { model: "gpt-5.5[1m]", autoCompact: LIMITS, options: { readWindows } }).result;
  expect(sent("thread/start")).toMatchObject({ model: "gpt-5.5", config: { model_auto_compact_token_limit: 150_000 } });
});

test("Never and Default write nothing, and read no catalog", async () => {
  let reads = 0;
  const readWindows = async () => ((reads += 1), WINDOWS);
  await runTurn("plain", { model: "gpt-6-sol", autoCompact: { mode: "never" }, options: { readWindows } }).result;
  expect(sent("thread/start").config).toBeUndefined();
  expect(reads).toBe(0);
});

test("the user's MCP servers ride thread/start's config overlay", async () => {
  await runTurn("plain", {
    mcpServers: [
      mcp("local", { transport: "stdio", command: "node", args: ["server.js"], env: { TOKEN: "x" } }),
      mcp("linear", { transport: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer managed" } }),
    ],
  }).result;

  expect(sent("thread/start").config).toEqual({
    mcp_servers: {
      local: { command: "node", args: ["server.js"], env: { TOKEN: "x" } },
      linear: { url: "https://mcp.linear.app/mcp", http_headers: { Authorization: "Bearer managed" } },
    },
  });
});

test("Telar's own computer use turns off Codex's native one — for this thread only", async () => {
  await runTurn("plain", {
    mcpServers: [mcp("mac", { transport: "stdio", command: "/usr/local/bin/cua-driver", args: ["mcp"] })],
  }).result;

  expect(sent("thread/start").config).toEqual({
    mcp_servers: { mac: { command: "/usr/local/bin/cua-driver", args: ["mcp"] } },
    features: { computer_use: false },
  });
});

test("a claim WITHOUT the mac server leaves Codex's native computer use alone", async () => {
  await runTurn("plain", {
    mcpServers: [mcp("linear", { transport: "http", url: "https://mcp.linear.app/mcp" })],
  }).result;
  const config = sent("thread/start").config as { features?: unknown };
  expect(config.features).toBeUndefined();
});

test("the browser socket rides the SAME overlay, Telar last, and the token never touches argv", async () => {
  const lease = { url: "http://127.0.0.1:1234/v2/browser/mcp", token: "tok_secret_abc" };
  await runTurn("plain", {
    browserSocket: lease,
    mcpServers: [mcp("linear", { transport: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer managed" } })],
  }).result;

  expect(sent("thread/start").config).toEqual({
    mcp_servers: {
      linear: { url: "https://mcp.linear.app/mcp", http_headers: { Authorization: "Bearer managed" } },
      "telar-browser": { url: lease.url, http_headers: { Authorization: "Bearer tok_secret_abc" } },
    },
  });
  const argv = sent("@argv").argv as string[];
  expect(argv.slice(1)).toEqual(["app-server"]);
  expect(JSON.stringify(argv)).not.toContain("tok_secret_abc");
  expect(sent("thread/start").developerInstructions).toContain("tools may be deferred");
  expect(sent("thread/start").developerInstructions).toContain("telar-browser");
});

test("the `telar` wall rides the same overlay, beside the browser's, token on stdin only", async () => {
  const browser = { url: "http://127.0.0.1:1234/v2/browser/mcp", token: "tok_browser" };
  const telar = { url: "http://127.0.0.1:5678/v2/telar/mcp", token: "tok_telar_xyz", generation: "g1" };
  await runTurn("plain", { browserSocket: browser, telarSocketLease: telar }).result;

  expect(sent("thread/start").config).toEqual({
    mcp_servers: {
      "telar-browser": { url: browser.url, http_headers: { Authorization: "Bearer tok_browser" } },
      telar: { url: telar.url, http_headers: { Authorization: "Bearer tok_telar_xyz" }, tool_timeout_sec: 660 },
    },
  });
  const argv = sent("@argv").argv as string[];
  expect(argv.slice(1)).toEqual(["app-server"]);
  expect(JSON.stringify(argv)).not.toContain("tok_telar_xyz");
});

test("the `telar` wall stands alone too — a Codex session without a browser still reaches its peers", async () => {
  const telar = { url: "http://127.0.0.1:5678/v2/telar/mcp", token: "tok_only", generation: "g1" };
  await runTurn("plain", { telarSocketLease: telar }).result;
  expect(sent("thread/start").config).toEqual({
    mcp_servers: { telar: { url: telar.url, http_headers: { Authorization: "Bearer tok_only" }, tool_timeout_sec: 660 } },
  });
});

test("a RESUMED turn carries the browser overlay too — a new socket URL must reach an old thread", async () => {
  const lease = { url: "http://127.0.0.1:4321/v2/browser/mcp", token: "tok_next" };
  await runTurn("plain", { providerSessionId: "thread-42", browserSocket: lease }).result;
  expect(sent("thread/resume").config).toEqual({
    mcp_servers: { "telar-browser": { url: lease.url, http_headers: { Authorization: "Bearer tok_next" } } },
  });
  expect(sent("thread/resume").developerInstructions).toContain("tools may be deferred");
});

test("the tool catalogue is refreshed AFTER the thread call and BEFORE turn/start, and its failure costs nothing", async () => {
  const lease = { url: "http://127.0.0.1:1234/v2/browser/mcp", token: "tok_abc" };
  const { result } = runTurn("plain", { browserSocket: lease });
  await expect(result).resolves.toMatchObject({ text: expect.any(String) });
  const methods = wire().map((entry) => entry.method);
  const reload = methods.indexOf("config/mcpServer/reload");
  expect(reload).toBeGreaterThan(methods.indexOf("thread/start"));
  expect(reload).toBeLessThan(methods.indexOf("turn/start"));
});

test("a turn with no MCP servers at all sends no catalogue refresh", async () => {
  await runTurn("plain").result;
  expect(wire().some((entry) => entry.method === "config/mcpServer/reload")).toBeFalse();
  expect(sent("thread/start").developerInstructions).toBeUndefined();
});

test("a resumed turn resumes the thread and never opens a second one", async () => {
  const { result } = runTurn("plain", { providerSessionId: "thread-42" });
  await expect(result).resolves.toMatchObject({ providerSessionId: "thread-42" });
  expect(sent("thread/resume").threadId).toBe("thread-42");
  expect(wire().some((entry) => entry.method === "thread/start")).toBeFalse();
});

test("the posture follows whether the engine wired a gate at all", async () => {
  await runTurn("plain").result;
  expect(sent("turn/start")).toMatchObject({ approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } });

  clearWire();
  await runTurn("plain", { onRequest: async () => "accept" }).result;
  expect(sent("turn/start")).toMatchObject({
    approvalPolicy: "on-request",
    sandboxPolicy: { type: "workspaceWrite", writableRoots: ["/tmp/project"], networkAccess: true },
  });
});

test("an explicit thread config overrides the derived posture", async () => {
  await runTurn("plain", {
    onRequest: async () => "accept",
    options: { threadConfig: { approvalPolicy: "untrusted", sandbox: "read-only", approvalsReviewer: "user" } },
  }).result;
  expect(sent("thread/start")).toMatchObject({ approvalPolicy: "untrusted", sandbox: "read-only" });
  expect(sent("turn/start").sandboxPolicy).toEqual({ type: "readOnly", networkAccess: false });
});

test("reasoning is its own row, is filled in from deltas, and never joins the answer", async () => {
  const { result, observations } = runTurn("reasoning");
  await expect(result).resolves.toMatchObject({ text: "answer" });

  const delta = deltas(observations)[0];
  expect(delta?.kind === "content.delta" && delta.stream).toBe("reasoning_text");
  const closed = completed(observations).find((o) => o.kind === "item.completed" && o.detail?.type === "reasoning");
  expect(closed?.kind === "item.completed" && closed.detail?.type === "reasoning" && closed.detail.text).toBe(
    "weighing options",
  );
});

test("tool items land on the canonical rows a Claude turn would produce", async () => {
  const { result, observations } = runTurn("tools");
  await result;
  const rows = started(observations).map((o) => (o.kind === "item.started" ? o.item : null));

  const command = rows.find((row) => row?.detail.type === "command_execution");
  expect(command?.detail.type === "command_execution" && command.detail.command.command).toBe("ls -la /tmp");
  expect(command?.title).toBe("ls -la /tmp");

  const change = rows.find((row) => row?.detail.type === "file_change");
  expect(change?.detail.type === "file_change" && change.detail.change).toEqual({ path: "src/a.ts", kind: "edit" });
  expect(change?.title).toBe("src/a.ts (+1 more)");

  const mcp = rows.find((row) => row?.detail.type === "mcp_tool_call");
  expect(mcp?.detail.type === "mcp_tool_call" && mcp.detail.call.server).toBe("linear");
  expect(mcp?.detail.type === "mcp_tool_call" && mcp.detail.call.name).toBe("mcp__linear__search");

  expect(rows.some((row) => row?.detail.type === "web_search")).toBeTrue();
  const unknown = rows.find((row) => row?.detail.type === "unknown");
  expect(unknown?.detail.type === "unknown" && unknown.detail.label).toBe("quantumEntanglement");
});

test("a completed command carries its output and exit code back onto its own row", async () => {
  const { result, observations } = runTurn("tools");
  await result;
  const openRow = started(observations).find((o) => o.kind === "item.started" && o.item.detail.type === "command_execution");
  const closedRow = completed(observations).find((o) => o.kind === "item.completed" && o.detail?.type === "command_execution");
  expect(closedRow?.kind === "item.completed" && closedRow.itemId).toBe(
    openRow?.kind === "item.started" ? openRow.item.id : "",
  );
  expect(closedRow?.kind === "item.completed" && closedRow.detail?.type === "command_execution" && closedRow.detail.command).toMatchObject(
    { outputPreview: "total 0\n", exitCode: 0 },
  );
});

test("a declined item is declined, not failed — nothing went wrong", async () => {
  const { result, observations } = runTurn("declined");
  await result;
  const closed = completed(observations)[0];
  expect(closed?.kind === "item.completed" && closed.status).toBe("declined");
});

test("a failed item is failed", async () => {
  const { result, observations } = runTurn("failed-tool");
  await result;
  const closed = completed(observations)[0];
  expect(closed?.kind === "item.completed" && closed.status).toBe("failed");
});

test("a republished item is the same row, not a second one", async () => {
  const { result, observations } = runTurn("repeat-snapshot");
  await result;
  const patches = started(observations).filter((o) => o.kind === "item.started" && o.item.detail.type === "file_change");
  expect(patches).toHaveLength(1);
  expect(completed(observations).filter((o) => o.kind === "item.completed" && o.detail?.type === "file_change")).toHaveLength(1);
});

test("a row the app-server never closes is closed as failed, not left spinning", async () => {
  const { result, observations } = runTurn("abandoned-item");
  await result;
  const closed = completed(observations).find(
    (o) => o.kind === "item.completed" && started(observations).some((s) => s.kind === "item.started" && s.item.detail.type === "command_execution" && s.item.id === o.itemId),
  );
  expect(closed?.kind === "item.completed" && closed.status).toBe("failed");
});

test("the plan is one row updated in place, not a new checklist per revision", async () => {
  const { result, observations } = runTurn("plan");
  await result;
  const plans = observations.filter(
    (o) => (o.kind === "item.started" || o.kind === "item.updated") && o.item.detail.type === "plan",
  );
  expect(plans.map((o) => o.kind)).toEqual(["item.started", "item.updated"]);
  const [first, second] = plans;
  expect(first?.kind === "item.started" && second?.kind === "item.updated" && first.item.id === second.item.id).toBeTrue();
  expect(second?.kind === "item.updated" && second.item.detail.type === "plan" && second.item.detail.plan.steps[0]).toEqual({
    step: "read the driver",
    status: "completed",
  });
});

test("mid-turn compaction is keyed off the item, and the turn still ends", async () => {
  const { result, observations } = runTurn("auto-compact");
  await expect(result).resolves.toMatchObject({ text: "done" });
  expect(started(observations).some((o) => o.kind === "item.started" && o.item.detail.type === "context_compaction")).toBeTrue();
});

test("a child thread becomes a TASK, and its work is filed under it rather than the parent timeline", async () => {
  const { result, observations } = runTurn("child-thread");
  await expect(result).resolves.toMatchObject({ text: "parent answer" });

  const opened = observations.find((o) => o.kind === "task.started");
  expect(opened?.kind === "task.started" && opened.task).toMatchObject({
    id: "task_fake-child-thread",
    kind: "agent",
    state: "running",
    providerTaskId: "fake-child-thread",
  });

  const childRow = started(observations).find(
    (o) => o.kind === "item.started" && o.item.providerRefs?.sessionId === "fake-child-thread",
  );
  expect(childRow?.kind === "item.started" && childRow.item.taskId).toBe("task_fake-child-thread");
  const parentRows = started(observations).filter((o) => o.kind === "item.started" && o.item.taskId === undefined);
  expect(parentRows.length).toBeGreaterThan(0);

  const closed = observations.find((o) => o.kind === "task.completed");
  expect(closed?.kind === "task.completed" && closed.task).toMatchObject({ id: "task_fake-child-thread", state: "completed" });
});

test("a fatal error notification fails the turn with the server's own message", async () => {
  await expect(runTurn("error").result).rejects.toThrow("fake fatal failure");
});

test("a retryable error is a row, not the end of the turn", async () => {
  const { result, observations } = runTurn("error-retryable");
  await expect(result).resolves.toMatchObject({ text: "done" });
  const errorRow = started(observations).find((o) => o.kind === "item.started" && o.item.detail.type === "error");
  expect(errorRow?.kind === "item.started" && errorRow.item.detail.type === "error" && errorRow.item.detail.error.message).toBe(
    "rate limited, retrying",
  );
});

test("a failed turn is never reported as a completed one", async () => {
  await expect(runTurn("turn-failed").result).rejects.toThrow("model refused the turn");
});

test("a missing Codex is a typed provider-unavailable failure, before any subprocess exists", async () => {
  process.env.CODEX_BIN = scratchPath("definitely-not-codex");
  await expect(runTurn("plain").result).rejects.toBeInstanceOf(ProviderUnavailableError);
});

test("an abort ends the turn rather than waiting out the subprocess", async () => {
  const controller = new AbortController();
  const { result } = runTurn("plain", { controller });
  controller.abort(new Error("turn stopped"));
  await expect(result).rejects.toThrow("turn stopped");
});

test("a steered message rides turn/steer with the expected turn id, and is journalled where it landed", async () => {
  const steer = new SteerMailbox();
  const { result, observations } = runTurn("steer", { steer });
  steer.push("change course");
  await expect(result).resolves.toMatchObject({ text: "steered" });
  expect(sent("turn/steer")).toMatchObject({
    threadId: "fake-thread",
    expectedTurnId: "fake-turn-1",
    input: [{ type: "text", text: "change course" }],
  });
  const row = started(observations).find((o) => o.kind === "item.started" && o.item.detail.type === "user_message");
  expect(row?.kind === "item.started" && row.item.detail.type === "user_message" && row.item.detail.text).toBe("change course");
});

test("a steered image with no words rides turn/steer as pixels, and its row still shows the file", async () => {
  const steer = new SteerMailbox();
  const { result, observations } = runTurn("steer", { steer });
  steer.push({ text: "", attachments: [{ id: "att_1", name: "shot.png", mediaType: "image/png", bytes: 4, path: "/tmp/shot.png" }] });
  await expect(result).resolves.toMatchObject({ text: "steered" });
  expect(sent("turn/steer")).toMatchObject({ input: [{ type: "localImage", path: "/tmp/shot.png" }] });
  const row = started(observations).find((o) => o.kind === "item.started" && o.item.detail.type === "user_message");
  expect(row?.kind === "item.started" && row.item.detail.type === "user_message" ? row.item.detail.attachments?.[0]?.name : undefined).toBe("shot.png");
});

test("a steered WAKE rides turn/steer framed as the engine's notice, and its row is a wake — not the person's (#194)", async () => {
  const steer = new SteerMailbox();
  const { result, observations } = runTurn("steer", { steer });
  const wakeReason = { kind: "request_opened" as const, sessionId: "session_child", runId: "run_child", requestId: "req_1" };
  steer.push({ text: "[wake: waiting] Session session_child — is WAITING on a request", wakeReason });
  await expect(result).resolves.toMatchObject({ text: "steered" });

  const input = sent("turn/steer") as { input: Array<{ type: string; text?: string }> };
  const text = input.input.find((block) => block.type === "text")!.text!;
  expect(text).toStartWith("[engine wake · request_opened · session session_child]");
  expect(text).toEndWith("is WAITING on a request");

  const row = started(observations).find((o) => o.kind === "item.started" && o.item.detail.type === "user_message");
  expect(row?.kind === "item.started" && row.item).toMatchObject({ title: "Woken by a session", detail: { type: "user_message", wakeReason } });
  expect(row?.kind === "item.started" && (row.item.detail as { sender?: unknown }).sender).toBeUndefined();
});

test("a notification goes in as a developer instruction, and only its one line rides the user channel", async () => {
  await runTurn("plain", { prompt: PEER.body, notification: PEER }).result;

  const instructions = String(sent("thread/start").developerInstructions);
  expect(instructions).toContain("# Notification (peer_message)");
  expect(instructions).toContain("Another session sent this session a message.");
  expect(instructions).toContain(PEER.body);
  expect(instructions).toContain("Nobody typed it");

  const input = sent("turn/start").input as Array<Record<string, unknown>>;
  expect(input).toEqual([{ type: "text", text: PEER.summary, text_elements: [] }]);
  expect(JSON.stringify(input)).not.toContain("None of it is in this notice");
});

test("an ordinary turn's prompt still rides the user channel untouched", async () => {
  await runTurn("plain", { prompt: "please fix the editor" }).result;
  expect(sent("turn/start").input).toEqual([{ type: "text", text: "please fix the editor", text_elements: [] }]);
  expect(String(sent("thread/start").developerInstructions ?? "")).not.toContain("# Notification");
});

test("a notification STEERED mid-turn carries the same header, because turn/steer has no developer channel", async () => {
  const steer = new SteerMailbox();
  steer.push({ text: "the body", sender: { sessionId: "session_peer" }, notification: PEER });
  const { result, observations } = runTurn("steer", { steer });
  await result;

  const steered = sent("turn/steer").input as Array<Record<string, unknown>>;
  expect(String(steered[0]?.text)).toContain("# Notification (peer_message)");
  expect(String(steered[0]?.text)).toContain(PEER.body);
  const rows = started(observations).filter((o) => o.kind === "item.started" && o.item.detail.type === "notification");
  expect(rows).toHaveLength(1);
});
