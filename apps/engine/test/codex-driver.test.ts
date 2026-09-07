/**
 * The Codex seam, driven through a REAL `codex app-server` subprocess.
 *
 * WHY A SUBPROCESS AND NOT A MOCK. Every bug this driver exists to avoid lives
 * at the transport: a handler awaited inside the stdout reader, a server→client
 * request nobody answered, a `decision` spelled in the wrong vocabulary. None
 * of those are reachable from an injected async iterable — they are properties
 * of stdio framing, of ordering, and of what got written back. So the fake
 * app-server is a real process, reached the way production reaches Codex
 * (`CODEX_BIN`), and the assertions are made on the observations the driver
 * produced AND on the bytes it wrote (the fixture's request/response tape).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer, RequestDecision, TurnObservation } from "@telar/engine-client";
import { codexMcpServers, codexSandboxPolicy, codexTurnInput, createCodexDriver, type CodexDriverOptions } from "../src/codex-driver";
import { codexApprovalRequest, codexUsage } from "../src/codex/items";
import { ProviderUnavailableError, type DriverRequest } from "../src/driver";
import { SteerMailbox } from "../src/steering";

const FAKE_BIN = fileURLToPath(new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url));

let previousCodexBin: string | undefined;
let logDir: string;
let logPath: string;

beforeEach(() => {
  previousCodexBin = process.env.CODEX_BIN;
  process.env.CODEX_BIN = FAKE_BIN;
  logDir = mkdtempSync(join(tmpdir(), "codex-driver-"));
  logPath = join(logDir, "wire.jsonl");
});

afterEach(() => {
  if (previousCodexBin === undefined) delete process.env.CODEX_BIN;
  else process.env.CODEX_BIN = previousCodexBin;
  rmSync(logDir, { recursive: true, force: true });
});

type Recorded = { method: string; params: Record<string, unknown> | null };

const wire = (): Recorded[] =>
  readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Recorded);

function sent(method: string): Record<string, unknown> {
  const hit = wire().find((entry) => entry.method === method);
  if (!hit) throw new Error(`no ${method} on the wire: ${JSON.stringify(wire().map((e) => e.method))}`);
  return hit.params ?? {};
}

/** Everything the client replied to a server→client request. */
const replies = (): Array<{ id: number; result: Record<string, unknown> | null; error: { code: number } | null }> =>
  wire()
    .filter((entry) => entry.method === "@response")
    .map((entry) => entry.params as never);

type RunOptions = {
  prompt?: string;
  cwd?: string;
  providerSessionId?: string;
  onRequest?: (request: DriverRequest) => Promise<RequestDecision | { decision: RequestDecision; answers?: Record<string, unknown> }>;
  controller?: AbortController;
  options?: CodexDriverOptions;
  mcpServers?: McpServer[];
  browserSocket?: { url: string; token: string };
  sessionsSocket?: { url: string; token: string };
  steer?: SteerMailbox;
};

function runTurn(scenario: string, run: RunOptions = {}) {
  const observations: TurnObservation[] = [];
  const controller = run.controller ?? new AbortController();
  const driver = createCodexDriver({
    ...run.options,
    env: { FAKE_CODEX_TURN_SCENARIO: scenario, FAKE_CODEX_PARAMS_LOG: logPath, ...run.options?.env },
  });
  const result = driver.run({
    prompt: run.prompt ?? "hi",
    cwd: run.cwd ?? "/tmp/project",
    signal: controller.signal,
    onObservations: async (batch) => void observations.push(...batch),
    ...(run.providerSessionId ? { providerSessionId: run.providerSessionId } : {}),
    ...(run.onRequest ? { onRequest: run.onRequest } : {}),
    ...(run.mcpServers ? { mcpServers: run.mcpServers } : {}),
    ...(run.browserSocket ? { browserSocket: run.browserSocket } : {}),
    ...(run.sessionsSocket ? { sessionsSocket: run.sessionsSocket } : {}),
    ...(run.steer ? { steer: run.steer } : {}),
  });
  return { result, observations, controller };
}

