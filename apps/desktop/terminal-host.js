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
 * reports facts about them — their bytes, how they ended, and whether it was
 * this host that was closing them. apps/engine/src/run/ decides what that
 * means for the terminal's record.
 *
 * ONLY node-pty SAYS HOW A TERMINAL ENDED. The one producer of `exited` is
 * node-pty's own exit event, carrying a code. There used to be a third fate,
 * `unknown`, for a kill that was not seen to land within five seconds or a pty
 * whose fd raised an error; it existed to hold a project's one deployment slot
 * while Telar could not vouch for a process. "Run = a new terminal" removed
 * the slot and all liveness tracking with it, so this host no longer invents
 * an ending: a terminal stays in the table — still closable, still killable —
 * until node-pty reports its exit.
 *
 * A TERMINAL OWNS ITS PROCESS, AND CLOSING IT ENDS IT ("Run = a new terminal").
 * Every PTY belongs to a SESSION and says who opened it (`origin`), and
 * closing one — or every one of a session, or every one at quit — signals its
 * process groups SIGTERM and, a second later, SIGKILL. The ending node-pty
 * then reports carries `closed` — `close`, `session` or `quit` — so the engine
 * can record who ended it. THERE IS NO LIVENESS POLLING HERE, deliberately:
 * "is something running in this terminal" is asked once, when a person is
 * about to be asked to confirm, and answered from one `ps` snapshot — see
 * `activeProcesses`.
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
const fs = require("node:fs");
const path = require("node:path");

/**
 * WHAT WE CAN HONESTLY SAY ABOUT A TERMINAL THAT IS NO LONGER RUNNING.
 *
 * Exported as a vocabulary rather than string literals because the engine and
 * the renderer both map these onto what they show.
 */
const TerminalFate = Object.freeze({
  /** node-pty reported an exit and we have its code. The only clean claim. */
  EXITED: "exited",
  /** No process was ever created — either the spawn threw, or Telar refused it
   *  before spawning because the request could not have run (`unusableCwd`).
   *  There is no exit code here, because nothing ever exited. */
  FAILED: "failed",
});

/**
 * WHY THIS HOST WAS ENDING A TERMINAL, carried on its `exited` ending so the
 * engine can say who closed it: one terminal closed (`close`), a whole session
 * closed (`session`), or Telar quitting (`quit`). Absent when the process ended
 * by itself.
 */
const CloseReason = Object.freeze({
  CLOSE: "close",
  SESSION: "session",
  QUIT: "quit",
});

/**
 * WHO OPENED A TERMINAL, AND THEREFORE WHO MAY REACH IT (#198).
 *
 * There are two callers in this process and they are not peers. The RENDERER
 * opens the terminals a person asked for in a Terminal tab; the ENGINE opens
 * the one behind a run, over `run-terminal-server.js`. Before this existed,
 * `telar:terminal:list` handed the cockpit EVERY id in the process — a run's
 * included — and `telar:terminal:write` checked only that the sender was the
 * cockpit's top frame. Nothing surfaced a run's id, so it was latent rather
 * than exploitable; it was still a renderer able to type into, resize and kill
 * a process it did not start and cannot see.
 *
 * SO OWNERSHIP IS RECORDED AT `open` AND CHECKED AT EVERY VERB. It is not a UI
 * convention: `write`, `resize` and `kill` refuse an id whose owner is not the
 * caller, and `list` does not mention one. Run's terminal is reachable from the
 * cockpit exactly one way — through the engine, over HTTP, where the bytes have
 * been through `pty-stream.ts` — and that is the point of the guard rather than
 * a side effect of it.
 *
 * THE DEFAULT IS `renderer`, WHICH IS THE FAIL-CLOSED DIRECTION. A caller that
 * forgets to say gets the less privileged of the two and is refused an engine
 * terminal; the engine has to name itself to reach its own. An owner that is
 * neither throws rather than being rounded to one, because a typo that quietly
 * became `renderer` would be the guard failing open.
 */
const TerminalOwner = Object.freeze({
  RENDERER: "renderer",
  ENGINE: "engine",
});

function terminalOwner(value) {
  if (value === undefined || value === null) return TerminalOwner.RENDERER;
  if (value === TerminalOwner.RENDERER || value === TerminalOwner.ENGINE) return value;
  throw new Error(`Telar does not know the terminal owner ${JSON.stringify(value)}.`);
}

