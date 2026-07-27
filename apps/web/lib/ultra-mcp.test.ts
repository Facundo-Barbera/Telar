// Hermetic tests for the "ultra" in-process MCP server (docs/plans/
// ultra-harness.md §4, cut U5). Mirrors loom-mcp.answer-blocked.test.ts's
// harness exactly: @telar/core is mock.module'd so no real Ultra
// core/filesystem is ever touched, and the SDK MCP server's registered
// handlers are invoked directly.
//
// bun provides "bun:test" at runtime; @types/bun isn't a dep of this Next app
// (see loom-mcp.answer-blocked.test.ts's identical note). The runtime is
// `bun test`.
// @ts-expect-error no @types/bun in this workspace
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
// Capture the REAL @telar/core (hoisted above the mock.module below) so
// afterAll can restore it — bun's mock.module is process-global and would
// otherwise leak into sibling test files. `AccountProfile` is a type-only
// import — erased at compile time, so it's unaffected by the mock below.
import * as realCore from "@telar/core";
import type { AccountProfile } from "@telar/core";

// SNAPSHOT the real exports into a plain object NOW, before mock.module runs.
// `realCore` is a live ES-module namespace: once mock.module replaces the
// module, `realCore`'s own bindings reflect the MOCK, so restoring
// `() => realCore` in afterAll would re-install the mock and leak it into every
// later test file. Spreading here copies the genuine functions by value.
const realCoreSnapshot = { ...realCore };

type CompileResult =
  | { ok: true; meta: Record<string, unknown> }
  | { ok: false; error: string; kind: string; detail: string; line: number };

// ── Controllable mock state (reset in beforeEach) ───────────────────────────
let compileScriptReturn: CompileResult = { ok: true, meta: { name: "t" } };
const compileScriptCalls: string[] = [];

let launchUltraReturn: { ok: true; runId: string; meta: Record<string, unknown> } | { ok: false; error: string } = {
  ok: true,
  runId: "u-mockrun",
  meta: { name: "t" },
};
const launchUltraCalls: Record<string, unknown>[] = [];

let getUltraManifestReturn: Record<string, unknown> | null = {
  runId: "u-mockrun",
  state: "running",
  meta: { name: "t" },
  spend: 0.12,
  startedAt: 1000,
  updatedAt: 2000,
};
const getUltraManifestCalls: string[] = [];

let readUltraEventsReturn: { events: Record<string, unknown>[] } = { events: [] };

let stopUltraRunReturn = true;
const stopUltraRunCalls: string[] = [];

const getProjectReturn = (project: string) => {
  if (project !== "proj") throw new Error(`unknown project ${project}`);
  return { manifest: { root: "/root/proj" } };
};

// Mock @telar/core BEFORE importing ultra-mcp (a static import of ultra-mcp
// would be hoisted above this, so it's pulled in via `await import` below).
mock.module("@telar/core", () => ({
  compileScript: (script: string) => {
    compileScriptCalls.push(script);
    return compileScriptReturn;
  },
  getProject: (p: string) => getProjectReturn(p),
  getUltraManifest: (runId: string) => {
    getUltraManifestCalls.push(runId);
    return getUltraManifestReturn;
  },
  launchUltra: async (opts: Record<string, unknown>) => {
    launchUltraCalls.push(opts);
    return launchUltraReturn;
  },
  readUltraEvents: () => readUltraEventsReturn,
  stopUltraRun: (runId: string) => {
    stopUltraRunCalls.push(runId);
    return stopUltraRunReturn;
  },
}));

afterAll(() => {
  mock.module("@telar/core", () => realCoreSnapshot);
});

const { createUltraMcpServer, ULTRA_AUTO_TOOLS, ULTRA_TOOL_DESCRIPTION } = await import("./ultra-mcp");

