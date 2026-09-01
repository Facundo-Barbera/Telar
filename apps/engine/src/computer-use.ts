/**
 * COMPUTER USE FOR TELAR SESSIONS — Telar's own engine, not the provider's.
 *
 * The tool surface (list_apps, a screenshot + accessibility tree, click, type,
 * scroll, drag, keys) is served by an MCP server injected into a CLAIM, so both
 * providers reach the SAME desktop through the SAME approval pipeline runtime
 * modes already gate. Two backends can supply it, in preference order:
 *
 *   1. cua-driver (github.com/trycua/cua, MIT) — the open-source computer-use
 *      driver. A stdio MCP server that auto-launches its own permission-holding
 *      daemon (CuaDriver.app, `com.trycua.driver`), so the macOS grants belong
 *      to an app Telar can bundle rather than to a proprietary one. This is what
 *      lets Telar OWN computer use and hand it to Claude AND Codex, and it is
 *      why the Codex driver turns OFF Codex's native `computer_use` when a claim
 *      carries this server (see codex-driver.ts) — otherwise the model would see
 *      two desktops under two names.
 *
 *   2. Codex's Sky client — the fallback for a machine that has Codex's bundled
 *      computer-use plugin but not cua-driver. Sky is proprietary and its grant
 *      belongs to OpenAI's app; it is native on Codex already, so it is offered
 *      to CLAUDE only (injecting it into Codex would double the tools).
 *
 * ══ INDEPENDENCE IS THE PRIME RULE (the Lintel precedent) ══
 *
 * Neither backend present, wrong platform, kill switch set — the resolver
 * answers undefined and no server is injected, silently. Nothing retries,
 * nothing logs an error a person must dismiss, and a session behaves exactly as
 * it did before this existed. `TELAR_COMPUTER_USE=0` is the kill switch.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ComputerUsePermission, ComputerUseStatus, McpServer } from "@telar/engine-client";

/**
 * The id is the provider-facing server name: tools arrive as `mcp__mac__click`.
 *
 * NOT `computer-use`, though that is the honest name: Claude Code RESERVES it
 * ("...is a reserved MCP server name and was not loaded" — measured with
 * --debug-to-stderr, and the refusal is otherwise silent: the server simply
 * never connects). A USER-registered server with this id wins — see
 * `withComputerUse`. The presence of a server with THIS id in a Codex claim is
 * also the signal that turns off Codex's native computer use.
 */
export const COMPUTER_USE_SERVER_ID = "mac";

/** Which engine is supplying the desktop. Decides who gets it (cua → both
 *  providers; sky → Claude only) and whether the Sky host app needs waking. */
export type ComputerUseBackend = "cua" | "sky";
export type ResolvedComputerUse = { server: McpServer; backend: ComputerUseBackend };

/* ------------------------------------------------------------------ *
 * cua-driver — the open-source primary.
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

/* ------------------------------------------------------------------ *
 * Sky — the proprietary fallback (Codex's bundled plugin).
 * ------------------------------------------------------------------ */

const LAUNCHER_RELATIVE = "bin/computer-use-client-launcher";
const CLIENT_RELATIVE =
  "computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient";

export type ComputerUseProbe = {
  env?: Record<string, string | undefined>;
  home?: string;
  platform?: NodeJS.Platform;
  /** Injected for tests; the real one is fs.existsSync. */
  exists?: (candidate: string) => boolean;
  /** Injected for tests; lists version directories in the plugin cache. */
  listVersions?: (cacheDir: string) => string[];
  now?: () => number;
};

/**
 * Newest version wins, compared numerically per dot-segment — the cache keeps
 * every version ever installed, and "1.0.10" must beat "1.0.9" even though the
 * string sort disagrees.
 */
export function newestVersion(versions: readonly string[]): string | undefined {
  return [...versions].sort((left, right) => {
    const a = left.split(".").map((part) => Number.parseInt(part, 10) || 0);
    const b = right.split(".").map((part) => Number.parseInt(part, 10) || 0);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const delta = (b[i] ?? 0) - (a[i] ?? 0);
      if (delta !== 0) return delta;
    }
    return right.localeCompare(left);
  })[0];
}

