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
const resumeUltraRunCalls: { runId: string; opts: Record<string, unknown> }[] = [];

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

// The durable record ultra_inspect reads. Shaped like the real thing: the
// journal holds only SETTLED ordinals, while the agents/ directory holds a file
// for every ordinal that streamed at least one event — so the two disagree
// exactly when an agent died without settling, which is the case worth seeing.
let readJournalReturn: Record<string, unknown>[] = [];
let listUltraAgentOrdinalsReturn: number[] = [];
let readUltraAgentTranscriptReturn: Record<number, Record<string, unknown>[]> = {};

let stopUltraRunReturn = true;
const stopUltraRunCalls: string[] = [];

// AC-E5 — core's durable "register interest in ONE run". Mocked like every
// other core edge here: the real one is proven in packages/core's
// ultra-wake.test.ts, and what THIS file owns is the wiring — that the tool
// calls it, with the SERVER's own session id, and only when asked.
let watchUltraRunReturn: Record<string, unknown> = {
  ok: true,
  runId: "u-mockrun",
  state: "running",
  name: "t",
  alreadyWatching: false,
};
const watchUltraRunCalls: { sessionId: string; runId: string }[] = [];

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
  resumeUltraRun: async (runId: string, opts: Record<string, unknown>) => {
    resumeUltraRunCalls.push({ runId, opts });
    return launchUltraReturn;
  },
  readUltraEvents: () => readUltraEventsReturn,
  readJournal: () => readJournalReturn,
  listUltraAgentOrdinals: () => listUltraAgentOrdinalsReturn,
  readUltraAgentTranscript: (_runId: string, ordinal: number) => readUltraAgentTranscriptReturn[ordinal] ?? [],
  stopUltraRun: (runId: string) => {
    stopUltraRunCalls.push(runId);
    return stopUltraRunReturn;
  },
  watchUltraRun: (sessionId: string, runId: string) => {
    watchUltraRunCalls.push({ sessionId, runId });
    return watchUltraRunReturn;
  },
}));

afterAll(() => {
  mock.module("@telar/core", () => realCoreSnapshot);
});

const { createUltraMcpServer, ULTRA_AUTO_TOOLS, ULTRA_TOOL_DESCRIPTION, ULTRA_STATUS_NOTE } =
  await import("./ultra-mcp");

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
  resumeUltraRunCalls.length = 0;
  readUltraEventsReturn = { events: [] };
  readJournalReturn = [];
  listUltraAgentOrdinalsReturn = [];
  readUltraAgentTranscriptReturn = {};
  stopUltraRunReturn = true;
  stopUltraRunCalls.length = 0;
  watchUltraRunReturn = { ok: true, runId: "u-mockrun", state: "running", name: "t", alreadyWatching: false };
  watchUltraRunCalls.length = 0;
});

describe("ultra MCP server — tool registration", () => {
  test("registers exactly ultra / ultra_status / ultra_stop / ultra_inspect, matching ULTRA_AUTO_TOOLS", () => {
    expect(ULTRA_AUTO_TOOLS).toEqual([
      "mcp__ultra__ultra",
      "mcp__ultra__ultra_status",
      "mcp__ultra__ultra_stop",
      "mcp__ultra__ultra_inspect",
    ]);
    const server = makeServer();
    const tools = (server as unknown as { instance: { _registeredTools: Record<string, unknown> } }).instance
      ._registeredTools;
    expect(new Set(Object.keys(tools))).toEqual(
      new Set(["ultra", "ultra_status", "ultra_stop", "ultra_inspect"]),
    );
  });

  test("the ultra tool's input schema carries no project/account/identity field", () => {
    // `resume` is the one input that names an EXISTING run, and it is the only
    // reason this set grew. It is not an identity field: the project, the
    // guardrails and the account are still resolved from the server's own opts
    // on a resume exactly as on a launch, and the run's own session ownership
    // is checked in the handler before anything replays.
    const keys = inputSchemaKeys(makeServer(), "ultra");
    expect(new Set(keys)).toEqual(new Set(["script", "args", "resume"]));
    expect(keys).not.toContain("project");
    expect(keys).not.toContain("account");
    expect(keys).not.toContain("sessionId");
  });
});

