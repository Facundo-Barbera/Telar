/**
 * Telar's own computer use — cua-driver, and the gate that decides whether a
 * claim gets it.
 *
 * Pinned against the REAL layout on this machine: cua-driver installs a
 * symlink in ~/.local/bin pointing at CuaDriver.app. NOTHING HERE SPAWNS: the
 * gate is driven with an injected `status`, never the real probe.
 */
import { describe, expect, test } from "bun:test";
import type { ComputerUseStatus, McpServer } from "@telar/engine-client";
import {
  claimHasComputerUse,
  classifyProbeError,
  COMPUTER_USE_SERVER_ID,
  createComputerUseGate,
  resolveComputerUse,
  resolveComputerUseServer,
  withComputerUse,
  type ComputerUseProbe,
  type ResolvedComputerUse,
} from "../src/computer-use";

const HOME = "/Users/tester";
const CUA_SYMLINK = `${HOME}/.local/bin/cua-driver`;

/** cua installed. */
const cuaOnly = (overrides: Partial<ComputerUseProbe> = {}): ComputerUseProbe => ({
  env: {},
  home: HOME,
  platform: "darwin",
  exists: (candidate: string) => candidate === CUA_SYMLINK,
  now: () => 1_000,
  ...overrides,
});

describe("resolveComputerUse", () => {
  test("cua-driver resolves as a plain stdio `mcp` server", () => {
    const resolved = resolveComputerUse(cuaOnly());
    expect(resolved?.backend).toBe("cua");
    expect(resolved?.server.id).toBe("mac");
    expect(resolved?.server.spec).toEqual({ transport: "stdio", command: CUA_SYMLINK, args: ["mcp"] });
  });

  test("CUA_DRIVER_BIN overrides the search — a bundled app can point here", () => {
    const bundled = "/Applications/Telar.app/Contents/Resources/cua-driver";
    const resolved = resolveComputerUse(cuaOnly({ env: { CUA_DRIVER_BIN: bundled }, exists: (c: string) => c === bundled }));
    expect(resolved?.backend).toBe("cua");
    expect(resolved?.server.spec.transport === "stdio" && resolved.server.spec.command).toBe(bundled);
  });

  test("no driver, nothing — kill switch and platform guard too", () => {
    expect(resolveComputerUse(cuaOnly({ exists: () => false }))).toBeUndefined();
    expect(resolveComputerUse(cuaOnly({ env: { TELAR_COMPUTER_USE: "0" } }))).toBeUndefined();
    expect(resolveComputerUse(cuaOnly({ platform: "linux" }))).toBeUndefined();
  });

  test("resolveComputerUseServer is the server half, for the claim", () => {
    expect(resolveComputerUseServer(cuaOnly())?.id).toBe("mac");
    expect(resolveComputerUseServer(cuaOnly({ exists: () => false }))).toBeUndefined();
  });
});

describe("classifyProbeError", () => {
  test("cua's structured words map to a grant the person can flip", () => {
    expect(classifyProbeError("permissions_pending: macOS Accessibility or Screen Recording permission is still pending")).toBe("denied");
    expect(classifyProbeError("Screen Recording permission not granted")).toBe("denied");
    expect(classifyProbeError("something else entirely")).toBe("unknown");
  });

  test("a backend refusing the CALLER is its own state, not a denial", () => {
    expect(classifyProbeError("Computer Use server error -10000: Sender process is not authenticated")).toBe("unauthenticated");
    expect(classifyProbeError("Sender process is not authenticated")).toBe("unauthenticated");
    // A code must be a code, not a prefix of a longer number.
    expect(classifyProbeError("-100001")).toBe("unknown");
  });

  test("Sky's Apple-event codes are no longer read", () => {
    // Sky is gone, so -1743 (errAEEventNotPermitted) is just a number now.
    expect(classifyProbeError("Computer Use server error -1743 (unknown error)")).toBe("unknown");
  });
});