function resolveSky(
  env: Record<string, string | undefined>,
  home: string,
  exists: (candidate: string) => boolean,
  listVersions: (dir: string) => string[],
  at: number,
): ResolvedComputerUse | undefined {
  const codexHome = env.CODEX_HOME ?? path.join(home, ".codex");
  if (!exists(path.join(codexHome, CLIENT_RELATIVE))) return undefined;
  const cacheDir = path.join(codexHome, "plugins", "cache", "openai-bundled", "computer-use");
  const version = newestVersion(listVersions(cacheDir));
  if (!version) return undefined;
  const launcher = path.join(cacheDir, version, LAUNCHER_RELATIVE);
  if (!exists(launcher)) return undefined;
  return {
    backend: "sky",
    server: {
      id: COMPUTER_USE_SERVER_ID,
      label: "Computer Use (Mac)",
      enabled: true,
      // The launcher reads CODEX_HOME to find the client; pinned so the server
      // resolves against the same install this resolver just checked.
      spec: { transport: "stdio", command: launcher, args: ["mcp"], env: { CODEX_HOME: codexHome } },
      createdAt: at,
      updatedAt: at,
    },
  };
}

/**
 * The desktop engine for this machine, with its backend — or undefined, which
 * means computer use does not exist here and nothing anywhere says so. cua is
 * tried first because it is the one Telar owns.
 */
export function resolveComputerUse(probe: ComputerUseProbe = {}): ResolvedComputerUse | undefined {
  const env = probe.env ?? process.env;
  if (env.TELAR_COMPUTER_USE === "0") return undefined;
  // Both backends drive macOS accessibility; on anything else there is nothing.
  if ((probe.platform ?? process.platform) !== "darwin") return undefined;

  const exists = probe.exists ?? fs.existsSync;
  const home = probe.home ?? os.homedir();
  const at = (probe.now ?? Date.now)();
  const listVersions =
    probe.listVersions ??
    ((dir: string) => {
      try {
        return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
      } catch {
        return [];
      }
    });
  return resolveCua(env, home, exists, at) ?? resolveSky(env, home, exists, listVersions, at);
}

/** Back-compat: the claim only needs the server. The daemon uses the richer
 *  `resolveComputerUse` so it also knows the backend. */
export function resolveComputerUseServer(probe: ComputerUseProbe = {}): McpServer | undefined {
  return resolveComputerUse(probe)?.server;
}

/**
 * The Sky HOST APP, which the Sky client drives over Apple events — with it
 * stopped every call answers `-1712 errAETimeout`, and the client does not
 * launch it. cua-driver needs none of this: its `mcp` proxy auto-launches its
 * own daemon. So this is a no-op unless the resolved backend is Sky.
 */
export function openComputerUseHost(probe: Pick<ComputerUseProbe, "env" | "home"> = {}): void {
  const env = probe.env ?? process.env;
  const codexHome = env.CODEX_HOME ?? path.join(probe.home ?? os.homedir(), ".codex");
  try {
    spawn("open", ["-g", path.join(codexHome, "computer-use", "Codex Computer Use.app")], { stdio: "ignore", detached: true }).unref();
  } catch {
    // Absent `open`, broken app bundle — the next tool call reports it.
  }
}

let hostLaunchAttempted = false;
/** Wake whatever host the resolved backend drives, once per daemon. cua
 *  self-launches, so only Sky needs this. */
export function launchComputerUseHost(probe: ComputerUseProbe = {}): void {
  if (hostLaunchAttempted) return;
  hostLaunchAttempted = true;
  if (resolveComputerUse(probe)?.backend === "sky") openComputerUseHost(probe);
}

/**
 * cua's own native granting flow: `cua-driver permissions grant` launches
 * CuaDriver.app through LaunchServices so the macOS dialogs attribute to the
 * app, requests Accessibility + Screen Recording, and verifies live capture.
 * Detached so the dialogs are the app's, not ours. A no-op for Sky (whose
 * grant flow IS the probe) and for an uninstalled machine.
 */