// Reach into the SDK server's registered tools to invoke a handler directly —
// identical idiom to loom-mcp.answer-blocked.test.ts's toolHandler.
function toolHandler(server: unknown, name: string) {
  const tools = (
    server as {
      instance: { _registeredTools: Record<string, { handler: (a: unknown, extra: unknown) => Promise<unknown> }> };
    }
  ).instance._registeredTools;
  const t = tools[name];
  if (!t) throw new Error(`tool ${name} not registered`);
  return (args: Record<string, unknown>) => t.handler(args, {});
}

function inputSchemaKeys(server: unknown, name: string): string[] {
  const tools = (
    server as { instance: { _registeredTools: Record<string, { inputSchema?: { shape?: Record<string, unknown> } }> } }
  ).instance._registeredTools;
  return Object.keys(tools[name]?.inputSchema?.shape ?? {});
}

const account = { name: "human@acct", provider: "claude" } as unknown as AccountProfile;

function makeServer(overrides: Partial<Parameters<typeof createUltraMcpServer>[0]> = {}) {
  return createUltraMcpServer({
    project: "proj",
    account,
    getSessionId: () => "sess-1",
    getMessageId: () => "turn-1",
    ...overrides,
  });
}

const textOf = (r: unknown) =>
  ((r as { content?: { text?: string }[] }).content ?? []).map((c) => c.text ?? "").join("");
const isError = (r: unknown) => Boolean((r as { isError?: boolean }).isError);

beforeEach(() => {
  compileScriptReturn = { ok: true, meta: { name: "t" } };
  compileScriptCalls.length = 0;
  launchUltraReturn = { ok: true, runId: "u-mockrun", meta: { name: "t" } };
  launchUltraCalls.length = 0;
  getUltraManifestReturn = {
    runId: "u-mockrun",
    state: "running",
    meta: { name: "t" },
    spend: 0.12,
    startedAt: 1000,
    updatedAt: 2000,
  };
  getUltraManifestCalls.length = 0;
  readUltraEventsReturn = { events: [] };
  stopUltraRunReturn = true;
  stopUltraRunCalls.length = 0;
});

describe("ultra MCP server — tool registration", () => {
  test("registers exactly ultra / ultra_status / ultra_stop, matching ULTRA_AUTO_TOOLS", () => {
    expect(ULTRA_AUTO_TOOLS).toEqual(["mcp__ultra__ultra", "mcp__ultra__ultra_status", "mcp__ultra__ultra_stop"]);
    const server = makeServer();
    const tools = (server as unknown as { instance: { _registeredTools: Record<string, unknown> } }).instance
      ._registeredTools;
    expect(new Set(Object.keys(tools))).toEqual(new Set(["ultra", "ultra_status", "ultra_stop"]));
  });

  test("the ultra tool's input schema carries no project/account/identity field", () => {
    const keys = inputSchemaKeys(makeServer(), "ultra");
    expect(new Set(keys)).toEqual(new Set(["script", "args"]));
    expect(keys).not.toContain("project");
    expect(keys).not.toContain("account");
  });
});

describe("ultra — non-blocking launch", () => {
  test("returns {runId, meta} immediately without ever awaiting run completion", async () => {
    const call = toolHandler(makeServer(), "ultra");
    const res = await call({ script: "export const meta = {};", args: { x: 1 } });
    expect(isError(res)).toBe(false);
    const parsed = JSON.parse(textOf(res));
    expect(parsed.runId).toBe("u-mockrun");
    expect(parsed.meta).toEqual({ name: "t" });
    expect(typeof parsed.note).toBe("string");
  });

  test("resolves the project SLUG to its manifest root, and passes the server's OWN account/session/turn ids — never tool input", async () => {
    const call = toolHandler(makeServer({ getSessionId: () => "sess-42", getMessageId: () => "turn-42" }), "ultra");
    await call({ script: "s", args: { a: 1 }, project: "EVIL", account: "EVIL" } as Record<string, unknown>);
    expect(launchUltraCalls.length).toBe(1);
    const opts = launchUltraCalls[0]!;
    expect(opts.project).toBe("/root/proj"); // resolved root, not the raw slug or "EVIL"
    expect(opts.account).toEqual(account); // the SERVER's account, never "EVIL" from input
    expect(opts.sessionId).toBe("sess-42");
    expect(opts.messageId).toBe("turn-42");
    expect(opts.script).toBe("s");
    expect(opts.args).toEqual({ a: 1 });
  });

  test("an unknown project resolves to an error result, never calling launchUltra", async () => {
    const call = toolHandler(makeServer({ project: "nope" }), "ultra");
    const res = await call({ script: "s" });
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain("nope");
    expect(launchUltraCalls.length).toBe(0);
  });
});

