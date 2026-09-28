const fs = require("node:fs");
const path = require("node:path");

const TerminalFate = Object.freeze({
  EXITED: "exited",

  FAILED: "failed",
});

const CloseReason = Object.freeze({
  CLOSE: "close",
  SESSION: "session",
  QUIT: "quit",
});

const TerminalOwner = Object.freeze({
  RENDERER: "renderer",
  ENGINE: "engine",
});

function terminalOwner(value) {
  if (value === undefined || value === null) return TerminalOwner.RENDERER;
  if (value === TerminalOwner.RENDERER || value === TerminalOwner.ENGINE) return value;
  throw new Error(`Telar does not know the terminal owner ${JSON.stringify(value)}.`);
}

const TerminalOrigin = Object.freeze({
  USER: "user",
  AGENT: "agent",
  RUN: "run",
});

function terminalOrigin(value, owner) {
  if (value === undefined || value === null) return owner === TerminalOwner.ENGINE ? TerminalOrigin.RUN : TerminalOrigin.USER;
  const allowed = owner === TerminalOwner.ENGINE ? [TerminalOrigin.AGENT, TerminalOrigin.RUN] : [TerminalOrigin.USER];
  if (allowed.includes(value)) return value;
  throw new Error(`A terminal opened by the ${owner} cannot have the origin ${JSON.stringify(value)}.`);
}

function shortText(value, max) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

const TERM = "xterm-256color";

const COLORTERM = "truecolor";

const TERM_PROGRAM = "Telar";

const CLOSE_GRACE_MS = 1_000;

function readProcessTable(deps = {}) {
  const execFile = deps.execFile ?? require("node:child_process").execFile;
  return new Promise((resolve, reject) => {
    execFile(
      "ps",
      ["-A", "-ww", "-o", "pid=,ppid=,pgid=,tpgid=,tty=,command="],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } },
      (error, stdout) => (error ? reject(error) : resolve(parseProcessTable(stdout))),
    );
  });
}

function parseProcessTable(text) {
  const rows = [];
  for (const line of String(text || "").split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s?(.*)$/.exec(line);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      tpgid: Number(match[4]),
      tty: match[5],
      command: match[6].trim(),
    });
  }
  return rows;
}

function ttyName(value) {
  if (typeof value !== "string") return undefined;
  const name = value.replace(/^\/dev\//, "").trim();
  return name && !/^\?+$/.test(name) ? name : undefined;
}

function terminalActivity(terminal, rows) {
  const tty = ttyName(terminal.tty);
  const shell = rows.find((row) => row.pid === terminal.pid);
  const members = rows.filter(
    (row) =>
      row.pid !== terminal.pid &&
      (row.ppid === terminal.pid || row.pgid === terminal.pid || (tty !== undefined && ttyName(row.tty) === tty)),
  );
  const foreground = shell && shell.tpgid > 1 && shell.tpgid !== terminal.pid ? shell.tpgid : undefined;
  const lead =
    (foreground !== undefined && (members.find((row) => row.pid === foreground) ?? members.find((row) => row.pgid === foreground))) ||
    members[0];
  const groups = [...new Set([terminal.pid, ...members.map((row) => row.pgid)])].filter((group) => Number.isInteger(group) && group > 1);
  return {
    active: foreground !== undefined || members.length > 0,
    processes: members.length,
    command: lead ? lead.command : undefined,
    groups,
  };
}

function decideQuit(terminals) {
  const list = Array.isArray(terminals) ? terminals : [];
  const busy = list.filter((terminal) => terminal && terminal.active);
  if (busy.length === 0) return { action: "quit", closing: list.length };
  const count = busy.length;
  const shown = busy.slice(0, 5).map((terminal) => `• ${clip(terminal.command || "a command", 80)}`);
  if (count > shown.length) shown.push(`…and ${count - shown.length} more`);
  return {
    action: "confirm",
    count,
    closing: list.length,
    dialog: {
      type: "warning",
      message: count === 1 ? "1 process is still running in Telar's terminals" : `${count} processes are still running in Telar's terminals`,
      detail:
        `${shown.join("\n")}\n\n` +
        "Quitting Telar closes its terminals and ends everything running in them. " +
        "Work they have not saved or finished will be lost.",
      buttons: ["End them and quit", "Cancel"],
      defaultId: 0,
      cancelId: 1,
    },
  };
}

function busyTerminals(terminals) {
  const busy = (Array.isArray(terminals) ? terminals : []).filter((terminal) => terminal && terminal.active);
  return { count: busy.length, commands: busy.slice(0, 5).map((terminal) => clip(terminal.command || "a command", 80)) };
}

function clip(text, max) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function terminalEnv(baseEnv, version) {
  const env = {};
  for (const [key, value] of Object.entries(baseEnv || {})) {
    if (typeof value === "string") env[key] = value;
  }
  delete env.ELECTRON_RUN_AS_NODE;
  env.TERM = TERM;
  if (typeof env.COLORTERM !== "string" || env.COLORTERM.trim() === "") env.COLORTERM = COLORTERM;
  env.TERM_PROGRAM = TERM_PROGRAM;
  if (version) env.TERM_PROGRAM_VERSION = String(version);
  return env;
}

function killTerminalTree(pid, signal, deps = {}) {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Telar cannot signal a terminal without a process id (got ${JSON.stringify(pid)}).`);
  }
  const platform = deps.platform ?? process.platform;
  if (platform === "win32") {
    const run = deps.spawnSync ?? require("node:child_process").spawnSync;

    const result = run("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true });
    if (result && result.error) throw result.error;
    return;
  }
  const kill = deps.kill ?? ((target, sig) => process.kill(target, sig));
  kill(-pid, signal);
}

function ensureSpawnHelper(deps = {}) {
  const platform = deps.platform ?? process.platform;
  if (platform === "win32") return { path: null, changed: false };
  const fs = deps.fs ?? require("node:fs");
  const libDir = deps.libDir ?? path.dirname(require.resolve("node-pty"));
  const candidates = spawnHelperCandidates(libDir, platform, deps.arch ?? process.arch);
  const helper = candidates.find((candidate) => fs.existsSync(candidate));
  if (!helper) {
    throw new Error(
      `Telar could not find node-pty's spawn-helper. Looked in: ${candidates.join(", ")}. ` +
        "Without it every terminal fails with posix_spawnp.",
    );
  }
  const mode = fs.statSync(helper).mode;
  if ((mode & 0o111) !== 0) return { path: helper, changed: false };
  try {
    fs.chmodSync(helper, (mode & 0o7777) | 0o755);
  } catch (error) {
    throw new Error(
      `Telar could not make node-pty's spawn-helper executable at ${helper}: ${messageOf(error)}. ` +
        "node-pty ships it mode 0644 and never chmods it, so every terminal would fail with posix_spawnp.",
    );
  }
  return { path: helper, changed: true };
}