describe("the claim gate — no working computer use, no tools", () => {
  const status = (permission: ComputerUseStatus["permission"]): ComputerUseStatus => ({ installed: true, backend: "cua", hostRunning: true, permission });
  const gateAnswering = (answer: ComputerUseStatus, overrides: { hostRunning?: () => Promise<boolean>; probe?: ComputerUseProbe } = {}) => {
    const calls: ComputerUseProbe[] = [];
    const gate = createComputerUseGate(overrides.probe ?? cuaOnly(), {
      status: async (probe) => {
        calls.push(probe);
        return answer;
      },
      hostRunning: overrides.hostRunning ?? (async () => true),
      now: () => 42,
    });
    return { gate, calls };
  };

  test("before any measurement, a claim gets nothing", () => {
    const { gate } = gateAnswering(status("granted"));
    expect(gate.last()).toBeUndefined();
    expect(gate.forClaim()).toBeUndefined();
  });

  test("a measured `granted` injects the cua server", async () => {
    const { gate } = gateAnswering(status("granted"));
    await gate.measure();
    expect(gate.forClaim()?.backend).toBe("cua");
    expect(withComputerUse([], [], "claude", gate.forClaim()).map((s) => s.id)).toEqual([COMPUTER_USE_SERVER_ID]);
  });

  test("anything but `granted` injects nothing", async () => {
    const answers: ComputerUseStatus[] = [status("denied"), status("unknown"), status("unauthenticated"), { installed: false, hostRunning: false }];
    for (const answer of answers) {
      const { gate } = gateAnswering(answer);
      await gate.measure();
      expect(gate.forClaim()).toBeUndefined();
      expect(withComputerUse([], [], "claude", gate.forClaim())).toEqual([]);
    }
  });

  test("a user's own `mac` still wins over a granted gate — enabled or disabled", async () => {
    const { gate } = gateAnswering(status("granted"));
    await gate.measure();
    const theirs: McpServer = { id: COMPUTER_USE_SERVER_ID, label: "theirs", enabled: true, spec: { transport: "stdio", command: "/bin/echo" }, createdAt: 0, updatedAt: 0 };
    expect(withComputerUse([theirs], [theirs], "claude", gate.forClaim())).toEqual([theirs]);
    expect(withComputerUse([], [{ ...theirs, enabled: false }], "claude", gate.forClaim())).toEqual([]);
  });

  test("concurrent measurements share one probe, stamped with the injected clock", async () => {
    const { gate, calls } = gateAnswering(status("granted"));
    const [first, second] = await Promise.all([gate.measure(), gate.measure()]);
    expect(calls).toHaveLength(1);
    expect(first).toBe(second);
    expect(gate.last()).toEqual({ status: status("granted"), measuredAt: 42 });
  });

  test("the start-time probe never runs against a stopped daemon", async () => {
    const { gate, calls } = gateAnswering(status("granted"), { hostRunning: async () => false });
    expect(await gate.measureIfHostRunning()).toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(gate.forClaim()).toBeUndefined();
  });

  test("the start-time probe measures when the daemon is already up", async () => {
    const { gate, calls } = gateAnswering(status("granted"));
    expect(await gate.measureIfHostRunning()).toEqual(status("granted"));
    expect(calls).toHaveLength(1);
    expect(gate.forClaim()?.backend).toBe("cua");
  });

  test("the start-time probe spawns nothing on a machine without the driver", async () => {
    let asked = false;
    const { gate, calls } = gateAnswering(status("granted"), {
      probe: cuaOnly({ exists: () => false }),
      hostRunning: async () => ((asked = true), true),
    });
    expect(await gate.measureIfHostRunning()).toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(asked).toBe(false);
  });
});

describe("withComputerUse — who gets it", () => {
  const cua = resolveComputerUse(cuaOnly())!;
  const user = (id: string, enabled = true): McpServer => ({
    id,
    label: id,
    enabled,
    spec: { transport: "stdio", command: "/bin/echo" },
    createdAt: 0,
    updatedAt: 0,
  });

  test("it goes to every provider Telar drives", () => {
    expect(withComputerUse([], [], "claude", cua).map((s) => s.id)).toEqual([COMPUTER_USE_SERVER_ID]);
    expect(withComputerUse([], [], "opencode", cua).map((s) => s.id)).toEqual([COMPUTER_USE_SERVER_ID]);
  });

  test("Codex gets it too (#521)", () => {
    // #368 withheld it, reasoning that Codex ships its own provider and a second
    // desktop under a second name is the thing to avoid. The second desktop was
    // never the risk the withholding removed — the driver already switches the
    // native feature off whenever a `mac` server is in the claim — and what the
    // withholding did remove was the only desktop a Codex session had.
    expect(withComputerUse([], [], "codex", cua).map((s) => s.id)).toEqual([COMPUTER_USE_SERVER_ID]);
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