const mcp = (id: string, spec: McpServer["spec"]): McpServer => ({
  id,
  label: id,
  enabled: true,
  spec,
  createdAt: 0,
  updatedAt: 0,
});

const started = (observations: TurnObservation[]) => observations.filter((o) => o.kind === "item.started");
const completed = (observations: TurnObservation[]) => observations.filter((o) => o.kind === "item.completed");
const deltas = (observations: TurnObservation[]) => observations.filter((o) => o.kind === "content.delta");

// ── the ordinary turn ──────────────────────────────────────────────────────

test("a turn streams its text as deltas and does not double it on completion", async () => {
  const { result, observations } = runTurn("plain");
  await expect(result).resolves.toMatchObject({ text: "hello", providerSessionId: "fake-thread" });

  expect(deltas(observations).map((o) => (o.kind === "content.delta" ? o.text : ""))).toEqual(["hel", "lo"]);
  // THE DOUBLE-COUNT GUARD. Codex re-sends an agentMessage's FULL text on
  // `item/completed`; appending it after streaming produces "hellohello" in the
  // turn result and a duplicated transcript. One row, one copy of the text.
  const messages = started(observations).filter((o) => o.kind === "item.started" && o.item.detail.type === "assistant_message");
  expect(messages).toHaveLength(1);
});

test("usage comes from tokenUsage.last, never .total, and carries no invented price", async () => {
  const { result, observations } = runTurn("plain");
  const resolved = await result;

  // `.total` is cumulative across the thread's whole history — reading it here
  // re-bills every earlier turn of a resumed session on every subsequent one.
  // The fixture's totals are 9000s precisely so a `.total` read is unmistakable.
  expect(resolved.usage).toEqual({
    tokens: { input: 120, output: 45, cacheRead: 30, cacheCreate: 10, reasoning: 12 },
    contextUsed: 195,
    contextMax: 400_000,
  });
  // Codex quotes no price anywhere on this wire. An absent figure is the honest
  // answer; a computed one would be a second definition of what a turn cost.
  expect(resolved.usage && "costUsd" in resolved.usage).toBeFalse();
  // The child thread's usage is its own turn's, not this one's.
  expect(observations.filter((o) => o.kind === "usage")).toHaveLength(1);
});

test("a usage update for the wrong shape reports nothing rather than zeros", () => {
  // Anti-vacuity for the mapping above: a snapshot with no `last` must not
  // become a zeroed reading that looks like a turn which cost nothing.
  expect(codexUsage({ tokenUsage: { total: { inputTokens: 10 }, modelContextWindow: 400000 } })).toBeUndefined();
  expect(codexUsage({})).toBeUndefined();
});

// ── the wire ───────────────────────────────────────────────────────────────

test("turn/start sends the app-server's own input shape, snake_case field and all", async () => {
  await runTurn("plain", { prompt: "hello codex" }).result;
  // `text_elements` is REQUIRED and is snake_case alone among every field on
  // this wire. A text item without it is rejected, and "tidying" it is the
  // change that would do it.
  expect(sent("turn/start").input).toEqual([{ type: "text", text: "hello codex", text_elements: [] }]);
  expect(codexTurnInput("x")).toEqual([{ type: "text", text: "x", text_elements: [] }]);
});

test("an image attachment becomes a localImage element; anything else is named in the text", () => {
  // `localImage` carries a PATH, not bytes — the app-server's own `UserInput`
  // union says so, and the file is already on the disk Codex is working on.
  const input = codexTurnInput("look", [
    { id: "att_1", name: "shot.png", mediaType: "image/png", bytes: 4, path: "/tmp/shot.png" },
    { id: "att_2", name: "notes.md", mediaType: "text/markdown", bytes: 9, path: "/tmp/notes.md" },
  ]);
  expect(input[1]).toEqual({ type: "localImage", path: "/tmp/shot.png" });
  expect(String((input[0] as { text: string }).text)).toContain("notes.md (text/markdown) at /tmp/notes.md");
  // The text element keeps its required snake_case field even when it grew.
  expect(input[0]).toMatchObject({ type: "text", text_elements: [] });
});

