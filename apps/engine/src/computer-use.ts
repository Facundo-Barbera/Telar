/**
 * COMPUTER USE FOR TELAR SESSIONS — Telar's own engine, not the provider's.
 *
 * The tool surface (list_apps, a screenshot + accessibility tree, click, type,
 * scroll, drag, keys) is served by an MCP server injected into a CLAIM, so every
 * provider Telar supplies reaches the SAME desktop through the SAME approval
 * pipeline runtime modes already gate. One backend supplies it: cua-driver
 * (github.com/trycua/cua, MIT), the open-source computer-use driver. A packaged
 * Telar ships its own copy inside Telar.app as "Computer Use for Telar"
 * (`COMPUTER_USE_HELPER_BUNDLE_ID`), with its own grants, socket and state, so
 * a CuaDriver.app the person installed separately is never used or disturbed.
 * A dev checkout has no bundle and uses that external install, whose stdio MCP
 * server auto-launches its own permission-holding daemon (`com.trycua.driver`).
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
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  driverTakesComputerUse,
  type ComputerUseBackend,
  type ComputerUseGrant,
  type ComputerUsePane,
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
/** `helper` is present only for the helper bundled inside Telar.app. */
export type ResolvedComputerUse = { server: McpServer; backend: ComputerUseBackend; helper?: BundledHelper };

/* ------------------------------------------------------------------ *
 * cua-driver.
 * ------------------------------------------------------------------ */

/** Where cua's installer puts things: a symlink in ~/.local/bin, and the app it
 *  points at. Either being executable is enough to run `cua-driver mcp`, which
 *  proxies through (and auto-launches) the app's daemon. A DEV checkout's only
 *  route — a packaged Telar with its helper never looks here. */
const CUA_APP_BINARY = "/Applications/CuaDriver.app/Contents/MacOS/cua-driver";
const cuaSymlink = (home: string) => path.join(home, ".local", "bin", "cua-driver");

/**
 * THE HELPER TELAR SHIPS — cua-driver inside Telar.app as "Computer Use for
 * Telar" (apps/desktop/computer-use-helper.json, scripts/computer-use-helper.mjs).
 * The desktop shell names its path in TELAR_COMPUTER_USE_HELPER.
 *
 * ITS OWN IDENTITY IS THE POINT. macOS keys the Accessibility and Screen
 * Recording grants to bundle id + team, so the helper's grants are neither a
 * separately installed CuaDriver.app's nor Telar's, and survive Telar updates.
 * Changing this id orphans every grant already given; the packaging test pins
 * it against the build's pin.
 */
export const COMPUTER_USE_HELPER_BUNDLE_ID = "com.telar.desktop.computer-use";

export type BundledHelper = {
  /** The helper's .app, inside Telar.app/Contents/Helpers. */
  app: string;
  binary: string;
  bundleId: string;
  /** OUR socket and pid file. cua's default is ~/Library/Caches/cua-driver/
   *  cua-driver.sock (cua-driver-core/src/daemon.rs `default_socket_path`),
   *  which a separately installed CuaDriver.app listens on. cua 0.28.2's
   *  `serve` accepts `--pid-file` but IGNORES it (main.rs always writes
   *  `default_pid_file_path()`), so nothing reads this file: our daemon is
   *  found in the process table instead (`helperDaemonPids`). */
  socket: string;
  pidFile: string;
  /** Where cua keeps config, telemetry ids and extensions for this copy. */
  stateDir: string;
  /** For the daemon AND the MCP proxy. */
  env: Record<string, string>;
};

/**
 * ISOLATION FROM A SEPARATELY INSTALLED cua. Renaming the bundle is not enough
 * on its own: cua derives its socket and state from its EXECUTABLE NAME, not
 * its bundle (`bundle.rs` `state_namespace`), and an `mcp` proxy that finds no
 * daemon relaunches one with `open -a CuaDriver` by app NAME
 * (`cli.rs` `launch_daemon_with_state_and_wait`) — which is the person's own
 * install and its grants. So everything cua would put in a shared place is
 * pointed at ours, and Telar starts the daemon itself (`helperDaemonLaunch`).
 *
 * Telemetry and the update check are off: cua's defaults report usage to
 * cua's analytics and poll GitHub, neither of which a person asked Telar to do
 * on their behalf, and the pinned version rides Telar's releases instead.
 */
