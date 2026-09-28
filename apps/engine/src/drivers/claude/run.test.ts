import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProviderUnavailableError } from "../contract";
import { SteerMailbox } from "../../domains/turns";
import { createClaudeDriver as createRealClaudeDriver } from "./run";
import { createClaudeDriver, run } from "../../../test/claude-harness";

test("the Claude seam forwards SDK text and accepts only an explicit successful result", async () => {
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield { type: "assistant", message: { content: [{ type: "text", text: "hello" }] } };
      yield { type: "result", subtype: "success" };
    },
  }));
  const { sink, result } = run(driver);
  await expect(result).resolves.toMatchObject({ text: "hello" });
  // No stream events, so the envelope is the compatibility fallback and the
  // text arrives as one complete item rather than as deltas.
  expect(sink.observations.map((o) => o.kind)).toEqual(["item.started", "item.completed"]);
});

test("the Claude seam resumes and captures the SDK session id", async () => {
  let receivedResume: string | undefined;
  const driver = createClaudeDriver(async () => ({
    async *query(input) {
      receivedResume = input.options.resume;
      yield { type: "assistant", session_id: "claude-new-session", message: { content: [{ type: "text", text: "hello" }] } };
      yield { type: "result", subtype: "success" };
    },
  }));
  const { result } = run(driver, { providerSessionId: "claude-prior-session" });
  await expect(result).resolves.toMatchObject({ text: "hello", providerSessionId: "claude-new-session" });
  expect(receivedResume).toBe("claude-prior-session");
});

test("the session's model and effort reach the SDK, and an unknown effort is dropped rather than forwarded", async () => {
  const seen: { model?: string; effort?: string }[] = [];
  const driver = createClaudeDriver(async () => ({
    async *query(input) {
      seen.push({ model: input.options.model, effort: input.options.effort });
      yield { type: "result", subtype: "success" };
    },
  }));
  await run(driver, { model: "claude-opus-5", effort: "xhigh" }).result;
  await run(driver, { model: "claude-opus-5", effort: "deliberate" }).result;
  await run(driver, {}).result;
  expect(seen).toEqual([
    { model: "claude-opus-5", effort: "xhigh" },
    { model: "claude-opus-5", effort: undefined },
    { model: undefined, effort: undefined },
  ]);
});

test("the browser socket registers as its own http server, ALONGSIDE the in-process telar server", async () => {
  // THE KEY IS WHAT NAMES THE SERVER — `mcp__telar-browser__…` is the prefix
  // the model sees and every client parses, so the key must be the contract's
  // `TELAR_BROWSER_MCP_SERVER`, on both providers.
  let servers: Record<string, unknown> | undefined;
  const sdk = async () => ({
    tool: (name: string) => ({ name }),
    createSdkMcpServer: (input: unknown) => input,
    async *query(input: { options: { mcpServers?: Record<string, unknown> } }) {
      servers = input.options.mcpServers;
      yield { type: "result", subtype: "success" };
    },
  });
  const sessions = { list: async () => ({ sessions: [], projects: [] }) };
  await run(createClaudeDriver(sdk), {
    browserSocket: { url: "http://127.0.0.1:1234/v2/browser/mcp", token: "tok_abc" },
    sessions,
  }).result;
  // Both Telar registrations present; the http entry carries the lease.
  expect(Object.keys(servers ?? {})).toEqual(["telar-browser", "telar"]);
  expect(servers?.["telar-browser"]).toEqual({
    type: "http",
    url: "http://127.0.0.1:1234/v2/browser/mcp",
    headers: { Authorization: "Bearer tok_abc" },
  });
  // …and the in-process server holds NO browser tools: the sessions wall is
  // what puts it there, and every name on it is a sessions verb. One tool
  // surface per capability, not two.
  const telar = servers?.telar as { tools?: { name?: string }[] } | undefined;
  const inProcess = (telar?.tools ?? []).map((tool) => tool.name);
  expect(inProcess.length).toBe(20);
  expect(inProcess.every((name) => name!.startsWith("sessions_"))).toBe(true);
  // #877: `warp` was the one name here that was not a sessions verb, and it was
  // registered UNCONDITIONALLY. Pinned as an absence so a re-add fails here.
  expect(inProcess).not.toContain("warp");
});

