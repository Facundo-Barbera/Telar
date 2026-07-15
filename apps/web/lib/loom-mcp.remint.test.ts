// Session-slot remint: a terminal (or deleted) loom no longer occupies the
// session's loom slot — draft_bundle_file mints a FRESH draft loom and rebinds
// the link, instead of gluing the session to a dead loom with a stale baseSha.
// Hermetic, mirroring loom-mcp.answer-blocked.test.ts: @telar/core is
// mock.module'd, registered handlers invoked directly.
//
// @ts-expect-error no @types/bun in this workspace
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import * as realCore from "@telar/core";

let getLoomReturn: { state?: string } | null = null;
let draftCount = 0;
const writeBundleCalls: Array<[string, string]> = [];

mock.module("@telar/core", () => ({
  answerBlocked: async () => true,
  getLoom: () => getLoomReturn,
  listAccounts: () => [],
  loadPolicy: () => ({}),
  createDraftLoom: () => ({ id: `draft-${++draftCount}` }),
  writeBundleFile: (loomId: string, path: string) => {
    writeBundleCalls.push([loomId, path]);
  },
  updateDraftObjectiveFromBundle: () => {},
  writeContract: () => {},
  listBundleFiles: () => [],
  readContract: () => ({ contract: null, errors: [] }),
  listLooms: () => [],
  isListableLoom: () => true,
  isTerminalWorkUnitState: (s: string) => ["done", "halted", "failed", "skipped"].includes(s),
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

afterAll(() => {
  mock.module("@telar/core", () => realCore);
});

const { createLoomMcpServer } = await import("./loom-mcp");

function toolHandler(server: unknown, name: string) {
  const tools = (server as { instance: { _registeredTools: Record<string, { handler: (a: unknown, extra: unknown) => Promise<unknown> }> } })
    .instance._registeredTools;
  const t = tools[name];
  if (!t) throw new Error(`tool ${name} not registered`);
  return (args: Record<string, unknown>) => t.handler(args, {});
}

type Link = { loomId?: string; role?: "planner" | "steerer" };

function makeServer(link: Link) {
  return { link, server: createLoomMcpServer({ project: "proj", objectiveSeed: "seed", account: "a@b", link, getSessionId: () => "s" }) };
}

const textOf = (r: unknown) =>
  ((r as { content?: { text?: string }[] }).content ?? []).map((c) => c.text ?? "").join("");
const isError = (r: unknown) => Boolean((r as { isError?: boolean }).isError);

beforeEach(() => {
  writeBundleCalls.length = 0;
});

describe("draft_bundle_file — session-slot remint", () => {
  test("terminal loom frees the slot: fresh draft minted and rebound", async () => {
    getLoomReturn = { state: "halted" };
    const { link, server } = makeServer({ loomId: "dead", role: "planner" });
    const res = await toolHandler(server, "draft_bundle_file")({ path: "objective.md", contents: "x" });
    expect(link.loomId).not.toBe("dead");
    expect(link.loomId).toMatch(/^draft-/);
    expect(writeBundleCalls[0][0]).toBe(link.loomId!); // wrote into the NEW loom
    expect(textOf(res)).toContain("minted FRESH draft loom");
    expect(isError(res)).toBe(false);
  });

  test("deleted loom (getLoom null) also remints", async () => {
    getLoomReturn = null;
    const { link, server } = makeServer({ loomId: "ghost", role: "planner" });
    await toolHandler(server, "draft_bundle_file")({ path: "objective.md", contents: "x" });
    expect(link.loomId).toMatch(/^draft-/);
  });

  test("a live loom keeps its slot — no remint", async () => {
    getLoomReturn = { state: "scoping" };
    const { link, server } = makeServer({ loomId: "live", role: "planner" });
    const res = await toolHandler(server, "draft_bundle_file")({ path: "notes.md", contents: "x" });
    expect(link.loomId).toBe("live");
    expect(writeBundleCalls[0][0]).toBe("live");
    expect(textOf(res)).not.toContain("minted FRESH");
  });

  test("steerer links never remint, even on a terminal loom", async () => {
    getLoomReturn = { state: "halted" };
    const { link, server } = makeServer({ loomId: "steered", role: "steerer" });
    await toolHandler(server, "draft_bundle_file")({ path: "steering.md", contents: "x" });
    expect(link.loomId).toBe("steered");
  });
});

describe("propose_contract — fail-closed on a terminal/deleted loom", () => {
  test("terminal loom: errResult directing to draft_bundle_file", async () => {
    getLoomReturn = { state: "failed" };
    const { server } = makeServer({ loomId: "dead", role: "planner" });
    const res = await toolHandler(server, "propose_contract")({ assertions: [] });
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain("draft_bundle_file first");
  });

  test("live loom: contract writes normally", async () => {
    getLoomReturn = { state: "scoping" };
    const { server } = makeServer({ loomId: "live", role: "planner" });
    const res = await toolHandler(server, "propose_contract")({ assertions: [] });
    expect(isError(res)).toBe(false);
  });
});