describe("ultra_inspect — the durable record, which nothing could read", () => {
  // THE CASE THIS TOOL WAS BUILT FOR, reproduced from the real one. Run
  // u-893ce7701785 spawned 10 agents and journaled 6; ordinals 2, 6 and 7 ended
  // `error_max_turns` with the subtype in their own transcripts. The counters
  // said `dead: 0` and three in flight, and nothing could open the files that
  // held the answer. Hours went into calling them "hung".
  const owned = () => {
    getUltraManifestReturn = { runId: "u-mockrun", state: "stopped", sessionId: "sess-1" };
  };
  const diedOnTurns = {
    type: "result",
    subtype: "error_max_turns",
    turns: 41,
    costUsd: 1.3,
  };

  test("the roster names the ordinals that spawned but never settled", () => {
    owned();
    listUltraAgentOrdinalsReturn = [0, 1, 2];
    readJournalReturn = [
      { ordinal: 0, result: { text: "brief one" } },
      { ordinal: 1, result: { text: "brief two" } },
    ];
    return toolHandler(makeServer(), "ultra_inspect")({ runId: "u-mockrun" }).then((res) => {
      const parsed = JSON.parse(textOf(res));
      expect(parsed.spawned).toBe(3);
      expect(parsed.settled).toBe(2);
      expect(parsed.unsettled).toEqual([2]);
      // The sentence, not just the numbers. Two counts side by side are what a
      // reader has to subtract and then interpret, and interpreting them wrongly
      // is the whole reason this exists.
      expect(parsed.note).toContain("2");
      expect(parsed.note).toContain("never settled");
    });
  });

  test("a clean run says so plainly rather than leaving an empty list to read", async () => {
    owned();
    listUltraAgentOrdinalsReturn = [0];
    readJournalReturn = [{ ordinal: 0, result: "done" }];
    const res = await toolHandler(makeServer(), "ultra_inspect")({ runId: "u-mockrun" });
    const parsed = JSON.parse(textOf(res));
    expect(parsed.unsettled).toEqual([]);
    expect(parsed.note).toContain("Every spawned agent settled");
  });

  test("inspecting one agent surfaces the result subtype that says WHY it stopped", async () => {
    owned();
    listUltraAgentOrdinalsReturn = [2];
    readUltraAgentTranscriptReturn = {
      2: [{ type: "tool", name: "Read" }, diedOnTurns],
    };
    const res = await toolHandler(makeServer(), "ultra_inspect")({ runId: "u-mockrun", ordinal: 2 });
    const parsed = JSON.parse(textOf(res));
    // Pulled out of the tail deliberately: it is the single most useful field,
    // and a tail long enough to be useful is long enough to bury it.
    expect(parsed.endedWith.subtype).toBe("error_max_turns");
    expect(parsed.settled).toBe(false);
  });

  test("the transcript is TAILED, not headed — how it ended is the question", async () => {
    owned();
    listUltraAgentOrdinalsReturn = [0];
    readUltraAgentTranscriptReturn = {
      0: [...Array.from({ length: 40 }, (_, i) => ({ type: "tool", name: `t${i}` })), diedOnTurns],
    };
    const res = await toolHandler(makeServer(), "ultra_inspect")({ runId: "u-mockrun", ordinal: 0 });
    const parsed = JSON.parse(textOf(res));
    expect(parsed.events).toBe(41);
    expect(parsed.tail.length).toBeLessThan(41);
    expect(parsed.tail[parsed.tail.length - 1].subtype).toBe("error_max_turns");
    // The first tool call must NOT be in a tail — a head would show the setup
    // and hide the death.
    expect(parsed.tail[0].name).not.toBe("t0");
  });

  test("a run belonging to another session cannot be inspected", async () => {
    // A transcript contains everything an agent read. Same ownership rule as
    // resume, and for a stronger reason.
    getUltraManifestReturn = { runId: "u-other", state: "done", sessionId: "sess-99" };
    const res = await toolHandler(makeServer(), "ultra_inspect")({ runId: "u-other" });
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain("different session");
  });

  test("an unknown run and an unknown ordinal both fail cleanly", async () => {
    getUltraManifestReturn = null;
    expect(isError(await toolHandler(makeServer(), "ultra_inspect")({ runId: "u-nope" }))).toBe(true);
    owned();
    listUltraAgentOrdinalsReturn = [0];
    const res = await toolHandler(makeServer(), "ultra_inspect")({ runId: "u-mockrun", ordinal: 99 });
    expect(isError(res)).toBe(true);
  });
});