test("a turn with no browser socket registers no telar-browser server", async () => {
  // Anti-vacuity for the spread above: absence means ABSENT, not an entry with
  // an undefined url the provider would then try to reach.
  let servers: Record<string, unknown> | undefined;
  const sdk = async () => ({
    tool: (name: string) => ({ name }),
    createSdkMcpServer: (input: unknown) => input,
    async *query(input: { options: { mcpServers?: Record<string, unknown> } }) {
      servers = input.options.mcpServers;
      yield { type: "result", subtype: "success" };
    },
  });
  const sessions = { list: async () => ({ sessions: [], projects: [] }) };
  await run(createClaudeDriver(sdk), { sessions }).result;
  expect(Object.keys(servers ?? {})).toEqual(["telar"]);
});

test("canUseTool waves the browser socket's tools through, and ONLY those", async () => {
  const asked: string[] = [];
  const answers: unknown[] = [];
  const sdk = async () => ({
    tool: (name: string) => ({ name }),
    createSdkMcpServer: (input: unknown) => input,
    async *query(input: {
      options: {
        canUseTool?: (name: string, args: Record<string, unknown>, opts: { signal: AbortSignal; toolUseID: string }) => Promise<unknown>;
      };
    }) {
      const opts = { signal: new AbortController().signal, toolUseID: "toolu_1" };
      answers.push(await input.options.canUseTool!("mcp__telar-browser__browser_click", {}, opts));
      answers.push(await input.options.canUseTool!("mcp__telar__sessions_create", {}, opts));
      yield { type: "result", subtype: "success" };
    },
  });
  await run(createClaudeDriver(sdk), {
    browserSocket: { url: "http://127.0.0.1:1234/v2/browser/mcp", token: "tok_abc" },
    onRequest: async (request: { detail: { kind: string; call?: { name: string } } }) => {
      asked.push(request.detail.kind === "tool_call" ? (request.detail.call?.name ?? "?") : request.detail.kind);
      return "accept";
    },
  }).result;
  expect(answers).toEqual([{ behavior: "allow" }, { behavior: "allow" }]);
  // The engine heard about the sessions call and ONLY the sessions call.
  expect(asked).toEqual(["mcp__telar__sessions_create"]);
});

test("a toolkit registers under the SAME one server, and only when the turn carries one", async () => {
  const seen: { serverKeys?: string[] } = {};
  const names: string[] = [];
  const sdk = async () => ({
    tool: (name: string, _d: string, _s: unknown, handler: (a: Record<string, unknown>) => Promise<{ content: unknown[] }>) => {
      names.push(name);
      return { name, handler };
    },
    createSdkMcpServer: (input: unknown) => input,
    async *query(input: { options: { mcpServers?: Record<string, unknown> } }) {
      seen.serverKeys = Object.keys(input.options.mcpServers ?? {});
      yield { type: "result", subtype: "success" };
    },
  });

  const sessions = { list: async () => ({ sessions: [], projects: [] }) };
  await run(createClaudeDriver(sdk), { sessions }).result;
  expect(seen.serverKeys).toEqual(["telar"]);
  expect(names).toEqual([
    "sessions_list",
    "sessions_create",
    "sessions_send",
    "sessions_read",
    "sessions_status",
    "sessions_stop",
    "sessions_settle",
    "sessions_diff",
    "sessions_subscribe",
    "sessions_unsubscribe",
    "sessions_subscriptions",
    "sessions_requests",
    "sessions_resolve_request",
    "sessions_find",
    "sessions_outline",
    "sessions_answer",
    "sessions_steps",
    "sessions_step",
    "sessions_grep",
    // #543, appended at the END so the wall GROWS rather than reorders — a
    // reordered list is a diff nobody can read against the one before it.
    "sessions_schedule",
  ]);
  // #877: `warp` sat after these, registered whether or not the turn carried a
  // capability. Pinned as an absence so a re-add fails here.
  expect(names).not.toContain("warp");

  names.length = 0;
  await run(createClaudeDriver(sdk)).result;
  expect(names).toEqual([]);
  expect(seen.serverKeys).toEqual([]);
});