describe("ultra — the PRE-RUN model lint rejects a bad script with a useful, structured message", () => {
  test("a compile reject (missing-model) is surfaced as a structured error, before ANY launch attempt", async () => {
    compileScriptReturn = {
      ok: false,
      error: 'agent() call at line 3 is missing opts.model — every agent() call must name its model explicitly (doc §4): agent("hello", { label: "x" })',
      kind: "missing-model",
      detail: 'agent("hello", { label: "x" })',
      line: 3,
    };
    const call = toolHandler(makeServer(), "ultra");
    const res = await call({ script: "export const meta = {};\nexport default async function ({agent}) { return agent(\"hello\", {label:\"x\"}); }" });

    expect(isError(res)).toBe(true);
    const body = JSON.parse(textOf(res));
    expect(body.kind).toBe("missing-model");
    expect(body.line).toBe(3);
    expect(body.detail).toContain("agent(");
    expect(body.error).toContain("opts.model");
    // Rejected BEFORE any spend — launchUltra (and hence a real run/disk
    // write) must never even be attempted.
    expect(launchUltraCalls.length).toBe(0);
    expect(compileScriptCalls.length).toBe(1);
  });

  test("launchUltra's own {ok:false} is still surfaced defensively, even though the pre-check normally catches it first", async () => {
    launchUltraReturn = { ok: false, error: "some other launch-time failure" };
    const call = toolHandler(makeServer(), "ultra");
    const res = await call({ script: "s" });
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain("some other launch-time failure");
  });
});

