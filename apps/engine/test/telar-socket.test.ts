/**
 * THE `telar` WALL OVER A SOCKET — that the core toolkits collect and dispatch
 * unchanged, which is the precondition for serving them to both providers.
 *
 * This file is about the TRANSPORT, not about what any tool does: each toolkit
 * has its own suite for that. What is asserted here is the set of properties
 * that would silently break if the transport were wrong — names, presence,
 * absence, liveness, and the token.
 *
 * Every case drives a real `TelarToolSocket` over real loopback HTTP with real
 * toolkit builders. No provider process runs.
 */
import { afterEach, expect, test } from "bun:test";
import { TELAR_MCP_SERVER, assertTelarToolNames, canonicalToolName } from "@telar/engine-client";
import { latexTools } from "../src/latex/latex-tools";
import { dsTools } from "../src/ds/ds-tools";
import { notebookTools } from "../src/ds/notebook-tools";
import { displayTools } from "../src/display/tools";
import { TelarToolSocket, collectTelarWall, telarWallIdentity } from "../src/telar-socket";

const sockets: TelarToolSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) await socket.close();
});

/** Answers that name themselves, so a case can tell WHICH capability ran. */
const latexLike = (mark: string) => ({
  toolchain: async () => ({ mark }),
  status: async () => ({ status: "never", mark }),
  compile: async () => ({ ok: true, path: `${mark}.tex`, pdfPath: `${mark}.pdf`, diagnostics: [], logTail: [] }),
  log: async () => ({ lines: [mark] }),
  packages: async () => ({ mark }),
  install: async () => ({ ok: true, lines: [mark] }),
  clean: async () => ({ removed: [mark] }),
});

async function bound(parts: Parameters<typeof collectTelarWall>[0]) {
  const socket = new TelarToolSocket();
  sockets.push(socket);
  const lease = (await socket.bind(() => collectTelarWall(parts)))!;
  return { socket, lease };
}