/**
 * WHY A TERMINAL EXISTS, WHICH IS NOT THE SAME QUESTION AS WHO MAY REACH IT.
 *
 * `owner` is the security boundary above: which door the verbs come through.
 * `origin` is what a person sees on the tab — a shell they opened (`user`), a
 * process an agent started so the person can watch it (`agent`), or a saved
 * run configuration (`run`). The engine opens the last two; the renderer opens
 * only the first.
 *
 * THE PAIRING IS ENFORCED HERE, not trusted from the caller. A renderer that
 * could label its shell `agent` would make a person's own terminal look like
 * something an agent is responsible for, and an engine terminal labelled
 * `user` would claim a person typed a command they never saw. Neither is a
 * privilege, both are a lie on screen, so both throw. Absent, each owner gets
 * the only origin it ever had before this field existed — `user` for the
 * renderer, `run` for the engine — which is what keeps today's engine client,
 * which does not send one, working unchanged.
 */
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

/** A session id or a title as the host keeps it: a short string, or nothing.
 *  Anything else is dropped rather than coerced, because `String({})` as a
 *  session id would quietly put a terminal in a session nobody has. */
function shortText(value, max) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

/** The terminal type we claim to be, and the one xterm.js is configured for. */
const TERM = "xterm-256color";
/** What the emulator can paint, for a parent that did not already say. See
 *  `terminalEnv` for why this defers rather than overwrites. */
const COLORTERM = "truecolor";

/**
 * THIS STRING IS PUBLIC API.
 *
 * `$TERM_PROGRAM` is what a person's shell branches on, and people branch on it
 * — the owner's own ~/.zshrc does. It is `Telar`, it is stable, and renaming it
 * silently breaks dotfiles we never see. If it ever has to change, that is a
 * release note, not a refactor.
 */
const TERM_PROGRAM = "Telar";

/**
 * HOW LONG A CLOSED TERMINAL'S PROCESSES GET TO END ON THEIR OWN.
 *
 * SIGTERM first because a dev server that is told politely flushes its logs,
 * removes its lock file and gives the port back; SIGKILL a second later
 * because a process that traps TERM, or is wedged, must not be able to keep a
 * closed terminal's work alive behind the person's back. One second is what
 * T3 Code settled on for the same close (Manager.ts:99) and it is long enough
 * for every graceful shutdown we have watched, short enough that quitting
 * Telar never feels like it hung.
 */
const CLOSE_GRACE_MS = 1_000;

/**
 * ONE SNAPSHOT OF THE PROCESS TABLE, ASKED WHEN SOMEBODY NEEDS AN ANSWER.
 *
 * NOT A POLL. This runs when a person is about to close a terminal or quit and
 * we have to decide whether to ask them first, and once when a terminal is
 * closed so its signal reaches every job in it. Nothing calls it on a timer.
 *
 * `ps` RATHER THAN node-pty's `process` getter, because the getter answers
 * only the foreground program's NAME, and the two questions we have need more:
 * whether anything besides the shell is running (children, background jobs),
 * and which process GROUPS live on this terminal — an interactive shell puts
 * each job in its own group, so signalling the shell's group alone would miss
 * `bun run dev` started at the prompt. `tty` is what ties a job to the
 * terminal it was started in; `tpgid` is the terminal's foreground group,
 * which is how "the shell is busy" is told apart from "the shell is at a
 * prompt". `-ww` so a long command line is not cut at 80 columns — it is shown
 * to the person in the confirmation.
 *
 * `LC_ALL=C` so the columns are the ones the parser expects whatever the
 * person's locale does to number formatting.
 */
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

/** `ps`'s rows as numbers. A row that does not parse is skipped, not guessed. */
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

