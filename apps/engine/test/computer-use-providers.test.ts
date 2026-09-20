/**
 * WHAT EACH PROVIDER'S SESSION ACTUALLY RECEIVES — one table, #368.
 *
 * The applicability of computer use was three separate opinions that had drifted
 * apart: the claim fold gave it to Claude, Codex and (by accident of a union
 * widened when the adapter landed) OpenCode; the file's own header said Claude
 * and Codex; the settings pane said nothing at all, which every reader took as
 * "all of them". #368 settled on Claude and OpenCode, on the reasoning that
 * Codex arrives with a desktop of its own; #521 found that a withheld Codex
 * session had no desktop Telar could see, gate or name instead. The answer is
 * all three, and this is the fixture that states it once.
 *
 * IT READS THE REAL CODE PATHS, not a restatement of them: the claim is folded
 * by `withComputerUse`, OpenCode's half is the driver's own `mcpConfiguration`,
 * and Codex's is `codexMcpServers` plus the `features` signal. A fixture that
 * built its own idea of any of them would pass while the product was broken,
 * which is exactly what happened here — twice.
 */
import { describe, expect, test } from "bun:test";
import { COMPUTER_USE_DRIVERS, driverTakesComputerUse, type McpServer, type ProviderDriverKind } from "@telar/engine-client";
import { codexMcpServers } from "../src/codex-driver";
import { claimHasComputerUse, COMPUTER_USE_SERVER_ID, resolveComputerUse, withComputerUse } from "../src/computer-use";
import { mcpConfiguration } from "../src/opencode/driver";
import type { DriverRun } from "../src/provider-contract";

const DRIVERS: readonly ProviderDriverKind[] = ["claude", "codex", "opencode"];

const HOME = "/Users/tester";
const CUA = `${HOME}/.local/bin/cua-driver`;
const CODEX = `${HOME}/.codex`;
const SKY_CLIENT = `${CODEX}/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient`;
const SKY_LAUNCHER = `${CODEX}/plugins/cache/openai-bundled/computer-use/1.0.1/bin/computer-use-client-launcher`;

const machine = (exists: (candidate: string) => boolean) =>
  resolveComputerUse({ env: {}, home: HOME, platform: "darwin", exists, listVersions: () => ["1.0.1"], now: () => 0 });

const cua = machine((candidate) => candidate === CUA)!;
const sky = machine((candidate) => candidate === SKY_CLIENT || candidate === SKY_LAUNCHER)!;

/** A user server every provider gets, so "nothing" is never confused with
 *  "nothing reached this driver at all". */
const linear: McpServer = {
  id: "linear",
  label: "Linear",
  enabled: true,
  spec: { transport: "http", url: "https://mcp.linear.app/mcp" },
  createdAt: 0,
  updatedAt: 0,
};

/** The servers ONE claim hands a session of this provider on this machine —
 *  the same call `state.ts` makes at claim time. */
const claimFor = (driver: ProviderDriverKind, resolved = cua) => withComputerUse([linear], [linear], driver, resolved);

