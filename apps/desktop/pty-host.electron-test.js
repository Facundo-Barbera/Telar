/**
 * IS IT ACTUALLY A PTY? (#198, W1) — asked of a real Electron, a real native
 * addon and a real shell.
 *
 * THE CENTRAL PROOF IS `test -t 1`, AND IT IS CHOSEN FOR WHAT IT CANNOT DO.
 * Every other way of starting a process in this repository — `spawn`, `fork`,
 * `Bun.spawn` — hands the child a PIPE, and a pipe answers that question NO.
 * So the check fails exactly when the thing it is here to prove is absent,
 * which is the property this repo's instruments keep turning out to lack. It is
 * not a test-name grep and it is not a substring both states emit: the two
 * states give literally opposite answers, and BOTH ARE MEASURED HERE — case 2
 * runs the identical probe through a pipe and requires the opposite answer, so
 * a run where the PTY silently degraded to a pipe fails rather than passes.
 *
 * READ BACK FROM INSIDE THE SHELL, NEVER FROM THIS PROCESS. `printenv` in the
 * child is the only thing that proves the child's environment; asserting on the
 * object we passed to `spawn` would prove we can read our own variable.
 *
 * WHY IT IS AN ELECTRON TEST. node-pty is a native addon and this asserts it
 * loads under Electron's ABI — a bun unit test would prove nothing about the
 * runtime that ships. The desktop unit suite also runs on ubuntu, where
 * node-pty publishes no prebuild at all. terminal-host.test.js covers the
 * module's logic with an injected spawner; this file covers the part that can
 * only be true of the real thing.
 *
 * THE MARKER IS A COUNT, NOT A NAME. It prints only after every registered
 * case has passed, and it carries the number of them plus the two opposite
 * answers from cases 1 and 2. A run that short-circuits, throws, or drops the
 * control arm cannot emit it — which is the whole reason it is shaped this way
 * rather than as a describe-name a skipped test would print for free.
 *
 * Run: `bun run test:desktop:pty`. Every shell it starts exits; the one case
 * that deliberately leaves a process running kills it before returning.
 */
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");
const { TerminalHost, TerminalFate, TERM, TERM_PROGRAM, terminalEnv, killTerminalTree, defaultShell } = require("./terminal-host");

app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "telar-pty-host-")));
app.on("window-all-closed", () => {});

/** Every case that must pass before the marker may be printed. The number is
 *  repeated in .github/workflows/verify.yml on purpose: changing it is a
 *  deliberate act, and a run that produces a different one is not this test. */
const CASES = 11;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const note = (line) => console.log(`PTY ${line}`);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * Run one shell to completion on a PTY and collect everything it wrote.
 *
 * IT MUST ONLY ANSWER FOR THE TERMINAL IT OPENED (#845). There is ONE host
 * here and `onData`/`onExit` are single slots on it, so each call replaces the
 * previous call's handlers — and an ending that has not arrived yet lands in
 * whoever holds the slot when it does. That is not hypothetical: case 8 kills
 * a shell and moves on as soon as the GRANDCHILD is reaped, which can happen
 * before node-pty's reaping thread has called back for the shell itself. The
 * stray ending is `{fate: exited, exitCode: 0, signal: 9}` — node-pty leaves
 * `exit_code` at 0 for a SIGNALLED child (src/unix/pty.cc:110, :189-194) — so
 * a helper that took it would see a launch that "exited 0". #845 is one hour
 * of CI spent reading that as the product being wrong.
 *
 * The id is the fix and it was always available: the host has passed it to
 * both callbacks since it was written, and this helper threw it away.
 */
function runOnPty(host, script, options = {}) {
  return new Promise((resolve, reject) => {
    let out = "";
    // Assigned from `open()` below, which returns before any callback can fire
    // — the host mints the id and spawns synchronously, so there is no window
    // in which one of OUR frames could arrive while this is still null.
    let ours = null;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`a shell on a pty never ended: ${JSON.stringify(script)} (saw ${JSON.stringify(out)})`));
    }, 15_000);
    host.onData = (id, data) => {
      if (id === ours) out += data;
    };
    host.onExit = (id, ending) => {
      if (settled || id !== ours) return;
      settled = true;
      clearTimeout(timer);
      resolve({ out, ending });
    };
    const opened = host.open({ shell: "/bin/sh", args: ["-c", script], ...options });
    ours = opened.id;
    if (opened.ending) {
      settled = true;
      clearTimeout(timer);
      resolve({ out, ending: opened.ending });
    }
  });
}