/** `/dev/ttys003` and `ttys003` are the same terminal; `??` and `?` are none. */
function ttyName(value) {
  if (typeof value !== "string") return undefined;
  const name = value.replace(/^\/dev\//, "").trim();
  return name && !/^\?+$/.test(name) ? name : undefined;
}

/**
 * WHAT IS RUNNING IN ONE TERMINAL, from one snapshot. Pure, so it is tested
 * against a table rather than against a machine.
 *
 * A PROCESS BELONGS TO THIS TERMINAL when it is the shell's child, in the
 * shell's own group, or attached to the terminal's tty. The three overlap on
 * purpose: a `run` terminal is `sh -c cmd` with no job control, so its work is
 * in the shell's group; an interactive shell puts each job in a NEW group on
 * the same tty; and a child that detached from the tty is still the shell's
 * child. What is deliberately NOT followed is a grandchild that detached — a
 * program that went out of its way to leave is not this terminal's to end.
 *
 * ACTIVE means somebody would lose something if this closed now: the
 * terminal's foreground group is not the shell (a command holds the prompt),
 * or anything other than the shell belongs to it (a backgrounded job, a
 * child). An idle shell at its prompt is not active, and closing one is not
 * worth a question.
 *
 * `groups` is every process group a close must signal — the shell's own
 * first. Never a group id of 1 or less: `kill(-1)` is every process this user
 * owns and `kill(-0)` is Telar's own group.
 */
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

/**
 * QUIT OR ASK FIRST — the decision, with no Electron in it.
 *
 * ONE question for the whole app, never one per terminal: a person quitting
 * with three dev servers up is making one decision, and three dialogs in a row
 * is how the third gets clicked through unread. An idle shell is not counted —
 * closing it loses nothing — so a Telar with only prompts open quits without
 * asking, which is what quitting did before any of this existed.
 *
 * THE COPY EXPLAINS ITSELF: what is running (the command lines, so the person
 * recognises their own work), what quitting does to it, and that the choice
 * is theirs. It names no other product. The buttons say what they do; "OK"
 * would not tell anyone that their server is about to stop.
 *
 * @param {Array<{ active: boolean, command?: string }>} terminals
 *   what `activeProcesses` answered for every live terminal.
 */
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

/**
 * WHAT THE RESTART-TO-UPDATE QUESTION SAYS ABOUT TERMINALS. The update path asks
 * its own question in the cockpit and never `decideQuit`'s, so it needs the same
 * facts in a form the renderer can print: how many are busy, and what they run.
 */
function busyTerminals(terminals) {
  const busy = (Array.isArray(terminals) ? terminals : []).filter((terminal) => terminal && terminal.active);
  return { count: busy.length, commands: busy.slice(0, 5).map((terminal) => clip(terminal.command || "a command", 80)) };
}

function clip(text, max) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * THE ENVIRONMENT A TELAR TERMINAL STARTS IN.
 *
 * Four variables added and one REMOVED, and the removal is the interesting
 * half. `COLORTERM=truecolor` is set ONLY WHEN THE PARENT DID NOT ALREADY SAY —
 * absent, or present and empty. Without any value Neovim's `termguicolors` and
 * every other truecolour-aware program fall back to a 256-colour approximation,
 * which on the owner's colourscheme painted the whole buffer green;
 * `xterm-256color` as `TERM` cannot say 24-bit on its own, and `COLORTERM` is
 * the variable that does. But an inherited value is a statement someone already
 * made about this environment, and overwriting it is how a terminal ends up
 * arguing with the shell that launched it. T3 Code defers here (Manager.ts:1300)
 * and so do we: fill the silence, do not talk over the answer.
 * `ELECTRON_RUN_AS_NODE=1` is something Telar puts in its own children's
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
  if (typeof env.COLORTERM !== "string" || env.COLORTERM.trim() === "") env.COLORTERM = COLORTERM;
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
 * IS THIS A DIRECTORY THE SHELL WILL ACTUALLY BE ABLE TO ENTER? (#845)
 *
 * WHAT IT COSTS TO LEARN THIS THE OTHER WAY, on macOS, which is the platform
 * this app ships to. node-pty does not `chdir` in our process — it hands the
 * cwd to `spawn-helper`, and that helper's entire handling of a cwd it cannot
 * enter is `_exit(1)` (node-pty 1.1.0, src/unix/spawn-helper.cc). No `perror`,
 * no message, nothing written to the pty. So a person who opens a terminal on
 * a project directory that has been moved, deleted or unmounted watches a
 * terminal appear and vanish, with a blank window and no sentence anywhere.
 * (The non-Apple branch in pty.cc:419 does at least `perror`; the branch that
 * actually runs on a Mac does not.)
 *
 * SO WE LOOK FIRST, and refuse with a sentence that names the directory. A
 * refusal is `failed` and not an exit, because it is the literal truth: no
 * process was created, so there is nothing to be uncertain about and nothing
 * whose exit code could mean anything.
 *
 * A DIAGNOSTIC, NOT A GATE, and the difference is worth being explicit about
 * because "check with access(2), then act" is an antipattern when it is load
 * bearing. It is not load bearing here: the kernel's `chdir` in the child is
 * still the thing that enforces this, and a directory that disappears between
 * this check and the spawn simply ends the way it always did — an ordinary
 * nonzero exit. What this buys is the common case, where the directory was
 * already gone before we were asked, and a person gets told which one.
 *
 * `X_OK` ON A DIRECTORY IS THE RIGHT QUESTION, and it is the one that holds
 * for root too: POSIX grants a privileged process `X_OK` only when at least
 * one execute bit is set, so a `chmod 000` directory is refused for everybody.
 * `R_OK` would be the wrong question — a shell can sit in a directory it
 * cannot list.
 *
 * @returns {string | null} a sentence when the cwd cannot be used, else null.
 */
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
    // The constants come from the real module either way; they are numbers, not
    // behaviour, so an injected `fs` does not have to carry a copy of them.
    io.accessSync(cwd, fs.constants.X_OK);
  } catch (error) {
    return `Telar cannot start a terminal in ${cwd}: it is a directory this process may not enter (${messageOf(error)}). No process was started.`;
  }
  return null;
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
    this.closeGraceMs = options.closeGraceMs ?? CLOSE_GRACE_MS;
    this.killTree = options.killTree ?? ((pid, signal) => killTerminalTree(pid, signal, { platform: this.platform }));
    // Injected so a test reads a table it wrote and runs the SIGKILL second on
    // a clock it controls, rather than on the machine's and the wall's.
    this.listProcesses = options.listProcesses ?? (() => readProcessTable());
    this.setTimer = options.setTimeout ?? setTimeout;
    this.clearTimer = options.clearTimeout ?? clearTimeout;
    // Injected only so `unusableCwd`'s refusals can be staged without making a
    // real unreadable directory in a test. Production reads the real one.
    this.fs = options.fs ?? fs;
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
   *
   * `owner` is recorded here and nowhere else: a terminal cannot change hands.
   * Nor can `sessionId` or `origin`: a terminal belongs to the session whose
   * panel it was opened in for its whole life, which is what lets settling
   * that session close exactly its terminals and nobody else's.
   */
  open(request = {}) {
    if (this.disposed) throw new Error("Telar's terminal host is shutting down and will not start another shell.");
    const owner = terminalOwner(request.owner);
    const origin = terminalOrigin(request.origin, owner);
    const sessionId = shortText(request.sessionId, 200);
    const title = shortText(request.title, 200);
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

    /**
     * A LAUNCH THAT CANNOT RUN IS REFUSED HERE, NOT DISCOVERED FROM ITS EXIT
     * CODE (#845). On macOS the child's only reaction to a cwd it cannot enter
     * is a silent `_exit(1)` — see `unusableCwd`. Refusing first is what turns
     * that into a sentence a person can read, and it is the honest fate: the
     * spawn did not happen, so this is `failed` for the same reason a spawn
     * that threw is.
     */
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
      // NEVER STARTED: there is no process at all, so this is the one ending
      // this host reports without node-pty.
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
      // The slave side's name, `/dev/ttys003`. What ties an interactive
      // shell's jobs — each in its own process group — back to this terminal.
      tty: typeof pty.ptsName === "string" ? pty.ptsName : undefined,
      shell,
      args,
      cwd: request.cwd,
      cols,
      rows,
      startedAt: this.now(),
      closing: null,
      // Why a close is in flight — see `CloseReason`. Set once, by the first
      // close to reach this terminal.
      closeReason: null,
      onLeaderExit: null,
    };
    this.terminals.set(id, record);
    /**
     * A PTY'S FD ERRORING MUST NOT ABORT THE WHOLE SHELL.
     *
     * node-pty's socket handler rethrows anything that is not EAGAIN or EIO
     * (`lib/unixTerminal.js:123`, again at `:206`), and that throw comes out of
     * a stream callback in the MAIN process — uncatchable by any caller, so it
     * takes Electron with it and loses every other terminal's fate at once.
     *
     * AN ERROR IS NOT AN ENDING. This used to settle the terminal `unknown` and
     * drop it from the table — without signalling anything, so whatever ran in
     * it kept running with nothing left able to close it. The terminal owns its
     * process, so it stays: still in the table, still closable, and settled
     * when node-pty reports the exit, which on an EIO is usually right behind.
     *
     * TWO LISTENERS BECAUSE NODE-PTY COUNTS THEM: it rethrows while
     * `listeners('error').length < 2`, and `Terminal._forwardEvents`
     * (`lib/terminal.js:90`) registers only `data` and `exit`, so reaching two
     * is ours to do. Both are deliberately empty.
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
      pty.on("error", () => {});
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
        ...(record.closeReason ? { closed: record.closeReason } : {}),
      });
      // A terminal being closed learns here that its shell is gone, which is
      // the moment to find out whether anything else in it still is.
      if (record.onLeaderExit) record.onLeaderExit();
    });
    return { id, pid: record.pid };
  }

  /** Bytes from the keyboard. A write to a terminal that has ended is dropped
   *  rather than thrown: the renderer learns of the exit asynchronously, so a
   *  keystroke in flight across that gap is normal and is not an error.
   *
   *  A write to SOMEBODY ELSE'S terminal is dropped by the same `false`, which
   *  is deliberate: an id the caller does not own must be indistinguishable
   *  from an id that does not exist, or the refusal is itself a way to ask
   *  which ids are live. */
  write(id, data, owner) {
    const record = this._owned(id, owner);
    if (!record || typeof data !== "string") return false;
    record.pty.write(data);
    return true;
  }

  /** The window was resized. SIGWINCH is the PTY's job, not ours. */
  resize(id, cols, rows, owner) {
    const record = this._owned(id, owner);
    if (!record) return false;
    record.cols = size(cols, record.cols);
    record.rows = size(rows, record.rows);
    record.pty.resize(record.cols, record.rows);
    return true;
  }

  /**
   * ONE SIGNAL TO A TERMINAL'S WHOLE TREE — a Ctrl-C-shaped first word before
   * a close, not a close. A signal that lands produces node-pty's exit and the
   * terminal settles through the normal path; one that is ignored leaves the
   * terminal exactly where it was, open and closable.
   *
   * NO CLOCK ON IT ANY MORE. This used to settle the terminal `unknown` if no
   * exit arrived within five seconds, and on a signal that threw — both to
   * hold a project's deployment slot, and both by dropping the terminal from
   * the table while its process might still be running, so nothing could
   * close it afterwards. With no slot and no liveness tracking, an ignored
   * signal is simply ignored, and `close` is what ends a terminal for sure.
   *
   * Answers whether the signal was sent. `ESRCH` counts: the group is already
   * empty, and the exit is on its way.
   */
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

  /**
   * What is live right now FOR ONE OWNER — facts only, no handles.
   *
   * SCOPED, NOT FILTERED BY THE CALLER. The renderer asks this to re-adopt the
   * shells its previous render left running; answering with the engine's run
   * terminals too would hand it ids it has no business holding, and an id is
   * the whole of the address.
   */
  list(owner) {
    const scope = terminalOwner(owner);
    return [...this.terminals.values()].filter((record) => record.owner === scope).map(facts);
  }

  /** One terminal's facts, under the same scope rule as every verb. */
  describe(id, owner) {
    const record = this._owned(id, owner);
    return record ? facts(record) : undefined;
  }

  /**
   * HOW MANY TERMINALS EACH SESSION HOLDS, WHOEVER OPENED THEM — issue #883.
   *
   * Counts, never ids: the engine asks this to say "Settle closes 2 terminals"
   * and to keep settled sessions under their limit, and it acts on a session
   * only through `killBySession`. Handing it the person's terminal ids would
   * hand it addresses it has no business holding. A terminal in no session is
   * nobody's to count here.
   */
  countBySession() {
    const counts = {};
    for (const record of this.terminals.values()) {
      if (record.sessionId) counts[record.sessionId] = (counts[record.sessionId] ?? 0) + 1;
    }
    return counts;
  }

  /** How many terminals are live, whoever opened them. Quit asks this first:
   *  with none, there is nothing to close and nothing to wait for. */
  get size() {
    return this.terminals.size;
  }

  /**
   * CLOSE ONE TERMINAL, WHICH ENDS WHAT RUNS IN IT.
   *
   * Every process group on the terminal is sent SIGTERM, and whatever has not
   * gone a second later gets SIGKILL (see `CLOSE_GRACE_MS`). The terminal
   * settles through node-pty's own exit event, `exited` with the signal, the
   * same as any other ending — a close is not a separate fate.
   *
   * Resolves `false` for an id the caller does not own (the same silence as
   * `write`), else `true` once the escalation is over: every group is either
   * confirmed empty or has been sent SIGKILL. It does NOT wait for the exit
   * event itself, which arrives through `onExit` like always.
   */
  async close(id, owner, options = {}) {
    const record = this._owned(id, owner);
    if (!record) return false;
    await this._close([record], { ...options, reason: CloseReason.CLOSE });
    return true;
  }

  /**
   * CLOSE EVERY TERMINAL A SESSION OWNS — what settling that session will do.
   *
   * EVERY OWNER BY DEFAULT, because the session is the unit here: settling it
   * ends the shells the person opened in its panel AND the runs and agent
   * terminals the engine opened there. `owner` narrows it for a caller that
   * must stay in its own scope.
   *
   * A SESSION ID IS REQUIRED, and "no session" never matches "no session". A
   * terminal opened before sessions were recorded, or by a caller that did not
   * say, has none — and a settle that passed `undefined` must close nothing,
   * not every terminal nobody labelled.
   *
   * @returns {Promise<number>} how many terminals were closed.
   */
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

  /**
   * CLOSE EVERYTHING — quitting Telar.
   *
   * `final` also stops the host starting anything new, BEFORE the snapshot is
   * taken: a terminal opened during the second this takes would otherwise be
   * the one survivor of a quit.
   */
  async closeAll(options = {}) {
    if (options.final) this.disposed = true;
    const records = [...this.terminals.values()];
    await this._close(records, { ...options, reason: CloseReason.QUIT });
    return records.length;
  }

  /**
   * IS ANYTHING RUNNING IN THESE TERMINALS, RIGHT NOW?
   *
   * Asked by whoever is about to close something and has to decide whether to
   * ask first — the quit dialog today, the tab's close button next. One `ps`
   * for every terminal asked about; no timer, no cache, no memory of the last
   * answer. See `terminalActivity` for what "active" means.
   *
   * `owner` scopes it like `list`; with no owner every terminal is answered,
   * which only main's quit path asks for. `ids` narrows it further.
   *
   * WHEN THE TABLE CANNOT BE READ, every terminal is `active`. The question is
   * "should we ask before ending this", and the answer we cannot check is yes:
   * a needless question costs a click, a missing one costs somebody's server.
   * Windows has no `ps`, and gets the same answer for the same reason.
   */
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

  /**
   * WHO OPENED THIS TERMINAL, or nothing once the host no longer holds it.
   *
   * ASKED BY THE FAN-OUT, NOT BY A VERB (#890). `_owned` answers "may this
   * caller address that id", which is the question every verb asks; this one
   * answers "whose bytes are these", which is what `main.js` needs before it
   * decides where a frame may go. A run's RAW output must reach the engine and
   * nobody else — the cockpit gets the engine's redacted mirror of it instead —
   * so the delivery has to be able to tell the two scopes apart without being
   * entitled to act on either.
   */
  ownerOf(id) {
    const record = this.terminals.get(id);
    return record ? record.owner : undefined;
  }

  /**
   * THE HOST IS GOING AWAY WHILE TERMINALS ARE STILL RUNNING — so it ends them.
   *
   * This USED to mark every live terminal `unknown` and signal nothing, on the
   * argument that ending a person's long-running process at shutdown was the
   * engine's policy to decide. It has been decided, the other way: a terminal
   * owns its process, and quitting Telar closes its terminals. Leaving them
   * running is how a dev server outlived the app that started it and held its
   * port against the next launch, with nothing in Telar able to reach it.
   *
   * SYNCHRONOUS, AND SO THE SHELL'S GROUP ONLY. This is the last-resort path —
   * `will-quit`, a test's teardown — where nothing can be awaited, so there is
   * no process table to find an interactive shell's other job groups with.
   * The ordinary quit goes through `closeAll` first, which does read it; by
   * the time this runs there is normally nothing left. SIGKILL follows a
   * second later if the process is still alive to deliver it.
   *
   * NO ENDING IS INVENTED. Each terminal settles when node-pty reports its
   * exit, as `exited` with the signal. The returned promise resolves when the
   * escalation is over, for a caller that can wait.
   */
  dispose() {
    this.disposed = true;
    const records = [...this.terminals.values()];
    return Promise.all(records.map((record) => this._closeRecord(record, null, { reason: CloseReason.QUIT })));
  }

  /** One snapshot for a batch of closes, or `null` when there is none to be
   *  had. Never throws: a close must still signal the shell's own group. */
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
    // ONE TABLE, READ BEFORE ANY SIGNAL. After the first SIGTERM processes
    // start dying and being reparented, and a table read then would miss the
    // very jobs it is for.
    const rows = records.some((record) => !record.closing) ? await this._snapshot() : null;
    await Promise.all(records.map((record) => this._closeRecord(record, rows, options)));
  }

  /**
   * SIGTERM NOW, SIGKILL AFTER THE GRACE — for one terminal's groups.
   *
   * THE SIGKILL DOES NOT WAIT FOR THE SHELL, AND DOES NOT STOP AT IT EITHER. A
   * shell that traps TERM keeps running, so the second signal is what ends it;
   * and a shell that dies on TERM can leave a child that ignored it, so the
   * shell's exit alone is not the end of the terminal's work.
   *
   * THE SHELL'S EXIT IS THE ONE MOMENT WE LOOK, ONCE. When node-pty reports it,
   * each group still pending is probed with signal 0; a group that is gone
   * (ESRCH) is dropped, and if none is left the close is over early. That is
   * what keeps a quit with well-behaved servers from always costing the full
   * second — and it is also the guard against the one real hazard in a
   * delayed `kill(-pgid)`: a group id we have seen go empty is never signalled
   * again. A group still populated at the probe cannot have been reused.
   *
   * THE TIMER IS NOT unref'd, unlike every other timer in this file. Quitting
   * awaits this, and an unref'd SIGKILL is one the process can exit without
   * sending — the exact survivor this exists to prevent.
   */
  _closeRecord(record, rows, options) {
    if (record.closing) return record.closing;
    record.closeReason = options.reason ?? CloseReason.CLOSE;
    const graceMs = options.graceMs ?? this.closeGraceMs;
    const groups = rows ? terminalActivity(record, rows).groups : [record.pid];
    record.closing = new Promise((resolve) => {
      const pending = new Set();
      /**
       * A HANGUP FIRST, TO THE SHELL'S OWN GROUP — because an interactive
       * shell IGNORES SIGTERM. Without this every idle zsh would sit out the
       * whole grace and die to SIGKILL, and quitting with three prompts open
       * would always cost a second. SIGHUP is what closing a terminal window
       * has always sent (the kernel sends it when the controlling terminal
       * goes away): the shell exits and hands the hangup on to its jobs. The
       * SIGTERM and SIGKILL below are unchanged; this only lets the ordinary
       * case finish early. Not on Windows, whose killer is already final.
       */
      if (this.platform !== "win32") {
        try {
          this.killTree(record.pid, "SIGHUP");
        } catch {
          /* the SIGTERM below meets the same fate and handles it */
        }
      }
      for (const group of groups) {
        try {
          this.killTree(group, "SIGTERM");
          pending.add(group);
        } catch {
          // ESRCH: that group is already empty. Anything else (EPERM) is a
          // group we cannot signal at all, and SIGKILL would fail the same way.
        }
      }
      // Windows' killer is already `taskkill /T /F`; there is no gentler
      // first step to escalate from.
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
            /* already gone, which is the outcome we wanted */
          }
        }
        finish();
      }, graceMs);
    });
    return record.closing;
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
   * Await this before `app.exit` when something was just signalled — which,
   * now that quitting closes every terminal, is every quit that had one open.
   * It stays a separate call rather than folded into `closeAll` because the
   * wait belongs to whoever is about to exit, not to a close that a session
   * settling will also make while the app carries on.
   */
  drain(ms = 400) {
    // Deliberately NOT unref'd: the whole point is to hold the loop open long
    // enough for a callback that is already on its way.
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * The record `owner` is entitled to address, or nothing.
   *
   * ONE PLACE, so "who may reach this terminal" cannot be answered differently
   * by `write` than by `kill`. `dispose` deliberately does not come through
   * here: the host going away is about every handle it holds, whoever asked
   * for it.
   */
  _owned(id, owner) {
    const scope = terminalOwner(owner);
    const record = this.terminals.get(id);
    return record && record.owner === scope ? record : undefined;
  }

  /** One ending per terminal, ever. */
  _settle(record, ending) {
    if (!this.terminals.has(record.id) || this.terminals.get(record.id) !== record) return;
    this.terminals.delete(record.id);
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

/** What `list` and `describe` say about a terminal: facts, never the handle. */
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
  CloseReason,
  TerminalOwner,
  TerminalOrigin,
  TERM,
  TERM_PROGRAM,
  CLOSE_GRACE_MS,
  terminalEnv,
  readProcessTable,
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
