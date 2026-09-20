/**
 * A REAL PTY, AND IT LIVES HERE RATHER THAN IN THE ENGINE (#198).
 *
 * WHY THE SHELL AND NOT THE DAEMON, because this is the first thing the next
 * person will want to move. The engine runs under TWO runtimes: `bun run
 * src/main.ts` in development, and Electron-as-node when packaged — main.js
 * forks it with `execPath: nodeExecPath()` and `ELECTRON_RUN_AS_NODE: "1"`. A
 * native addon over there would have to load under both. In Electron main there
 * is one ABI, and the browser host already lives in this process.
 *
 * POLICY STAYS IN THE ENGINE; THIS MODULE HOLDS THE HANDLE. It owns PTYs and
 * reports facts about them. It does not decide what a dead PTY means for a
 * project's deployment slot — apps/engine/src/run/ does, and the difference
 * matters most in the one case below.
 *
 * `unknown` IS NOT A ROUNDING OF `exited`. In apps/engine/src/run/types.ts the
 * status `unknown` means "we cannot vouch that this is dead", and an `unknown`
 * run KEEPS HOLDING ITS PROJECT'S SLOT. So this host never reports a clean exit
 * it did not observe: the only thing that produces `exited` is node-pty's own
 * exit event, carrying a code. Everything else — the host torn down with
 * terminals still live, a kill we issued and never saw land, a handle that
 * threw — is `unknown`, with the pid in the message so a human can go and look.
 * The failure being designed against is the quiet one: this process dies, and
 * something downstream frees a slot for a server that is still listening.
 *
 * WHAT WE PUT IN THE ENVIRONMENT, AND NOTHING ELSE. Telar is a terminal
 * emulator, not a shell configurator. We contribute the window, the tabs, the
 * font and an honest identity; the user's dotfiles own the rest, including when
 * the result looks wrong under our theme. See `terminalEnv`.
 *
 * NO `require("electron")` AT LOAD, and no `require("node-pty")` either — the
 * same rule chord-scope.js states for the first reason, plus a second for the
 * second: the desktop unit suite runs on ubuntu-latest (.github/workflows/
 * verify.yml, the `test` matrix) and node-pty publishes no linux prebuild. The
 * native module is reached through an injected `spawnPty` that defaults to a
 * lazy require, so these tests never load it and the real proof lives in
 * pty-host.electron-test.js instead.
 */
const path = require("node:path");

/**
 * WHAT WE CAN HONESTLY SAY ABOUT A TERMINAL THAT IS NO LONGER RUNNING.
 *
 * Exported as a vocabulary rather than three string literals because the engine
 * has to map these onto `RunStatus` and the mapping is not symmetric: `exited`
 * and `failed` are terminal and release the slot, `unknown` is terminal for us
 * and NOT terminal for the engine.
 */
const TerminalFate = Object.freeze({
  /** node-pty reported an exit and we have its code. The only clean claim. */
  EXITED: "exited",
  /** The spawn itself threw; no process was ever created. */
  FAILED: "failed",
  /** We stopped being able to vouch. The slot stays held; nobody is signalled. */
  UNKNOWN: "unknown",
});

/** The terminal type we claim to be, and the one xterm.js is configured for. */
const TERM = "xterm-256color";

/**
 * THIS STRING IS PUBLIC API.
 *
 * `$TERM_PROGRAM` is what a person's shell branches on, and people branch on it
 * — the owner's own ~/.zshrc does. It is `Telar`, it is stable, and renaming it
 * silently breaks dotfiles we never see. If it ever has to change, that is a
 * release note, not a refactor.
 */
const TERM_PROGRAM = "Telar";

/** How long a killed terminal has to actually report its exit before we stop
 *  vouching for it. Past this we say `unknown` rather than guess `exited`. */
const KILL_OBSERVE_MS = 5_000;