async function mcp(lease: { url: string; token: string }, method: string, params?: unknown) {
  const response = await fetch(lease.url, {
    method: "POST",
    headers: { authorization: `Bearer ${lease.token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const listed = (body: Record<string, unknown>) => ((body.result as { tools?: { name: string }[] })?.tools ?? []).map((tool) => tool.name);

test("the migrated toolkits collect under their SHIPPED names", async () => {
  const capability = latexLike("one");
  const { lease } = await bound([{ name: "latex", build: latexTools, capability: () => capability }]);

  const names = listed((await mcp(lease, "tools/list")).body);
  expect(names).toContain("latex_compile");
  expect(names).toContain("latex_status");
  // The socket registers under `telar`, so the qualified name a provider
  // produces is the one that already ships — no stored approval moves.
  expect(canonicalToolName(TELAR_MCP_SERVER, "latex_compile")).toBe("mcp__telar__latex_compile");
  expect(() => assertTelarToolNames(names)).not.toThrow();
});

test("data science and notebook collect side by side, with no duplicate tool", async () => {
  const ds = { packages: async () => ({ ok: true }) } as unknown as Parameters<typeof dsTools>[1];
  const { lease } = await bound([
    { name: "ds", build: dsTools, capability: () => ds },
    { name: "notebook", build: notebookTools, capability: () => ds },
  ]);

  const names = listed((await mcp(lease, "tools/list")).body);
  expect(names.some((name) => name.startsWith("ds_"))).toBe(true);
  expect(names.some((name) => name.startsWith("notebook_"))).toBe(true);
  // TWO WALLS, ONE CAPABILITY, NO DOUBLE REGISTRATION — `ds` and `notebook` are
  // two prefixes of one plugin, and a name appearing twice would make an
  // approval ambiguous.
  expect(new Set(names).size).toBe(names.length);
  expect(() => assertTelarToolNames(names)).not.toThrow();
});

test("a capability the turn does not carry contributes NO tools", async () => {
  // Absence is absence, not a tool that answers for a runtime it cannot see.
  const { lease } = await bound([
    { name: "latex", build: latexTools, capability: () => undefined },
    { name: "display", build: displayTools, capability: () => ({ open: async () => ({ ok: true }) }) },
  ]);
  const names = listed((await mcp(lease, "tools/list")).body);
  expect(names.some((name) => name.startsWith("latex_"))).toBe(false);
  expect(names.some((name) => name.startsWith("display_"))).toBe(true);
});

test("a call dispatches to the LIVE capability, not the one the wall was built with", async () => {
  // The query outlives the turn, so the wall reads through a getter. A captured
  // capability would answer the second turn from the first turn's object.
  let current = latexLike("first");
  const { lease } = await bound([{ name: "latex", build: latexTools, capability: () => current }]);

  // `latex_log` echoes what the capability returned; `latex_status` formats its
  // answer into a sentence and would hide which object produced it.
  const before = await mcp(lease, "tools/call", { name: "latex_log", arguments: {} });
  expect(JSON.stringify(before.body)).toContain("first");

  current = latexLike("second");
  const after = await mcp(lease, "tools/call", { name: "latex_log", arguments: {} });
  expect(JSON.stringify(after.body)).toContain("second");
});

test("an unknown tool fails closed", async () => {
  const { lease } = await bound([{ name: "latex", build: latexTools, capability: () => latexLike("x") }]);
  const answer = await mcp(lease, "tools/call", { name: "not_a_tool", arguments: {} });
  // An error, never a silent success — a provider asking for something this
  // wall does not have must be told so.
  expect(JSON.stringify(answer.body)).toMatch(/error|unknown|not/i);
  expect(JSON.stringify(answer.body)).not.toContain('"result":{"content":[]}');
});

test("two sessions get two tokens, each reaching only its own wall, and a released one dies", async () => {
  const socket = new TelarToolSocket();
  sockets.push(socket);
  const first = (await socket.bind(() => collectTelarWall([{ name: "latex", build: latexTools, capability: () => latexLike("alpha") }])))!;
  const second = (await socket.bind(() => collectTelarWall([{ name: "latex", build: latexTools, capability: () => latexLike("beta") }])))!;

  expect(JSON.stringify((await mcp(first, "tools/call", { name: "latex_log", arguments: {} })).body)).toContain("alpha");
  expect(JSON.stringify((await mcp(second, "tools/call", { name: "latex_log", arguments: {} })).body)).toContain("beta");
  expect(first.generation).not.toBe(second.generation);

  first.release();
  expect((await mcp(first, "tools/list")).status).toBe(401);
  expect((await mcp(second, "tools/list")).status).toBe(200);
});

test("the advertised list follows the turn WITHOUT rotating the token", async () => {
  // The reuse property: a turn that gains or loses a capability must change what
  // `tools/list` returns, but must NOT invalidate the credential a provider was
  // started with — that is the 401-under-a-reused-query failure.
  let latex: unknown = undefined;
  const socket = new TelarToolSocket();
  sockets.push(socket);
  const lease = (await socket.bind(() => collectTelarWall([{ name: "latex", build: latexTools, capability: () => latex }])))!;

  expect(listed((await mcp(lease, "tools/list")).body)).toEqual([]);
  latex = latexLike("now-on");
  expect(listed((await mcp(lease, "tools/list")).body).some((name) => name.startsWith("latex_"))).toBe(true);
  expect((await mcp(lease, "tools/list")).status).toBe(200);
});

test("the socket takes its own bearer and serves one path", async () => {
  const { lease } = await bound([{ name: "latex", build: latexTools, capability: () => latexLike("guarded") }]);
  const wrong = await fetch(lease.url, {
    method: "POST",
    headers: { authorization: "Bearer nope", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  expect(wrong.status).toBe(401);

  const elsewhere = await fetch(new URL("/v2/elsewhere", lease.url), {
    method: "POST",
    headers: { authorization: `Bearer ${lease.token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  expect(elsewhere.status).toBe(404);
});

test("close stops serving every binding at once", async () => {
  const { socket, lease } = await bound([{ name: "latex", build: latexTools, capability: () => latexLike("x") }]);
  expect((await mcp(lease, "tools/list")).status).toBe(200);
  await socket.close();
  // The listener is gone, so the credential has nothing left to open.
  await expect(mcp(lease, "tools/list")).rejects.toBeDefined();
});

test("an in-flight call finishes against the capability it STARTED with", async () => {
  // A handler that touches the capability twice must not bind the first call to
  // this turn's object and the second to the next turn's. Freshness lives
  // BETWEEN requests (the wall re-collects); within one request the capability
  // is fixed.
  let released!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => (released = resolve));
  // Resolved INSIDE the handler, so the swap below is guaranteed to land while
  // the call is genuinely in flight rather than before it reached the server.
  const started = new Promise<void>((resolve) => (entered = resolve));
  let current: unknown = {
    ...latexLike("first"),
    log: async () => {
      entered();
      await gate;
      return { lines: ["first"] };
    },
  };
  const { lease } = await bound([{ name: "latex", build: latexTools, capability: () => current }]);

  const inFlight = mcp(lease, "tools/call", { name: "latex_log", arguments: {} });
  await started;
  current = latexLike("second"); // the turn moved on, mid-call
  released();

  // Still `first` — the call that started before the swap finishes against the
  // object it started with.
  expect(JSON.stringify((await inFlight).body)).toContain("first");

  // …and the NEXT request sees the new one, because collection happens per
  // request rather than once at bind.
  expect(JSON.stringify((await mcp(lease, "tools/call", { name: "latex_log", arguments: {} })).body)).toContain("second");
});

test("the wall's IDENTITY changes when the capability set does — a stable token is not catalog coherence", async () => {
  // Re-collecting per request keeps DISPATCH honest server-side, but a reused
  // provider keeps the catalog it was started with. So the set has to be
  // fingerprintable, or a model sees a tool it can no longer call.
  let latex: unknown = latexLike("on");
  const parts = [
    { name: "latex", build: latexTools, capability: () => latex },
    { name: "display", build: displayTools, capability: () => ({ open: async () => ({ ok: true }) }) },
  ];

  expect(telarWallIdentity(parts)).toEqual(["display", "latex"]);
  latex = undefined;
  expect(telarWallIdentity(parts)).toEqual(["display"]);
  latex = latexLike("back");
  expect(telarWallIdentity(parts)).toEqual(["display", "latex"]);
});

test("dispatch refuses a disabled tool server-side, whatever catalog the provider cached", async () => {
  // The other half of the same point: even if a provider still advertises
  // `latex_*` from a stale catalog, the wall no longer has it, so the call is
  // refused here rather than reaching a capability the project turned off.
  let latex: unknown = latexLike("on");
  const socket = new TelarToolSocket();
  sockets.push(socket);
  const lease = (await socket.bind(() => collectTelarWall([{ name: "latex", build: latexTools, capability: () => latex }])))!;

  expect(JSON.stringify((await mcp(lease, "tools/call", { name: "latex_log", arguments: {} })).body)).toContain("on");

  latex = undefined;
  const refused = await mcp(lease, "tools/call", { name: "latex_log", arguments: {} });
  expect(JSON.stringify(refused.body)).toMatch(/error|unknown|not/i);
  expect(listed((await mcp(lease, "tools/list")).body)).toEqual([]);
});
