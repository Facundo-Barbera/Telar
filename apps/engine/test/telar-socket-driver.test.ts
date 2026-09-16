/**
 * THE CLAUDE DRIVER AGAINST A REAL `telar` SOCKET — the wiring, not the wall.
 *
 * `telar-socket.test.ts` proves the socket serves the core toolkits. This proves
 * the DRIVER uses it: that the `telar` key becomes the worker-hosted http entry,
 * that the in-process server is not ALSO built under that key, that one lease
 * survives many turns, and — the property root called out as distinct from the
 * token — that a change to the capability SET actually refreshes what a reused
 * provider advertises rather than merely changing what the server will dispatch.
 *
 * The SDK is a fake; no provider process runs and no paid call is made.
 */
import { afterEach, expect, test } from "bun:test";
import { TELAR_MCP_SERVER, TELAR_BROWSER_MCP_SERVER } from "@telar/engine-client";
import { createClaudeDriver } from "../src/driver";
import { TelarToolSocket } from "../src/telar-socket";
import { allowCliInThisFile } from "./allow-cli";

/** NO PROVIDER PROCESS IS SPAWNED HERE, but a binary path IS resolved —
 *  the Claude driver resolves one before handing the turn to a fake SDK.
 *  So this file opts past issue #532’s no-spawn gate, for its own scope only.
 *  See ./allow-cli.ts. */
allowCliInThisFile();

const sockets: TelarToolSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) await socket.close();
});

/** Records the server table and the tool list each query was started with. */
function fakeSdk() {
  const queries: { servers: Record<string, unknown> | undefined; inProcessTools: string[] }[] = [];
  const inProcess: string[] = [];
  return {
    queries,
    sdk: async () => ({
      tool: (name: string) => {
        inProcess.push(name);
        return { name };
      },
      createSdkMcpServer: (input: { tools: { name: string }[] }) => ({ kind: "in-process", tools: input.tools }),
      async *query(input: { options: { mcpServers?: Record<string, unknown> }; prompt: AsyncIterable<unknown> }) {
        queries.push({ servers: input.options.mcpServers, inProcessTools: [...inProcess] });
        inProcess.length = 0;
        for await (const message of input.prompt) {
          void message;
          yield { type: "result", subtype: "success" };
        }
      },
    }),
  };
}

const latexCapability = () => ({
  toolchain: async () => ({}),
  status: async () => ({ status: "never" }),
  compile: async () => ({ ok: true, path: "m.tex", pdfPath: "m.pdf", diagnostics: [], logTail: [] }),
  log: async () => ({ lines: ["x"] }),
  packages: async () => ({}),
  install: async () => ({ ok: true, lines: [] }),
  clean: async () => ({ removed: [] }),
});