export function bundledHelper(app: string, home: string): BundledHelper {
  const caches = path.join(home, "Library", "Caches", COMPUTER_USE_HELPER_BUNDLE_ID);
  const stateDir = path.join(home, "Library", "Application Support", COMPUTER_USE_HELPER_BUNDLE_ID);
  return {
    app,
    binary: path.join(app, "Contents", "MacOS", "cua-driver"),
    bundleId: COMPUTER_USE_HELPER_BUNDLE_ID,
    socket: path.join(caches, "driver.sock"),
    pidFile: path.join(caches, "driver.pid"),
    stateDir,
    env: {
      CUA_DRIVER_RS_HOME: stateDir,
      CUA_DRIVER_HOME: stateDir,
      CUA_DRIVER_TELEMETRY_HOME: stateDir,
      CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
      CUA_DRIVER_RS_UPDATE_CHECK: "false",
      // cua's first-launch gate opens System Settings panes and waits on
      // stdin; the grant is Telar's to ask for, from the settings pane.
      CUA_DRIVER_RS_PERMISSIONS_GATE: "0",
    },
  };
}

/**
 * How Telar starts the helper's daemon: THROUGH LAUNCHSERVICES, so the daemon
 * is its own responsible process and macOS attributes its grants (and names its
 * prompts) to the helper rather than to Telar. `-n` because cua's `mcp` would
 * otherwise have done this with `-a CuaDriver`; `-g` keeps it in the background.
 *
 * ONE LAUNCH SHOWS AS TWO PROCESSES. `serve` outside a bundle named
 * CuaDriver.app re-execs itself with the TCC responsibility disclaimed
 * (cua-driver/src/responsibility.rs `reexec_disclaimed_if_needed`): the parent
 * only waits for the child, and the child binds the socket and does the work.
 */
export function helperDaemonLaunch(helper: BundledHelper): { command: string; args: string[] } {
  return {
    command: "/usr/bin/open",
    args: [
      "-n",
      "-g",
      "-a",
      helper.app,
      ...Object.entries(helper.env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
      "--args",
      "serve",
      "--socket",
      helper.socket,
      "--pid-file",
      helper.pidFile,
      "--no-permissions-gate",
    ],
  };
}

/** What "Remove permissions" runs — the helper's two grants and nothing else. */
export function helperResetCommands(bundleId: string): { command: string; args: string[] }[] {
  return ["Accessibility", "ScreenCapture"].map((service) => ({ command: "/usr/bin/tccutil", args: ["reset", service, bundleId] }));
}

function server(command: string, args: string[], at: number, env?: Record<string, string>): McpServer {
  return {
    id: COMPUTER_USE_SERVER_ID,
    label: "Computer Use (Mac)",
    enabled: true,
    spec: { transport: "stdio", command, args, ...(env ? { env } : {}) },
    createdAt: at,
    updatedAt: at,
  };
}

/**
 * THE ORDER: the bundled helper, then CUA_DRIVER_BIN, then cua's own install.
 *
 * A PACKAGED TELAR WITH A HELPER NEVER FALLS BACK. With TELAR_COMPUTER_USE_HELPER
 * set, a missing binary answers undefined — computer use absent — rather than
 * quietly driving the desktop through another app's grants, which is exactly
 * the confusion bundling exists to end. The desktop only sets it when the helper
 * is in the bundle, so a dev checkout (no bundle) keeps the external route.
 */
function resolveCua(env: Record<string, string | undefined>, home: string, exists: (candidate: string) => boolean, at: number): ResolvedComputerUse | undefined {
  const bundledApp = env.TELAR_COMPUTER_USE_HELPER?.trim();
  if (bundledApp) {
    const helper = bundledHelper(bundledApp, home);
    if (!exists(helper.binary)) return undefined;
    // `CUA_DRIVER_EMBEDDED=1` on the PROXY only: with no daemon on our socket it
    // fails instead of `open -a CuaDriver` (cli.rs `run_mcp_via_daemon_proxy`).
    // Telar starts the daemon; see `ensureHelperDaemon`.
    return { backend: "cua", helper, server: server(helper.binary, ["mcp", "--socket", helper.socket], at, { ...helper.env, CUA_DRIVER_EMBEDDED: "1" }) };
  }
  const override = env.CUA_DRIVER_BIN?.trim();
  const command = [override, cuaSymlink(home), CUA_APP_BINARY].find((candidate): candidate is string => Boolean(candidate) && exists(candidate!));
  if (!command) return undefined;
  // `mcp` is a stdio MCP server that auto-launches CuaDriver.app's daemon and
  // proxies through it — so nothing here needs a separate host wake.
  return { backend: "cua", server: server(command, ["mcp"], at) };
}

/* ------------------------------------------------------------------ *
 * The bundled helper's daemon — Telar's to start.
 * ------------------------------------------------------------------ */

/** Whether something accepts connections on a unix socket. */
export function socketListening(socket: string, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    const connection = net.connect(socket);
    const done = (answer: boolean) => {
      connection.destroy();
      resolve(answer);
    };
    connection.setTimeout(timeoutMs, () => done(false));
    connection.once("connect", () => done(true));
    connection.once("error", () => done(false));
  });
}

