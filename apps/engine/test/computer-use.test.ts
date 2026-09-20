/**
 * Telar's own computer use — cua-driver preferred, Codex's Sky as a fallback.
 *
 * Pinned against the REAL layouts on this machine: cua-driver installs a
 * symlink in ~/.local/bin pointing at CuaDriver.app; Sky's launcher lives in
 * the Codex plugin cache under a version directory and dies without its client.
 */
import { describe, expect, test } from "bun:test";
import type { McpServer } from "@telar/engine-client";
import {
  claimHasComputerUse,
  classifyProbeError,
  COMPUTER_USE_SERVER_ID,
  newestVersion,
  resolveComputerUse,
  resolveComputerUseServer,
  withComputerUse,
  type ResolvedComputerUse,
} from "../src/computer-use";

const HOME = "/Users/tester";
const CODEX = `${HOME}/.codex`;
const CUA_SYMLINK = `${HOME}/.local/bin/cua-driver`;
const SKY_CLIENT = `${CODEX}/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient`;
const SKY_CACHE = `${CODEX}/plugins/cache/openai-bundled/computer-use`;
const SKY_LAUNCHER = `${SKY_CACHE}/1.0.1000919/bin/computer-use-client-launcher`;

/** A machine with BOTH backends installed — the interesting case, because cua
 *  must win. */
const both = (overrides: Partial<Parameters<typeof resolveComputerUse>[0]> = {}) => ({
  env: {},
  home: HOME,
  platform: "darwin" as const,
  exists: (candidate: string) => candidate === CUA_SYMLINK || candidate === SKY_CLIENT || candidate === SKY_LAUNCHER,
  listVersions: () => ["1.0.1000919"],
  now: () => 1_000,
  ...overrides,
});

/** Sky only — cua absent. */
const skyOnly = (overrides: Partial<Parameters<typeof resolveComputerUse>[0]> = {}) =>
  both({ exists: (candidate: string) => candidate === SKY_CLIENT || candidate === SKY_LAUNCHER, ...overrides });

/** cua only. */
const cuaOnly = (overrides: Partial<Parameters<typeof resolveComputerUse>[0]> = {}) =>
  both({ exists: (candidate: string) => candidate === CUA_SYMLINK, ...overrides });

describe("resolveComputerUse — backend preference", () => {
  test("cua-driver wins when both are installed, as a plain stdio `mcp` server", () => {
    const resolved = resolveComputerUse(both());
    expect(resolved?.backend).toBe("cua");
    expect(resolved?.server.id).toBe("mac");
    expect(resolved?.server.spec).toEqual({ transport: "stdio", command: CUA_SYMLINK, args: ["mcp"] });
  });

  test("Sky is the fallback when cua is absent, pinned to CODEX_HOME", () => {
    const resolved = resolveComputerUse(skyOnly());
    expect(resolved?.backend).toBe("sky");
    expect(resolved?.server.spec).toEqual({ transport: "stdio", command: SKY_LAUNCHER, args: ["mcp"], env: { CODEX_HOME: CODEX } });
  });

  test("CUA_DRIVER_BIN overrides the search — a bundled app can point here", () => {
    const bundled = "/Applications/Telar.app/Contents/Resources/cua-driver";
    const resolved = resolveComputerUse(both({ env: { CUA_DRIVER_BIN: bundled }, exists: (c: string) => c === bundled }));
    expect(resolved?.backend).toBe("cua");
    expect(resolved?.server.spec.transport === "stdio" && resolved.server.spec.command).toBe(bundled);
  });

  test("neither backend, nothing — kill switch and platform guard too", () => {
    expect(resolveComputerUse(both({ exists: () => false }))).toBeUndefined();
    expect(resolveComputerUse(both({ env: { TELAR_COMPUTER_USE: "0" } }))).toBeUndefined();
    expect(resolveComputerUse(both({ platform: "linux" }))).toBeUndefined();
  });

  test("a Sky launcher without its client is not resolved — it would die on spawn", () => {
    expect(resolveComputerUse(both({ exists: (c: string) => c === SKY_LAUNCHER }))).toBeUndefined();
  });

  test("resolveComputerUseServer is the server half, for the claim", () => {
    expect(resolveComputerUseServer(cuaOnly())?.id).toBe("mac");
    expect(resolveComputerUseServer(both({ exists: () => false }))).toBeUndefined();
  });
});