export function grantComputerUseAccess(probe: ComputerUseProbe = {}): { started: boolean; backend?: ComputerUseBackend } {
  const resolved = resolveComputerUse(probe);
  if (!resolved || resolved.server.spec.transport !== "stdio") return { started: false };
  if (resolved.backend !== "cua") return { started: false, backend: resolved.backend };
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
 * A backend's own words about why a call failed, mapped to the three states a
 * reader can act on. cua answers in structured prose (`permissions_pending`,
 * "permission … not granted"); Sky answers in macOS error codes: -1743
 * errAEEventNotPermitted is a denial, -1712 errAETimeout / -609
 * connectionInvalid mean its host app is down.
 */
export function classifyProbeError(text: string): ComputerUsePermission {
  const lower = text.toLowerCase();
  if (/permission[s]?[_\s-]*(pending|denied)/.test(lower) || /(accessibility|screen recording)[\s\S]*(not granted|pending|denied)/.test(lower)) {
    return "denied";
  }
  if (/-1743\b/.test(text)) return "denied";
  if (/-1712\b/.test(text) || /-609\b/.test(text)) return "host-not-running";
  return "unknown";
}

/** One JSON-RPC exchange: initialize, then a REAL read-only `list_apps` — the
 *  honest way to ask "is this permitted". For cua a pending grant answers
 *  immediately with a structured error; for Sky an undecided grant blocks on a
 *  macOS consent dialog, which is why the wait is generous. */
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
 * What the settings page shows, measured rather than remembered: which backend
 * is installed, whether its host/daemon is up, and the grant from one real
 * read-only call. cua answers cleanly (granted / permissions_pending); Sky's
 * probe doubles as its macOS granting prompt.
 */
export async function computerUseStatus(probe: ComputerUseProbe = {}, timeoutMs = 30_000): Promise<ComputerUseStatus> {
  const resolved = resolveComputerUse(probe);
  if (!resolved || resolved.server.spec.transport !== "stdio") return { installed: false, hostRunning: false };
  const hostRunning = await running(resolved.backend === "cua" ? "CuaDriver" : "SkyComputerUseService");
  const spec = resolved.server.spec;
  const outcome = await probeListApps({ command: spec.command, ...(spec.args ? { args: spec.args } : {}), ...(spec.env ? { env: spec.env } : {}) }, timeoutMs);
  return { installed: true, backend: resolved.backend, hostRunning, permission: outcome.permission, ...(outcome.message ? { message: outcome.message } : {}) };
}

/* ------------------------------------------------------------------ *
 * The claim-time fold.
 * ------------------------------------------------------------------ */

/**
 * Which servers a turn actually gets.
 *
 * cua goes to BOTH providers — it is Telar's own, and the point is that Claude
 * and Codex drive the same desktop. Sky goes to CLAUDE ONLY: it is already
 * native on Codex, so injecting it there would double the tools.
 *
 * THE USER'S ENTRY WINS. A registered server with this id — pointed elsewhere,
 * or disabled — is a decision injection must not overrule. `state.ts` filters
 * disabled servers out BEFORE this fold, so the check reads the unfiltered list.
 */
export function withComputerUse(
  servers: readonly McpServer[],
  allServers: readonly McpServer[],
  driver: "claude" | "codex",
  resolved: ResolvedComputerUse | undefined,
): McpServer[] {
  if (!resolved) return [...servers];
  if (driver === "codex" && resolved.backend !== "cua") return [...servers];
  if (allServers.some((server) => server.id === COMPUTER_USE_SERVER_ID)) return [...servers];
  return [...servers, resolved.server];
}

/** Whether a claim's servers include Telar's own computer-use server — the
 *  signal the Codex driver reads to turn OFF Codex's native `computer_use`, so
 *  the model is not handed two desktops. */
export function claimHasComputerUse(servers: readonly McpServer[] | undefined): boolean {
  return Boolean(servers?.some((server) => server.id === COMPUTER_USE_SERVER_ID));
}