function spawnHelperCandidates(libDir, platform, arch) {
  const paths = [];
  for (const build of ["build/Release", "build/Debug", `prebuilds/${platform}-${arch}`]) {
    for (const root of ["..", "."]) {
      paths.push(
        path
          .resolve(libDir, root, build, "spawn-helper")
          .replace("app.asar", "app.asar.unpacked")
          .replace("node_modules.asar", "node_modules.asar.unpacked"),
      );
    }
  }
  return paths;
}

function nodePtySpawner() {
  const ptyModule = require("node-pty");
  ensureSpawnHelper();
  return (file, args, options) => ptyModule.spawn(file, args, options);
}

function unusableCwd(cwd, deps = {}) {
  if (cwd === undefined || cwd === null || cwd === "") return null;
  if (typeof cwd !== "string") {
    return `Telar was asked to start a terminal in ${JSON.stringify(cwd)}, which is not a path. No process was started.`;
  }
  const io = deps.fs ?? fs;
  let stats;
  try {
    stats = io.statSync(cwd);
  } catch (error) {
    return `Telar cannot start a terminal in ${cwd}: ${messageOf(error)}. No process was started.`;
  }
  if (!stats.isDirectory()) {
    return `Telar cannot start a terminal in ${cwd}: it exists but is not a directory. No process was started.`;
  }
  try {
    io.accessSync(cwd, fs.constants.X_OK);
  } catch (error) {
    return `Telar cannot start a terminal in ${cwd}: it is a directory this process may not enter (${messageOf(error)}). No process was started.`;
  }
  return null;
}

class TerminalHost {
  constructor(options = {}) {
    this.platform = options.platform ?? process.platform;
    this.now = options.now ?? Date.now;
    this.version = options.version ?? require("./package.json").version;
    this.onData = options.onData ?? (() => {});
    this.onExit = options.onExit ?? (() => {});
    this.closeGraceMs = options.closeGraceMs ?? CLOSE_GRACE_MS;
    this.killTree = options.killTree ?? ((pid, signal) => killTerminalTree(pid, signal, { platform: this.platform }));

    this.listProcesses = options.listProcesses ?? (() => readProcessTable());
    this.setTimer = options.setTimeout ?? setTimeout;
    this.clearTimer = options.clearTimeout ?? clearTimeout;

    this.fs = options.fs ?? fs;

    this._spawnPty = options.spawnPty ?? null;

    this.terminals = new Map();
    this.sequence = 0;
    this.disposed = false;
  }

