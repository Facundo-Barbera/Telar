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
const CASES = 10;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const note = (line) => console.log(`PTY ${line}`);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** Run one shell to completion on a PTY and collect everything it wrote. */
function runOnPty(host, script, options = {}) {
  return new Promise((resolve, reject) => {
    let out = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`a shell on a pty never ended: ${JSON.stringify(script)} (saw ${JSON.stringify(out)})`));
    }, 15_000);
    host.onData = (_id, data) => {
      out += data;
    };
    host.onExit = (_id, ending) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ out, ending });
    };
    const opened = host.open({ shell: "/bin/sh", args: ["-c", script], ...options });
    if (opened.ending) {
      settled = true;
      clearTimeout(timer);
      resolve({ out, ending: opened.ending });
    }
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

function teardown(host) {
  if (!host) return;
  for (const terminal of host.list()) {
    try {
      killTerminalTree(terminal.pid, "SIGKILL", { platform: process.platform });
    } catch {
      /* already gone */
    }
  }
  host.dispose("the pty test ended");
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
  host.kill(live.id, "SIGKILL");
  for (let attempt = 0; attempt < 50 && !isGone(grandchild.pid); attempt += 1) await sleep(100);
  report.groupKill = { grandchild: grandchild.pid, gone: isGone(grandchild.pid) };
  assert(isGone(grandchild.pid), `pid ${grandchild.pid} survived the kill — the signal reached the shell but not its process group`);
  pass("kill reaches the process group", `the backgrounded pid ${grandchild.pid} is gone`);

  /* 9. WHAT A LAUNCH THAT CANNOT WORK ACTUALLY LOOKS LIKE — and it is not what
   *    the obvious guess says, which is why it is pinned rather than assumed.
   *
   *    Neither a MISSING BINARY nor an UNUSABLE CWD fails the spawn. node-pty
   *    forks the pty successfully in both cases and the failure happens inside
   *    the child, so each arrives as an ordinary NONZERO `exited` with a real
   *    pid. `failed` is reachable only when `pty.fork` itself throws — an
   *    unusable spawn-helper does it — which is not something a user's command
   *    can cause. So W4 must read "the command was wrong" off an exit code,
   *    never off this fate, and must not expect `failed` for a typo.
   *
   *    Measured, twice: the first version of this case asserted `failed` for a
   *    missing binary, and the second asserted it for a missing cwd. Both were
   *    wrong. The `failed` path is covered in terminal-host.test.js with a
   *    spawner that throws, which is the only way to reach it on purpose. */
  const badCwd = await runOnPty(host, "true", { cwd: path.join(os.tmpdir(), "telar-no-such-dir-198"), env: dirty });
  report.badCwd = badCwd.ending;
  assert(badCwd.ending.fate === TerminalFate.EXITED, `an unusable cwd reported ${JSON.stringify(badCwd.ending)}`);
  assert(badCwd.ending.exitCode !== 0, `an unusable cwd exited ${badCwd.ending.exitCode} — a launch that never ran must not look successful`);
  const missing = await runOnPty(host, "exec /var/empty/telar-no-such-binary-198", { env: dirty });
  report.missingBinary = missing.ending;
  assert(
    missing.ending.fate === TerminalFate.EXITED && missing.ending.exitCode !== 0,
    `a nonexistent command came back as ${JSON.stringify(missing.ending)} — expected a nonzero exit`,
  );
  pass("a launch that cannot work", `bad cwd → exited ${badCwd.ending.exitCode}; missing command → exited ${missing.ending.exitCode}; neither is ${TerminalFate.FAILED}`);

  /* 10. THE ONE THE FATE MODEL EXISTS FOR. The host goes away with a terminal
   *     still running: `unknown`, never `exited`, with the pid named — so
   *     nothing downstream frees a slot for a process that is still alive. */
  const orphan = await new Promise((resolve) => {
    host.onData = () => {};
    host.onExit = (id, ending) => resolve({ id, ending });
    host.open({ shell: "/bin/sh", args: ["-c", "sleep 20"], env: dirty });
    setTimeout(() => host.dispose("Telar quit"), 300);
  });
  report.dispose = orphan.ending;
  assert(orphan.ending.fate === TerminalFate.UNKNOWN, `a live terminal at shutdown reported ${orphan.ending.fate} — it must never claim an exit it did not see`);
  assert(orphan.ending.exitCode === undefined, "an unknown ending carried an exit code, which is a claim we cannot make");
  assert(String(orphan.ending.reason).includes(String(orphan.ending.pid)), `the unknown reason does not name the pid: ${orphan.ending.reason}`);
  // dispose() deliberately does not kill. This test started it, so this test
  // ends it — nothing is left running behind the suite.
  try {
    killTerminalTree(orphan.ending.pid, "SIGKILL", { platform: "darwin" });
  } catch {
    /* already gone */
  }
  pass("dispose with a terminal still live", `fate=${orphan.ending.fate}, pid named, no exit claimed`);

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

app.whenReady().then(main).then(
  () => {
    teardown(liveHost);
    app.exit(0);
  },
  (error) => {
    console.error("PTY_HOST_FAIL", error);
    teardown(liveHost);
    app.exit(1);
  },
);