/** `tools/list` as a provider would ask it. */
async function advertised(entry: { url: string; headers: Record<string, string> }) {
  const response = await fetch(entry.url, {
    method: "POST",
    headers: { ...entry.headers, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const body = (await response.json()) as { result?: { tools?: { name: string }[] } };
  return (body.result?.tools ?? []).map((tool) => tool.name);
}

function driverWith(socket: TelarToolSocket) {
  const { sdk, queries } = fakeSdk();
  const driver = createClaudeDriver(sdk);
  const turn = (extra: Record<string, unknown> = {}) =>
    driver.run({
      prompt: "prompt",
      sessionId: "session_telar",
      cwd: "/tmp",
      signal: new AbortController().signal,
      onObservations: async () => undefined,
      telarSocket: socket,
      ...extra,
    });
  return { turn, queries };
}

test("the `telar` key is the worker-hosted http entry, and the in-process server is NOT also built", async () => {
  const socket = new TelarToolSocket();
  sockets.push(socket);
  const { turn, queries } = driverWith(socket);

  await turn({ latex: latexCapability() });

  const entry = queries[0]?.servers?.[TELAR_MCP_SERVER] as { type: string; url: string; headers: Record<string, string> };
  expect(entry?.type).toBe("http");
  expect(entry.url).toContain("/v2/telar/mcp");
  expect(entry.headers.Authorization).toMatch(/^Bearer /);

  // ONE registration under the key. An in-process server built alongside would
  // shadow or be shadowed — a duplicate-key bug, not a fallback.
  expect(JSON.stringify(entry)).not.toContain("in-process");

  // …and the wall really answers, under the shipped names.
  expect(await advertised(entry)).toContain("latex_compile");
});

test("the browser socket still registers under its own key, unchanged", async () => {
  const socket = new TelarToolSocket();
  sockets.push(socket);
  const { turn, queries } = driverWith(socket);
  await turn({ browserSocket: { url: "http://127.0.0.1:9/v2/browser/mcp", token: "b" } });
  expect(queries[0]?.servers?.[TELAR_BROWSER_MCP_SERVER]).toBeDefined();
  expect(queries[0]?.servers?.[TELAR_MCP_SERVER]).toBeDefined();
});

test("one lease serves many turns — a reused query keeps a valid credential", async () => {
  const socket = new TelarToolSocket();
  sockets.push(socket);
  const { turn, queries } = driverWith(socket);

  await turn({ latex: latexCapability() });
  await turn({ latex: latexCapability() });

  // Same capability set, so the query is REUSED and the entry is not rebuilt.
  expect(queries).toHaveLength(1);
  const entry = queries[0]!.servers![TELAR_MCP_SERVER] as { url: string; headers: Record<string, string> };
  // The token minted for turn one still works on turn two.
  expect(await advertised(entry)).toContain("latex_compile");
});

test("on → off → on refreshes what a reused provider ADVERTISES, with no duplicate tools", async () => {
  /**
   * THE CATALOG REGRESSION. A live tool list keeps DISPATCH honest, but a
   * provider caches the catalog it was started with — so the capability set has
   * to cold-start the query, or a model keeps offering a tool the project just
   * turned off.
   */
  const socket = new TelarToolSocket();
  sockets.push(socket);
  const { turn, queries } = driverWith(socket);

  await turn({ latex: latexCapability() });
  expect(queries).toHaveLength(1);
  const first = queries[0]!.servers![TELAR_MCP_SERVER] as { url: string; headers: Record<string, string> };
  expect(await advertised(first)).toContain("latex_compile");

  // OFF: the set changed, so the query must be rebuilt rather than reused.
  await turn({});
  expect(queries).toHaveLength(2);
  const off = queries[1]!.servers![TELAR_MCP_SERVER] as { url: string; headers: Record<string, string> };
  expect(await advertised(off)).not.toContain("latex_compile");

  // ON again: rebuilt once more, and the tool is back exactly once.
  await turn({ latex: latexCapability() });
  expect(queries).toHaveLength(3);
  const back = queries[2]!.servers![TELAR_MCP_SERVER] as { url: string; headers: Record<string, string> };
  const names = await advertised(back);
  expect(names.filter((name) => name === "latex_compile")).toEqual(["latex_compile"]);
  expect(new Set(names).size).toBe(names.length);
});

test("server-side dispatch refuses a disabled tool even against a stale catalog", async () => {
  // The other half: a provider still holding the old catalog cannot execute a
  // tool the current turn does not carry, because the wall re-collects per
  // request and no longer has it.
  const socket = new TelarToolSocket();
  sockets.push(socket);
  const { turn, queries } = driverWith(socket);

  await turn({ latex: latexCapability() });
  const entry = queries[0]!.servers![TELAR_MCP_SERVER] as { url: string; headers: Record<string, string> };
  expect(await advertised(entry)).toContain("latex_compile");

  await turn({}); // latex gone
  const call = await fetch(entry.url, {
    method: "POST",
    headers: { ...entry.headers, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "latex_compile", arguments: {} } }),
  });
  const body = JSON.stringify(await call.json());
  expect(body).toMatch(/error|unknown|not/i);
  expect(body).not.toContain("m.pdf");
});