test("a turn that carries the run capability registers run_* on the in-process telar server", async () => {
  const names: string[] = [];
  const sdk = async () => ({
    tool: (name: string, _d: string, _s: unknown, handler: (a: Record<string, unknown>) => Promise<{ content: unknown[] }>) => {
      names.push(name);
      return { name, handler };
    },
    createSdkMcpServer: (input: unknown) => input,
    async *query() {
      yield { type: "result", subtype: "success" };
    },
  });
  const run_ = {
    configurations: async () => [],
    createConfiguration: async () => ({}) as never,
    updateConfiguration: async () => ({}) as never,
    removeConfiguration: async () => {},
    status: async () => ({ history: [] }) as never,
    start: async () => ({}) as never,
    stop: async () => ({}) as never,
    restart: async () => ({}) as never,
    release: async () => {},
    output: async () => ({}) as never,
    bytes: async () => ({}) as never,
    write: async () => {},
    resize: async () => {},
  };
  await run(createClaudeDriver(sdk), { run: run_ as never }).result;
  expect(names).toEqual(
    expect.arrayContaining(["terminal_open", "terminal_list", "terminal_output", "terminal_wait", "terminal_kill", "run_configs", "run_save_config", "run_start", "run_status", "run_output", "run_stop"]),
  );
});

test("an image attachment reaches Claude as pixels; anything else reaches it as a path", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "telar-attach-")), "shot.png");
  fs.writeFileSync(file, Buffer.from([137, 80, 78, 71]));
  let prompt: unknown;
  const driver = createClaudeDriver(async () => ({
    async *query(input) {
      prompt = input.prompt;
      yield { type: "result", subtype: "success" };
    },
  }));
  await run(driver, {
    attachments: [
      { id: "att_1", name: "shot.png", mediaType: "image/png", bytes: 4, path: file },
      { id: "att_2", name: "notes.md", mediaType: "text/markdown", bytes: 9, path: "/tmp/notes.md" },
    ],
  }).result;

  expect(typeof prompt).toBe("object");
  const first = await (prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]().next();
  expect(first.done).toBe(false);
  const content = (first.value as { message: { content: Array<Record<string, unknown>> } }).message.content;
  expect(content[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw==" } });
  // The non-image is NAMED WITH ITS PATH rather than inlined: the agent has a
  // Read tool and a file it can reopen beats a copy it cannot.
  expect(content[1]).toMatchObject({ type: "text" });
  expect(String((content[1] as { text: string }).text)).toContain("notes.md (text/markdown) at /tmp/notes.md");
});

test("an image-only message reaches Claude as the image and a note naming it — never an empty text block", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "telar-attach-")), "shot.png");
  fs.writeFileSync(file, Buffer.from([137, 80, 78, 71]));
  let prompt: unknown;
  const driver = createClaudeDriver(async () => ({
    async *query(input) {
      prompt = input.prompt;
      yield { type: "result", subtype: "success" };
    },
  }));
  await run(driver, { prompt: "", attachments: [{ id: "att_1", name: "shot.png", mediaType: "image/png", bytes: 4, path: file }] }).result;
  const first = await (prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]().next();
  const content = (first.value as { message: { content: Array<Record<string, unknown>> } }).message.content;
  expect(content[0]).toMatchObject({ type: "image" });
  // Verified against the SDK: [image, this note] is accepted and the model
  // describes the picture.
  expect(content[1]).toEqual({ type: "text", text: "Attached files:\n- shot.png (image, shown above)" });
});