test("the app-server is launched with exactly one argument and told everything else in params", async () => {
  await runTurn("plain").result;
  // Config on an argv is world-readable through `ps` to every process running
  // as this user — including the sandboxed shells of the agent sessions.
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
  // `dynamicTools: []` says "this client has no tools", which is not the same
  // sentence as saying nothing — and a resumed thread that says it LOSES the
  // tools it started with. Same for developerInstructions and config.
  expect("dynamicTools" in params).toBeFalse();
  expect("developerInstructions" in params).toBeFalse();
  // A session with no servers must say NOTHING rather than declare an empty
  // registry, which would read as "forget the ones in config.toml".
  expect("config" in params).toBeFalse();
  expect(params).toMatchObject({ cwd: "/tmp/project", model: "gpt-5.5" });
});

test("the user's MCP servers ride thread/start's config overlay", async () => {
  // THE HEADER OF codex-driver.ts USED TO SAY THIS WAS IMPOSSIBLE — "the shape
  // its thread/start `config` overlay accepts for servers is not something this
  // driver can verify against anything". It was settled by asking the real
  // binary rather than reasoning about it: `codex app-server
  // generate-json-schema` publishes the overlay, and driving codex-cli 0.145.0
  // with a real MCP server showed all four shapes reach `ready` with their
  // tools listed. The shapes below are the ones that were measured.
  await runTurn("plain", {
    mcpServers: [
      mcp("local", { transport: "stdio", command: "node", args: ["server.js"], env: { TOKEN: "x" } }),
      mcp("linear", { transport: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer managed" } }),
    ],
  }).result;

  expect(sent("thread/start").config).toEqual({
    mcp_servers: {
      local: { command: "node", args: ["server.js"], env: { TOKEN: "x" } },
      // THE TOKEN TRAVELS ON STDIN, WHICH IS THE WHOLE REASON THIS IS ALLOWED.
      // t3 code injects its own server through `-c` argv and is therefore forced
      // to pass the token as `bearer_token_env_var`, because an argv is
      // world-readable through `ps` to every process running as this user —
      // including the sandboxed shells of the agent sessions. The `config`
      // overlay has no such exposure, and `app-server` is still spawned with
      // exactly one argument.
      // NO `default_tools_approval_mode`. Setting it would hand the decision
      // to Codex's config; the engine answers the approval instead — see the
      // elicitation test below.
      linear: { url: "https://mcp.linear.app/mcp", http_headers: { Authorization: "Bearer managed" } },
    },
  });
});

test("Telar's own computer use turns off Codex's native one — for this thread only", async () => {
  // The claim carries Telar's `mac` server (cua-driver). Codex's bundled
  // computer_use is disabled in the SAME per-thread config overlay, never
  // written to config.toml — so the user's own ChatGPT/Codex keeps its native
  // computer use. Without this the model sees two desktops under two names.
  await runTurn("plain", {
    mcpServers: [mcp("mac", { transport: "stdio", command: "/usr/local/bin/cua-driver", args: ["mcp"] })],
  }).result;

  expect(sent("thread/start").config).toEqual({
    mcp_servers: { mac: { command: "/usr/local/bin/cua-driver", args: ["mcp"] } },
    features: { computer_use: false },
  });
});

test("a claim WITHOUT the mac server leaves Codex's native computer use alone", async () => {
  // No `features` overlay at all — an absent overlay says nothing, which is not
  // the same sentence as `computer_use: true`.
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

  // Merged WITH the user's servers, Telar's entry applied last — there is no
  // `strictMcpConfig` on this path, so shadowing a colliding user server is
  // the only defence available.
  expect(sent("thread/start").config).toEqual({
    mcp_servers: {
      linear: { url: "https://mcp.linear.app/mcp", http_headers: { Authorization: "Bearer managed" } },
      "telar-browser": { url: lease.url, http_headers: { Authorization: "Bearer tok_secret_abc" } },
    },
  });
  // The spawn rule survives the injection: exactly one argument, and the
  // token reaches the app-server on stdin only.
  const argv = sent("@argv").argv as string[];
  expect(argv.slice(1)).toEqual(["app-server"]);
  expect(JSON.stringify(argv)).not.toContain("tok_secret_abc");
  expect(sent("thread/start").developerInstructions).toContain("tools may be deferred");
  expect(sent("thread/start").developerInstructions).toContain("telar-browser");
});

test("the sessions socket rides the same overlay, beside the browser's, token on stdin only", async () => {
  // The `sessions_*` wall for Codex — see `sessions-tools/run-socket.ts`. Same
  // shape, same shadowing rule, same spawn discipline as the browser's entry.
  const browser = { url: "http://127.0.0.1:1234/v2/browser/mcp", token: "tok_browser" };
  const sessions = { url: "http://127.0.0.1:5678/v2/sessions/mcp", token: "tok_sessions_xyz" };
  await runTurn("plain", { browserSocket: browser, sessionsSocket: sessions }).result;

  expect(sent("thread/start").config).toEqual({
    mcp_servers: {
      "telar-browser": { url: browser.url, http_headers: { Authorization: "Bearer tok_browser" } },
      "telar-sessions": { url: sessions.url, http_headers: { Authorization: "Bearer tok_sessions_xyz" } },
    },
  });
  const argv = sent("@argv").argv as string[];
  expect(argv.slice(1)).toEqual(["app-server"]);
  expect(JSON.stringify(argv)).not.toContain("tok_sessions_xyz");
});

test("the sessions socket stands alone too — a Codex session without a browser still reaches its peers", async () => {
  const sessions = { url: "http://127.0.0.1:5678/v2/sessions/mcp", token: "tok_only" };
  await runTurn("plain", { sessionsSocket: sessions }).result;
  expect(sent("thread/start").config).toEqual({
    mcp_servers: { "telar-sessions": { url: sessions.url, http_headers: { Authorization: "Bearer tok_only" } } },
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
  // The fixture answers `config/mcpServer/reload` with -32601 (it implements
  // nothing it was not taught), so this test ALSO proves the refresh is
  // non-fatal: a stale catalogue costs tools, a throw would cost the turn.
  const methods = wire().map((entry) => entry.method);
  const reload = methods.indexOf("config/mcpServer/reload");
  expect(reload).toBeGreaterThan(methods.indexOf("thread/start"));
  expect(reload).toBeLessThan(methods.indexOf("turn/start"));
});

test("a turn with no MCP servers at all sends no catalogue refresh", async () => {
  // Anti-vacuity for the guard: a session with nothing registered must not
  // grow a new request on every turn.
  await runTurn("plain").result;
  expect(wire().some((entry) => entry.method === "config/mcpServer/reload")).toBeFalse();
  expect(sent("thread/start").developerInstructions).toBeUndefined();
});

test("the translation names Codex's fields, not the contract's", () => {
  // `sse` IS SENT AS `url` TOO: Codex has one HTTP client and picks the
  // transport from what the server answers. There is no `sse` key to set, and
  // inventing one would be the unknown-key failure that kept this unbuilt.
  expect(codexMcpServers([mcp("events", { transport: "sse", url: "https://mcp.example.com/sse" })])).toEqual({
    events: { url: "https://mcp.example.com/sse" },
  });
  // Empty collections are dropped rather than sent as empty, for the same
  // reason `config` itself is omitted when there is nothing to say.
  expect(codexMcpServers([mcp("bare", { transport: "stdio", command: "node", args: [], env: {} })])).toEqual({
    bare: { command: "node" },
  });
  expect(codexMcpServers([])).toBeUndefined();
  expect(codexMcpServers(undefined)).toBeUndefined();
});

test("a resumed turn resumes the thread and never opens a second one", async () => {
  const { result } = runTurn("plain", { providerSessionId: "thread-42" });
  await expect(result).resolves.toMatchObject({ providerSessionId: "thread-42" });
  expect(sent("thread/resume").threadId).toBe("thread-42");
  // A resume that also started a thread would silently orphan the history the
  // engine handed over.
  expect(wire().some((entry) => entry.method === "thread/start")).toBeFalse();
});

test("the posture follows whether the engine wired a gate at all", async () => {
  await runTurn("plain").result;
  // No `onRequest` is the full-access shape `driver.ts` documents: nothing to
  // ask, so Codex is told not to.
  expect(sent("turn/start")).toMatchObject({ approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } });

  rmSync(logPath, { force: true });
  await runTurn("plain", { onRequest: async () => "accept" }).result;
  // A gate exists, so Codex asks about everything and the ENGINE decides. Codex
  // must never apply a second policy on top of the engine's — two deciders,
  // one audit trail.
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
  // The per-turn policy is what actually decides network access, and it is
  // derived from the same value so the two can never disagree.
  expect(sent("turn/start").sandboxPolicy).toEqual({ type: "readOnly", networkAccess: false });
  expect(codexSandboxPolicy("danger-full-access", "/x")).toEqual({ type: "dangerFullAccess" });
});

// ── items ──────────────────────────────────────────────────────────────────

test("reasoning is its own row, is filled in from deltas, and never joins the answer", async () => {
  const { result, observations } = runTurn("reasoning");
  await expect(result).resolves.toMatchObject({ text: "answer" });

  const delta = deltas(observations)[0];
  expect(delta?.kind === "content.delta" && delta.stream).toBe("reasoning_text");
  // Codex sends reasoning text ONLY as deltas — the completed item carries
  // none — so a stored row would read empty unless the driver keeps the
  // accumulation and puts it back.
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
  // One Codex item is one row, so a multi-file patch says so rather than
  // pretending it touched one file.
  expect(change?.title).toBe("src/a.ts (+1 more)");

  const mcp = rows.find((row) => row?.detail.type === "mcp_tool_call");
  expect(mcp?.detail.type === "mcp_tool_call" && mcp.detail.call.server).toBe("linear");
  // NORMALIZED TO CLAUDE'S SPELLING. Codex hands over `{ server, tool }` and
  // this used to store `linear.search` while the identical tool called through
  // Claude stored `mcp__linear__search` — one tool with two names, so a client
  // grouping by tool sees two, and an approval remembered against one does not
  // match the other.
  expect(mcp?.detail.type === "mcp_tool_call" && mcp.detail.call.name).toBe("mcp__linear__search");

  expect(rows.some((row) => row?.detail.type === "web_search")).toBeTrue();
  // THE LOAD-BEARING CASE: an item type this driver has never heard of still
  // produces a row. Codex ships new item types faster than this file learns
  // them, and a silently missing row is worse than an ugly one.
  const unknown = rows.find((row) => row?.detail.type === "unknown");
  expect(unknown?.detail.type === "unknown" && unknown.detail.label).toBe("quantumEntanglement");
});

test("a completed command carries its output and exit code back onto its own row", async () => {
  const { result, observations } = runTurn("tools");
  await result;
  const openRow = started(observations).find((o) => o.kind === "item.started" && o.item.detail.type === "command_execution");
  const closedRow = completed(observations).find((o) => o.kind === "item.completed" && o.detail?.type === "command_execution");
  // Keyed off Codex's item id, so the completion closes the row its start
  // opened rather than opening a second one.
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
  // The discriminating half of the case above: the two statuses must not be
  // collapsed in either direction.
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
  // Same row id both times — the legacy bridge minted a fresh TodoWrite-shaped
  // tool call per update and left the transcript full of near-identical lists.
  const [first, second] = plans;
  expect(first?.kind === "item.started" && second?.kind === "item.updated" && first.item.id === second.item.id).toBeTrue();
  expect(second?.kind === "item.updated" && second.item.detail.type === "plan" && second.item.detail.plan.steps[0]).toEqual({
    step: "read the driver",
    status: "completed",
  });
});

test("mid-turn compaction is keyed off the item, and the turn still ends", async () => {
  // The legacy bridge waited for a `thread/compacted` notification that is dead
  // in current Codex; the fixture never sends one, so a driver that waited
  // would hang here instead of finishing.
  const { result, observations } = runTurn("auto-compact");
  await expect(result).resolves.toMatchObject({ text: "done" });
  expect(started(observations).some((o) => o.kind === "item.started" && o.item.detail.type === "context_compaction")).toBeTrue();
});

test("a child thread becomes a TASK, and its work is filed under it rather than the parent timeline", async () => {
  const { result, observations } = runTurn("child-thread");
  // The parent's answer only. A sub-agent's prose is not what the human asked.
  await expect(result).resolves.toMatchObject({ text: "parent answer" });

  // Codex has no `task_started` to key off the way Claude does — a sub-agent
  // simply IS a thread that is not the root, so the task is declared the first
  // time such a thread speaks.
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
  // The parent's own rows stay unfiled — that is what makes the split mean
  // something.
  const parentRows = started(observations).filter((o) => o.kind === "item.started" && o.item.taskId === undefined);
  expect(parentRows.length).toBeGreaterThan(0);

  // The child's turn completing is the only signal it is done. Without closing
  // it here `livenessOf` would report this session as working forever.
  const closed = observations.find((o) => o.kind === "task.completed");
  expect(closed?.kind === "task.completed" && closed.task).toMatchObject({ id: "task_fake-child-thread", state: "completed" });
});

// ── approvals ──────────────────────────────────────────────────────────────

test("an approval is answered without stalling the stream behind it", async () => {
  // THE DEADLOCK TEST. The fixture keeps streaming while the approval is
  // outstanding, and this handler refuses to answer until it has SEEN one of
  // those deltas. A driver that awaited its approval handler inside the stdout
  // reader can never satisfy both, and this test times out instead of passing.
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
  // The row and the request correlate through Codex's own item id.
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
  // `approved`, not `accept`. Sending the item/* spelling here is not an error
  // the app-server reports — it is a decision it ignores.
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
  // Kinds are coarse by capability: what the human is being asked is "may you
  // write files here", which is one decision whatever the tool is called.
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
  // `cancel` is not "no to this call", it is "stop", and the difference is
  // exactly this: the fixture goes on to finish the turn normally after a
  // decline, so a driver that treated cancel as an ordinary decline would
  // RESOLVE here with the turn's text instead of withdrawing.
  await expect(result).rejects.toThrow("cancelled this turn");
});

test("with no gate wired, an approval is refused rather than left hanging", async () => {
  // approvalPolicy is "never" in this posture so the app-server should not ask
  // — but if it does, an unanswered request stops the turn forever.
  const { result } = runTurn("approval-command");
  await expect(result).resolves.toMatchObject({ text: "ok" });
  expect(replies().at(-1)?.error?.code).toBe(-32601);
});

test("a server request this client has never heard of is still answered", async () => {
  // The fixture will not finish the turn until it gets a reply. Every
  // server→client request must be answered — including the ones from a Codex
  // newer than this driver — or the app-server waits, and so does the human.
  const { result } = runTurn("unknown-request");
  await expect(result).resolves.toMatchObject({ text: "done" });
  expect(replies().at(-1)?.error?.code).toBe(-32601);
});

// ── failure ────────────────────────────────────────────────────────────────

test("a fatal error notification fails the turn with the server's own message", async () => {
  await expect(runTurn("error").result).rejects.toThrow("fake fatal failure");
});

test("a retryable error is a row, not the end of the turn", async () => {
  // Ending here would fail a turn that goes on to succeed — the app-server said
  // it would try again.
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
  process.env.CODEX_BIN = join(logDir, "definitely-not-codex");
  // A binary that is not there must read as a binary that is not there — the
  // legacy resolver spawned it anyway and reported "app-server exited
  // (code=null)", which told the user nothing about what to install.
  await expect(runTurn("plain").result).rejects.toBeInstanceOf(ProviderUnavailableError);
});

test("an abort ends the turn rather than waiting out the subprocess", async () => {
  const controller = new AbortController();
  const { result } = runTurn("plain", { controller });
  controller.abort(new Error("turn stopped"));
  await expect(result).rejects.toThrow("turn stopped");
});

test("an MCP tool approval is an elicitation, and the engine answers it", () => {
  // THE REAL PAYLOAD, copied from a logged turn against codex-cli 0.145.0.
  // Codex does not send an approval request for MCP tools at all — it sends an
  // MCP *elicitation*, the protocol's general "ask the human" channel, with the
  // approval buried in `_meta.codex_approval_kind`. Nothing about the method
  // name says "approval", which is why it went unrecognised: the transport
  // answered -32601 (RULE TWO, so the app-server is never left waiting) and
  // Codex read a refused REQUEST as a refused TOOL, ending the turn with "user
  // rejected MCP tool call" about a user who was never asked.
  const approval = codexApprovalRequest("mcpServer/elicitation/request", {
    threadId: "019ffda0-1892-7510-989e-5efb17c4de3b",
    turnId: "019ffda0-20dc-7961-914a-26b1a34ed12f",
    serverName: "probe",
    mode: "form",
    _meta: {
      codex_approval_kind: "mcp_tool_call",
      persist: ["session", "always"],
      tool_description: "Answers pong.",
      tool_params: { query: "x" },
    },
    message: 'Allow the probe MCP server to run tool "ping"?',
    requestedSchema: { type: "object", properties: {} },
  });

  expect(approval?.kind).toBe("tool_call");
  // Qualified the way every other MCP row names its tool, so the approval card
  // and the timeline row it is about spell the same string. The tool name is
  // ONLY in the prose — `serverName` and `tool_params` are structured, the tool
  // itself is not — so it is read out of the quotes.
  expect(approval?.detail).toEqual({
    kind: "tool_call",
    call: { name: "mcp__probe__ping", server: "probe", input: { query: "x" } },
  });
});

test("an elicitation that is not an approval is not one to answer", () => {
  // A server may legitimately elicit input — a form, a URL to visit — and the
  // engine has no answer to invent, which is the rule `user_input` follows in
  // the contract. Recognising it as an approval would auto-accept somebody's
  // form on their behalf.
  expect(
    codexApprovalRequest("mcpServer/elicitation/request", {
      serverName: "probe",
      mode: "url",
      message: "Open this to link your account",
      url: "https://example.com/link",
      elicitationId: "e1",
    }),
  ).toBeNull();
});

test("a declined MCP approval answers in the elicitation's vocabulary, not the approval one", async () => {
  // THREE VOCABULARIES FOR ONE QUESTION and none of them errors on the wrong
  // one — the app-server ignores a decision it cannot read, which presents as a
  // turn that hangs or silently refuses. `action`, not `decision`, and the
  // values come from MCP rather than from Codex.
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

test("a steered message rides turn/steer with the expected turn id, and is journalled where it landed", async () => {
  // The fixture's turn finishes only once a turn/steer arrives, so the test
  // is deterministic: push → pump wakes → wire carries it → turn ends.
  const steer = new SteerMailbox();
  const { result, observations } = runTurn("steer", { steer });
  steer.push("change course");
  await expect(result).resolves.toMatchObject({ text: "steered" });
  // The protocol's own params: threadId, the REQUIRED active-turn
  // precondition, and the same input shape turn/start sends.
  expect(sent("turn/steer")).toMatchObject({
    threadId: "fake-thread",
    expectedTurnId: "fake-turn-1",
    input: [{ type: "text", text: "change course" }],
  });
  // The injected sentence is a transcript row — the agent's change of
  // direction must have a visible cause.
  const row = started(observations).find((o) => o.kind === "item.started" && o.item.detail.type === "user_message");
  expect(row?.kind === "item.started" && row.item.detail.type === "user_message" && row.item.detail.text).toBe("change course");
});

test("the app-server's requestUserInput becomes a user_input request, and the answers ride back by question id", async () => {
  // The SAME contract shape the Claude driver's AskUserQuestion arm opens, so
  // the cockpit's question drawer serves both providers. The wire reply maps
  // question id → {answers: string[]} (ToolRequestUserInputResponse).
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

test("a declined requestUserInput answers an EMPTY map — the tool's own no-answer arm, not a hang", async () => {
  const { result } = runTurn("request-user-input", { onRequest: async () => "decline" });
  await expect(result).resolves.toMatchObject({ text: "answered={}" });
});

test("an accepted MCP approval carries the content field the protocol requires", async () => {
  await runTurn("mcp-elicitation", { onRequest: async () => "accept" }).result;
  expect(replies()[0]?.result).toEqual({ action: "accept", content: {} });
});

test("the browser socket's OWN elicitation is answered by the driver, never by the engine", async () => {
  // THE SOCKET IS THE DECIDER for its tools — the per-lease gate already asked
  // the engine before the call ran. Routing Codex's elicitation to `onRequest`
  // too would put two cards in front of one click. And it must be an ACCEPT in
  // the elicitation's vocabulary, never an unanswered request: a -32601 reads
  // to Codex as a refused tool, naming a user who was never asked.
  const seen: DriverRequest[] = [];
  const { result, observations } = runTurn("mcp-elicitation-telar", {
    browserSocket: { url: "http://127.0.0.1:1234/v2/browser/mcp", token: "tok_abc" },
    onRequest: async (request) => {
      seen.push(request);
      return "decline";
    },
  });
  await result;
  // A gate that would have said NO was never consulted — and the tool ran,
  // because the socket's gate is where that no belongs.
  expect(seen).toEqual([]);
  expect(replies()[0]?.result).toEqual({ action: "accept", content: {} });
  // …and the call lands on the SAME row type a Claude session's browser call
  // produces, under the same canonical name — the whole point of sharing the
  // `telar-browser` key across providers.
  const row = observations.find((o) => o.kind === "item.completed" && o.status === "completed");
  expect(row?.kind === "item.completed" && row.detail?.type).toBe("browser_action");
  expect(row?.kind === "item.completed" && row.detail?.type === "browser_action" && row.detail.call.name).toBe(
    "mcp__telar-browser__browser_navigate",
  );
});

test("the sessions socket's elicitation DOES reach the engine's gate — it carries no gate of its own", async () => {
  // THE DELIBERATE ASYMMETRY with the browser test above. The browser socket
  // enforces approvals per lease, so its elicitation is auto-accepted here;
  // the sessions socket enforces nothing, so its elicitation must ride the
  // ordinary approval arm — the same ladder a Claude session's `sessions_*`
  // call answers to through `canUseTool`. Auto-accepting it would make Codex
  // the one provider whose sessions tools skip the mode's decision.
  const seen: DriverRequest[] = [];
  const { result } = runTurn("mcp-elicitation-telar-sessions", {
    sessionsSocket: { url: "http://127.0.0.1:5678/v2/sessions/mcp", token: "tok_s" },
    onRequest: async (request) => {
      seen.push(request);
      return "decline";
    },
  });
  await expect(result).resolves.toMatchObject({ text: "action=decline" });
  expect(seen.map((request) => request.kind)).toEqual(["tool_call"]);
  // Declined in the elicitation's own vocabulary, so Codex reads a refusal,
  // not a broken server.
  expect(replies()[0]?.result).toEqual({ action: "decline" });
});
