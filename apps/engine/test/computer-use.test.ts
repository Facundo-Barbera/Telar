/**
 * Computer use for Claude, resolved off the Codex install.
 *
 * Pinned against the REAL layout on this machine: the launcher lives in the
 * plugin cache under a version directory, and it is a shell script that dies
 * without the Sky client app — which is why the resolver checks both.
 */
import { describe, expect, test } from "bun:test";
import type { McpServer } from "@telar/engine-client";
import { COMPUTER_USE_SERVER_ID, newestVersion, resolveComputerUseServer, withComputerUse } from "../src/computer-use";

const HOME = "/Users/tester";
const CODEX = `${HOME}/.codex`;
const CLIENT = `${CODEX}/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient`;
const CACHE = `${CODEX}/plugins/cache/openai-bundled/computer-use`;

const probe = (overrides: Partial<Parameters<typeof resolveComputerUseServer>[0]> = {}) => ({
  env: {},
  home: HOME,
  platform: "darwin" as const,
  exists: (candidate: string) => candidate === CLIENT || candidate === `${CACHE}/1.0.1000919/bin/computer-use-client-launcher`,
  listVersions: () => ["1.0.1000919"],
  now: () => 1_000,
  ...overrides,
});

describe("resolveComputerUseServer", () => {
  test("a full install resolves to a stdio server pinned to the same CODEX_HOME", () => {
    const server = resolveComputerUseServer(probe());
    expect(server?.id).toBe("mac");
    expect(server?.enabled).toBe(true);
    expect(server?.spec).toEqual({
      transport: "stdio",
      command: `${CACHE}/1.0.1000919/bin/computer-use-client-launcher`,
      args: ["mcp"],
      env: { CODEX_HOME: CODEX },
    });
  });

  test("CODEX_HOME overrides the default, the way the launcher itself reads it", () => {
    const other = "/opt/codex";
    const server = resolveComputerUseServer(
      probe({
        env: { CODEX_HOME: other },
        exists: (candidate: string) =>
          candidate.startsWith(other) && (candidate.endsWith("SkyComputerUseClient") || candidate.endsWith("computer-use-client-launcher")),
      }),
    );
    expect(server?.spec.transport === "stdio" && server.spec.env?.CODEX_HOME).toBe(other);
  });

  test("no Sky client, no server — a launcher without its client dies on spawn", () => {
    expect(resolveComputerUseServer(probe({ exists: (c: string) => c.includes("launcher") }))).toBeUndefined();
  });

  test("no cached launcher, no server", () => {
    expect(resolveComputerUseServer(probe({ listVersions: () => [] }))).toBeUndefined();
  });

  test("the kill switch and the platform guard both answer absent", () => {
    expect(resolveComputerUseServer(probe({ env: { TELAR_COMPUTER_USE: "0" } }))).toBeUndefined();
    expect(resolveComputerUseServer(probe({ platform: "linux" }))).toBeUndefined();
  });
});

describe("newestVersion", () => {
  test("numeric per segment, not lexicographic — 1.0.10 beats 1.0.9", () => {
    expect(newestVersion(["1.0.9", "1.0.10"])).toBe("1.0.10");
    expect(newestVersion(["1.0.1000919", "1.0.999999"])).toBe("1.0.1000919");
    expect(newestVersion([])).toBeUndefined();
  });
});

describe("withComputerUse", () => {
  const resolved = resolveComputerUseServer(probe())!;
  const user = (id: string, enabled = true): McpServer => ({
    id,
    label: id,
    enabled,
    spec: { transport: "stdio", command: "/bin/echo" },
    createdAt: 0,
    updatedAt: 0,
  });

  test("a Claude claim gains the server; a Codex claim is left alone", () => {
    expect(withComputerUse([], [], "claude", resolved).map((s) => s.id)).toEqual([COMPUTER_USE_SERVER_ID]);
    // Codex loads the plugin natively — a second registration is the same
    // tools twice under two names.
    expect(withComputerUse([], [], "codex", resolved)).toEqual([]);
  });

  test("an uninstalled machine injects nothing, silently", () => {
    expect(withComputerUse([user("linear")], [user("linear")], "claude", undefined).map((s) => s.id)).toEqual(["linear"]);
  });

  test("a user's own entry wins — including a DISABLED one", () => {
    const theirs = user(COMPUTER_USE_SERVER_ID);
    expect(withComputerUse([theirs], [theirs], "claude", resolved)).toEqual([theirs]);
    // Disabled is filtered out of the enabled list before the fold, so the
    // check reads the unfiltered one: switching the server off must not
    // resurrect the built-in.
    const disabled = user(COMPUTER_USE_SERVER_ID, false);
    expect(withComputerUse([], [disabled], "claude", resolved)).toEqual([]);
  });
});
