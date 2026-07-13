// M11.3 lane B — the conversational-escalation write path (answer_blocked) and
// the escalation read-only toolset. Hermetic: @telar/core is mock.module'd so
// no real loom/store is touched; the SDK MCP server's registered handlers are
// invoked directly (server.instance._registeredTools[name].handler).
//
// bun provides "bun:test" at runtime; @types/bun isn't a dep of this Next app,
// so the web tsconfig (which includes **/*.ts) can't resolve it — suppress just
// the import, exactly like lib/permissions.test.ts. The runtime is `bun test`.
// @ts-expect-error no @types/bun in this workspace
import { afterAll, describe, expect, mock, test } from "bun:test";
import { z } from "zod";
// Capture the REAL @telar/core (this static import is hoisted above the
// mock.module below, so it snapshots the genuine module instance) — bun's
// mock.module is process-global and would otherwise leak into sibling test
// files (e.g. titles.test.ts imports accountEnv). afterAll re-installs it.
import * as realCore from "@telar/core";

// Record every answerBlocked call so we can assert the `by` is the SERVER-
// resolved account, never tool input (§M.6 human-by moat).
const answerBlockedCalls: unknown[][] = [];
let answerBlockedReturn = true;
let getLoomReturn: { state?: string } | null = { state: "ready" };

// Mock @telar/core BEFORE importing loom-mcp (static imports of loom-mcp would
// be hoisted above this, so loom-mcp is pulled in via `await import` below).
// Every name loom-mcp imports must be present; ContractAssertion / WorkUnitState
// are zod schemas evaluated at tool-construction time, so they must parse.
mock.module("@telar/core", () => ({
  answerBlocked: async (...args: unknown[]) => {
    answerBlockedCalls.push(args);
    return answerBlockedReturn;
  },
  getLoom: () => getLoomReturn,
  listAccounts: () => [],
  loadPolicy: () => ({}),
  createDraftLoom: () => ({ id: "draft" }),
  writeBundleFile: () => {},
  updateDraftObjectiveFromBundle: () => {},
  writeContract: () => {},
  listBundleFiles: () => [],
  readContract: () => ({ contract: null, errors: [] }),
  listLooms: () => [],
  isListableLoom: () => true,
  startLoomFromBundle: async () => ({ id: "L" }),
  saveLoom: () => {},
  steerLoom: async () => ({}),
  rejectLoom: async () => ({}),
  resumeLoom: () => ({}),
  cancelLoom: () => true,
  addWatch: () => ({}),
  ContractAssertion: z.any(),
  WorkUnitState: z.any(),
}));

// Restore the real module so the mock never bleeds into sibling test files.
afterAll(() => {
  mock.module("@telar/core", () => realCore);
});

const {
  createLoomMcpServer,
  formatEscalationContext,
  LOOM_ANSWER_BLOCKED_TOOL,
  LOOM_AUTO_TOOLS,
  LOOM_ESCALATION_DISALLOWED_TOOLS,
  LOOM_ESCALATION_READONLY_TOOLS,
  LOOM_START_TOOL,
} = await import("./loom-mcp");

// Reach into the SDK server's registered tools to invoke a handler directly.
// The registered key is the bare tool name (e.g. "answer_blocked").
function toolHandler(server: unknown, name: string) {
  const tools = (server as { instance: { _registeredTools: Record<string, { handler: (a: unknown, extra: unknown) => Promise<unknown> } > } })
    .instance._registeredTools;
  const t = tools[name];
  if (!t) throw new Error(`tool ${name} not registered`);
  return (args: Record<string, unknown>) => t.handler(args, {});
}

function makeServer(account = "human@acct", loomId = "L1") {
  return createLoomMcpServer({
    project: "proj",
    objectiveSeed: "seed",
    account,
    link: { loomId },
    getSessionId: () => "sess-1",
  });
}

const textOf = (r: unknown) =>
  ((r as { content?: { text?: string }[] }).content ?? []).map((c) => c.text ?? "").join("");
const isError = (r: unknown) => Boolean((r as { isError?: boolean }).isError);