export type HelperDeps = {
  spawn?: typeof spawn;
  listening?: (socket: string) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  /** Every process's pid and command line (`ps -axo pid=,command=`). */
  processes?: () => { pid: number; command: string }[];
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** `/usr/bin/open` with these args; true when it exited 0. */
  open?: (args: string[]) => Promise<boolean>;
};

const launching = new Map<string, Promise<boolean>>();

function psProcesses(): { pid: number; command: string }[] {
  const answer = spawnSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return (answer.stdout ?? "").split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    return match ? [{ pid: Number(match[1]), command: match[2]! }] : [];
  });
}

/**
 * OUR daemon's pids — the disclaiming parent and the serving child — read from
 * the process table: OUR binary running `serve` on OUR socket. Never a pid
 * file: cua ignores `--pid-file` and writes the SHARED
 * ~/Library/Caches/cua-driver/cua-driver.pid, which a separately installed
 * CuaDriver.app also writes, so a pid there may be the person's own daemon.
 */
export function helperDaemonPids(helper: BundledHelper, deps: HelperDeps = {}): number[] {
  return (deps.processes ?? psProcesses)()
    .filter(({ command }) => command.startsWith(`${helper.binary} serve`) && command.includes(`--socket ${helper.socket}`))
    .map(({ pid }) => pid);
}

/**
 * The launch lock beside the socket. The in-process `launching` map only
 * dedupes callers inside ONE engine; this one holds across processes (a second
 * engine, a restarted one racing the old one's launch). `wx` is the atomic part;
 * a lock older than a launch can take is a crashed launcher's and is taken over.
 */
function takeLaunchLock(helper: BundledHelper, staleMs: number): (() => void) | undefined {
  const lock = `${helper.socket}.launch.lock`;
  for (let tries = 0; tries < 2; tries += 1) {
    try {
      fs.closeSync(fs.openSync(lock, "wx"));
      return () => fs.rmSync(lock, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs < staleMs) return undefined;
        fs.rmSync(lock, { force: true });
      } catch {
        // Released between the two calls: try again.
      }
    }
  }
  return undefined;
}

/**
 * Up, or started — ONE DAEMON PER SOCKET. Concurrent callers in this process
 * share one launch; across processes, whoever holds the launch lock launches
 * and everyone else waits for the socket, and a helper daemon already in the
 * process table (up, not listening yet) is waited for rather than doubled.
 * The daemon starts with cua's gate off and nobody asks for a prompt, so
 * starting it draws nothing on the screen — which is why, unlike an external
 * install, Telar may start it at engine start and at a claim.
 */
