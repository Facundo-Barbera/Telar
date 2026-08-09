// The Claude-shaped MCP roster, translated for Codex — story 13's pure half.
// Every case here is a shape `resolveProjectMcpServers` or a SessionProfile can
// actually produce, including the two it produces that Codex has no spelling
// for, because a converter that silently returns fewer keys than it was given
// is the silent degradation AD-11 forbids.
//
// bun provides "bun:test" at runtime; @types/bun isn't a dependency of this
// Next app, so the web tsconfig (which includes **/*.ts) can't resolve it.
// @ts-expect-error no @types/bun in this workspace
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";

import { resetCodexMcpWarnings, toCodexMcpServers, warnCodexMcpLosses } from "./codex-mcp";

const roster = (r: Record<string, McpServerConfig>) => r;

describe("toCodexMcpServers", () => {
  test("an explicit stdio server becomes command/args/env", () => {
    const { servers, dropped } = toCodexMcpServers(
      roster({
        linear: {
          type: "stdio",
          command: "/usr/local/bin/linear-mcp",
          args: ["--stdio"],
          env: { LINEAR_API_KEY: "tok-abc" },
        },
      }),
    );
    expect(servers).toEqual({
      linear: {
        transport: "stdio",
        command: "/usr/local/bin/linear-mcp",
        args: ["--stdio"],
        env: { LINEAR_API_KEY: "tok-abc" },
      },
    });
    expect(dropped).toEqual([]);
  });

  test("a MISSING type is stdio, not unknown", () => {
    // `type` is optional on the SDK's stdio member, and this is the shape most
    // hand-written telar.yaml servers actually take. Read the other way — "no
    // tag, no idea, drop it" — the common case is the one that disappears.
    const { servers, dropped } = toCodexMcpServers(
      roster({ local: { command: "bun", args: ["server.ts"] } as McpServerConfig }),
    );
    expect(servers).toEqual({ local: { transport: "stdio", command: "bun", args: ["server.ts"] } });
    expect(dropped).toEqual([]);
  });

  test("empty args/env are omitted rather than sent as empty tables", () => {
    const { servers } = toCodexMcpServers(
      roster({ bare: { type: "stdio", command: "bare-mcp", args: [], env: {} } }),
    );
    expect(servers.bare).toEqual({ transport: "stdio", command: "bare-mcp" });
  });

  test("an http server becomes url + headers, which codex spells http_headers", () => {
    // The rename to `http_headers` happens one layer down, in codexMcpConfig —
    // this layer keeps the SDK's word so the two conversions stay separable.
    const { servers, dropped } = toCodexMcpServers(
      roster({
        notion: {
          type: "http",
          url: "https://mcp.notion.com/mcp",
          headers: { Authorization: "Bearer tok-xyz" },
        },
      }),
    );
    expect(servers).toEqual({
      notion: {
        transport: "http",
        url: "https://mcp.notion.com/mcp",
        headers: { Authorization: "Bearer tok-xyz" },
      },
    });
    expect(dropped).toEqual([]);
  });

  test("an sdk (in-process) server is dropped, and says why", () => {
    // Telar's own servers are these. They are not lost on Codex — they reach it
    // as `dynamicTools` — and the reason string is what keeps a future reader
    // from "fixing" that by inventing a subprocess for an object.
    const { servers, dropped } = toCodexMcpServers(
      roster({ workspace: { type: "sdk", name: "workspace", instance: {} } as McpServerConfig }),
    );
    expect(servers).toEqual({});
    expect(dropped).toEqual([
      {
        name: "workspace",
        type: "sdk",
        reason: "in-process servers reach Codex as dynamic tools, not as MCP config",
      },
    ]);
  });

  test("an sse server is dropped — codex 0.145 has no sse transport", () => {
    const { servers, dropped } = toCodexMcpServers(
      roster({ legacy: { type: "sse", url: "https://example.test/sse" } }),
    );
    expect(servers).toEqual({});
    expect(dropped[0]!.name).toBe("legacy");
    expect(dropped[0]!.reason).toContain("sse");
  });

  test("a mixed roster converts what it can and reports the rest — not all-or-nothing", () => {
    const { servers, dropped } = toCodexMcpServers(
      roster({
        keep: { type: "stdio", command: "keep-mcp" },
        gone: { type: "sse", url: "https://example.test/sse" },
        also: { type: "http", url: "https://example.test/mcp" },
      }),
    );
    expect(Object.keys(servers).sort()).toEqual(["also", "keep"]);
    expect(dropped.map((d) => d.name)).toEqual(["gone"]);
  });

  test("the conversion COPIES: mutating the result cannot reach the roster", () => {
    // The roster's env objects hold live MCP tokens owned by
    // resolveProjectMcpServers. A shared reference here would let this
    // provider's plumbing edit the other's credentials.
    const source = roster({
      linear: { type: "stdio", command: "x", args: ["a"], env: { K: "v" } },
    });
    const { servers } = toCodexMcpServers(source);
    const converted = servers.linear as unknown as { args: string[]; env: Record<string, string> };
    converted.args.push("b");
    converted.env.K = "mutated";
    expect(source.linear).toEqual({ type: "stdio", command: "x", args: ["a"], env: { K: "v" } });
  });

  test("an empty roster converts to an empty roster", () => {
    expect(toCodexMcpServers({})).toEqual({ servers: {}, dropped: [], narrowed: [] });
  });

  // ── the name grammar, measured against a live app-server ──────────────────
  // codex 0.145.0 refuses a server whose name is not ^[a-zA-Z0-9_-]+$ and says
  // so only in an `mcpServer/startupStatus/updated` notification. Telar's own
  // roster key type is `z.record(z.string(), …)`, so this is a shape a project
  // can legally declare, and it WORKS on Claude.

  test("a server name codex refuses is a DROP, not a silent vanishing", () => {
    const { servers, dropped } = toCodexMcpServers(
      roster({ "my.server": { type: "stdio", command: "x" } }),
    );
    expect(servers).toEqual({});
    expect(dropped).toEqual([
      {
        name: "my.server",
        type: "stdio",
        reason: "codex rejects this server name — it must match ^[a-zA-Z0-9_-]+$",
      },
    ]);
  });

  test("the names codex DOES accept still convert — the anti-vacuity half", () => {
    // Both of these were probed against the real binary and spawned. A regex
    // that rejected them would turn a working server into a warning.
    const { servers, dropped } = toCodexMcpServers(
      roster({
        plain_name: { type: "stdio", command: "x" },
        "has-dash": { type: "stdio", command: "y" },
        MiXed09: { type: "stdio", command: "z" },
      }),
    );
    expect(Object.keys(servers).sort()).toEqual(["MiXed09", "has-dash", "plain_name"]);
    expect(dropped).toEqual([]);
  });

  test("a bad name reports as a NAME problem even on a transport that also fails", () => {
    // Reporting "no sse transport" for a server whose real defect is its name
    // would send the human to fix the wrong thing.
    const { dropped } = toCodexMcpServers(
      roster({ "bad.name": { type: "sse", url: "https://example.test/sse" } }),
    );
    expect(dropped[0]!.reason).toContain("server name");
  });

  // ── fields that come along with nothing to carry them ─────────────────────

  test("`tools` is reported as a NARROWING — dropping an allowlist widens the roster", () => {
    const { servers, narrowed } = toCodexMcpServers(
      roster({
        notion: {
          type: "http",
          url: "https://mcp.notion.com/mcp",
          tools: [{ name: "search" }],
        } as unknown as McpServerConfig,
      }),
    );
    // The server still mounts — this is not a drop.
    expect(servers.notion).toEqual({ transport: "http", url: "https://mcp.notion.com/mcp" });
    expect(narrowed).toHaveLength(1);
    expect(narrowed[0]!.name).toBe("notion");
    expect(narrowed[0]!.fields).toEqual(["tools"]);
    // The direction is the point: a lost allowlist makes Codex see MORE tools
    // than Claude does, which is the one way a silent loss must never fail.
    expect(narrowed[0]!.reason).toContain("WIDENS");
  });

  test("timeout and alwaysLoad are reported together, once, per server", () => {
    const { narrowed } = toCodexMcpServers(
      roster({
        slow: { type: "stdio", command: "x", timeout: 30000, alwaysLoad: true } as McpServerConfig,
      }),
    );
    expect(narrowed).toEqual([
      { name: "slow", fields: ["timeout", "alwaysLoad"], reason: expect.stringContaining("timeout") },
    ]);
  });

  test("a plain server narrows nothing — the discriminator", () => {
    const { narrowed } = toCodexMcpServers(
      roster({ linear: { type: "stdio", command: "x", args: ["--stdio"], env: { K: "v" } } }),
    );
    expect(narrowed).toEqual([]);
  });

  test("a DROPPED server is not also reported as narrowed", () => {
    // It never mounted; telling the user it "loses timeout" would be noise on
    // top of the line that actually matters.
    const { dropped, narrowed } = toCodexMcpServers(
      roster({ legacy: { type: "sse", url: "https://example.test/sse", timeout: 5000 } as McpServerConfig }),
    );
    expect(dropped).toHaveLength(1);
    expect(narrowed).toEqual([]);
  });
});

