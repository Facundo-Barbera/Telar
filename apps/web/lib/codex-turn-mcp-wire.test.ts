// EXTERNAL MCP SERVERS REACHING CODEX — story 13, over a real subprocess.
//
// The unit half (codex-mcp.test.ts) proves the roster is TRANSLATED correctly.
// This proves it is SENT: through `runCodexTurn`, across a spawn, in the
// params of the request that opens the thread — and, the part that a
// pure-function test structurally cannot reach, in the params of `thread/resume`
// too, which is where a "declared once at start" implementation would silently
// hand a resumed session a thread with none of its project's servers.
//
// There is NO normalized event for an injected config, by design: the whole
// mechanism is invisible on the event stream. So the assertion is made on the
// wire, via the fixture's FAKE_CODEX_PARAMS_LOG request tape. A test that
// watched the yielded events instead would pass over a `runCodexTurn` that
// dropped `opts.mcpServers` on the floor entirely — which is exactly the state
// this story found the code in.
//
// bun provides "bun:test" at runtime; @types/bun isn't a dependency of this
// Next app, so the web tsconfig (which includes **/*.ts) can't resolve it.
// @ts-expect-error no @types/bun in this workspace
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type CodexMcpServerConfig,
  resetCodexMcpStartupWarnings,
  runCodexTurn,
} from "./codex-app-server";

const FAKE_BIN = fileURLToPath(new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url));

let previousCodexBin: string | undefined;
let logDir: string;
let logPath: string;

beforeEach(() => {
  previousCodexBin = process.env.CODEX_BIN;
  process.env.CODEX_BIN = FAKE_BIN;
  logDir = mkdtempSync(join(tmpdir(), "codex-mcp-wire-"));
  logPath = join(logDir, "requests.jsonl");
});

afterEach(() => {
  if (previousCodexBin === undefined) delete process.env.CODEX_BIN;
  else process.env.CODEX_BIN = previousCodexBin;
  rmSync(logDir, { recursive: true, force: true });
});

// AppServerClient spawns with EXACTLY this env — PATH for the fixture's
// `#!/usr/bin/env bun` shebang, and the tape path so the fixture (reading its
// OWN process.env) writes where this file can read.
const fakeEnv = () => ({
  PATH: process.env.PATH ?? "",
  FAKE_CODEX_TURN_SCENARIO: "plain",
  FAKE_CODEX_PARAMS_LOG: logPath,
});