describe("ultra_status — state/journal-summary plumbing", () => {
  test("rolls up agent/phase/log events from the run's event stream onto the manifest snapshot", async () => {
    getUltraManifestReturn = {
      runId: "u-1",
      state: "running",
      meta: { name: "n" },
      spend: 0.5,
      startedAt: 10,
      updatedAt: 20,
    };
    readUltraEventsReturn = {
      events: [
        { type: "phase", title: "summarize" },
        { type: "agent", ordinal: 0, ok: true, model: "sonnet" },
        { type: "agent", ordinal: 1, ok: false, model: "sonnet" },
        { type: "log", msg: "starting" },
        { type: "phase", title: "rank" },
        { type: "log", msg: "ranking" },
      ],
    };
    const call = toolHandler(makeServer(), "ultra_status");
    const res = await call({ runId: "u-1" });
    expect(isError(res)).toBe(false);
    const body = JSON.parse(textOf(res));
    expect(body.state).toBe("running");
    expect(body.spend).toBe(0.5);
    expect(body.agents).toEqual({ done: 1, dead: 1, total: 2 });
    expect(body.phases).toEqual(["summarize", "rank"]);
    expect(body.recentLog).toEqual(["starting", "ranking"]);
    expect(body.result).toBeUndefined(); // not `done` yet
    expect(getUltraManifestCalls).toEqual(["u-1"]);
  });

  test("a `done` run's result is included; a non-done run's is not", async () => {
    getUltraManifestReturn = {
      runId: "u-2",
      state: "done",
      meta: {},
      spend: 1,
      startedAt: 1,
      updatedAt: 2,
      result: { summary: "ok" },
    };
    const res = await toolHandler(makeServer(), "ultra_status")({ runId: "u-2" });
    const body = JSON.parse(textOf(res));
    expect(body.result).toEqual({ summary: "ok" });
  });

  test("an unknown runId is an error result", async () => {
    getUltraManifestReturn = null;
    const res = await toolHandler(makeServer(), "ultra_status")({ runId: "u-missing" });
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain("u-missing");
  });

  // Story 4.2 / D7 — THE NEW `agent-start` VARIANT MUST NOT DISTURB THIS TOOL.
  //
  // WHY THE PROOF LIVES HERE AND NOWHERE ELSE. `ultra_status` is defined in
  // `apps/web/lib/ultra-mcp.ts`, and `packages/core` cannot import `apps/web` —
  // so no core suite can make this claim, however much the change it is about
  // lives in core.
  //
  // Story 4.1 protected `ultra_status` by not touching the file. Story 4.2
  // touches the STREAM this tool reads, so it owes the equivalent proof: the
  // rollup keys on `e.type === "agent"` for the done/dead counts and on
  // `"phase"`/`"log"` for the rest, so a new variant is ignored BY
  // CONSTRUCTION — and "by construction" is a claim a test can check.
  test("4.2 D7 — the rollup is BYTE-IDENTICAL with and without agent-start events interleaved", async () => {
    const manifest = {
      runId: "u-d7",
      state: "running",
      meta: { name: "n" },
      spend: 0.5,
      startedAt: 10,
      updatedAt: 20,
    };
    const without = [
      { type: "phase", title: "summarize" },
      { type: "agent", ordinal: 0, ok: true, model: "sonnet" },
      { type: "agent", ordinal: 1, ok: false, model: "sonnet" },
      { type: "log", msg: "starting" },
      { type: "phase", title: "rank" },
      { type: "log", msg: "ranking" },
    ];
    // The SAME stream, with `agent-start` where the executor really emits it:
    // immediately before each ordinal's own settle.
    const withStart = [
      { type: "phase", title: "summarize" },
      { type: "agent-start", ordinal: 0, model: "sonnet", effort: "high" },
      { type: "agent", ordinal: 0, ok: true, model: "sonnet", effort: "high" },
      { type: "agent-start", ordinal: 1, model: "sonnet" },
      { type: "agent", ordinal: 1, ok: false, model: "sonnet" },
      { type: "log", msg: "starting" },
      { type: "phase", title: "rank" },
      { type: "log", msg: "ranking" },
    ];

    getUltraManifestReturn = { ...manifest };
    readUltraEventsReturn = { events: without };
    const before = textOf(await toolHandler(makeServer(), "ultra_status")({ runId: "u-d7" }));

    getUltraManifestReturn = { ...manifest };
    readUltraEventsReturn = { events: withStart };
    const after = textOf(await toolHandler(makeServer(), "ultra_status")({ runId: "u-d7" }));

    expect(after).toBe(before);
    // Anti-vacuity: both really did roll something up, so a tool that returned
    // the empty string for everything could not pass the equality above.
    const body = JSON.parse(after);
    expect(body.agents).toEqual({ done: 1, dead: 1, total: 2 });
    expect(body.phases).toEqual(["summarize", "rank"]);
    expect(body.recentLog).toEqual(["starting", "ranking"]);
  });
});

