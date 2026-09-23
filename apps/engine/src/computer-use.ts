/**
 * COMPUTER USE FOR TELAR SESSIONS — Telar's own engine, not the provider's.
 *
 * The tool surface (list_apps, a screenshot + accessibility tree, click, type,
 * scroll, drag, keys) is served by an MCP server injected into a CLAIM, so every
 * provider Telar supplies reaches the SAME desktop through the SAME approval
 * pipeline runtime modes already gate. One backend supplies it: cua-driver
 * (github.com/trycua/cua, MIT), the open-source computer-use driver. A stdio MCP
 * server that auto-launches its own permission-holding daemon (CuaDriver.app,
 * `com.trycua.driver`), so the macOS grants belong to an app Telar can bundle
 * rather than to a proprietary one.
 *
 * EVERY PROVIDER TELAR DRIVES GETS IT, Codex included since #521 — see
 * `COMPUTER_USE_DRIVERS` in the protocol package for why it did not, and why
 * withholding turned out to leave a Codex session with no desktop at all.
 *
 * ══ INDEPENDENCE IS THE PRIME RULE (the Lintel precedent) ══
 *
 * Driver absent, wrong platform, kill switch set — the resolver answers
 * undefined and no server is injected, silently. Nothing retries, nothing logs
 * an error a person must dismiss, and a session behaves exactly as it did
 * before this existed. `TELAR_COMPUTER_USE=0` is the kill switch.
 *
 * ══ NO WORKING COMPUTER USE, NO TOOLS ══
 *
 * Resolving on disk is not working. A driver installed but not yet granted
 * used to be injected anyway, so every session was handed a dozen tools that
 * could only answer `permissions_pending` — and in a Codex claim the injection
 * also switched Codex's native computer use off in exchange. So the claim is
 * gated on a MEASUREMENT (`createComputerUseGate`): the `mac` server goes in only
 * while the last real probe answered `granted`. The probe is never run per claim
 * (a subprocess round trip in front of every turn, and against a daemon that is
 * not up it would raise macOS prompts); it runs when the settings pane asks,
 * and at daemon start only when the driver's daemon is already running.
 *
 * ══ WHY CODEX'S SKY CLIENT IS GONE ══
 *
 * It used to be the fallback. Sky (`SkyComputerUseService`) compares the
 * sender's PARENT and RESPONSIBLE process Team ID against OpenAI's `2DC432GLL2`
 * and answers `-10000: Sender process is not authenticated` to everyone else
 * (manaflow-ai/codex-cua README; openai/codex#19544 — the Homebrew `codex` fails
 * even `list_apps`, only the Codex.app-bundled one works). Telar, Claude Code,
 * OpenCode and a Homebrew codex are never OpenAI-signed. The only accepted
 * parent is the Codex.app-bundled `codex`, whose native computer use already
 * works — and Telar's injection would only have switched that off in favour of
 * the same engine. Sky could never give a Telar session a desktop.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  driverTakesComputerUse,
  type ComputerUseBackend,
  type ComputerUsePermission,
  type ComputerUseStatus,
  type McpServer,
  type ProviderDriverKind,
} from "@telar/engine-client";

/**
 * The id is the provider-facing server name: tools arrive as `mcp__mac__click`.
 *
 * NOT `computer-use`, though that is the honest name: Claude Code RESERVES it
 * ("...is a reserved MCP server name and was not loaded" — measured with
 * --debug-to-stderr, and the refusal is otherwise silent: the server simply
 * never connects). A USER-registered server with this id wins — see
 * `withComputerUse`. The presence of a server with THIS id in a Codex claim is
 * also the signal that turns off Codex's native computer use, and it does not
 * care who put it there: Telar's own injection and a `mac` server the user
 * registered by hand both reach it, because two desktops under two names is the
 * thing worth avoiding either way.
 */
export const COMPUTER_USE_SERVER_ID = "mac";

export type { ComputerUseBackend };
export type ResolvedComputerUse = { server: McpServer; backend: ComputerUseBackend };

/* ------------------------------------------------------------------ *
 * cua-driver.
 * ------------------------------------------------------------------ */

/** Where the installer puts things: a symlink in ~/.local/bin, and the app it
 *  points at. Either being executable is enough to run `cua-driver mcp`, which
 *  proxies through (and auto-launches) the app's daemon. */