describe("newestVersion", () => {
  test("numeric per segment, not lexicographic — 1.0.10 beats 1.0.9", () => {
    expect(newestVersion(["1.0.9", "1.0.10"])).toBe("1.0.10");
    expect(newestVersion(["1.0.1000919", "1.0.999999"])).toBe("1.0.1000919");
    expect(newestVersion([])).toBeUndefined();
  });
});

describe("classifyProbeError", () => {
  test("cua's structured words and Sky's macOS codes both map to a fix", () => {
    // cua answers in prose.
    expect(classifyProbeError("permissions_pending: macOS Accessibility or Screen Recording permission is still pending")).toBe("denied");
    expect(classifyProbeError("Screen Recording permission not granted")).toBe("denied");
    // Sky answers in codes: -1743 is a denial; -1712/-609 mean its host is down.
    expect(classifyProbeError("Computer Use server error -1743 (unknown error)")).toBe("denied");
    expect(classifyProbeError("error -1712 timed out")).toBe("host-not-running");
    expect(classifyProbeError("connection invalid (-609)")).toBe("host-not-running");
    expect(classifyProbeError("something else entirely")).toBe("unknown");
    // A code must be a code, not a substring of a longer number.
    expect(classifyProbeError("id 17435 failed")).toBe("unknown");
  });
});

describe("withComputerUse — who gets it", () => {
  const cua = resolveComputerUse(cuaOnly())!;
  const sky = resolveComputerUse(skyOnly())!;
  const user = (id: string, enabled = true): McpServer => ({
    id,
    label: id,
    enabled,
    spec: { transport: "stdio", command: "/bin/echo" },
    createdAt: 0,
    updatedAt: 0,
  });

  test("both backends go to every provider Telar drives", () => {
    for (const resolved of [cua, sky]) {
      expect(withComputerUse([], [], "claude", resolved).map((s) => s.id)).toEqual([COMPUTER_USE_SERVER_ID]);
      expect(withComputerUse([], [], "opencode", resolved).map((s) => s.id)).toEqual([COMPUTER_USE_SERVER_ID]);
    }
  });

  test("Codex gets it too, whatever the backend (#521)", () => {
    // #368 withheld it, reasoning that Codex ships its own provider and a second
    // desktop under a second name is the thing to avoid. The second desktop was
    // never the risk the withholding removed — the driver already switches the
    // native feature off whenever a `mac` server is in the claim — and what the
    // withholding did remove was the only desktop a Codex session had.
    expect(withComputerUse([], [], "codex", cua).map((s) => s.id)).toEqual([COMPUTER_USE_SERVER_ID]);
    expect(withComputerUse([], [], "codex", sky).map((s) => s.id)).toEqual([COMPUTER_USE_SERVER_ID]);
  });

  test("an uninstalled machine injects nothing, silently", () => {
    expect(withComputerUse([user("linear")], [user("linear")], "claude", undefined).map((s) => s.id)).toEqual(["linear"]);
  });

  test("a user's own entry wins — including a DISABLED one", () => {
    const theirs = user(COMPUTER_USE_SERVER_ID);
    expect(withComputerUse([theirs], [theirs], "claude", cua)).toEqual([theirs]);
    // Disabled is filtered out of the enabled list before the fold, so the
    // check reads the unfiltered one: switching the server off must not
    // resurrect the built-in.
    const disabled = user(COMPUTER_USE_SERVER_ID, false);
    expect(withComputerUse([], [disabled], "opencode", cua)).toEqual([]);
  });
});

describe("claimHasComputerUse — the Codex native-disable signal", () => {
  const mac: McpServer = { id: COMPUTER_USE_SERVER_ID, label: "mac", enabled: true, spec: { transport: "stdio", command: "cua-driver", args: ["mcp"] }, createdAt: 0, updatedAt: 0 };
  test("true only when Telar's own server is present", () => {
    expect(claimHasComputerUse([mac])).toBe(true);
    expect(claimHasComputerUse([{ ...mac, id: "linear" }])).toBe(false);
    expect(claimHasComputerUse([])).toBe(false);
    expect(claimHasComputerUse(undefined)).toBe(false);
  });
});

// A `ResolvedComputerUse` is `{ server, backend }` — pinned so a shape change
// is caught here rather than at the state.ts injection site.
const _shape: ResolvedComputerUse | undefined = resolveComputerUse(cuaOnly());
void _shape;