  get spawnPty() {
    if (!this._spawnPty) this._spawnPty = nodePtySpawner();
    return this._spawnPty;
  }

  open(request = {}) {
    if (this.disposed) throw new Error("Telar's terminal host is shutting down and will not start another shell.");
    const owner = terminalOwner(request.owner);
    const origin = terminalOrigin(request.origin, owner);
    const sessionId = shortText(request.sessionId, 200);
    const title = shortText(request.title, 200);

    const baseEnv = request.env ?? process.env;
    const shell = typeof request.shell === "string" && request.shell.trim() ? request.shell : defaultShell(this.platform, baseEnv);
    const args = Array.isArray(request.args) ? request.args.filter((arg) => typeof arg === "string") : [];
    const cols = size(request.cols, 80);
    const rows = size(request.rows, 24);
    const env = terminalEnv(baseEnv, this.version);
    const id = `term_${(this.sequence += 1).toString(36)}_${this.now().toString(36)}`;

    const refusal = unusableCwd(request.cwd, { fs: this.fs });
    if (refusal) {
      const ending = { id, fate: TerminalFate.FAILED, error: refusal, at: this.now() };
      this.onExit(id, ending);
      return { id, pid: undefined, ending };
    }

    let pty;
    try {
      pty = this.spawnPty(shell, args, {
        name: TERM,
        cols,
        rows,
        cwd: request.cwd || undefined,
        env,
      });
    } catch (error) {
      const ending = { id, fate: TerminalFate.FAILED, error: messageOf(error), at: this.now() };
      this.onExit(id, ending);
      return { id, pid: undefined, ending };
    }

    const record = {
      id,
      owner,
      origin,
      sessionId,
      title,
      pty,
      pid: pty.pid,

      tty: typeof pty.ptsName === "string" ? pty.ptsName : undefined,
      shell,
      args,
      cwd: request.cwd,
      cols,
      rows,
      startedAt: this.now(),
      closing: null,

      closeReason: null,
      onLeaderExit: null,
    };
    this.terminals.set(id, record);

    if (typeof pty.on === "function") {
      pty.on("error", () => {});
      pty.on("error", () => {});
    }
    pty.onData((data) => {
      if (this.terminals.get(id) === record) this.onData(id, data);
    });
    pty.onExit((ending) => {
      this._settle(record, {
        fate: TerminalFate.EXITED,
        exitCode: typeof ending?.exitCode === "number" ? ending.exitCode : undefined,
        signal: ending?.signal ? String(ending.signal) : undefined,
        ...(record.closeReason ? { closed: record.closeReason } : {}),
      });

      if (record.onLeaderExit) record.onLeaderExit();
    });
    return { id, pid: record.pid };
  }

  write(id, data, owner) {
    const record = this._owned(id, owner);
    if (!record || typeof data !== "string") return false;
    record.pty.write(data);
    return true;
  }

  resize(id, cols, rows, owner) {
    const record = this._owned(id, owner);
    if (!record) return false;
    record.cols = size(cols, record.cols);
    record.rows = size(rows, record.rows);
    record.pty.resize(record.cols, record.rows);
    return true;
  }

  kill(id, signal = "SIGTERM", owner) {
    const record = this._owned(id, owner);
    if (!record) return false;
    try {
      this.killTree(record.pid, signal);
    } catch (error) {
      return Boolean(error && error.code === "ESRCH");
    }
    return true;
  }

  list(owner) {
    const scope = terminalOwner(owner);
    return [...this.terminals.values()].filter((record) => record.owner === scope).map(facts);
  }

  describe(id, owner) {
    const record = this._owned(id, owner);
    return record ? facts(record) : undefined;
  }

  countBySession() {
    const counts = {};
    for (const record of this.terminals.values()) {
      if (record.sessionId) counts[record.sessionId] = (counts[record.sessionId] ?? 0) + 1;
    }
    return counts;
  }

  get size() {
    return this.terminals.size;
  }

  async close(id, owner, options = {}) {
    const record = this._owned(id, owner);
    if (!record) return false;
    await this._close([record], { ...options, reason: CloseReason.CLOSE });
    return true;
  }

  async killBySession(sessionId, options = {}) {
    const wanted = shortText(sessionId, 200);
    if (!wanted) return 0;
    const scope = options.owner === undefined ? undefined : terminalOwner(options.owner);
    const records = [...this.terminals.values()].filter(
      (record) => record.sessionId === wanted && (scope === undefined || record.owner === scope),
    );
    await this._close(records, { ...options, reason: CloseReason.SESSION });
    return records.length;
  }

