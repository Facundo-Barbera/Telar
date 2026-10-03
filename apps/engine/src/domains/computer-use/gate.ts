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

export const COMPUTER_USE_SERVER_ID = "mac";

export type ResolvedComputerUse = { server: McpServer; backend: ComputerUseBackend; helper?: BundledHelper };

const CUA_APP_BINARY = "/Applications/CuaDriver.app/Contents/MacOS/cua-driver";
const cuaSymlink = (home: string) => path.join(home, ".local", "bin", "cua-driver");

export const COMPUTER_USE_HELPER_BUNDLE_ID = "com.telar.desktop.computer-use";

export type BundledHelper = {
  app: string;
  binary: string;
  bundleId: string;
  socket: string;
  pidFile: string;
  stateDir: string;
  env: Record<string, string>;
};

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
      CUA_DRIVER_RS_PERMISSIONS_GATE: "0",
    },
  };
}

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

function resolveCua(env: Record<string, string | undefined>, home: string, exists: (candidate: string) => boolean, at: number): ResolvedComputerUse | undefined {
  const bundledApp = env.TELAR_COMPUTER_USE_HELPER?.trim();
  if (bundledApp) {
    const helper = bundledHelper(bundledApp, home);
    if (!exists(helper.binary)) return undefined;
    return { backend: "cua", helper, server: server(helper.binary, ["mcp", "--socket", helper.socket], at, { ...helper.env, CUA_DRIVER_EMBEDDED: "1" }) };
  }
  const override = env.CUA_DRIVER_BIN?.trim();
  const command = [override, cuaSymlink(home), CUA_APP_BINARY].find((candidate): candidate is string => Boolean(candidate) && exists(candidate!));
  if (!command) return undefined;
  return { backend: "cua", server: server(command, ["mcp"], at) };
}

function socketListening(socket: string, timeoutMs = 1_000): Promise<boolean> {
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
  processes?: () => { pid: number; command: string }[];
  kill?: (pid: number, signal: NodeJS.Signals) => void;
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

export function helperDaemonPids(helper: BundledHelper, deps: HelperDeps = {}): number[] {
  return (deps.processes ?? psProcesses)()
    .filter(({ command }) => command.startsWith(`${helper.binary} serve`) && command.includes(`--socket ${helper.socket}`))
    .map(({ pid }) => pid);
}

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
      }
    }
  }
  return undefined;
}

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
    if (helperDaemonPids(helper, deps).length > 0) return waitForSocket();
    const release = takeLaunchLock(helper, timeoutMs + 5_000);
    if (!release) return waitForSocket();
    try {
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

function stopHelperDaemon(helper: BundledHelper, deps: HelperDeps = {}): boolean {
  const pids = helperDaemonPids(helper, deps);
  for (const pid of pids) {
    try {
      (deps.kill ?? ((target, signal) => process.kill(target, signal)))(pid, "SIGTERM");
    } catch {
    }
  }
  return pids.length > 0;
}

async function restartHelperDaemon(helper: BundledHelper, deps: HelperDeps = {}, timeoutMs = 5_000): Promise<boolean> {
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
  exists?: (candidate: string) => boolean;
  now?: () => number;
};

export function resolveComputerUse(probe: ComputerUseProbe = {}): ResolvedComputerUse | undefined {
  const env = probe.env ?? process.env;
  if (env.TELAR_COMPUTER_USE === "0") return undefined;
  if ((probe.platform ?? process.platform) !== "darwin") return undefined;

  const exists = probe.exists ?? fs.existsSync;
  const home = probe.home ?? os.homedir();
  const at = (probe.now ?? Date.now)();
  return resolveCua(env, home, exists, at);
}

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

async function probeHelperGrants(helper: BundledHelper, request: boolean, deps: HelperDeps = {}): Promise<HelperGrants | { error: string }> {
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

export async function revealComputerUseHelper(probe: ComputerUseProbe = {}, deps: HelperDeps = {}): Promise<{ revealed: boolean }> {
  const helper = resolveComputerUse(probe)?.helper;
  if (!helper) return { revealed: false };
  return { revealed: await (deps.open ?? runOpen)(["-R", helper.app]) };
}

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

function callTool(spec: StdioSpec, name: string, args: Record<string, unknown>, timeoutMs: number, deps: HelperDeps = {}): Promise<ToolAnswer> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = (deps.spawn ?? spawn)(spec.command, spec.args ?? [], { env: { ...process.env, ...spec.env }, stdio: ["pipe", "pipe", "ignore"] });
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
    child.stdin?.on("error", () => undefined);

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

export function interpretListApps(answer: ToolAnswer): ProbeOutcome {
  if (answer.kind === "timeout") return { permission: "unknown", message: NO_ANSWER };
  if (answer.kind === "error") return { permission: classifyProbeError(answer.message), message: answer.message.slice(0, 400) };
  return answer.isError ? { permission: classifyProbeError(answer.text), message: answer.text.slice(0, 400) } : { permission: "granted" };
}

function daemonGrants(answer: ToolAnswer): HelperGrants | undefined {
  const report = answer.kind === "result" ? answer.structured : undefined;
  return report ? { accessibility: report.accessibility === true, screenRecording: report.screen_recording === true } : undefined;
}

const captureVerified = new Map<string, string>();
const lastRestart = new Map<string, number>();

type CaptureCheck = { ok: true } | { ok: false; unknown?: boolean; reason: string };

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

export async function computerUseStatus(probe: ComputerUseProbe = {}, timeoutMs = 30_000, deps: HelperDeps = {}): Promise<ComputerUseStatus> {
  const resolved = resolveComputerUse(probe);
  if (!resolved || resolved.server.spec.transport !== "stdio") return { installed: false, hostRunning: false };
  const spec = resolved.server.spec;
  const { helper } = resolved;
  if (helper) {
    let up = await ensureHelperDaemon(helper, deps);
    const fresh = await probeHelperGrants(helper, false, deps);
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

type ComputerUseMeasurement = { status: ComputerUseStatus; measuredAt: number };
export type ComputerUseGate = {
  last(): ComputerUseMeasurement | undefined;
  measure(): Promise<ComputerUseStatus>;
  forClaim(): ResolvedComputerUse | undefined;
  measureIfHostRunning(): Promise<ComputerUseStatus | undefined>;
};

export function createComputerUseGate(
  probe: ComputerUseProbe = {},
  deps: { status?: (probe: ComputerUseProbe) => Promise<ComputerUseStatus>; hostRunning?: () => Promise<boolean>; now?: () => number } = {},
): ComputerUseGate {
  const status = deps.status ?? ((p: ComputerUseProbe) => computerUseStatus(p));
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
      if (resolved?.helper) void ensureHelperDaemon(resolved.helper);
      return resolved;
    },
    async measureIfHostRunning() {
      try {
        if (!resolveComputerUse(probe)) return undefined;
        if (!(await hostRunning())) return undefined;
        return await measure();
      } catch {
        return undefined;
      }
    },
  };
}

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

export function claimHasComputerUse(servers: readonly McpServer[] | undefined): boolean {
  return Boolean(servers?.some((server) => server.id === COMPUTER_USE_SERVER_ID));
}