describe("warnCodexMcpLosses", () => {
  const original = console.warn;
  let lines: string[];
  const losses = (dropped: unknown[] = [], narrowed: unknown[] = []) =>
    ({ dropped, narrowed }) as Parameters<typeof warnCodexMcpLosses>[0];

  beforeEach(() => {
    resetCodexMcpWarnings();
    lines = [];
    console.warn = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
  });

  afterEach(() => {
    console.warn = original;
    resetCodexMcpWarnings();
  });

  test("names the server and the reason", () => {
    warnCodexMcpLosses(losses([{ name: "legacy", type: "sse", reason: "no sse transport" }]), "proj");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("legacy");
    expect(lines[0]).toContain("no sse transport");
  });

  test("warns ONCE per server per process — a dropped server is a standing condition", () => {
    // This runs on every turn of every session. Without the dedupe the log
    // becomes one line per turn forever, which is how a real warning gets
    // filtered out by the humans who need to read it.
    const drop = losses([{ name: "legacy", type: "sse", reason: "no sse transport" }]);
    warnCodexMcpLosses(drop, "proj");
    warnCodexMcpLosses(drop, "proj");
    warnCodexMcpLosses(drop, "proj");
    expect(lines).toHaveLength(1);
  });

  test("a DIFFERENT server still warns", () => {
    warnCodexMcpLosses(losses([{ name: "a", type: "sse", reason: "r" }]), "proj");
    warnCodexMcpLosses(losses([{ name: "b", type: "sse", reason: "r" }]), "proj");
    expect(lines).toHaveLength(2);
  });

  test("THE SCOPE IS IN THE KEY — one project's drop cannot silence another's", () => {
    // The dedupe set is module-global and the roster is per-project. Keyed on
    // `name:type` alone, the second project's identical `legacy` would be
    // swallowed forever and that user would never learn their server is gone.
    const drop = losses([{ name: "legacy", type: "sse", reason: "no sse transport" }]);
    warnCodexMcpLosses(drop, "project-a");
    warnCodexMcpLosses(drop, "project-b");
    expect(lines).toHaveLength(2);
    // …and it is still once per project, not once per turn.
    warnCodexMcpLosses(drop, "project-a");
    expect(lines).toHaveLength(2);
  });

  test("a NARROWING warns too, and separately from a drop of the same server", () => {
    warnCodexMcpLosses(
      losses(
        [{ name: "legacy", type: "sse", reason: "no sse transport" }],
        [{ name: "notion", fields: ["tools"], reason: "tools: allowlist — WIDENS" }],
      ),
      "proj",
    );
    expect(lines).toHaveLength(2);
    expect(lines.some((l) => l.includes("notion") && l.includes("tools"))).toBe(true);
  });

  test("nothing lost, nothing said", () => {
    warnCodexMcpLosses(losses(), "proj");
    expect(lines).toEqual([]);
  });
});