  async closeAll(options = {}) {
    if (options.final) this.disposed = true;
    const records = [...this.terminals.values()];
    await this._close(records, { ...options, reason: CloseReason.QUIT });
    return records.length;
  }

  async activeProcesses(options = {}) {
    const scope = options.owner === undefined ? undefined : terminalOwner(options.owner);
    const ids = Array.isArray(options.ids) ? new Set(options.ids.map(String)) : undefined;
    const records = [...this.terminals.values()].filter(
      (record) => (scope === undefined || record.owner === scope) && (ids === undefined || ids.has(record.id)),
    );
    if (records.length === 0) return [];
    const rows = await this._snapshot();
    return records.map((record) => {
      const activity = rows ? terminalActivity(record, rows) : { active: true, processes: 0, command: undefined };
      return {
        id: record.id,
        sessionId: record.sessionId,
        origin: record.origin,
        title: record.title,
        active: activity.active,
        processes: activity.processes,
        command: activity.command,
      };
    });
  }

  ownerOf(id) {
    const record = this.terminals.get(id);
    return record ? record.owner : undefined;
  }

  dispose() {
    this.disposed = true;
    const records = [...this.terminals.values()];
    return Promise.all(records.map((record) => this._closeRecord(record, null, { reason: CloseReason.QUIT })));
  }

  async _snapshot() {
    if (this.platform === "win32") return null;
    try {
      return await this.listProcesses();
    } catch {
      return null;
    }
  }

  async _close(records, options) {
    if (records.length === 0) return;

    const rows = records.some((record) => !record.closing) ? await this._snapshot() : null;
    await Promise.all(records.map((record) => this._closeRecord(record, rows, options)));
  }

  _closeRecord(record, rows, options) {
    if (record.closing) return record.closing;
    record.closeReason = options.reason ?? CloseReason.CLOSE;
    const graceMs = options.graceMs ?? this.closeGraceMs;
    const groups = rows ? terminalActivity(record, rows).groups : [record.pid];
    record.closing = new Promise((resolve) => {
      const pending = new Set();

      if (this.platform !== "win32") {
        try {
          this.killTree(record.pid, "SIGHUP");
        } catch {
        }
      }
      for (const group of groups) {
        try {
          this.killTree(group, "SIGTERM");
          pending.add(group);
        } catch {
        }
      }

      if (pending.size === 0 || this.platform === "win32") {
        resolve();
        return;
      }
      let timer = null;
      const finish = () => {
        if (timer !== null) this.clearTimer(timer);
        timer = null;
        record.onLeaderExit = null;
        resolve();
      };
      record.onLeaderExit = () => {
        for (const group of [...pending]) {
          try {
            this.killTree(group, 0);
          } catch (error) {
            if (error && error.code === "ESRCH") pending.delete(group);
          }
        }
        if (pending.size === 0) finish();
      };
      timer = this.setTimer(() => {
        timer = null;
        for (const group of pending) {
          try {
            this.killTree(group, "SIGKILL");
          } catch {
          }
        }
        finish();
      }, graceMs);
    });
    return record.closing;
  }

  drain(ms = 400) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  _owned(id, owner) {
    const scope = terminalOwner(owner);
    const record = this.terminals.get(id);
    return record && record.owner === scope ? record : undefined;
  }

  _settle(record, ending) {
    if (!this.terminals.has(record.id) || this.terminals.get(record.id) !== record) return;
    this.terminals.delete(record.id);
    this.onExit(record.id, { id: record.id, pid: record.pid, at: this.now(), ...ending });
  }
}

function defaultShell(platform, env) {
  if (platform === "win32") return (env && env.COMSPEC) || "cmd.exe";
  const chosen = env && typeof env.SHELL === "string" ? env.SHELL.trim() : "";
  return chosen || "/bin/sh";
}

function facts(record) {
  return {
    id: record.id,
    pid: record.pid,
    sessionId: record.sessionId,
    origin: record.origin,
    title: record.title,
    shell: record.shell,
    cwd: record.cwd,
    cols: record.cols,
    rows: record.rows,
    startedAt: record.startedAt,
  };
}

function size(value, fallback) {
  const rounded = Math.floor(Number(value));
  return Number.isFinite(rounded) && rounded > 0 ? Math.min(rounded, 9999) : fallback;
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

module.exports = {
  TerminalHost,
  TerminalFate,
  TerminalOwner,
  TERM,
  TERM_PROGRAM,
  CLOSE_GRACE_MS,
  terminalEnv,
  parseProcessTable,
  terminalActivity,
  decideQuit,
  busyTerminals,
  killTerminalTree,
  ensureSpawnHelper,
  spawnHelperCandidates,
  unusableCwd,
  defaultShell,
};