const CUA_APP_BINARY = "/Applications/CuaDriver.app/Contents/MacOS/cua-driver";
const cuaSymlink = (home: string) => path.join(home, ".local", "bin", "cua-driver");

function resolveCua(env: Record<string, string | undefined>, home: string, exists: (candidate: string) => boolean, at: number): ResolvedComputerUse | undefined {
  const override = env.CUA_DRIVER_BIN?.trim();
  const command = [override, cuaSymlink(home), CUA_APP_BINARY].find((candidate): candidate is string => Boolean(candidate) && exists(candidate!));
  if (!command) return undefined;
  return {
    backend: "cua",
    server: {
      id: COMPUTER_USE_SERVER_ID,
      label: "Computer Use (Mac)",
      enabled: true,
      // `mcp` is a stdio MCP server that auto-launches CuaDriver.app's daemon
      // and proxies through it — so nothing here needs a separate host wake.
      spec: { transport: "stdio", command, args: ["mcp"] },
      createdAt: at,
      updatedAt: at,
    },
  };
}

export type ComputerUseProbe = {
  env?: Record<string, string | undefined>;
  home?: string;
  platform?: NodeJS.Platform;
  /** Injected for tests; the real one is fs.existsSync. */
  exists?: (candidate: string) => boolean;
  now?: () => number;
};

/**
 * The desktop engine for this machine, with its backend — or undefined, which
 * means computer use does not exist here and nothing anywhere says so. Resolving
 * is only "installed"; whether a claim gets it is the gate's question.
 */
export function resolveComputerUse(probe: ComputerUseProbe = {}): ResolvedComputerUse | undefined {
  const env = probe.env ?? process.env;
  if (env.TELAR_COMPUTER_USE === "0") return undefined;
  // cua drives macOS accessibility; on anything else there is nothing.
  if ((probe.platform ?? process.platform) !== "darwin") return undefined;

  const exists = probe.exists ?? fs.existsSync;
  const home = probe.home ?? os.homedir();
  const at = (probe.now ?? Date.now)();
  return resolveCua(env, home, exists, at);
}

/** Back-compat: the claim only needs the server. The daemon uses the richer
 *  `resolveComputerUse` so it also knows the backend. */
export function resolveComputerUseServer(probe: ComputerUseProbe = {}): McpServer | undefined {
  return resolveComputerUse(probe)?.server;
}

/**
 * cua's own native granting flow: `cua-driver permissions grant` launches
 * CuaDriver.app through LaunchServices so the macOS dialogs attribute to the
 * app, requests Accessibility + Screen Recording, and verifies live capture.
 * Detached so the dialogs are the app's, not ours. A no-op for an uninstalled
 * machine. A fresh grant does not reach sessions until the next probe — the
 * pane's Test access — records it.
 */
export function grantComputerUseAccess(probe: ComputerUseProbe = {}): { started: boolean; backend?: ComputerUseBackend } {
  const resolved = resolveComputerUse(probe);
  if (!resolved || resolved.server.spec.transport !== "stdio") return { started: false };
  try {
    spawn(resolved.server.spec.command, ["permissions", "grant"], { stdio: "ignore", detached: true }).unref();
    return { started: true, backend: "cua" };
  } catch {
    return { started: false, backend: "cua" };
  }
}

/* ------------------------------------------------------------------ *
 * The permission probe — what the settings page reports.
 * ------------------------------------------------------------------ */

/**
 * The backend's own words about why a call failed, mapped to the states a
 * reader can act on. cua answers in structured prose (`permissions_pending`,
 * "permission … not granted") → `denied`, a grant the person can flip.
 * `-10000` / "Sender process is not authenticated" is a backend refusing the
 * CALLER — Sky's answer to anything not OpenAI-signed — which no grant fixes,
 * so it gets its own state. Codes are word-bounded so `-100001` is not `-10000`.
 * Sky's old Apple-event codes (-1743, -1712, -609) are no longer read: nothing
 * Telar runs can produce them.
 */
export function classifyProbeError(text: string): ComputerUsePermission {
  const lower = text.toLowerCase();
  if (/not authenticated/.test(lower) || /-10000\b/.test(text)) return "unauthenticated";
  if (/permission[s]?[_\s-]*(pending|denied)/.test(lower) || /(accessibility|screen recording)[\s\S]*(not granted|pending|denied)/.test(lower)) {
    return "denied";
  }
  return "unknown";
}

