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

const { createUltraMcpServer, ULTRA_AUTO_TOOLS } = await import("./ultra-mcp");

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
});

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