describe("the computer-use tool set, per provider", () => {
  test("every provider is handed it, Codex included", () => {
    // #521. Codex was withheld on the reasoning that it ships its own provider,
    // and the effect was a Codex session with NO desktop — not one of its own.
    expect(Object.fromEntries(DRIVERS.map((driver) => [driver, claimFor(driver).map((server) => server.id)]))).toEqual({
      claude: ["linear", COMPUTER_USE_SERVER_ID],
      codex: ["linear", COMPUTER_USE_SERVER_ID],
      opencode: ["linear", COMPUTER_USE_SERVER_ID],
    });
  });

  test("the backend does not change who gets it — Sky follows cua", () => {
    // Sky used to be Claude-only, on the reasoning that it is native on Codex.
    // Sky reaching a Codex session is the odd-looking pairing that reasoning was
    // guarding: it is Codex's own plugin handed back to Codex. It is still the
    // right answer — same name, same approval gate as every other provider, and
    // the native feature goes off so the model is never offered both.
    expect(Object.fromEntries(DRIVERS.map((driver) => [driver, claimFor(driver, sky).map((server) => server.id)]))).toEqual({
      claude: ["linear", COMPUTER_USE_SERVER_ID],
      codex: ["linear", COMPUTER_USE_SERVER_ID],
      opencode: ["linear", COMPUTER_USE_SERVER_ID],
    });
  });

  test("the claim fold and the published list are the same fact", () => {
    // The settings pane badges its Computer use row from `COMPUTER_USE_DRIVERS`.
    // If these two could disagree the pane would promise a provider the claim
    // withholds it from — #368 — or stay silent about one it supplies, which is
    // the same drift pointing the other way and is what #521 was.
    for (const driver of DRIVERS) {
      expect(claimFor(driver).some((server) => server.id === COMPUTER_USE_SERVER_ID)).toBe(driverTakesComputerUse(driver));
    }
    expect([...COMPUTER_USE_DRIVERS].sort()).toEqual(["claude", "codex", "opencode"]);
  });
});

describe("Codex carries it without ever seeing two desktops", () => {
  /**
   * THE WHOLE REASON THE INJECTION IS SAFE, asserted on the real seam rather
   * than described: the driver serialises the claim into `thread/start`'s
   * `config`, and the same claim drives `features.computer_use`. The injected
   * server and Codex's native feature cannot both be live on one thread.
   *
   * WHAT THIS DOES NOT ASSERT: that `codex app-server` HONOURS the overlay. It
   * proves what Telar sends. Only a live Codex session can prove what Codex
   * does with it — see the PR for #521.
   */
  const overlay = (driver: ProviderDriverKind, resolved = cua) => {
    const claim = claimFor(driver, resolved);
    return {
      servers: codexMcpServers(claim),
      ...(claimHasComputerUse(claim) ? { features: { computer_use: false } } : {}),
    };
  };

  test("the `mac` server reaches Codex's config and turns the native feature off", () => {
    expect(overlay("codex")).toEqual({
      servers: {
        linear: { url: "https://mcp.linear.app/mcp" },
        // `mcp` is cua-driver's stdio proxy subcommand; dropping it registers a
        // server that prints usage and exits.
        [COMPUTER_USE_SERVER_ID]: { command: CUA, args: ["mcp"] },
      },
      features: { computer_use: false },
    });
  });

  test("Sky's CODEX_HOME pin travels into Codex's config too", () => {
    expect(overlay("codex", sky).servers?.[COMPUTER_USE_SERVER_ID]).toEqual({
      command: SKY_LAUNCHER,
      args: ["mcp"],
      env: { CODEX_HOME: CODEX },
    });
  });

  test("no computer-use backend on the machine leaves the native feature alone", () => {
    // The kill switch and the uninstalled machine are the same path, and both
    // must leave a Codex session exactly as it was before any of this existed.
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
    // `mcp` is cua-driver's stdio proxy subcommand: dropping it would register a
    // server that prints usage and exits.
    const config = mcpConfiguration(run("opencode"));
    expect(config[COMPUTER_USE_SERVER_ID]).toEqual({ type: "local", command: [CUA, "mcp"], environment: undefined });
    expect(config.linear).toEqual({ type: "remote", url: "https://mcp.linear.app/mcp", headers: undefined, oauth: false });
  });

  test("Sky's CODEX_HOME pin travels with it", () => {
    // OpenCode OVERLAYS `environment` on the server process's own, so the
    // launcher keeps PATH and HOME — the same spawn the Claude driver gives it.
    const config = mcpConfiguration({ ...run("opencode"), mcpServers: claimFor("opencode", sky) });
    expect(config[COMPUTER_USE_SERVER_ID]).toEqual({
      type: "local",
      command: [SKY_LAUNCHER, "mcp"],
      environment: { CODEX_HOME: CODEX },
    });
  });
});