/** One JSON-RPC exchange: initialize, then a REAL read-only `list_apps` — the
 *  honest way to ask "is this permitted". A running daemon with a pending grant
 *  answers immediately with a structured error; a daemon this call had to
 *  launch may put its permissions panel on screen first, which is why the wait
 *  is generous. */
function probeListApps(spec: { command: string; args?: string[]; env?: Record<string, string> }, timeoutMs: number): Promise<{ permission: ComputerUsePermission; message?: string }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(spec.command, spec.args ?? [], { env: { ...process.env, ...(spec.env ?? {}) }, stdio: ["pipe", "pipe", "ignore"] });
    } catch (error) {
      resolve({ permission: "unknown", message: error instanceof Error ? error.message : "could not start the client" });
      return;
    }
    let settled = false;
    const finish = (outcome: { permission: ComputerUsePermission; message?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(outcome);
    };
    const timer = setTimeout(
      () => finish({ permission: "unknown", message: "No answer — a permission dialog may be on screen. Decide it, then test again." }),
      timeoutMs,
    );
    child.once("error", (error) => finish({ permission: "unknown", message: error.message }));

    let buffer = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let cut;
      while ((cut = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 1);
        if (!line.trim()) continue;
        let msg: { id?: number; result?: { content?: { type?: string; text?: string }[]; isError?: boolean }; error?: { message?: string } };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1) {
          child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
          child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_apps", arguments: {} } }) + "\n");
        } else if (msg.id === 2) {
          if (msg.error) {
            finish({ permission: classifyProbeError(msg.error.message ?? ""), message: (msg.error.message ?? "").slice(0, 400) });
            return;
          }
          const text = (msg.result?.content ?? []).map((part) => part.text ?? "").join(" ");
          finish(msg.result?.isError ? { permission: classifyProbeError(text), message: text.slice(0, 400) } : { permission: "granted" });
          return;
        }
      }
    });
    child.stdin?.write(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "telar", version: "2.0" } } }) + "\n",
    );
  });
}

/** The daemon's process, as `pgrep -f` sees it. */
const CUA_DAEMON_PATTERN = "CuaDriver";