// Story 4.2 / AC6 proof 5 — THE CLIENT HALF NOW EXISTS, SO PIN THE SENTENCES IT
// DEPENDS ON.
//
// "A message with neither chip nor explicit keyword never triggers `ultra`" is
// enforced WHERE IT IS ACTUALLY ENFORCED, and that is PROSE, not code:
// `ultra-mcp.ts`'s own header says so — "opt-in is a REQUEST enforced by the
// tool description … never a per-call human click". NO TEST CAN PROVE A MODEL'S
// RESTRAINT. What a test CAN prove is that the clause the restraint rests on is
// still in the string, and that is what these are.
//
// The two substrings are copied OUT OF THE FILE, not out of the story, and each
// is a fragment rather than the whole sentence: the pin must survive a re-word
// of the tail and not survive a deletion of the clause. `"Never infer it
// yourself"` deliberately carries NO terminal period — the source sentence does
// not end there ("…yourself from an ordinary request.").
describe("4.2 AC6 — the ultra tool description still carries the opt-in clause the composer chip depends on", () => {
  test("it names the composer's Ultra chip", () => {
    expect(ULTRA_TOOL_DESCRIPTION).toContain("the composer's Ultra chip");
  });

  test("it still forbids the model inferring the call itself", () => {
    expect(ULTRA_TOOL_DESCRIPTION).toContain("Never infer it yourself");
  });

  test("it is pinned BY IDENTIFIER, not through the SDK's private tool registry", () => {
    // `ULTRA_TOOL_DESCRIPTION` gained `export` in story 4.2 for exactly this.
    // The alternative — `instance._registeredTools["ultra"].description` — reads
    // an SDK private and breaks on an upgrade for no reason. The registry is
    // still checked here, once, so the exported const and the registered tool
    // cannot silently diverge.
    const tools = (
      server_registry(makeServer()) as Record<string, { description?: string }>
    );
    expect(tools.ultra?.description).toBe(ULTRA_TOOL_DESCRIPTION);
  });

  test("D12 — the surface walk-through, the quality patterns and the worked example MOVED OUT", () => {
    // They live in `@/lib/ultra-authoring` now and arrive in the session's
    // system-prompt appendix instead. Asserting their ABSENCE here is what stops
    // a later edit from quietly restoring the second source of truth: two full
    // authoring texts that can disagree is the failure `session-prompts.ts`'s
    // header names.
    expect(ULTRA_TOOL_DESCRIPTION).not.toContain("Worked example:");
    expect(ULTRA_TOOL_DESCRIPTION).not.toContain("loop-until-dry");
    expect(ULTRA_TOOL_DESCRIPTION).not.toContain("adversarial-verify");
    expect(ULTRA_TOOL_DESCRIPTION).not.toContain("The injected surface is the ONLY thing");
    // …and what it KEEPS: the things that decide whether the call is legal.
    expect(ULTRA_TOOL_DESCRIPTION).toContain("Script format");
    expect(ULTRA_TOOL_DESCRIPTION).toContain("opts.model is REQUIRED");
    expect(ULTRA_TOOL_DESCRIPTION).toContain("Math.random()");
    expect(ULTRA_TOOL_DESCRIPTION).toContain("returns {runId} IMMEDIATELY");
  });
});

function server_registry(server: unknown) {
  return (server as { instance: { _registeredTools: Record<string, unknown> } }).instance
    ._registeredTools;
}

describe("ultra_stop — abort plumbing", () => {
  test("calls stopUltraRun with the given id and reports the resulting state", async () => {
    stopUltraRunReturn = true;
    getUltraManifestReturn = { runId: "u-3", state: "stopped", meta: {}, spend: 0, startedAt: 0, updatedAt: 0 };
    const res = await toolHandler(makeServer(), "ultra_stop")({ runId: "u-3" });
    expect(isError(res)).toBe(false);
    const body = JSON.parse(textOf(res));
    expect(body).toEqual({ runId: "u-3", stopped: true, state: "stopped" });
    expect(stopUltraRunCalls).toEqual(["u-3"]);
  });

  test("a run that isn't live returns stopped:false without erroring", async () => {
    stopUltraRunReturn = false;
    getUltraManifestReturn = { runId: "u-4", state: "done", meta: {}, spend: 0, startedAt: 0, updatedAt: 0 };
    const res = await toolHandler(makeServer(), "ultra_stop")({ runId: "u-4" });
    expect(isError(res)).toBe(false);
    const body = JSON.parse(textOf(res));
    expect(body).toEqual({ runId: "u-4", stopped: false, state: "done" });
  });
});