test("the user's MCP servers reach the SDK, and Telar's own key wins a collision", async () => {
  let servers: Record<string, unknown> | undefined;
  const driver = createClaudeDriver(async () => ({
    async *query(input) {
      servers = input.options.mcpServers;
      yield { type: "result", subtype: "success" };
    },
  }));
  await run(driver, {
    mcpServers: [
      { id: "linear", label: "Linear", enabled: true, createdAt: 1, updatedAt: 1, spec: { transport: "http", url: "https://mcp.linear.app" } },
      { id: "tools", label: "Tools", enabled: true, createdAt: 1, updatedAt: 1, spec: { transport: "stdio", command: "node", args: ["s.js"] } },
    ],
  }).result;
  expect(servers?.linear).toEqual({ type: "http", url: "https://mcp.linear.app" });
  expect(servers?.tools).toEqual({ type: "stdio", command: "node", args: ["s.js"] });
});

test("ultracode reaches the SDK as a setting beside fast mode, never as prompt text", async () => {
  const seen: { settings?: unknown }[] = [];
  const driver = createClaudeDriver(async () => ({
    async *query(input) {
      seen.push({ settings: input.options.settings });
      yield { type: "result", subtype: "success" };
    },
  }));
  await run(driver, { model: "claude-opus-5-5[1m]", ultracode: true, fastMode: true }).result;
  await run(driver, { model: "claude-opus-5-5[1m]" }).result;
  expect(seen[0]?.settings).toEqual({ fastMode: true, ultracode: true });
  // Absent stays absent: no settings layer is invented.
  expect(seen[1]?.settings).toBeUndefined();
});

test("fast mode stays explicit, and Claude turns keep 1M enabled", async () => {
  // A settings override is a request for non-default behaviour, so absence has
  // to stay absence. Both `[1m]` rows and bare family aliases explicitly keep
  // 1M enabled even if the host shell disabled it; the id picks the window.
  const seen: { model?: unknown; env?: Record<string, unknown>; settings?: { fastMode?: boolean } }[] = [];
  const driver = createClaudeDriver(async () => ({
    async *query(input) {
      seen.push({ model: input.options.model, env: input.options.env, settings: input.options.settings });
      yield { type: "result", subtype: "success" };
    },
  }));
  await run(driver, { model: "claude-fable-5-1[1m]", fastMode: true }).result;
  await run(driver, { model: "claude-opus-5" }).result;
  await run(driver, {}).result;
  expect(seen[0]).toMatchObject({ model: "claude-fable-5-1[1m]", env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: "0" }, settings: { fastMode: true } });
  expect(seen[1]).toMatchObject({ model: "claude-opus-5", env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: "0" }, settings: undefined });
  expect(seen[2]).toMatchObject({ model: undefined, env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: "0" }, settings: undefined });
});

test("a login's per-class auto-compact limit follows the session's window (#587)", async () => {
  const seen: (Record<string, unknown> | undefined)[] = [];
  const driver = createClaudeDriver(async () => ({
    async *query(input) {
      seen.push(input.options.env);
      yield { type: "result", subtype: "success" };
    },
  }));
  const autoCompact = { mode: "limits", standard: 150_000, long: 400_000 } as const;
  // A stale row from before #587 in the login's own env: the setting wins.
  const env = { DISABLE_AUTO_COMPACT: "1" };
  await run(driver, { model: "claude-opus-5-5", env, autoCompact }).result;
  await run(driver, { model: "claude-opus-5-5[1m]", env, autoCompact }).result;
  await run(driver, { model: "claude-mystery-9", autoCompact }).result;
  await run(driver, { model: "claude-opus-5-5", autoCompact: { mode: "never" } }).result;
  // N + 33 000 declared, and a percentage that lands both arms of the CLI's min on N.
  expect(seen[0]).toMatchObject({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: "183000", CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "92.02454" });
  expect(seen[0]).not.toHaveProperty("DISABLE_AUTO_COMPACT");
  expect(seen[1]).toMatchObject({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: "433000" });
  // A window it cannot name takes the standard limit, the earlier one.
  expect(seen[2]).toMatchObject({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: "183000" });
  expect(seen[3]).toMatchObject({ DISABLE_AUTO_COMPACT: "1" });
});