// Same hard-deadline discipline as codex-turn-compact-wire.test.ts: a generator
// that never finishes must fail this file, not hang it.
async function drain(
  gen: AsyncGenerator<{ type: string; [k: string]: unknown }>,
  timeoutMs = 5000,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`runCodexTurn did not return within ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    await Promise.race([
      (async () => {
        for await (const _ev of gen) void _ev;
      })(),
      timeout,
    ]);
  } finally {
    clearTimeout(timer!);
    await gen.return(undefined as never).catch(() => {});
  }
}

type Recorded = { method: string; params: Record<string, unknown> | null };

function tape(): Recorded[] {
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Recorded);
}

function paramsOf(method: string): Record<string, unknown> {
  const hit = tape().find((r) => r.method === method);
  if (!hit) throw new Error(`no ${method} request on the tape: ${JSON.stringify(tape().map((r) => r.method))}`);
  return hit.params ?? {};
}

const MCP: Record<string, CodexMcpServerConfig> = {
  linear: {
    transport: "stdio",
    command: "/usr/local/bin/linear-mcp",
    args: ["--stdio"],
    env: { LINEAR_API_KEY: "tok-abc" },
  },
  notion: {
    transport: "http",
    url: "https://mcp.notion.com/mcp",
    headers: { Authorization: "Bearer tok-xyz" },
  },
};

const baseOpts = () => ({
  prompt: "hello",
  cwd: process.cwd(),
  env: fakeEnv(),
  model: "gpt-5.6-sol",
  sandbox: "read-only" as const,
  approvalPolicy: "never" as const,
  approvalsReviewer: "auto_review" as const,
});

describe("runCodexTurn injects MCP servers per invocation", () => {
  test("thread/start carries config.mcp_servers in codex's own field spelling", async () => {
    await drain(runCodexTurn({ ...baseOpts(), mcpServers: MCP }));
    // The field names are Codex's, not the SDK's: `http_headers`, not
    // `headers`; snake_case `mcp_servers` under `config`. Asserted as a whole
    // object rather than key-by-key so an EXTRA key — a stray `transport` tag,
    // or the SDK's `headers` spelling surviving the rename — fails HERE.
    //
    // WHY WHOLE-OBJECT AND NOT `toMatchObject`: measured against the real
    // binary, an unknown field in the mcp_servers table is a hard error under
    // `--strict-config` ("unknown configuration field `mcp_servers.x.headers`")
    // and is SILENTLY IGNORED without it. Telar does not pass --strict-config,
    // so the lenient path is the one production takes: a misspelled field is
    // not an error anywhere, it is a server that starts without its headers and
    // 401s at the first tool call. Nothing downstream can catch that, which is
    // why the exact-shape assertion is the check.
    expect(paramsOf("thread/start").config).toEqual({
      mcp_servers: {
        linear: {
          command: "/usr/local/bin/linear-mcp",
          args: ["--stdio"],
          env: { LINEAR_API_KEY: "tok-abc" },
        },
        notion: {
          url: "https://mcp.notion.com/mcp",
          http_headers: { Authorization: "Bearer tok-xyz" },
        },
      },
    });
  });

  test("a RESUMED thread re-declares the same servers", async () => {
    await drain(runCodexTurn({ ...baseOpts(), resume: "thread-42", mcpServers: MCP }));
    const resumed = paramsOf("thread/resume");
    expect(resumed.threadId).toBe("thread-42");
    // The overlay is not persisted by the app-server, so silence here is a
    // resumed session quietly losing every external server it started with —
    // AD-11's silent degradation, on the path a long-lived session spends
    // almost all of its turns.
    expect(resumed.config).toEqual({
      mcp_servers: {
        linear: {
          command: "/usr/local/bin/linear-mcp",
          args: ["--stdio"],
          env: { LINEAR_API_KEY: "tok-abc" },
        },
        notion: {
          url: "https://mcp.notion.com/mcp",
          http_headers: { Authorization: "Bearer tok-xyz" },
        },
      },
    });
    // And nothing was started: a resume must not also open a fresh thread.
    expect(tape().some((r) => r.method === "thread/start")).toBe(false);
  });

  test("no servers means NO config key at all — not an empty override", async () => {
    await drain(runCodexTurn(baseOpts()));
    // `config: {}` is a statement ("override nothing"), and an empty
    // `mcp_servers` table is a different statement ("this client has no
    // servers") from not mentioning the table — the same distinction
    // dynamicTools/developerInstructions are omitted for. Every Codex session
    // today takes this path, so it is the one that must be byte-identical to
    // the pre-story request.
    expect(paramsOf("thread/start").config).toBeUndefined();
  });

  test("an empty roster object is treated as no servers", async () => {
    await drain(runCodexTurn({ ...baseOpts(), mcpServers: {} }));
    // Reachable from the route only if the omit-when-empty guard there is
    // removed; pinned here so this layer is safe on its own rather than by
    // agreement with its caller.
    expect(paramsOf("thread/start").config).toBeUndefined();
  });

  test("the secrets ride the pipe, never the argv", async () => {
    await drain(runCodexTurn({ ...baseOpts(), mcpServers: MCP }));
    // The deviation from brownfield.md's `-c mcp_servers.<name>.<field>` is
    // load-bearing and this is what pins it: an argv is world-readable via
    // `ps` to every process running as this user, INCLUDING the sandboxed
    // shells of the agent sessions themselves, and these env/header values are
    // MCP tokens materialized by resolveProjectMcpServers. If someone moves
    // injection back to the command line, the token below stops being on the
    // tape and this test says why that matters.
    expect(JSON.stringify(paramsOf("thread/start"))).toContain("tok-abc");
    const argv = (paramsOf("@argv").argv as string[]).join(" ");
    expect(argv).not.toContain("tok-abc");
    expect(argv).not.toContain("mcp_servers");
  });
});

describe("a server that fails to start is reported, not swallowed", () => {
  // The failure this story is most likely to produce — a bad command, an
  // unreachable url, a name codex refuses — appears on exactly ONE method, and
  // the turn then completes normally. Before this case existed, the app-server
  // was the only party that knew, and the human saw a model that simply never
  // used the tools their project declared.
  const original = console.warn;
  let lines: string[];

  beforeEach(() => {
    lines = [];
    console.warn = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    resetCodexMcpStartupWarnings();
  });

  afterEach(() => {
    console.warn = original;
    resetCodexMcpStartupWarnings();
  });

  const failingEnv = () => ({ ...fakeEnv(), FAKE_CODEX_TURN_SCENARIO: "mcp-startup-failed" });

  test("a failed startup names the server and the reason", async () => {
    await drain(runCodexTurn({ ...baseOpts(), env: failingEnv(), mcpServers: MCP }));
    const warned = lines.filter((l) => l.includes("failed to start"));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("probesrv");
    expect(warned[0]).toContain("handshaking with MCP server failed");
  });

  test("a `starting` update says nothing — only a failure is news", async () => {
    // The fixture emits `starting` before `failed`, exactly as the real
    // app-server does. Warning on both would double every line and teach the
    // reader to ignore them.
    await drain(runCodexTurn({ ...baseOpts(), env: failingEnv(), mcpServers: MCP }));
    expect(lines.filter((l) => l.includes("[codex-mcp]"))).toHaveLength(1);
  });

  test("the turn still completes — a dead server is not a dead turn", async () => {
    // The real app-server goes on to run the turn without the server's tools.
    // Throwing here would turn a degraded session into a failed one, which is
    // a worse trade than the log line.
    const seen: string[] = [];
    for await (const ev of runCodexTurn({ ...baseOpts(), env: failingEnv(), mcpServers: MCP })) {
      seen.push(ev.type);
    }
    expect(seen).toContain("session");
    expect(seen.some((t) => t === "text" || t === "text_delta" || t === "done")).toBe(true);
  });
});