export function ensureHelperDaemon(helper: BundledHelper, deps: HelperDeps = {}, timeoutMs = 10_000): Promise<boolean> {
  const listening = deps.listening ?? socketListening;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const existing = launching.get(helper.socket);
  if (existing) return existing;
  const waitForSocket = async () => {
    for (let waited = 0; waited < timeoutMs; waited += 250) {
      await sleep(250);
      if (await listening(helper.socket)) return true;
    }
    return false;
  };
  const attempt = (async () => {
    if (await listening(helper.socket)) return true;
    fs.mkdirSync(path.dirname(helper.socket), { recursive: true });
    fs.mkdirSync(helper.stateDir, { recursive: true });
    // Running but not listening yet: someone else's launch, still starting.
    if (helperDaemonPids(helper, deps).length > 0) return waitForSocket();
    const release = takeLaunchLock(helper, timeoutMs + 5_000);
    if (!release) return waitForSocket();
    try {
      // Re-checked under the lock: another process may have finished its launch
      // between our first look and taking the lock.
      if (await listening(helper.socket)) return true;
      const launch = helperDaemonLaunch(helper);
      try {
        (deps.spawn ?? spawn)(launch.command, launch.args, { stdio: "ignore", detached: true }).unref();
      } catch {
        return false;
      }
      return await waitForSocket();
    } finally {
      release();
    }
  })().finally(() => launching.delete(helper.socket));
  launching.set(helper.socket, attempt);
  return attempt;
}

/**
 * "Remove permissions": `tccutil reset` for the helper's id only — never
 * Telar's, never a separately installed cua's — then stop its daemon so no
 * process keeps a grant it no longer has. The next check starts a fresh one.
 */
export async function resetComputerUseAccess(probe: ComputerUseProbe = {}, deps: HelperDeps = {}): Promise<{ reset: boolean; message?: string }> {
  const helper = resolveComputerUse(probe)?.helper;
  if (!helper) return { reset: false, message: "Only Telar's bundled computer-use helper can be reset here." };
  const run = (command: string, args: string[]) =>
    new Promise<number | null>((resolve) => {
      try {
        const child = (deps.spawn ?? spawn)(command, args, { stdio: "ignore" });
        child.once("exit", (code) => resolve(code));
        child.once("error", () => resolve(null));
      } catch {
        resolve(null);
      }
    });
  const codes = [];
  for (const { command, args } of helperResetCommands(helper.bundleId)) codes.push(await run(command, args));
  stopHelperDaemon(helper, deps);
  return codes.every((code) => code === 0) ? { reset: true } : { reset: false, message: "macOS did not reset every permission." };
}

/** SIGTERM to OUR daemon — both of its processes, found by `helperDaemonPids` —
 *  and nothing else. False when there was none to stop. */
export function stopHelperDaemon(helper: BundledHelper, deps: HelperDeps = {}): boolean {
  const pids = helperDaemonPids(helper, deps);
  for (const pid of pids) {
    try {
      (deps.kill ?? ((target, signal) => process.kill(target, signal)))(pid, "SIGTERM");
    } catch {
      // Gone already: the parent exits with its child.
    }
  }
  return pids.length > 0;
}

/** Stop our daemon, wait for it to be gone — socket quiet, processes exited, or
 *  `ensureHelperDaemon` would wait on the dying one — then start a fresh one. */