test("MCP tool schemas are deferred behind tool search unless the environment says otherwise", async () => {
  // 142 tools / ~38k tokens rode every request in the 24 Sep benchmark because
  // Claude Code never switched tool search on by itself.
  const seen: (Record<string, unknown> | undefined)[] = [];
  const driver = createClaudeDriver(async () => ({
    async *query(input) {
      seen.push(input.options.env);
      yield { type: "result", subtype: "success" };
    },
  }));
  const saved = process.env.ENABLE_TOOL_SEARCH;
  try {
    delete process.env.ENABLE_TOOL_SEARCH;
    await run(driver, { model: "claude-opus-5-5[1m]" }).result;
    process.env.ENABLE_TOOL_SEARCH = "false";
    await run(driver, { model: "claude-opus-5-5[1m]", sessionId: "s-optout" }).result;
  } finally {
    if (saved === undefined) delete process.env.ENABLE_TOOL_SEARCH;
    else process.env.ENABLE_TOOL_SEARCH = saved;
  }
  expect(seen[0]).toMatchObject({ ENABLE_TOOL_SEARCH: "true" });
  expect(seen[1]).toMatchObject({ ENABLE_TOOL_SEARCH: "false" });
});

test("the Claude seam tells the SDK which executable to spawn", async () => {
  let received: string | undefined;
  const driver = createRealClaudeDriver(
    async () => ({
      async *query(input) {
        received = input.options.pathToClaudeCodeExecutable;
        yield { type: "result", subtype: "success" };
      },
    }),
    { resolveExecutable: () => "/opt/homebrew/bin/claude" },
  );
  await run(driver).result;
  expect(received).toBe("/opt/homebrew/bin/claude");
});

test("a resolver with nothing to offer leaves the SDK's own lookup alone", async () => {
  // Not the same as pointing it at a path that does not exist: an absent option
  // is the SDK's documented default, and inventing a path would turn "we could
  // not find one" into a spawn failure naming a file nobody chose.
  let seen = false;
  let received: string | undefined = "untouched";
  const driver = createRealClaudeDriver(
    async () => ({
      async *query(input) {
        seen = true;
        received = input.options.pathToClaudeCodeExecutable;
        yield { type: "result", subtype: "success" };
      },
    }),
    { resolveExecutable: () => undefined },
  );
  await run(driver).result;
  expect(seen).toBe(true);
  expect(received).toBeUndefined();
});

test("no Claude Code on this machine fails the turn with what to install", async () => {
  // AD-11: a harness Telar cannot honour fails the turn rather than degrading.
  // The message is the resolver's own, so the reader learns what to install
  // instead of reading an errno from a spawn three layers down.
  const driver = createRealClaudeDriver(
    async () => ({
      async *query() {
        throw new Error("the SDK must never be reached when there is no binary to run");
      },
    }),
    {
      resolveExecutable: () => {
        throw new ProviderUnavailableError("No Claude Code installation found. Telar does not bundle one.");
      },
    },
  );
  await expect(run(driver).result).rejects.toThrow(ProviderUnavailableError);
});

test("TELAR_CLAUDE_STREAMING_INPUT=0 restores the plain-string prompt — the field kill switch", async () => {
  const previous = process.env.TELAR_CLAUDE_STREAMING_INPUT;
  process.env.TELAR_CLAUDE_STREAMING_INPUT = "0";
  try {
    let seenPrompt: unknown;
    const driver = createClaudeDriver(async () => ({
      async *query({ prompt }: { prompt: unknown }) {
        seenPrompt = prompt;
        yield { type: "result", subtype: "success" };
      },
    }) as never);
    await run(driver, { steer: new SteerMailbox() }).result;
    expect(seenPrompt).toBe("prompt");
  } finally {
    if (previous === undefined) delete process.env.TELAR_CLAUDE_STREAMING_INPUT;
    else process.env.TELAR_CLAUDE_STREAMING_INPUT = previous;
  }
});

test("a user message echoed with STRING content does not fail the turn", async () => {
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield { type: "user", message: { role: "user", content: "a plain-string echo" } };
      yield { type: "assistant", message: { content: "also a plain string" } };
      yield { type: "assistant", message: { content: [{ type: "text", text: "hello" }] } };
      yield { type: "result", subtype: "success" };
    },
  }));
  await expect(run(driver).result).resolves.toMatchObject({ text: expect.stringContaining("hello") });
});
