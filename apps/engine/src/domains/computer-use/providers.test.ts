import { describe, expect, test } from "bun:test";
import { COMPUTER_USE_DRIVERS, driverTakesComputerUse, type McpServer, type ProviderDriverKind } from "@telar/engine-client";
import { codexMcpServers } from "../../drivers/codex";
import { claimHasComputerUse, COMPUTER_USE_SERVER_ID, createComputerUseGate, resolveComputerUse, withComputerUse, type ComputerUseProbe } from "./gate";
import { mcpConfiguration } from "../../drivers/opencode";
import type { DriverRun } from "../../drivers";

const DRIVERS: readonly ProviderDriverKind[] = ["claude", "codex", "opencode"];

const HOME = "/Users/tester";
const CUA = `${HOME}/.local/bin/cua-driver`;
const probe: ComputerUseProbe = { env: {}, home: HOME, platform: "darwin", exists: (candidate) => candidate === CUA, now: () => 0 };
const cua = resolveComputerUse(probe)!;

const linear: McpServer = {
  id: "linear",
  label: "Linear",
  enabled: true,
  spec: { transport: "http", url: "https://mcp.linear.app/mcp" },
  createdAt: 0,
  updatedAt: 0,
};

const claimFor = (driver: ProviderDriverKind, resolved = cua) => withComputerUse([linear], [linear], driver, resolved);

describe("the computer-use tool set, per provider", () => {
  test("every provider is handed it, Codex included", () => {
    expect(Object.fromEntries(DRIVERS.map((driver) => [driver, claimFor(driver).map((server) => server.id)]))).toEqual({
      claude: ["linear", COMPUTER_USE_SERVER_ID],
      codex: ["linear", COMPUTER_USE_SERVER_ID],
      opencode: ["linear", COMPUTER_USE_SERVER_ID],
    });
  });

  test("the claim fold and the published list are the same fact", () => {
    for (const driver of DRIVERS) {
      expect(claimFor(driver).some((server) => server.id === COMPUTER_USE_SERVER_ID)).toBe(driverTakesComputerUse(driver));
    }
    expect([...COMPUTER_USE_DRIVERS].sort()).toEqual(["claude", "codex", "opencode"]);
  });
});

describe("Codex carries it without ever seeing two desktops", () => {
  const overlayOf = (claim: McpServer[]) => ({
    servers: codexMcpServers(claim),
    ...(claimHasComputerUse(claim) ? { features: { computer_use: false } } : {}),
  });
  const overlay = (driver: ProviderDriverKind, resolved = cua) => overlayOf(claimFor(driver, resolved));

  test("the `mac` server reaches Codex's config and turns the native feature off", () => {
    expect(overlay("codex")).toEqual({
      servers: {
        linear: { url: "https://mcp.linear.app/mcp" },
        [COMPUTER_USE_SERVER_ID]: { command: CUA, args: ["mcp"] },
      },
      features: { computer_use: false },
    });
  });

  const gated = async (permission: "granted" | "denied" | "unauthenticated" | "unknown") => {
    const gate = createComputerUseGate(probe, { status: async () => ({ installed: true, backend: "cua", hostRunning: true, permission }), hostRunning: async () => true });
    await gate.measure();
    return overlayOf(withComputerUse([linear], [linear], "codex", gate.forClaim()));
  };

  test("a gate that has not measured `granted` leaves the native feature alone", async () => {
    for (const permission of ["denied", "unauthenticated", "unknown"] as const) {
      expect(await gated(permission)).toEqual({ servers: { linear: { url: "https://mcp.linear.app/mcp" } } });
    }
  });

  test("a granted gate hands Codex the same overlay as a resolved driver", async () => {
    expect(await gated("granted")).toEqual(overlay("codex"));
  });

  test("no computer-use backend on the machine leaves the native feature alone", () => {
    const claim = withComputerUse([linear], [linear], "codex", undefined);
    expect(claim.map((server) => server.id)).toEqual(["linear"]);
    expect(claimHasComputerUse(claim)).toBe(false);
  });
});

describe("OpenCode carries it as an ordinary local server", () => {
  const run = (driver: ProviderDriverKind): DriverRun => ({
    sessionId: "session_one",
    cwd: "/tmp/project",
    prompt: "hello",
    signal: new AbortController().signal,
    onObservations: async () => {},
    mcpServers: claimFor(driver),
  });

  test("the command and its args survive into OpenCode's own config", () => {
    const config = mcpConfiguration(run("opencode"));
    expect(config[COMPUTER_USE_SERVER_ID]).toEqual({ type: "local", command: [CUA, "mcp"], environment: undefined });
    expect(config.linear).toEqual({ type: "remote", url: "https://mcp.linear.app/mcp", headers: undefined, oauth: false });
  });
});
