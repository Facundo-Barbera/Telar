/**
 * WHAT EACH PROVIDER'S SESSION ACTUALLY RECEIVES — one table, #368.
 *
 * The applicability of computer use was three separate opinions that had drifted
 * apart: the claim fold gave it to Claude, Codex and (by accident of a union
 * widened when the adapter landed) OpenCode; the file's own header said Claude
 * and Codex; the settings pane said nothing at all, which every reader took as
 * "all of them". The answer is Claude and OpenCode — the providers that arrive
 * without a desktop of their own — and this is the fixture that states it once.
 *
 * IT READS THE REAL CODE PATHS, not a restatement of them: the claim is folded
 * by `withComputerUse`, and OpenCode's half is the driver's own
 * `mcpConfiguration`. A fixture that built its own idea of either would pass
 * while the product was broken, which is exactly what happened here.
 */
import { describe, expect, test } from "bun:test";
import { COMPUTER_USE_DRIVERS, driverTakesComputerUse, type McpServer, type ProviderDriverKind } from "@telar/engine-client";
import { COMPUTER_USE_SERVER_ID, resolveComputerUse, withComputerUse } from "../src/computer-use";
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
  test("Claude and OpenCode are handed it; Codex is not", () => {
    expect(Object.fromEntries(DRIVERS.map((driver) => [driver, claimFor(driver).map((server) => server.id)]))).toEqual({
      claude: ["linear", COMPUTER_USE_SERVER_ID],
      opencode: ["linear", COMPUTER_USE_SERVER_ID],
      // Codex ships its own computer-use provider. Telar withholds rather than
      // adds a second desktop under a second name.
      codex: ["linear"],
    });
  });

  test("the backend does not change who gets it — Sky follows cua", () => {
    // Sky used to be Claude-only, on the reasoning that it is native on Codex.
    // Now that Codex is withheld on its own account that clause is gone, and
    // OpenCode gets whichever backend the machine actually has.
    expect(Object.fromEntries(DRIVERS.map((driver) => [driver, claimFor(driver, sky).map((server) => server.id)]))).toEqual({
      claude: ["linear", COMPUTER_USE_SERVER_ID],
      opencode: ["linear", COMPUTER_USE_SERVER_ID],
      codex: ["linear"],
    });
  });

  test("the claim fold and the published list are the same fact", () => {
    // The settings pane badges its Computer use row from `COMPUTER_USE_DRIVERS`.
    // If these two could disagree the pane would promise a provider the claim
    // withholds it from, which is the drift #368 was filed about.
    for (const driver of DRIVERS) {
      expect(claimFor(driver).some((server) => server.id === COMPUTER_USE_SERVER_ID)).toBe(driverTakesComputerUse(driver));
    }
    expect([...COMPUTER_USE_DRIVERS].sort()).toEqual(["claude", "opencode"]);
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
