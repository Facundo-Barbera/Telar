/**
 * COMPUTER USE FOR CLAUDE SESSIONS, borrowed from the Codex install.
 *
 * Codex ships computer use as a bundled plugin: an MCP server
 * (`computer-use-client-launcher mcp`) fronting the Sky client app, which holds
 * the macOS Accessibility and Screen Recording grants and exposes the whole
 * tool surface — `list_apps`, `get_app_state` (screenshot + accessibility
 * tree), `click`, `type_text`, `press_key`, `scroll`, `drag`, `set_value`,
 * `select_text`, `perform_secondary_action`. Measured by handshaking the
 * launcher directly: it is a plain stdio MCP server, and nothing about it needs
 * Codex to be the caller.
 *
 * So Claude gets the same engine the same way Codex does: the launcher is
 * injected into a Claude claim as one more stdio MCP server, and every call
 * rides the approval pipeline user MCP servers already ride — runtime modes
 * gate a click exactly as they gate any other tool. Codex claims are LEFT
 * ALONE: the plugin already loads there natively, and a second registration
 * would hand the model every tool twice under two names.
 *
 * ══ INDEPENDENCE IS THE PRIME RULE (the Lintel precedent) ══
 *
 * Telar must behave identically when Codex's computer use is not installed:
 * no launcher, no client app, wrong platform — the resolver answers undefined
 * and no server is injected, silently. Nothing retries, nothing logs an error
 * a person has to dismiss. `TELAR_COMPUTER_USE=0` is the kill switch.
 *
 * THE CLIENT APP IS CHECKED, NOT JUST THE LAUNCHER. The launcher is a shell
 * script that execs the Sky client and exits 1 when it is missing — so a
 * launcher without its client is a server that dies on spawn, which the SDK
 * surfaces as a failed tool server on every turn. Absent is quieter and truer.
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
 * `withComputerUse`.
 */
export const COMPUTER_USE_SERVER_ID = "mac";

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

/**
 * The Codex computer-use client, as an `McpServer` — or undefined, which means
 * the feature does not exist on this machine and nothing anywhere says so.
 */
export function resolveComputerUseServer(probe: ComputerUseProbe = {}): McpServer | undefined {
  const env = probe.env ?? process.env;
  if (env.TELAR_COMPUTER_USE === "0") return undefined;
  // The Sky client is a macOS app driving macOS accessibility; on anything
  // else there is nothing to resolve.
  if ((probe.platform ?? process.platform) !== "darwin") return undefined;

  const exists = probe.exists ?? fs.existsSync;
  const codexHome = env.CODEX_HOME ?? path.join(probe.home ?? os.homedir(), ".codex");
  if (!exists(path.join(codexHome, CLIENT_RELATIVE))) return undefined;

  const cacheDir = path.join(codexHome, "plugins", "cache", "openai-bundled", "computer-use");
  const listVersions =
    probe.listVersions ??
    ((dir: string) => {
      try {
        return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
      } catch {
        return [];
      }
    });
  const version = newestVersion(listVersions(cacheDir));
  if (!version) return undefined;
  const launcher = path.join(cacheDir, version, LAUNCHER_RELATIVE);
  if (!exists(launcher)) return undefined;

  const at = (probe.now ?? Date.now)();
  return {
    id: COMPUTER_USE_SERVER_ID,
    label: "Computer Use (Mac)",
    enabled: true,
    spec: {
      transport: "stdio",
      command: launcher,
      args: ["mcp"],
      // The launcher reads CODEX_HOME to find the client; pinned so the server
      // resolves against the same install this resolver just checked.
      env: { CODEX_HOME: codexHome },
    },
    createdAt: at,
    updatedAt: at,
  };
}

/**
 * The Sky HOST APP, which the MCP client drives over Apple events — measured:
 * with the app stopped every tool call answers `-1712 errAETimeout`, and the
 * client does not launch it itself (Codex's own runtime does that half).
 * `open -g` keeps it in the background, is idempotent when it already runs,
 * and one attempt per daemon is enough — the app stays resident. Failure is
 * silent by the same independence rule as everything else here: the tool call
 * that follows will say what is wrong better than a log line can.
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
export function launchComputerUseHost(probe: Pick<ComputerUseProbe, "env" | "home"> = {}): void {
  if (hostLaunchAttempted) return;
  hostLaunchAttempted = true;
  openComputerUseHost(probe);
}

/* ------------------------------------------------------------------ *
 * The permission probe — what the settings page reports.
 * ------------------------------------------------------------------ */