describe("answer_blocked — the human-gated escalation write", () => {
  test("constant value + never auto-run", () => {
    expect(LOOM_ANSWER_BLOCKED_TOOL).toBe("mcp__loom__answer_blocked");
    // Absent from LOOM_AUTO_TOOLS (like start_loom) so it never lands in
    // allowedTools — it can only run via the interactive approval card.
    expect((LOOM_AUTO_TOOLS as readonly string[]).includes(LOOM_ANSWER_BLOCKED_TOOL)).toBe(false);
    expect((LOOM_AUTO_TOOLS as readonly string[]).includes(LOOM_START_TOOL)).toBe(false);
  });

  test("passes by = server account, NEVER tool input", async () => {
    answerBlockedCalls.length = 0;
    answerBlockedReturn = true;
    getLoomReturn = { state: "ready" };
    const server = makeServer("human@acct");
    const call = toolHandler(server, "answer_blocked");
    // Deliberately try to smuggle an identity through tool input — the schema
    // has no such field, and even if forwarded the handler must ignore it.
    const res = await call({
      devCommand: "bun run dev",
      verifyCommand: "bun test",
      runbook: "log in then /x",
      by: "EVIL",
      account: "EVIL",
    } as Record<string, unknown>);

    expect(answerBlockedCalls.length).toBe(1);
    const [id, by, opts] = answerBlockedCalls[0] as [string, string, Record<string, unknown>, unknown];
    expect(id).toBe("L1"); // resolved from the session link
    expect(by).toBe("human@acct"); // server account, not "EVIL"
    // The recipe passed to core carries ONLY the answer fields — no identity.
    expect(opts).toEqual({ devCommand: "bun run dev", verifyCommand: "bun test", runbook: "log in then /x" });
    expect(opts.by).toBeUndefined();
    expect(opts.account).toBeUndefined();
    // Success surfaces {loomId, state}.
    expect(isError(res)).toBe(false);
    expect(textOf(res)).toContain("\"loomId\": \"L1\"");
    expect(textOf(res)).toContain("\"state\": \"ready\"");
  });

  test("carries verifyCommand — the M11 strategy answer answer_loom can't", async () => {
    answerBlockedCalls.length = 0;
    answerBlockedReturn = true;
    const call = toolHandler(makeServer(), "answer_blocked");
    await call({ verifyCommand: "npm test" } as Record<string, unknown>);
    const [, , opts] = answerBlockedCalls[0] as [string, string, Record<string, unknown>, unknown];
    expect(opts.verifyCommand).toBe("npm test");
  });

  test("errResult when the loom isn't blocked / answer not viability-making", async () => {
    answerBlockedReturn = false;
    const call = toolHandler(makeServer(), "answer_blocked");
    const res = await call({ runbook: "narrative only" } as Record<string, unknown>);
    expect(isError(res)).toBe(true);
    expect(textOf(res).toLowerCase()).toContain("runbook alone");
  });

  test("input schema has no identity field (by/account can't be supplied)", () => {
    const tools = (makeServer() as unknown as {
      instance: { _registeredTools: Record<string, { inputSchema?: unknown }> };
    }).instance._registeredTools;
    const shape = (tools.answer_blocked.inputSchema as { shape?: Record<string, unknown> })?.shape ?? {};
    const keys = Object.keys(shape);
    expect(keys).not.toContain("by");
    expect(keys).not.toContain("account");
    // The four answer fields ARE the whole surface.
    expect(new Set(keys)).toEqual(new Set(["loomId", "devCommand", "verifyCommand", "runbook"]));
  });
});

describe("escalation toolsets — the read-only discuss wall", () => {
  const STATE_CHANGING = [
    "mcp__loom__draft_bundle_file",
    "mcp__loom__propose_contract",
    "mcp__loom__start_loom",
    "mcp__loom__steer_loom",
    "mcp__loom__reject_loom",
    "mcp__loom__answer_loom",
    "mcp__loom__resume_loom",
    "mcp__loom__cancel_loom",
    "mcp__loom__watch_loom",
  ];

  test("READONLY toolset auto-runs only reads — excludes every write + answer_blocked", () => {
    const ro = LOOM_ESCALATION_READONLY_TOOLS as readonly string[];
    expect(ro).toEqual(["Read", "Grep", "Glob", "mcp__loom__read_bundle", "mcp__loom__get_loom", "mcp__loom__list_looms"]);
    for (const t of STATE_CHANGING) expect(ro.includes(t)).toBe(false);
    // answer_blocked is NOT auto-run — it is human-gated, never pre-approved.
    expect(ro.includes(LOOM_ANSWER_BLOCKED_TOOL)).toBe(false);
  });

  test("DISALLOWED toolset hard-blocks every write — but NOT answer_blocked or the reads", () => {
    const dis = LOOM_ESCALATION_DISALLOWED_TOOLS as readonly string[];
    for (const t of STATE_CHANGING) expect(dis.includes(t)).toBe(true);
    // answer_blocked stays callable-but-gated (the ONLY escalation write path).
    expect(dis.includes(LOOM_ANSWER_BLOCKED_TOOL)).toBe(false);
    // The read tools are never disallowed.
    for (const t of ["mcp__loom__read_bundle", "mcp__loom__get_loom", "mcp__loom__list_looms", "Read", "Grep", "Glob"]) {
      expect(dis.includes(t)).toBe(false);
    }
  });

  test("READONLY and DISALLOWED are disjoint", () => {
    const ro = new Set(LOOM_ESCALATION_READONLY_TOOLS as readonly string[]);
    for (const t of LOOM_ESCALATION_DISALLOWED_TOOLS as readonly string[]) expect(ro.has(t)).toBe(false);
  });
});

describe("formatEscalationContext — the escalation seed", () => {
  test("includes blockedReason, blockedQuestion, assertions, and the signal reason", () => {
    const ctx = formatEscalationContext({
      loomId: "L9",
      state: "blocked",
      blockedReason: "no non-server verification strategy is derivable",
      blockedQuestion: "How should this library be verified?",
      assertions: [
        { type: "live-critic", description: "parser accepts valid input" },
        { type: "command", description: "suite passes" },
      ],
      signalReason: "package.json declares no test script (checked: test, bin, notebooks, charter intent)",
    });
    expect(ctx).toContain("L9");
    expect(ctx).toContain("How should this library be verified?");
    expect(ctx).toContain("no non-server verification strategy is derivable");
    expect(ctx).toContain("[live-critic] parser accepts valid input");
    expect(ctx).toContain("[command] suite passes");
    expect(ctx).toContain("checked: test, bin, notebooks, charter intent");
  });

  test("omits absent sections without erroring", () => {
    const ctx = formatEscalationContext({ loomId: "L0" });
    expect(ctx).toContain("L0");
    expect(ctx).not.toContain("The question the loop parked on");
    expect(ctx).not.toContain("Verification Contract");
  });
});