/** Wait for ONE named terminal's ending, whoever else is talking. Used where a
 *  test must not leave an ending in flight for the next case to catch. */
function endingOf(host, wanted, why) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${why}: ${wanted} never reported an ending`)), 15_000);
    host.onData = () => {};
    host.onExit = (id, ending) => {
      if (id !== wanted) return;
      clearTimeout(timer);
      resolve(ending);
    };
  });
}

/** The SAME probe through a pipe — the control arm for case 1. */
function runOnPipe(script, env) {
  const result = spawnSync("/bin/sh", ["-c", script], { env, encoding: "utf8" });
  return result.stdout || "";
}

/** Is this pid gone? `signal 0` asks without sending anything. */
function isGone(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH";
  }
}

/**
 * NOTHING SURVIVES THIS FILE. A pty holds an open fd and a live child, and
 * either is enough to keep Electron from exiting — which turns a failed
 * assertion into a job that sits until CI's 25-minute timeout instead of
 * reporting in seconds. Seen: the run that found case 9's wrong premise.
 */
let liveHost = null;

async function teardown(host) {
  if (!host) return;
  for (const terminal of host.list()) {
    try {
      killTerminalTree(terminal.pid, "SIGKILL", { platform: process.platform });
    } catch {
      /* already gone */
    }
  }
  host.dispose("the pty test ended");
  // AND THEN WAIT. This file signals real processes, and node-pty calls back
  // into JS from its reaping thread when one ends; exiting into that lands as
  // an uncaught Napi::Error and an abort. Measured at 4 aborts in 10 runs
  // without this, every one AFTER the success marker had been printed — so the
  // exit-code half of CI's gate is the only thing that would have caught it,
  // which is exactly why that job checks both.
  await host.drain();
}

async function main() {
  const report = {};
  let passed = 0;
  const pass = (name, detail) => {
    passed += 1;
    note(`${passed}. ${name} — ${detail}`);
  };

  const host = new TerminalHost({ version: "test-version" });
  liveHost = host;
  // Set OUR marker in the environment we hand over, so case 5's deletion is
  // exercised rather than merely satisfied by the CI runner's clean env.
  const dirty = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };

  /* 1. THE ONE THAT MATTERS. A pipe cannot answer this. */
  const probe = "test -t 1 && echo TTY_YES || echo TTY_NO";
  const tty = await runOnPty(host, probe, { env: dirty });
  report.pty = tty.out.trim();
  assert(/TTY_YES/.test(tty.out), `test -t 1 said ${JSON.stringify(tty.out)} — stdout is not a terminal, so this is not a pty`);
  assert(!/TTY_NO/.test(tty.out), `the shell answered both ways: ${JSON.stringify(tty.out)}`);
  pass("test -t 1 through the pty", "the shell's stdout IS a terminal");

  /* 2. THE CONTROL ARM. Identical script, a pipe instead — must answer NO. */
  const piped = runOnPipe(probe, dirty);
  report.pipe = piped.trim();
  assert(
    /TTY_NO/.test(piped) && !/TTY_YES/.test(piped),
    `the control arm said ${JSON.stringify(piped)} — a pipe reported a terminal, so case 1 proves nothing`,
  );
  // \r\n only exists because a terminal's line discipline put it there.
  assert(tty.out.includes("\r\n"), "the pty's output had no CR — the line discipline is not a terminal's");
  assert(!piped.includes("\r"), `the pipe's output carried a CR: ${JSON.stringify(piped)}`);
  pass("the same probe through a pipe", "answers NOT a terminal, and without CR");

  /* 3 + 4. The identity, read from inside the shell. */
  const ident = await runOnPty(host, 'printenv TERM_PROGRAM; printenv TERM; printenv TERM_PROGRAM_VERSION', { env: dirty });
  const lines = ident.out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  report.identity = lines;
  assert(lines[0] === TERM_PROGRAM, `the shell's $TERM_PROGRAM is ${JSON.stringify(lines[0])}, not ${JSON.stringify(TERM_PROGRAM)} — dotfiles branch on this`);
  pass("printenv TERM_PROGRAM inside the shell", `${TERM_PROGRAM}`);
  assert(lines[1] === TERM, `the shell's $TERM is ${JSON.stringify(lines[1])}, not ${JSON.stringify(TERM)}`);
  assert(lines[2] === "test-version", `$TERM_PROGRAM_VERSION is ${JSON.stringify(lines[2])} — it did not come from the host's version`);
  pass("printenv TERM inside the shell", `${TERM}, with TERM_PROGRAM_VERSION set`);

  /* 5. Our own marker taken back out, proven on the child that inherits it. */
  const leaked = await runOnPty(host, 'printenv ELECTRON_RUN_AS_NODE || echo ABSENT', { env: dirty });
  report.electronRunAsNode = leaked.out.trim();
  assert(/ABSENT/.test(leaked.out), `ELECTRON_RUN_AS_NODE reached the user's shell as ${JSON.stringify(leaked.out)}`);
  assert(dirty.ELECTRON_RUN_AS_NODE === "1", "the control for case 5 was not set, so its deletion was never exercised");
  pass("ELECTRON_RUN_AS_NODE", "set on the way in, absent inside the shell");

  /* 6. A size, and a resize the shell can see. A pipe has neither. */
  const sized = await new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`stty never answered: ${JSON.stringify(out)}`)), 15_000);
    host.onData = (_id, data) => {
      out += data;
    };
    host.onExit = (_id, ending) => {
      clearTimeout(timer);
      resolve({ out, ending });
    };
    const opened = host.open({ shell: "/bin/sh", args: ["-c", "stty size; sleep 1; stty size"], cols: 123, rows: 45, env: dirty });
    setTimeout(() => host.resize(opened.id, 99, 33), 400);
  });
  const sizes = sized.out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  report.sizes = sizes;
  assert(sizes[0] === "45 123", `the pty opened at ${JSON.stringify(sizes[0])}, not "45 123"`);
  assert(sizes[1] === "33 99", `the pty did not resize: stty says ${JSON.stringify(sizes[1])}, not "33 99"`);
  pass("stty size before and after resize", `${sizes[0]} then ${sizes[1]}`);

  /* 7. A clean exit is the ONLY thing that produces `exited`. */
  const clean = await runOnPty(host, "exit 7", { env: dirty });
  report.clean = clean.ending;
  assert(clean.ending.fate === TerminalFate.EXITED, `a shell that ran \`exit 7\` reported ${clean.ending.fate}`);
  assert(clean.ending.exitCode === 7, `the exit code came back as ${clean.ending.exitCode}`);
  pass("a shell that exits 7", `fate=${clean.ending.fate} exitCode=${clean.ending.exitCode}`);

  /* 8. Killing reaches the DESCENDANTS, not just the shell. */
  const grandchild = await new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`the backgrounded child never announced itself: ${JSON.stringify(out)}`)), 15_000);
    host.onData = (_id, data) => {
      out += data;
      const match = /CHILD=(\d+)/.exec(out);
      if (match) {
        clearTimeout(timer);
        resolve({ pid: Number(match[1]), out });
      }
    };
    host.onExit = () => {};
    host.open({ shell: "/bin/sh", args: ["-c", "sleep 20 & echo CHILD=$!; wait"], env: dirty });
  });
  const live = host.list()[0];
  assert(live && typeof live.pid === "number", "the terminal with a backgrounded child is not listed as live");
  assert(!isGone(grandchild.pid), `the backgrounded sleep (pid ${grandchild.pid}) was already gone before the kill`);
  // ARM THE WAIT BEFORE THE SIGNAL, and wait for THIS terminal's own ending
  // rather than for the grandchild alone (#845). The grandchild is reaped by
  // launchd, which can beat node-pty's reaping thread — so a case that only
  // polled the grandchild moved on with the shell's ending still in flight,
  // and the next case caught it.
  const killed = endingOf(host, live.id, "case 8");
  host.kill(live.id, "SIGKILL");
  for (let attempt = 0; attempt < 50 && !isGone(grandchild.pid); attempt += 1) await sleep(100);
  const killEnding = await killed;
  report.groupKill = { grandchild: grandchild.pid, gone: isGone(grandchild.pid), ending: killEnding };
  assert(isGone(grandchild.pid), `pid ${grandchild.pid} survived the kill — the signal reached the shell but not its process group`);
  // AND WHAT A KILLED TERMINAL ACTUALLY REPORTS, pinned as values because
  // misreading it is what #845 was. node-pty only assigns `exit_code` under
  // WIFEXITED, so a SIGNALLED shell comes back as code 0 WITH a signal — which
  // on the code alone is indistinguishable from a command that succeeded.
  assert(killEnding.fate === TerminalFate.EXITED, `the killed terminal reported ${JSON.stringify(killEnding)}`);
  assert(killEnding.signal === "9", `SIGKILL came back as signal ${JSON.stringify(killEnding.signal)}, not "9"`);
  assert(
    killEnding.exitCode === 0,
    `a SIGKILLed shell reported exitCode ${killEnding.exitCode} — the premise that a signalled child carries code 0 is what case 9 is read against`,
  );
  pass("kill reaches the process group", `the backgrounded pid ${grandchild.pid} is gone; the shell ended signal=9 exitCode=0`);

  /* 9. WHAT A LAUNCH THAT CANNOT WORK ACTUALLY LOOKS LIKE — and the two halves
   *    are DIFFERENT, which is the whole content of this case.
   *
   *    A MISSING BINARY is the child's problem. node-pty forks the pty fine and
   *    `execvp` fails inside the child, so it arrives as an ordinary NONZERO
   *    `exited` with a real pid. W4 must read "the command was wrong" off an
   *    exit code, never off a fate, and must not expect `failed` for a typo.
   *
   *    AN UNUSABLE CWD IS OURS, and since #845 it is refused before anything is
   *    spawned. It had to be: on macOS node-pty hands the cwd to `spawn-helper`,
   *    whose entire handling of a `chdir` it cannot make is `_exit(1)` with
   *    nothing written anywhere (1.1.0, src/unix/spawn-helper.cc) — a blank
   *    terminal that closes. Now it is `failed`, with a sentence naming the
   *    directory, and NO exit code, because nothing exited.
   *
   *    THE CWD IS UNDER A REGULAR FILE, not merely absent. A nonexistent path
   *    can in principle be created underneath a test, and a `chmod 000`
   *    directory is a different answer for a privileged user; `/etc/passwd/nope`
   *    is ENOTDIR for everybody, including root on a hosted runner.
   *
   *    Measured, three times: the first version of this case asserted `failed`
   *    for a missing binary and the second asserted it for a missing cwd — both
   *    wrong against the node-pty of the day. The third read an exit code off a
   *    racing ending that belonged to case 8's killed shell (#845). */
  const unenterable = path.join("/etc/passwd", "telar-not-a-dir-845");
  const badCwd = await runOnPty(host, "true", { cwd: unenterable, env: dirty });
  report.badCwd = badCwd.ending;
  assert(badCwd.ending.fate === TerminalFate.FAILED, `an unusable cwd reported ${JSON.stringify(badCwd.ending)}, not ${TerminalFate.FAILED}`);
  assert(badCwd.ending.pid === undefined, `a refused launch carried pid ${badCwd.ending.pid} — nothing was spawned, so there is no pid to name`);
  assert(
    badCwd.ending.exitCode === undefined,
    `a refused launch carried exitCode ${badCwd.ending.exitCode} — nothing exited, and a code here is how a launch that never ran comes to look successful`,
  );
  assert(String(badCwd.ending.error).includes(unenterable), `the refusal does not name the directory: ${JSON.stringify(badCwd.ending.error)}`);
  const missing = await runOnPty(host, "exec /var/empty/telar-no-such-binary-198", { env: dirty });
  report.missingBinary = missing.ending;
  assert(
    missing.ending.fate === TerminalFate.EXITED && missing.ending.exitCode !== 0,
    `a nonexistent command came back as ${JSON.stringify(missing.ending)} — expected a nonzero exit`,
  );
  pass(
    "a launch that cannot work",
    `bad cwd → ${badCwd.ending.fate}, no exit code; missing command → ${TerminalFate.EXITED} ${missing.ending.exitCode}`,
  );

  /* 10. THE CONTROL ARM FOR THE REFUSAL, and it is not optional: case 9 is
   *     satisfied by a host that refuses EVERY cwd, which would leave the
   *     product unable to open a terminal anywhere. So a usable directory must
   *     start a shell — and the shell's own `pwd`, read from inside it, must be
   *     that directory. Asserting on what we passed in would prove we can read
   *     our own variable. */
  // `pwd -P` and `realpathSync` on purpose: os.tmpdir() is under /var, which is
  // a symlink to /private/var on macOS, and the inherited $PWD is this
  // process's. Both sides ask for the physical path so they are comparable.
  const usable = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "telar-usable-cwd-845-")));
  const entered = await runOnPty(host, "pwd -P", { cwd: usable, env: dirty });
  report.usableCwd = { asked: usable, ending: entered.ending, pwd: entered.out.trim() };
  // Removed BEFORE the asserts, so a failure here does not also leave a
  // directory behind — this file's rule is that nothing survives it.
  fs.rmSync(usable, { recursive: true, force: true });
  assert(entered.ending.fate === TerminalFate.EXITED, `a usable cwd reported ${JSON.stringify(entered.ending)} — the refusal is refusing everything`);
  assert(entered.ending.exitCode === 0, `a shell in a usable directory exited ${entered.ending.exitCode}`);
  assert(entered.out.split(/\r?\n/)[0].trim() === usable, `the shell says it is in ${JSON.stringify(entered.out.trim())}, not ${JSON.stringify(usable)}`);
  pass("a usable cwd is entered, not refused", `the shell's own pwd is ${usable}`);

  /* 11. THE HOST GOES AWAY WITH A TERMINAL STILL RUNNING, AND ENDS IT.
   *     This case used to pin the opposite — `unknown`, nothing signalled —
   *     until "Run = a new terminal" decided a terminal owns its process and
   *     quitting closes it. What is pinned now: the process is signalled, and
   *     the ending is the REAL one node-pty reports, `exited` with the signal,
   *     never an ending the host made up. Id-matched like `runOnPty`, and for
   *     the same reason (#845): `dispose` reaches EVERY live terminal. */
  const orphan = await new Promise((resolve) => {
    let ours = null;
    host.onData = () => {};
    host.onExit = (id, ending) => {
      if (id === ours) resolve({ id, ending });
    };
    ours = host.open({ shell: "/bin/sh", args: ["-c", "sleep 20"], env: dirty }).id;
    setTimeout(() => host.dispose(), 300);
  });
  report.dispose = orphan.ending;
  assert(orphan.ending.fate === TerminalFate.EXITED, `a live terminal at shutdown reported ${JSON.stringify(orphan.ending)} — dispose must end it and report the real exit`);
  // SIGHUP (1) goes first and ends a plain `sleep`; SIGTERM (15) is the next
  // step. Either is dispose's own signal — what must not appear is no signal.
  assert(
    orphan.ending.signal === "1" || orphan.ending.signal === "15",
    `dispose's hangup/SIGTERM came back as signal ${JSON.stringify(orphan.ending.signal)}, not "1" or "15"`,
  );
  for (let attempt = 0; attempt < 50 && !isGone(orphan.ending.pid); attempt += 1) await sleep(100);
  assert(isGone(orphan.ending.pid), `pid ${orphan.ending.pid} survived dispose — the host went away and left it running`);
  pass("dispose with a terminal still live", `fate=${orphan.ending.fate} signal=${orphan.ending.signal}, the process is gone`);

  /* Checks that need no process at all, folded in rather than counted: they
   * hold for the win32 branch this Mac cannot run, and are the reason the
   * killer takes an injected platform. */
  const windowsCalls = [];
  killTerminalTree(4242, "SIGTERM", { platform: "win32", spawnSync: (file, args) => windowsCalls.push([file, args]) });
  assert(windowsCalls.length === 1 && windowsCalls[0][0] === "taskkill", `win32 did not reach taskkill: ${JSON.stringify(windowsCalls)}`);
  assert(windowsCalls[0][1].includes("/t") && windowsCalls[0][1].includes("/f"), `taskkill was called without /t /f: ${JSON.stringify(windowsCalls[0][1])}`);
  const posixCalls = [];
  killTerminalTree(4242, "SIGTERM", { platform: "darwin", kill: (pid, signal) => posixCalls.push([pid, signal]) });
  assert(posixCalls[0][0] === -4242, `posix did not signal the GROUP: ${JSON.stringify(posixCalls)}`);
  note(`win32/posix killer branches exercised: ${JSON.stringify([windowsCalls[0][1], posixCalls[0]])}`);

  assert(defaultShell("win32", {}) === "cmd.exe", "the win32 default shell is not cmd.exe");
  assert(!("ELECTRON_RUN_AS_NODE" in terminalEnv({ ELECTRON_RUN_AS_NODE: "1" }, "1.2.3")), "terminalEnv kept our own marker");

  /* THE MARKER. It cannot be printed by a run that stopped early, and it
   * carries the two OPPOSITE answers from cases 1 and 2 — so a green line here
   * means the pty said terminal and the pipe said not, in the same run. */
  assert(passed === CASES, `only ${passed} of ${CASES} cases ran to a pass — this run proved less than it claims`);
  note(`report ${JSON.stringify(report)}`);
  console.log(`PTY_HOST_OK ${passed}/${CASES} pty=tty pipe=not-a-tty`);
  return report;
}

app.whenReady()
  .then(main)
  .then(
    async () => {
      await teardown(liveHost);
      app.exit(0);
    },
    async (error) => {
      console.error("PTY_HOST_FAIL", error);
      await teardown(liveHost);
      app.exit(1);
    },
  );