/**
 * The macOS error codes a denied or dead automation bridge answers with.
 * Measured, all three: -1743 errAEEventNotPermitted (the Automation grant is
 * missing for whatever process macOS holds responsible), -1712 errAETimeout
 * and -609 connectionInvalid (the host app is not running or just died).
 */
export function classifyProbeError(text: string): ComputerUsePermission {
  if (/-1743\b/.test(text)) return "denied";
  if (/-1712\b/.test(text) || /-609\b/.test(text)) return "host-not-running";
  return "unknown";
}

/** One JSON-RPC exchange with the client: initialize, then a REAL read-only
 *  `list_apps` call — the only honest way to ask macOS "is this permitted",
 *  and the very call that makes it SHOW the Automation prompt when the answer
 *  is still undecided. That prompt is the granting flow. */
function probeListApps(spec: { command: string; args?: string[]; env?: Record<string, string> }, timeoutMs: number): Promise<{ permission: ComputerUsePermission; message?: string }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(spec.command, spec.args ?? [], {
        env: { ...process.env, ...(spec.env ?? {}) },
        stdio: ["pipe", "pipe", "ignore"],
      });
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
    // An UNDECIDED grant blocks here while macOS holds its consent dialog on
    // screen — which is the granting flow working, not a hang. The window has
    // to be long enough to walk to the dialog and click it; killing the client
    // earlier can also retract the prompt.
    const timer = setTimeout(
      () => finish({ permission: "unknown", message: "No answer — macOS may be showing an Automation consent dialog. Decide it, then test again." }),
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
            finish({ permission: classifyProbeError(msg.error.message ?? ""), message: msg.error.message ?? "" });
            return;
          }
          const text = (msg.result?.content ?? []).map((part) => part.text ?? "").join(" ");
          finish(msg.result?.isError ? { permission: classifyProbeError(text), message: text.slice(0, 400) } : { permission: "granted" });
          return;
        }
      }
    });
    child.stdin?.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "telar", version: "2.0" } },
      }) + "\n",
    );
  });
}

function isHostRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn("pgrep", ["-f", "SkyComputerUseService"], { stdio: "ignore" });
      child.once("exit", (code) => resolve(code === 0));
      child.once("error", () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}

/**
 * What the settings page shows, measured rather than remembered: the plugin's
 * presence from the resolver, the host app from the process table, and the
 * Automation grant from one real read-only call. macOS keys that grant on a
 * RESPONSIBLE PROCESS this daemon cannot reliably name from the inside (the
 * dev stack's chain ends at an orphaned bun; `launchctl procinfo` needs root)
 * — so the probe is also the granting flow: an undecided grant makes macOS
 * put up its own prompt, which names the right app better than we could.
 */
export async function computerUseStatus(probe: ComputerUseProbe = {}, timeoutMs = 30_000): Promise<ComputerUseStatus> {
  const server = resolveComputerUseServer(probe);
  if (!server || server.spec.transport !== "stdio") return { installed: false, hostRunning: await isHostRunning() };
  const hostRunning = await isHostRunning();
  const outcome = await probeListApps(
    { command: server.spec.command, ...(server.spec.args ? { args: server.spec.args } : {}), ...(server.spec.env ? { env: server.spec.env } : {}) },
    timeoutMs,
  );
  return { installed: true, hostRunning, permission: outcome.permission, ...(outcome.message ? { message: outcome.message } : {}) };
}

/**
 * The claim-time fold: which servers a turn actually gets.
 *
 * CLAUDE ONLY. Codex loads the plugin natively through its own runtime, so
 * injecting here would register the same tools twice under two names.
 *
 * THE USER'S ENTRY WINS. A registered server with this id — pointed somewhere
 * else, or disabled — is a decision, and injection must not overrule it. The
 * disabled case matters most: `state.ts` filters disabled servers out BEFORE
 * this fold, so the check reads the unfiltered list.
 */
export function withComputerUse(
  servers: readonly McpServer[],
  allServers: readonly McpServer[],
  driver: "claude" | "codex",
  resolved: McpServer | undefined,
): McpServer[] {
  if (driver !== "claude" || !resolved) return [...servers];
  if (allServers.some((server) => server.id === COMPUTER_USE_SERVER_ID)) return [...servers];
  return [...servers, resolved];
}