/**
 * THE ENVIRONMENT A TELAR TERMINAL STARTS IN.
 *
 * Three variables added and one REMOVED, and the removal is the interesting
 * half. `ELECTRON_RUN_AS_NODE=1` is something Telar puts in its own children's
 * environment (main.js `childEnv`), so a shell opened from inside Telar
 * inherits it — and then every `electron` the user runs in that shell silently
 * becomes a bare node. package-desktop.sh carries a paragraph about being bitten
 * by exactly this. Taking our own marker back out is not configuring their
 * shell; it is not lying to it.
 *
 * Nothing else is touched. No PATH repair, no prompt wrapper, no colour fix.
 */
function terminalEnv(baseEnv, version) {
  const env = {};
  for (const [key, value] of Object.entries(baseEnv || {})) {
    if (typeof value === "string") env[key] = value;
  }
  delete env.ELECTRON_RUN_AS_NODE;
  env.TERM = TERM;
  env.TERM_PROGRAM = TERM_PROGRAM;
  if (version) env.TERM_PROGRAM_VERSION = String(version);
  return env;
}

/**
 * KILLING A TERMINAL'S WHOLE TREE — ONE FUNCTION, WITH `platform` INJECTED.
 *
 * The two platforms do not merely differ in spelling. On POSIX node-pty calls
 * `setsid()`, so the child leads its own session and process group with
 * `pgid === pid`, and `kill(-pid)` reaches the `bun`/`node`/`vite` descendants
 * that a bare `kill(pid)` strands. Windows has no process groups to signal:
 * terminating the shell orphans its children, which keep the port and the CPU,
 * and the only ways out are `taskkill /T` or a Job Object.
 *
 * WINDOWS PACKAGING DOES NOT EXIST TODAY AND THIS DOES NOT ADD IT. What it
 * avoids is blocking it: `platform` is a parameter so the win32 branch is
 * exercised from a Mac, which is the pattern volumes.ts:78, host-path.ts:192
 * and git.ts:168 already use for the same reason.
 *
 * SHAPED LIKE THE ENGINE'S. apps/engine/src/run/manager.ts injects
 * `kill?: (pid, signal) => void` and calls it with a negated pid. This takes the
 * POSITIVE pid and negates internally, because "the group of `pid`" is not
 * expressible as a negative number on Windows — so a shared signature had to
 * pick one, and the one that can describe both platforms is the honest pid.
 */