export async function restartHelperDaemon(helper: BundledHelper, deps: HelperDeps = {}, timeoutMs = 5_000): Promise<boolean> {
  const listening = deps.listening ?? socketListening;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  if (stopHelperDaemon(helper, deps)) {
    for (let waited = 0; waited < timeoutMs; waited += 100) {
      if (!(await listening(helper.socket)) && helperDaemonPids(helper, deps).length === 0) break;
      await sleep(100);
    }
  }
  return ensureHelperDaemon(helper, deps);
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

/** The Privacy & Security lists, by the URLs cua's own gate opens
 *  (platform-macos/src/permissions/gate.rs `settings_url`). */
export const SETTINGS_PANE_URL: Record<ComputerUsePane, string> = {
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  "screen-recording": "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
};

function runOpen(args: string[], timeoutMs = 30_000): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn("/usr/bin/open", args, { stdio: "ignore", timeout: timeoutMs });
      child.once("exit", (code) => resolve(code === 0));
      child.once("error", () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}

type HelperGrants = { accessibility: boolean; screenRecording: boolean };

/**
 * THE HELPER'S GRANTS, FROM A FRESH PROCESS. cua's hidden probe
 * (`--cua-internal-permission-probe`, handled first thing in main.rs) prints
 * `{accessibility, screen_recording}` and exits; `-request` first calls
 * `AXIsProcessTrustedWithOptions(prompt)` and `CGRequestScreenCaptureAccess()`
 * for whatever is missing — which also puts the helper INTO both Settings lists.
 *
 * Fresh because macOS caches a negative Accessibility / Screen Recording answer
 * in the process that asked (cua's gate.rs says so and probes the same way), so
 * the long-lived daemon cannot see a grant given after it started. Through
 * LaunchServices (`open -n -W`, stdout to a file) because a child of the engine
 * would be answered for TELAR's grants, not the helper's.
 */
export async function probeHelperGrants(helper: BundledHelper, request: boolean, deps: HelperDeps = {}): Promise<HelperGrants | { error: string }> {
  const out = path.join(os.tmpdir(), `telar-cu-probe-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  try {
    fs.writeFileSync(out, "");
    const flag = request ? "--cua-internal-permission-probe-request" : "--cua-internal-permission-probe";
    const ran = await (deps.open ?? runOpen)(["-n", "-g", "-W", "--stdout", out, "-a", helper.app, "--args", flag]);
    const text = fs.readFileSync(out, "utf8").trim();
    if (!ran && !text) return { error: "The helper's permission check did not run." };
    const report = JSON.parse(text.split("\n").pop() ?? "") as { accessibility?: unknown; screen_recording?: unknown };
    return { accessibility: report.accessibility === true, screenRecording: report.screen_recording === true };
  } catch {
    return { error: "The helper's permission check gave no answer." };
  } finally {
    fs.rmSync(out, { force: true });
  }
}

const missingPanes = (grants: HelperGrants): ComputerUsePane[] => [
  ...(grants.accessibility ? [] : ["accessibility" as const]),
  ...(grants.screenRecording ? [] : ["screen-recording" as const]),
];

const PANE_LABEL: Record<ComputerUsePane, string> = { accessibility: "Accessibility", "screen-recording": "Screen Recording" };

/**
 * ASKING macOS FOR THE GRANTS — and always leaving the person somewhere they
 * can finish.
 *
 * BUNDLED: the helper asks for itself, through its hidden request probe (see
 * `probeHelperGrants`). NOT `check_permissions {prompt: true}` through the MCP
 * proxy, which is what this used to do: cua refuses a prompt on the tool path
 * (cua-driver-core/src/tool.rs, `os_permission_prompt_requires_trusted_host`),
 * and the refusal was swallowed — the "Grant access does nothing" bug. And NOT
 * `cua-driver permissions grant`: that relaunches `/Applications/CuaDriver.app`
 * by hardcoded path (`cli.rs` `request_permissions_via_launchservices`).
 *
 * The macOS prompt appears at most once per app — after that the request APIs
 * return false silently — so the prompt is never the whole answer: the first
 * list still missing a grant is opened in System Settings, as cua's own gate
 * does. Accessibility first; the pane asks again for Screen Recording once it
 * is the one left. The daemon is started too, so the tools are ready when the
 * grants are, and the answer says what each step did.
 *
 * EXTERNAL (dev): cua's own `permissions grant`, which launches CuaDriver.app
 * through LaunchServices so the dialogs attribute to it and runs cua's gate.
 */
export async function grantComputerUseAccess(probe: ComputerUseProbe = {}, deps: HelperDeps = {}): Promise<ComputerUseGrant> {
  const resolved = resolveComputerUse(probe);
  if (!resolved || resolved.server.spec.transport !== "stdio") return { started: false };
  const { helper } = resolved;
  if (!helper) {
    try {
      (deps.spawn ?? spawn)(resolved.server.spec.command, ["permissions", "grant"], { stdio: "ignore", detached: true }).unref();
      return { started: true, backend: "cua" };
    } catch (error) {
      return { started: false, backend: "cua", message: error instanceof Error ? error.message : "cua-driver did not start." };
    }
  }
  const daemon = await ensureHelperDaemon(helper, deps);
  const asked = await probeHelperGrants(helper, true, deps);
  const prompted = !("error" in asked);
  // No answer is no reason to leave the person nowhere: Accessibility is the
  // list every grant starts in.
  const missing = prompted ? missingPanes(asked) : (["accessibility"] as ComputerUsePane[]);
  const pane = missing[0];
  const opened = pane ? await (deps.open ?? runOpen)([SETTINGS_PANE_URL[pane]]) : false;
  const problems = [
    daemon ? undefined : "The computer-use helper did not start.",
    prompted ? undefined : asked.error,
    pane && !opened ? `System Settings did not open ${PANE_LABEL[pane]}.` : undefined,
  ].filter(Boolean);
  return {
    started: true,
    backend: "cua",
    daemon,
    prompted,
    ...(prompted ? { permission: missing.length === 0 ? ("granted" as const) : ("denied" as const) } : {}),
    ...(pane && opened ? { opened: pane } : {}),
    ...(problems.length ? { message: problems.join(" ") } : {}),
  };
}

/** "Show in Finder" for the helper, to drag into a Settings list that does not
 *  name it yet (a list only shows an app after it has asked, or been added). */
export async function revealComputerUseHelper(probe: ComputerUseProbe = {}, deps: HelperDeps = {}): Promise<{ revealed: boolean }> {
  const helper = resolveComputerUse(probe)?.helper;
  if (!helper) return { revealed: false };
  return { revealed: await (deps.open ?? runOpen)(["-R", helper.app]) };
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

type ToolAnswer =
  | { kind: "result"; isError: boolean; text: string; structured?: Record<string, unknown> }
  | { kind: "error"; message: string }
  | { kind: "timeout" };

type StdioSpec = { command: string; args?: string[]; env?: Record<string, string> };

/** One JSON-RPC exchange through the MCP server: initialize, then one tool call. */
function callTool(spec: StdioSpec, name: string, args: Record<string, unknown>, timeoutMs: number, deps: HelperDeps = {}): Promise<ToolAnswer> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = (deps.spawn ?? spawn)(spec.command, spec.args ?? [], { env: { ...process.env, ...(spec.env ?? {}) }, stdio: ["pipe", "pipe", "ignore"] });
    } catch (error) {
      resolve({ kind: "error", message: error instanceof Error ? error.message : "could not start the client" });
      return;
    }
    let settled = false;
    const finish = (answer: ToolAnswer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(answer);
    };
    const timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
    child.once("error", (error) => finish({ kind: "error", message: error.message }));

    let buffer = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let cut;
      while ((cut = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 1);
        if (!line.trim()) continue;
        let msg: {
          id?: number;
          result?: { content?: { type?: string; text?: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> };
          error?: { message?: string };
        };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1) {
          child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
          child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }) + "\n");
        } else if (msg.id === 2) {
          if (msg.error) return finish({ kind: "error", message: msg.error.message ?? "" });
          const text = (msg.result?.content ?? []).map((part) => part.text ?? "").join(" ");
          return finish({ kind: "result", isError: Boolean(msg.result?.isError), text, ...(msg.result?.structuredContent ? { structured: msg.result.structuredContent } : {}) });
        }
      }
    });
    child.stdin?.write(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "telar", version: "2.0" } } }) + "\n",
    );
  });
}

type ProbeOutcome = { permission: ComputerUsePermission; message?: string };

const NO_ANSWER = "No answer — a permission dialog may be on screen. Decide it, then test again.";

/** An external install: a REAL read-only `list_apps`. A running CuaDriver.app
 *  with a pending grant refuses it from its first-launch gate with
 *  `permissions_pending`; a daemon this call had to launch may put its
 *  permissions panel on screen first, which is why the wait is generous. */
export function interpretListApps(answer: ToolAnswer): ProbeOutcome {
  if (answer.kind === "timeout") return { permission: "unknown", message: NO_ANSWER };
  if (answer.kind === "error") return { permission: classifyProbeError(answer.message), message: answer.message.slice(0, 400) };
  return answer.isError ? { permission: classifyProbeError(answer.text), message: answer.text.slice(0, 400) } : { permission: "granted" };
}

function daemonGrants(answer: ToolAnswer): HelperGrants | undefined {
  const report = answer.kind === "result" ? answer.structured : undefined;
  return report ? { accessibility: report.accessibility === true, screenRecording: report.screen_recording === true } : undefined;
}

/** The daemon processes whose capture has been seen to work, per socket. */
const captureVerified = new Map<string, string>();
/** When Telar last restarted a daemon that could not capture, per socket. */
const lastRestart = new Map<string, number>();

type CaptureCheck = { ok: true } | { ok: false; unknown?: boolean; reason: string };

/**
 * WHETHER THE DAEMON CAN ACTUALLY CAPTURE: one real window screenshot, which
 * is what a session will ask it for. cua's read-only `check_permissions`
 * never runs its own live check (`SCShareableContent`, which Tahoe may follow
 * with a consent of its own) and `prompt:true` is refused on the tool path, so
 * the booleans are all it gives — and its `CGPreflightScreenCaptureAccess` has
 * been seen answering no while TCC holds the grant. `get_window_state` adds
 * `screenshot_width` only when a frame came back.
 *
 * Telar's own window when there is one (the pane is open in it), else any
 * window on screen. The image is dropped. Once per daemon process: a daemon
 * that captured once keeps its grant for its lifetime.
 */
async function daemonCaptures(spec: StdioSpec, helper: BundledHelper, timeoutMs: number, deps: HelperDeps): Promise<CaptureCheck> {
  const daemon = helperDaemonPids(helper, deps).join(",");
  if (daemon && captureVerified.get(helper.socket) === daemon) return { ok: true };
  const listed = await callTool(spec, "list_windows", { on_screen_only: true }, timeoutMs, deps);
  if (listed.kind !== "result" || listed.isError) return { ok: false, unknown: true, reason: listed.kind === "result" ? listed.text.slice(0, 300) : "list_windows gave no answer." };
  type Window = { window_id?: unknown; pid?: unknown; bounds?: { width?: unknown; height?: unknown } };
  const windows = ((listed.structured?.windows ?? []) as Window[]).filter(
    (window): window is { window_id: number; pid: number } =>
      typeof window.window_id === "number" && typeof window.pid === "number" && Number(window.bounds?.width) > 0 && Number(window.bounds?.height) > 0,
  );
  const target = windows.find((window) => window.pid === process.ppid) ?? windows[0];
  if (!target) return { ok: false, unknown: true, reason: "no window on screen to test with." };
  const shot = await callTool(spec, "get_window_state", { pid: target.pid, window_id: target.window_id, include_accessibility_tree: false }, timeoutMs, deps);
  if (shot.kind === "result" && !shot.isError && typeof shot.structured?.screenshot_width === "number") {
    if (daemon) captureVerified.set(helper.socket, daemon);
    return { ok: true };
  }
  const reason = shot.kind === "result" ? shot.text : shot.kind === "error" ? shot.message : "no answer.";
  return { ok: false, reason: reason.slice(0, 300) || "no frame came back." };
}

/** An external install's daemon, as `pgrep -f` sees it. */
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
 * `hostRunning` is measured AFTER the probe: `cua-driver mcp` auto-launches an
 * external install's daemon, so asking first reported "not running" on a
 * machine that was granted and working by the time the answer came back. The
 * bundled helper's daemon is Telar's to start, and is started first.
 */
export async function computerUseStatus(probe: ComputerUseProbe = {}, timeoutMs = 30_000, deps: HelperDeps = {}): Promise<ComputerUseStatus> {
  const resolved = resolveComputerUse(probe);
  if (!resolved || resolved.server.spec.transport !== "stdio") return { installed: false, hostRunning: false };
  const spec = resolved.server.spec;
  const { helper } = resolved;
  if (helper) {
    let up = await ensureHelperDaemon(helper, deps);
    const fresh = await probeHelperGrants(helper, false, deps);
    // Without the fresh probe, the daemon's own (possibly stale) booleans are
    // the best there is.
    const grants: HelperGrants | undefined =
      "error" in fresh ? (up ? daemonGrants(await callTool(spec, "check_permissions", { prompt: false }, timeoutMs, deps)) : undefined) : fresh;
    let outcome: ProbeOutcome & { missing?: ComputerUsePane[] };
    if (!grants) {
      outcome = { permission: "unknown", message: "error" in fresh ? fresh.error : NO_ANSWER };
    } else if (missingPanes(grants).length > 0) {
      const missing = missingPanes(grants);
      outcome = { permission: "denied", message: `Not granted: ${missing.map((pane) => PANE_LABEL[pane]).join(", ")}.`, missing };
    } else if (!up) {
      outcome = { permission: "unknown", message: "The computer-use helper did not start." };
    } else {
      // READY IS A CAPTURE, NOT A BOOLEAN. A daemon still holding an answer
      // macOS cached before the grant, or one whose preflight is simply wrong
      // for it (cua: "unreliable for CLI / child processes"), is restarted —
      // ours only — and tried once more.
      // At most once a minute: the pane polls every few seconds while the
      // person is in System Settings.
      let capture = await daemonCaptures(spec, helper, timeoutMs, deps);
      const now = (probe.now ?? Date.now)();
      if (!capture.ok && !capture.unknown && now - (lastRestart.get(helper.socket) ?? -Infinity) >= 60_000) {
        lastRestart.set(helper.socket, now);
        up = await restartHelperDaemon(helper, deps);
        if (up) capture = await daemonCaptures(spec, helper, timeoutMs, deps);
      }
      outcome = capture.ok
        ? { permission: "granted", missing: [] }
        : { permission: capture.unknown ? "unknown" : "denied", message: `Screen Recording is on, but the helper could not capture a window: ${capture.reason}` };
    }
    return {
      installed: true,
      bundled: true,
      backend: resolved.backend,
      hostRunning: up,
      permission: outcome.permission,
      ...(outcome.message ? { message: outcome.message } : {}),
      ...(outcome.missing ? { missing: outcome.missing } : {}),
    };
  }
  const outcome = interpretListApps(await callTool(spec, "list_apps", {}, timeoutMs, deps));
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
  // BUNDLED, "running" is "started": Telar's helper daemon starts with nothing
  // to draw (cua's gate off, no prompt asked), so the start-time probe may
  // start it rather than wait for someone to open the pane. An external install
  // is only probed when CuaDriver is already up, for the reason above.
  const hostRunning =
    deps.hostRunning ??
    (() => {
      const helper = resolveComputerUse(probe)?.helper;
      return helper ? ensureHelperDaemon(helper) : running(CUA_DAEMON_PATTERN);
    });
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
    forClaim: () => {
      if (!(last?.status.installed && last.status.permission === "granted")) return undefined;
      const resolved = resolveComputerUse(probe);
      // The bundled proxy never launches a daemon itself (it would reach for
      // CuaDriver.app), so a claim revives ours if it has gone. Deduplicated,
      // and a socket connect when it is up.
      if (resolved?.helper) void ensureHelperDaemon(resolved.helper);
      return resolved;
    },
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