function running(pattern: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn("pgrep", ["-f", pattern], { stdio: "ignore" });
      child.once("exit", (code) => resolve(code === 0));
      child.once("error", () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}

/**
 * What the settings page shows — and what the claim gate keeps — measured
 * rather than remembered: whether the driver is installed, whether its daemon
 * is up, and the grant from one real read-only call.
 *
 * `hostRunning` is measured AFTER the probe: `cua-driver mcp` auto-launches the
 * daemon, so asking first reported "not running" on a machine that was granted
 * and working by the time the answer came back.
 */
export async function computerUseStatus(probe: ComputerUseProbe = {}, timeoutMs = 30_000): Promise<ComputerUseStatus> {
  const resolved = resolveComputerUse(probe);
  if (!resolved || resolved.server.spec.transport !== "stdio") return { installed: false, hostRunning: false };
  const spec = resolved.server.spec;
  const outcome = await probeListApps({ command: spec.command, ...(spec.args ? { args: spec.args } : {}), ...(spec.env ? { env: spec.env } : {}) }, timeoutMs);
  const hostRunning = await running(CUA_DAEMON_PATTERN);
  return { installed: true, backend: resolved.backend, hostRunning, permission: outcome.permission, ...(outcome.message ? { message: outcome.message } : {}) };
}

/* ------------------------------------------------------------------ *
 * The claim gate — only a measured `granted` puts the tools in a claim.
 * ------------------------------------------------------------------ */

export type ComputerUseMeasurement = { status: ComputerUseStatus; measuredAt: number };
export type ComputerUseGate = {
  /** The last measurement, if any. */
  last(): ComputerUseMeasurement | undefined;
  /** One real probe; concurrent callers share the in-flight one. Stores the result with the time. */
  measure(): Promise<ComputerUseStatus>;
  /** What the daemon hands the store's `computerUse` option: the resolved cua
   *  server ONLY when the last probe answered `granted`, else undefined.
   *  Re-resolves the binary so an uninstall applies at the next claim. */
  forClaim(): ResolvedComputerUse | undefined;
  /** The daemon-start probe: measures only when the driver resolves AND its
   *  daemon is already running; otherwise spawns nothing and returns undefined. */
  measureIfHostRunning(): Promise<ComputerUseStatus | undefined>;
};

/**
 * The daemon's memory of whether computer use WORKS.
 *
 * NEVER PROBED PER CLAIM. A claim is on the path of every turn; a subprocess
 * round trip there is latency on every message, and against a stopped daemon
 * the probe launches it — which is exactly when cua-driver draws its own
 * permissions panel and raises the TCC prompts (`permissions/gate.rs`,
 * `also_raise_prompts`). A turn must never put a dialog on the screen. So a
 * claim reads the last answer, and the answer is refreshed where a person is
 * looking: the settings pane's GET (which also runs after Grant / Test access).
 *
 * AT DAEMON START, ONLY AGAINST A RUNNING DAEMON. Once CuaDriver.app is up, a
 * call with grants missing is refused from a static in-memory gate
 * (`permission_gate_pending_response` in `serve.rs`: `permissions_pending`) — no
 * prompt, no window. That is the only start-time probe that cannot draw on the
 * screen, so a machine that already works has the tools from its first turn
 * without anyone opening the pane, and a machine that does not stays silent.
 *
 * A USER-REGISTERED `mac` server still wins: `withComputerUse` checks the
 * user's list before it looks at what this answers, gate or no gate.
 */
export function createComputerUseGate(
  probe: ComputerUseProbe = {},
  deps: { status?: (probe: ComputerUseProbe) => Promise<ComputerUseStatus>; hostRunning?: () => Promise<boolean>; now?: () => number } = {},
): ComputerUseGate {
  const status = deps.status ?? ((p: ComputerUseProbe) => computerUseStatus(p));
  const hostRunning = deps.hostRunning ?? (() => running(CUA_DAEMON_PATTERN));
  const now = deps.now ?? Date.now;
  let last: ComputerUseMeasurement | undefined;
  let inFlight: Promise<ComputerUseStatus> | undefined;

  const measure = (): Promise<ComputerUseStatus> =>
    (inFlight ??= status(probe)
      .then((result) => {
        last = { status: result, measuredAt: now() };
        return result;
      })
      .finally(() => {
        inFlight = undefined;
      }));

  return {
    last: () => last,
    measure,
    forClaim: () => (last?.status.installed && last.status.permission === "granted" ? resolveComputerUse(probe) : undefined),
    async measureIfHostRunning() {
      try {
        if (!resolveComputerUse(probe)) return undefined;
        if (!(await hostRunning())) return undefined;
        return await measure();
      } catch {
        // Fire-and-forget at start: a failed probe leaves the gate closed,
        // which is the same as never having asked.
        return undefined;
      }
    },
  };
}

/* ------------------------------------------------------------------ *
 * The claim-time fold.
 * ------------------------------------------------------------------ */

/**
 * Which servers a turn actually gets.
 *
 * WHO. The desktop goes to every provider Telar drives, because the question a
 * claim has to answer is which desktop a TELAR session reaches, and the answer
 * is this one for all of them. The list lives in `COMPUTER_USE_DRIVERS` so the
 * settings pane reads the same fact.
 *
 * ONLY WHAT WORKS. `resolved` comes from the daemon's gate, which answers
 * undefined unless the last probe answered `granted` — so an installed but
 * ungranted driver injects nothing, and a Codex claim keeps its native feature.
 *
 * THE USER'S ENTRY WINS. A registered server with this id — pointed elsewhere,
 * or disabled — is a decision injection must not overrule. `state.ts` filters
 * disabled servers out BEFORE this fold, so the check reads the unfiltered list.
 */
export function withComputerUse(
  servers: readonly McpServer[],
  allServers: readonly McpServer[],
  driver: ProviderDriverKind,
  resolved: ResolvedComputerUse | undefined,
): McpServer[] {
  if (!resolved) return [...servers];
  if (!driverTakesComputerUse(driver)) return [...servers];
  if (allServers.some((server) => server.id === COMPUTER_USE_SERVER_ID)) return [...servers];
  return [...servers, resolved.server];
}

/** Whether a claim's servers include Telar's own computer-use server — the
 *  signal the Codex driver reads to turn OFF Codex's native `computer_use`, so
 *  the model is not handed two desktops. Downstream of the gate: a claim the
 *  gate kept `mac` out of leaves Codex's native computer use untouched. */
export function claimHasComputerUse(servers: readonly McpServer[] | undefined): boolean {
  return Boolean(servers?.some((server) => server.id === COMPUTER_USE_SERVER_ID));
}