function killTerminalTree(pid, signal, deps = {}) {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Telar cannot signal a terminal without a process id (got ${JSON.stringify(pid)}).`);
  }
  const platform = deps.platform ?? process.platform;
  if (platform === "win32") {
    const run = deps.spawnSync ?? require("node:child_process").spawnSync;
    // /T the tree, /F because a console application does not answer politely.
    // The signal is not passed on: Windows has no SIGTERM, and pretending it
    // does would make a graceful stop look available when it is not.
    const result = run("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true });
    if (result && result.error) throw result.error;
    return;
  }
  const kill = deps.kill ?? ((target, sig) => process.kill(target, sig));
  kill(-pid, signal);
}

/**
 * MAKE node-pty's `spawn-helper` EXECUTABLE, because the package does not.
 *
 * MEASURED, NOT INFERRED. node-pty ships its darwin prebuilds inside the npm
 * tarball — `prebuilds/darwin-arm64/{pty.node,spawn-helper}` — and the tarball
 * records BOTH as mode 0644. Nothing in the package chmods the helper: the
 * `install` script only decides whether to rebuild, and `postinstall` only
 * tidies `build/Release` for Windows. On macOS node-pty `execl`s that helper,
 * so a fresh install spawns nothing and raises `posix_spawnp failed` — an error
 * that names neither the file nor the mode.
 *
 * It bites BUN ESPECIALLY because bun blocks untrusted install scripts, which
 * is exactly what makes "the scripts never ran" look like the cause. It is not;
 * the scripts would not have fixed it either.
 *
 * Idempotent, and non-fatal by design: a packaged app may sit on a read-only
 * volume where the chmod cannot succeed and the bit was already set at build
 * time (see after-pack.js). What it must never do is let the ORIGINAL error
 * through unexplained, so a failure here is re-raised naming the helper.
 */
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

/**
 * Where node-pty's `spawn-helper` can be, RECONSTRUCTED THE WAY ITS OWN LOADER
 * SEARCHES — `lib/utils.js`'s `loadNativeModule` crosses three build
 * directories with two relative roots, and `lib/unixTerminal.js` then reads the
 * helper as a sibling of whichever one answered.
 *
 * REBUILT RATHER THAN READ OFF THE MODULE, and that is a correction worth
 * leaving here: `require("node-pty").native` is the ADDON, not the
 * `{ dir, module }` pair `loadNativeModule` returns internally, so a `.native.dir`
 * lookup is `undefined` and a repair keyed on it silently does nothing. The
 * Electron test failed twice with an unchanged 0644 helper before that was the
 * answer, which is the whole argument for asserting on the artefact — the mode
 * on disk — rather than on the repair having been called.
 */
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

/** The default `spawnPty`: node-pty, required on first use rather than at load,
 *  with its helper repaired first. */
function nodePtySpawner() {
  const ptyModule = require("node-pty");
  ensureSpawnHelper();
  return (file, args, options) => ptyModule.spawn(file, args, options);
}

/**
 * THE LIVE PTYs, AND THE ONLY THING THAT OWNS THEM.
 *
 * One host per Electron main process. Terminals are addressed by an id minted
 * here rather than by pid: a pid is reused by the operating system, and an id
 * that outlives its process is how a late `write` reaches a stranger.
 */
class TerminalHost {
  /**
   * @param {object} [options]
   * @param {(file: string, args: string[], opts: object) => object} [options.spawnPty]
   * @param {NodeJS.Platform} [options.platform]
   * @param {(pid: number, signal: string) => void} [options.killTree] shaped like
   *   the engine's injected killer so the two can be unified later.
   * @param {(id: string, data: string) => void} [options.onData]
   * @param {(id: string, ending: object) => void} [options.onExit]
   * @param {string} [options.version] what `$TERM_PROGRAM_VERSION` reports.
   */
  constructor(options = {}) {
    this.platform = options.platform ?? process.platform;
    this.now = options.now ?? Date.now;
    this.version = options.version ?? require("./package.json").version;
    this.onData = options.onData ?? (() => {});
    this.onExit = options.onExit ?? (() => {});
    this.killObserveMs = options.killObserveMs ?? KILL_OBSERVE_MS;
    this.killTree = options.killTree ?? ((pid, signal) => killTerminalTree(pid, signal, { platform: this.platform }));
    // Lazy on purpose: constructing a host must not load a native module, so a
    // window that never opens a terminal never pays for one.
    this._spawnPty = options.spawnPty ?? null;
    /** @type {Map<string, object>} */
    this.terminals = new Map();
    this.sequence = 0;
    this.disposed = false;
  }

  get spawnPty() {
    if (!this._spawnPty) this._spawnPty = nodePtySpawner();
    return this._spawnPty;
  }

  /**
   * Start a shell on a pseudo-terminal.
   *
   * `shell` and `args` are the caller's — a terminal emulator runs what it is
   * asked to run. What this adds is the environment above and a size, because
   * a PTY without one reports 0×0 and every full-screen program draws nothing.
   */
  open(request = {}) {
    if (this.disposed) throw new Error("Telar's terminal host is shutting down and will not start another shell.");
    // ONE base environment, read once: the fallback shell comes from `$SHELL`,
    // so resolving it against a different environment than the one the child
    // gets would answer /bin/sh for a person whose shell is fish.
    const baseEnv = request.env ?? process.env;
    const shell = typeof request.shell === "string" && request.shell.trim() ? request.shell : defaultShell(this.platform, baseEnv);
    const args = Array.isArray(request.args) ? request.args.filter((arg) => typeof arg === "string") : [];
    const cols = size(request.cols, 80);
    const rows = size(request.rows, 24);
    const env = terminalEnv(baseEnv, this.version);
    const id = `term_${(this.sequence += 1).toString(36)}_${this.now().toString(36)}`;

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
      // NEVER STARTED IS NOT UNKNOWN. There is no process to be uncertain
      // about, so this is the one failure a caller may treat as terminal.
      const ending = { id, fate: TerminalFate.FAILED, error: messageOf(error), at: this.now() };
      this.onExit(id, ending);
      return { id, pid: undefined, ending };
    }

    const record = { id, pty, pid: pty.pid, shell, args, cwd: request.cwd, cols, rows, startedAt: this.now(), killTimer: null };
    this.terminals.set(id, record);
    /**
     * A PTY'S FD ERRORING MUST NOT ABORT THE WHOLE SHELL.
     *
     * node-pty's socket handler rethrows anything that is not EAGAIN or EIO
     * (`lib/unixTerminal.js:123`, again at `:206`), and that throw comes out of
     * a stream callback in the MAIN process — uncatchable by any caller, so it
     * takes Electron with it and loses every other terminal's fate at once.
     * Handled here as `unknown`, which is what "we can no longer vouch for it"
     * means.
     *
     * TWO LISTENERS BECAUSE NODE-PTY COUNTS THEM: it rethrows while
     * `listeners('error').length < 2`, and `Terminal._forwardEvents`
     * (`lib/terminal.js:90`) registers only `data` and `exit`, so reaching two
     * is ours to do. The second handler is deliberately empty.
     *
     * HONEST LIMIT, because this was measured and the obvious reading is wrong:
     * reaching two listeners did NOT stop the `Napi::Error` abort seen at
     * shutdown — 4 aborts in 10 runs with two listeners against 2 in 10 with
     * one, which for n=10 says only that the listener count is not what drives
     * it. That abort has a different cause and is handled where it actually
     * happens; see `drain()`. This block is kept for the EIO/stream path it
     * genuinely covers, and its comment says what it does not cover.
     */
    if (typeof pty.on === "function") {
      pty.on("error", (error) => {
        this._settle(record, {
          fate: TerminalFate.UNKNOWN,
          reason: `this terminal's pseudo-terminal raised ${messageOf(error)} (pid ${record.pid}); Telar cannot vouch that its process group has ended`,
        });
      });
      pty.on("error", () => {});
    }
    pty.onData((data) => {
      if (this.terminals.get(id) === record) this.onData(id, data);
    });
    pty.onExit((ending) => {
      // THE ONLY PRODUCER OF `exited`. node-pty told us, with a code.
      this._settle(record, {
        fate: TerminalFate.EXITED,
        exitCode: typeof ending?.exitCode === "number" ? ending.exitCode : undefined,
        signal: ending?.signal ? String(ending.signal) : undefined,
      });
    });
    return { id, pid: record.pid };
  }

  /** Bytes from the keyboard. A write to a terminal that has ended is dropped
   *  rather than thrown: the renderer learns of the exit asynchronously, so a
   *  keystroke in flight across that gap is normal and is not an error. */
  write(id, data) {
    const record = this.terminals.get(id);
    if (!record || typeof data !== "string") return false;
    record.pty.write(data);
    return true;
  }

  /** The window was resized. SIGWINCH is the PTY's job, not ours. */
  resize(id, cols, rows) {
    const record = this.terminals.get(id);
    if (!record) return false;
    record.cols = size(cols, record.cols);
    record.rows = size(rows, record.rows);
    record.pty.resize(record.cols, record.rows);
    return true;
  }

  /**
   * Signal a terminal's whole tree, and START A CLOCK ON OUR OWN CLAIM.
   *
   * A kill that lands produces a real exit event and the terminal settles
   * `exited` through the normal path. A kill that does not land leaves a
   * process we asked to die and never saw die — so after `killObserveMs` this
   * settles `unknown` rather than letting the record sit open forever or
   * reporting an exit nobody observed.
   */
  kill(id, signal = "SIGTERM") {
    const record = this.terminals.get(id);
    if (!record) return false;
    try {
      this.killTree(record.pid, signal);
    } catch (error) {
      this._settle(record, {
        fate: TerminalFate.UNKNOWN,
        reason: `Telar could not signal this terminal's process group (pid ${record.pid}): ${messageOf(error)}`,
      });
      return true;
    }
    if (!record.killTimer) {
      record.killTimer = setTimeout(() => {
        this._settle(record, {
          fate: TerminalFate.UNKNOWN,
          reason: `this terminal did not report an exit within ${this.killObserveMs}ms of being signalled; its process group (pid ${record.pid}) may still be running`,
        });
      }, this.killObserveMs);
      // A pending kill must not be the reason the app cannot quit.
      if (typeof record.killTimer.unref === "function") record.killTimer.unref();
    }
    return true;
  }

  /** What is live right now — facts only, no handles. */
  list() {
    return [...this.terminals.values()].map((record) => ({
      id: record.id,
      pid: record.pid,
      shell: record.shell,
      cwd: record.cwd,
      cols: record.cols,
      rows: record.rows,
      startedAt: record.startedAt,
    }));
  }

  /**
   * THE HOST IS GOING AWAY WHILE TERMINALS ARE STILL RUNNING.
   *
   * Every one of them becomes `unknown`, never `exited`. This is the case the
   * whole fate model exists for: the window closed, or the app is quitting, and
   * the processes on the other side of those handles are a dev server and its
   * children. We did not see them end and we are about to stop being able to,
   * so we say so — and whatever downstream holds a slot keeps holding it.
   *
   * It does NOT kill them. Deciding that a shutdown should take a user's
   * long-running process with it is policy, and policy is the engine's.
   */
  dispose(reason = "Telar's terminal host shut down") {
    this.disposed = true;
    for (const record of [...this.terminals.values()]) {
      this._settle(record, {
        fate: TerminalFate.UNKNOWN,
        reason: `${reason} while this terminal was still running (pid ${record.pid}); Telar cannot vouch that it has ended`,
      });
    }
  }

  /**
   * LET PENDING EXIT CALLBACKS LAND BEFORE THE PROCESS GOES.
   *
   * node-pty reaps children on a background thread and calls back INTO JS when
   * one ends. Tearing V8 down while such a callback is in flight surfaces as
   * `libc++abi: terminating due to uncaught exception of type Napi::Error` and
   * an abort — after any work this process had already finished, so it looks
   * like a clean run that died at the very end.
   *
   * MEASURED, and it is why this exists as a real step rather than a shrug: a
   * harness that killed a shell and exited immediately aborted on 4 of 10 runs,
   * every one of them AFTER printing its success marker. A gate reading only
   * the marker would have called each of those green.
   *
   * Await this before `app.exit` when something was just signalled. It is not
   * needed on an ordinary quit — `dispose` does not kill anything — which is
   * why it is a separate call and not folded into `dispose`.
   */
  drain(ms = 400) {
    // Deliberately NOT unref'd: the whole point is to hold the loop open long
    // enough for a callback that is already on its way.
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** One ending per terminal, ever. */
  _settle(record, ending) {
    if (!this.terminals.has(record.id) || this.terminals.get(record.id) !== record) return;
    this.terminals.delete(record.id);
    if (record.killTimer) {
      clearTimeout(record.killTimer);
      record.killTimer = null;
    }
    this.onExit(record.id, { id: record.id, pid: record.pid, at: this.now(), ...ending });
  }
}

/**
 * The shell to run when the caller did not name one.
 *
 * `$SHELL` first because that is the one the person chose. `/bin/sh` as the
 * floor rather than a guess at zsh: it is the shell POSIX guarantees exists.
 */
function defaultShell(platform, env) {
  if (platform === "win32") return (env && env.COMSPEC) || "cmd.exe";
  const chosen = env && typeof env.SHELL === "string" ? env.SHELL.trim() : "";
  return chosen || "/bin/sh";
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
  TERM,
  TERM_PROGRAM,
  terminalEnv,
  killTerminalTree,
  ensureSpawnHelper,
  spawnHelperCandidates,
  defaultShell,
};