describe("ultra — resume, and what it may reach", () => {
  // WHY RESUME EXISTS AT ALL. resumeUltraRun has been built and guarded in core
  // since the storage cut, and no session could reach it. A run that died
  // halfway could only be recovered by re-authoring the whole script and paying
  // again for every agent that had already succeeded — which is exactly what
  // happened on 2026-08-05 to a run that had two implementation groups
  // committed and its design phase done.
  const ownedByUs = () => {
    getUltraManifestReturn = { runId: "u-mockrun", state: "stopped", sessionId: "sess-1" };
  };

  test("resume routes to resumeUltraRun with the runId, and never launches a new run", async () => {
    ownedByUs();
    const call = toolHandler(makeServer(), "ultra");
    const res = await call({ resume: "u-mockrun" });
    expect(isError(res)).toBe(false);
    expect(launchUltraCalls.length).toBe(0);
    expect(resumeUltraRunCalls.length).toBe(1);
    expect(resumeUltraRunCalls[0]!.runId).toBe("u-mockrun");
  });

  test("a bare resume passes NO script, so the persisted one runs", async () => {
    // Undefined is the signal core reads as "use script.js from the original
    // launch". Sending an empty string or the meta stub instead would overwrite
    // the persisted script and silently change what the resume runs.
    ownedByUs();
    await toolHandler(makeServer(), "ultra")({ resume: "u-mockrun" });
    expect(resumeUltraRunCalls[0]!.opts.script).toBeUndefined();
  });

  test("resume still resolves project and guardrails from the SERVER, never from input", async () => {
    // The property the whole file is built on: a script narrows work, it never
    // grants capability. A resume must not become the way around that.
    ownedByUs();
    await toolHandler(makeServer(), "ultra")({
      resume: "u-mockrun",
      project: "EVIL",
      account: "EVIL",
    } as Record<string, unknown>);
    expect(resumeUltraRunCalls[0]!.opts.project).toBe("/root/proj");
    expect(resumeUltraRunCalls[0]!.opts.guardrails).toEqual({
      root: "/root/proj",
      guardrails: { disallowedTools: [], protectedPaths: [] },
    });
  });

  test("a run belonging to ANOTHER session cannot be resumed", async () => {
    // `resume` is the first tool input that names an existing run, and a runId
    // is just a string. Without this check a model could name any run on the
    // machine and replay its journal and its persisted script.
    getUltraManifestReturn = { runId: "u-other", state: "stopped", sessionId: "sess-99" };
    const res = await toolHandler(makeServer(), "ultra")({ resume: "u-other" });
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain("different session");
    expect(resumeUltraRunCalls.length).toBe(0);
  });

  test("a run with NO recorded session is not adoptable either", async () => {
    // Unowned is not the same as ours. Treating a missing sessionId as a match
    // would make every pre-ownership run resumable from anywhere.
    getUltraManifestReturn = { runId: "u-old", state: "stopped" };
    const res = await toolHandler(makeServer(), "ultra")({ resume: "u-old" });
    expect(isError(res)).toBe(true);
    expect(resumeUltraRunCalls.length).toBe(0);
  });

  test("an unknown runId is refused before anything replays", async () => {
    getUltraManifestReturn = null;
    const res = await toolHandler(makeServer(), "ultra")({ resume: "u-nope" });
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain("not found");
    expect(resumeUltraRunCalls.length).toBe(0);
  });

  test("resume WITH a script is the stop-edit-resume surgery, and the script is compiled first", async () => {
    ownedByUs();
    compileScriptReturn = { ok: false, error: "bad", kind: "syntax", detail: "d", line: 1 };
    const res = await toolHandler(makeServer(), "ultra")({ resume: "u-mockrun", script: "nope(" });
    expect(isError(res)).toBe(true);
    expect(resumeUltraRunCalls.length).toBe(0);
  });

  test("neither script nor resume is a clean rejection, not a crash", async () => {
    const res = await toolHandler(makeServer(), "ultra")({});
    expect(isError(res)).toBe(true);
    expect(launchUltraCalls.length).toBe(0);
    expect(resumeUltraRunCalls.length).toBe(0);
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
    // NO `spend` IN THE PAYLOAD, and this assertion is the reversal of
    // `expect(body.spend).toBe(0.5)`. Removed on an owner ruling: the guiding
    // agent cannot act on a dollar figure, and handing it one only invited it
    // to narrate money at the user. Asserted ABSENT rather than deleted, so a
    // future edit cannot quietly put it back.
    expect(body.spend).toBeUndefined();
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

  // REPLACES story 4.2's "4.2 D7 — the rollup is BYTE-IDENTICAL with and without
  // agent-start events interleaved". That pin was 4.2 proving it did not disturb
  // this tool while it touched the stream the tool reads; this story deliberately
  // MAKES the tool read `agent-start`, which is a contract change rather than a
  // guard routed around. The replacement pins the NEW contract case by case, and
  // is strictly stronger: it covers the resume case a naive counter gets wrong.
  //
  // WHY THE PROOF LIVES HERE AND NOWHERE ELSE (carried forward from 4.2's note):
  // `ultra_status` is defined in `apps/web/lib/ultra-mcp.ts`, and `packages/core`
  // cannot import `apps/web` — so no core suite can make this claim, however much
  // the data it is about lives in core.
  describe("ultra_status now READS agent-start — the exact new contract", () => {
    const manifest = {
      runId: "u-live",
      state: "running",
      meta: { name: "n" },
      spend: 0,
      startedAt: 10,
      updatedAt: 20,
    };
    const status = async (events: Record<string, unknown>[]) => {
      getUltraManifestReturn = { ...manifest };
      readUltraEventsReturn = { events };
      return JSON.parse(textOf(await toolHandler(makeServer(), "ultra_status")({ runId: "u-live" })));
    };

    test("A FAN-OUT MID-FLIGHT reports agents in flight and its phase, where it used to report an unchanged zero", async () => {
      const body = await status([
        { type: "phase", title: "survey" },
        { type: "agent-start", ordinal: 0, model: "sonnet" },
        { type: "agent-start", ordinal: 1, model: "sonnet" },
        { type: "agent-start", ordinal: 2, model: "sonnet" },
      ]);
      expect(body.inFlight).toBe(3);
      expect(body.started).toBe(3);
      expect(body.phase).toBe("survey");
      expect(body.agents).toEqual({ done: 0, dead: 0, total: 0 });
    });

    test("started-then-settled moves one out of flight", async () => {
      const body = await status([
        { type: "agent-start", ordinal: 0, model: "sonnet" },
        { type: "agent-start", ordinal: 1, model: "sonnet" },
        { type: "agent", ordinal: 0, ok: true, model: "sonnet" },
      ]);
      expect(body.inFlight).toBe(1);
      expect(body.agents).toEqual({ done: 1, dead: 0, total: 1 });
    });

    test("RESUME SAFETY — a settle with NO start (a cache replay) never goes negative or lies", async () => {
      // THE CASE A NAIVE `startedCount - settledCount` GETS WRONG. `agent-start`
      // is never emitted on the cached-replay path, so a resume that replays
      // ordinals and runs others live would compute a negative and, clamped,
      // report 0 in flight while agents are genuinely burning money.
      const body = await status([
        { type: "agent-start", ordinal: 0, model: "sonnet" },
        { type: "agent", ordinal: 0, ok: true, model: "sonnet" },
        { type: "agent", ordinal: 1, ok: true, model: "sonnet" }, // replayed, never started
      ]);
      expect(body.inFlight).toBe(0);
      expect(body.agents).toEqual({ done: 2, dead: 0, total: 2 });

      const mixed = await status([
        { type: "agent", ordinal: 0, ok: true, model: "sonnet" }, // replayed
        { type: "agent", ordinal: 1, ok: true, model: "sonnet" }, // replayed
        { type: "agent-start", ordinal: 2, model: "sonnet" }, // live
        { type: "agent-start", ordinal: 3, model: "sonnet" }, // live
      ]);
      expect(mixed.inFlight).toBe(2);
    });

    test("ADDITIVE ONLY — a stream with no agent-start events keeps every existing figure", async () => {
      const body = await status([
        { type: "phase", title: "summarize" },
        { type: "agent", ordinal: 0, ok: true, model: "sonnet" },
        { type: "agent", ordinal: 1, ok: false, model: "sonnet" },
        { type: "log", msg: "starting" },
        { type: "phase", title: "rank" },
        { type: "log", msg: "ranking" },
      ]);
      expect(body.agents).toEqual({ done: 1, dead: 1, total: 2 });
      expect(body.phases).toEqual(["summarize", "rank"]);
      expect(body.recentLog).toEqual(["starting", "ranking"]);
      expect(body.inFlight).toBe(0);
      expect(body.started).toBe(0);
    });

    test("NO DENOMINATOR — nothing in the payload claims a total-agents figure", async () => {
      // Story 4.2 AC11: agents `total-planned` is NOT SOURCED and must not be
      // invented. `agents.total` is the SETTLED count and keeps that meaning.
      const body = await status([{ type: "agent-start", ordinal: 0, model: "sonnet" }]);
      expect(body.agents.expected).toBeUndefined();
      expect(body.agentsTotal).toBeUndefined();
      expect(body.progress).toBeUndefined();
      expect(Object.keys(body.agents).sort()).toEqual(["dead", "done", "total"]);
    });

    test("the honesty note is present and says the snapshot carries no cost", async () => {
      // Was "names cost-at-settle" and asserted "SETTLED agents only" — prose
      // explaining a `spend` field that no longer ships. The note now has to
      // say the opposite thing (there is no cost figure here, on purpose), so
      // the assertion follows it rather than pinning the retired wording.
      const body = await status([]);
      expect(body.note).toBe(ULTRA_STATUS_NOTE);
      expect(body.note).toContain("NO cost figure");
      expect(body.note).toContain("no total-agents denominator");
    });

    test("lastEventAt tolerates events with no `ts` — absent rather than NaN", async () => {
      const untimed = await status([{ type: "agent-start", ordinal: 0, model: "sonnet" }]);
      expect(untimed.lastEventAt).toBeUndefined();
      const timed = await status([
        { type: "agent-start", ordinal: 0, model: "sonnet", ts: 111 },
        { type: "log", msg: "x", ts: 222 },
      ]);
      expect(timed.lastEventAt).toBe(222);
    });
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

// AC-E5's first clause — the tool surface TEACHES the non-blocking wake.
describe("the ultra tool surface teaches ending the turn, not sleeping and polling", () => {
  test("the sentence that taught polling is GONE", () => {
    // The exact textual root of the observed sleep-and-poll habit. A negative
    // assertion on the sentence itself, so a re-word that reintroduces it fails.
    expect(ULTRA_TOOL_DESCRIPTION).not.toContain("Poll ultra_status(runId) for progress");
  });

  test("it tells the model the outcome arrives automatically and the way to wait is to END THE TURN", () => {
    expect(ULTRA_TOOL_DESCRIPTION).toContain("AUTOMATICALLY");
    expect(ULTRA_TOOL_DESCRIPTION).toContain("END YOUR TURN");
  });

  test("it NAMES the anti-pattern — a model not told what to avoid invents it", () => {
    expect(ULTRA_TOOL_DESCRIPTION).toContain("background shell");
    expect(ULTRA_TOOL_DESCRIPTION).toContain("busy-poll");
  });

  test("ultra_status reframes itself as a SNAPSHOT, not as the way to wait", () => {
    const desc = (server_registry(makeServer()) as Record<string, { description?: string }>)
      .ultra_status?.description;
    expect(desc).toContain("SNAPSHOT");
    // It names the E4/E5 recovery leg — the one case a wake turn SHOULD poll.
    expect(desc).toContain("had to truncate");
    expect(desc).not.toContain("instead of blocking on it");
  });

  test("the LAUNCH RESULT the model actually receives carries the same protocol", async () => {
    // Pinned on the parsed handler output rather than on a constant: this is the
    // string that drives the very next tool call.
    const res = await toolHandler(makeServer(), "ultra")({ script: "s" });
    const note = JSON.parse(textOf(res)).note as string;
    expect(note).toContain("END YOUR TURN");
    expect(note).toContain("AUTOMATICALLY");
    expect(note).not.toContain("poll progress");
  });

  test("ultra_stop's description is untouched — this task did not widen", () => {
    const desc = (server_registry(makeServer()) as Record<string, { description?: string }>)
      .ultra_stop?.description;
    expect(desc).toContain("Abort a live Ultra run");
    expect(desc).toContain("stopped:false");
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

// AC-E5's SECOND clause — the guiding agent can register interest in ONE run and
// have it delivered through the EXISTING story-4.1 durable mailbox.
//
// WHY THESE TESTS ARE ABOUT A FLAG AND NOT A FOURTH TOOL. Owner ruling 1 named a
// separate watch_loom-shaped tool as the preferred shape. Registering a fourth
// ultra tool NAME requires the same commit to edit four count-pinned files no
// lane owns (invariants.test.ts's MCP_INVENTORY — an ORDERED comparison, so
// register-without-pin reports GAINED and pin-without-register reports LOST —
// core's ULTRA_AUTO_TOOL_NAMES, and the two BASE_ALLOWED_TOOLS counts), and no
// ordering of those edits avoids a red window. The flag rides the tool that
// already takes exactly this one runId, so the registered NAME SET is untouched
// and every one of those pins stays green. ultra-mcp.ts carries the same note.
describe("AC-E5 — ultra_status can register interest in ONE run, without becoming a fourth tool", () => {
  test("the registered tool NAME SET matches the count-pinned files, which move together", () => {
    // This was "still exactly three", and the note above explains why a fourth
    // name is expensive: MCP_INVENTORY (ordered), core's ULTRA_AUTO_TOOL_NAMES
    // and the BASE_ALLOWED_TOOLS count all pin it, in files no lane owns, with
    // no edit order that avoids a red window.
    //
    // `ultra_inspect` paid that cost deliberately rather than riding an
    // existing tool as a flag. It is not a variant of status: status answers
    // "what is happening now" from live counters, inspect answers "what
    // happened" from the durable record, and folding a journal/transcript read
    // into the counters tool would have made the one call a reader reaches for
    // in a crisis the one that also means something else.
    const tools = server_registry(makeServer()) as Record<string, unknown>;
    expect(new Set(Object.keys(tools))).toEqual(
      new Set(["ultra", "ultra_status", "ultra_stop", "ultra_inspect"]),
    );
    expect(ULTRA_AUTO_TOOLS.length).toBe(4);
  });

  test("ultra_status's input schema gained `watch` and nothing else", () => {
    expect(new Set(inputSchemaKeys(makeServer(), "ultra_status"))).toEqual(new Set(["runId", "watch"]));
    // No session/project/identity field: same rule the `ultra` tool's own schema
    // test states — a script narrows work, it never grants capability.
    expect(inputSchemaKeys(makeServer(), "ultra_status")).not.toContain("sessionId");
  });

  test("`watch: true` stamps interest through core's DURABLE watchUltraRun", async () => {
    const res = await toolHandler(makeServer(), "ultra_status")({ runId: "u-1", watch: true });
    expect(isError(res)).toBe(false);
    expect(watchUltraRunCalls).toEqual([{ sessionId: "sess-1", runId: "u-1" }]);
    const body = JSON.parse(textOf(res));
    expect(body.watching).toEqual({
      ok: true,
      runId: "u-mockrun",
      state: "running",
      name: "t",
      alreadyWatching: false,
    });
  });

  test("it uses the SERVER's own session id, never anything from tool input", async () => {
    const call = toolHandler(makeServer({ getSessionId: () => "sess-42" }), "ultra_status");
    await call({ runId: "u-1", watch: true, sessionId: "EVIL" } as Record<string, unknown>);
    expect(watchUltraRunCalls).toEqual([{ sessionId: "sess-42", runId: "u-1" }]);
  });

  test("no session id yet is passed through as empty — core refuses it, this file does not invent one", async () => {
    const call = toolHandler(makeServer({ getSessionId: () => null }), "ultra_status");
    await call({ runId: "u-1", watch: true });
    expect(watchUltraRunCalls).toEqual([{ sessionId: "", runId: "u-1" }]);
  });

  test("ANTI-VACUITY — omitting `watch` registers NOTHING and returns a byte-identical payload", async () => {
    // The discriminator for the two tests above: if the tool stamped on every
    // call, they would pass and the flag would be a lie.
    readUltraEventsReturn = { events: [{ type: "phase", title: "survey", ts: 5 }] };
    const plain = await toolHandler(makeServer(), "ultra_status")({ runId: "u-1" });
    expect(watchUltraRunCalls).toEqual([]);
    const body = JSON.parse(textOf(plain));
    expect(body.watching).toBeUndefined();
    expect(Object.keys(body)).not.toContain("watching");

    // …and the payload is the SAME TEXT a pre-`watch` caller received. Compared
    // as the serialized string, not field by field, so an added key anywhere
    // fails rather than only an added `watching`.
    const again = await toolHandler(makeServer(), "ultra_status")({ runId: "u-1" });
    expect(textOf(again)).toBe(textOf(plain));
  });

  test("`watch: false` is a no-op too — only an explicit true registers", async () => {
    await toolHandler(makeServer(), "ultra_status")({ runId: "u-1", watch: false });
    expect(watchUltraRunCalls).toEqual([]);
  });

  test("THE NON-GATE — a REFUSED watch still returns the full snapshot", async () => {
    // Registering interest changes what the appendix SAYS about a run, never
    // whether the run is delivered. A cross-session refusal must therefore
    // degrade the marker and nothing else — it is not an error result.
    watchUltraRunReturn = { ok: false, runId: "u-1", error: 'No Ultra run "u-1" belongs to this session.' };
    readUltraEventsReturn = {
      events: [
        { type: "agent-start", ordinal: 0, model: "sonnet", ts: 1 },
        { type: "phase", title: "survey", ts: 2 },
      ],
    };
    const res = await toolHandler(makeServer(), "ultra_status")({ runId: "u-1", watch: true });
    expect(isError(res)).toBe(false);
    const body = JSON.parse(textOf(res));
    expect(body.watching.ok).toBe(false);
    expect(body.watching.error).toContain("belongs to this session");
    // Every existing figure still there, unchanged by the refusal.
    expect(body.state).toBe("running");
    expect(body.inFlight).toBe(1);
    expect(body.phase).toBe("survey");
    expect(body.agents).toEqual({ done: 0, dead: 0, total: 0 });
  });

  test("an unknown runId errors BEFORE anything is stamped", async () => {
    getUltraManifestReturn = null;
    const res = await toolHandler(makeServer(), "ultra_status")({ runId: "u-missing", watch: true });
    expect(isError(res)).toBe(true);
    expect(watchUltraRunCalls).toEqual([]);
  });

  test("the description TEACHES the registration, and still teaches ending the turn", async () => {
    const desc = (server_registry(makeServer()) as Record<string, { description?: string }>).ultra_status
      ?.description as string;
    expect(desc).toContain("watch: true");
    expect(desc).toContain("END YOUR TURN");
    // The two claims that keep it from reading as a subscription or a gate.
    expect(desc).toContain("blocks nothing");
    expect(desc).toContain("does NOT switch delivery on");
    // …and the snapshot framing the E4/E5 recovery leg depends on is intact.
    expect(desc).toContain("SNAPSHOT");
    expect(desc).toContain("had to truncate");
  });

  test("the LAUNCH RESULT names it at the moment the model first holds the runId", async () => {
    // Discoverability is the entire point of AC-E5: a capability the model is
    // told about only in a description it may never re-read is one it will not
    // use. This is the string it reads while deciding what to do next.
    const res = await toolHandler(makeServer(), "ultra")({ script: "s" });
    const note = JSON.parse(textOf(res)).note as string;
    expect(note).toContain("watch: true");
    expect(note).toContain("END YOUR TURN");
    expect(note).not.toContain("poll progress");
  });
});
