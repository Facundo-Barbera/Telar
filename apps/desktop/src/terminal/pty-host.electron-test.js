const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");
const { TerminalHost, TerminalFate, TERM, TERM_PROGRAM, terminalEnv, killTerminalTree, defaultShell } = require("./terminal-host");

app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "telar-pty-host-")));
app.on("window-all-closed", () => {});

const CASES = 11;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const note = (line) => console.log(`PTY ${line}`);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runOnPty(host, script, options = {}) {
  return new Promise((resolve, reject) => {
    let out = "";

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
    host.open({ shell: "/bin/sh", args: ["-c", script], ...options }).then((opened) => {
      ours = opened.id;
      if (opened.ending) {
        settled = true;
        clearTimeout(timer);
        resolve({ out, ending: opened.ending });
      }
    }, reject);
  });
}

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

function runOnPipe(script, env) {
  const result = spawnSync("/bin/sh", ["-c", script], { env, encoding: "utf8" });
  return result.stdout || "";
}

function isGone(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH";
  }
}

let liveHost = null;

async function teardown(host) {
  if (!host) return;
  for (const terminal of host.list()) {
    try {
      killTerminalTree(terminal.pid, "SIGKILL", { platform: process.platform });
    } catch {
    }
  }
  host.dispose("the pty test ended");

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

  const dirty = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };

  const probe = "test -t 1 && echo TTY_YES || echo TTY_NO";
  const tty = await runOnPty(host, probe, { env: dirty });
  report.pty = tty.out.trim();
  assert(/TTY_YES/.test(tty.out), `test -t 1 said ${JSON.stringify(tty.out)} — stdout is not a terminal, so this is not a pty`);
  assert(!/TTY_NO/.test(tty.out), `the shell answered both ways: ${JSON.stringify(tty.out)}`);
  pass("test -t 1 through the pty", "the shell's stdout IS a terminal");

  const piped = runOnPipe(probe, dirty);
  report.pipe = piped.trim();
  assert(
    /TTY_NO/.test(piped) && !/TTY_YES/.test(piped),
    `the control arm said ${JSON.stringify(piped)} — a pipe reported a terminal, so case 1 proves nothing`,
  );

  assert(tty.out.includes("\r\n"), "the pty's output had no CR — the line discipline is not a terminal's");
  assert(!piped.includes("\r"), `the pipe's output carried a CR: ${JSON.stringify(piped)}`);
  pass("the same probe through a pipe", "answers NOT a terminal, and without CR");

  const ident = await runOnPty(host, 'printenv TERM_PROGRAM; printenv TERM; printenv TERM_PROGRAM_VERSION', { env: dirty });
  const lines = ident.out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  report.identity = lines;
  assert(lines[0] === TERM_PROGRAM, `the shell's $TERM_PROGRAM is ${JSON.stringify(lines[0])}, not ${JSON.stringify(TERM_PROGRAM)} — dotfiles branch on this`);
  pass("printenv TERM_PROGRAM inside the shell", `${TERM_PROGRAM}`);
  assert(lines[1] === TERM, `the shell's $TERM is ${JSON.stringify(lines[1])}, not ${JSON.stringify(TERM)}`);
  assert(lines[2] === "test-version", `$TERM_PROGRAM_VERSION is ${JSON.stringify(lines[2])} — it did not come from the host's version`);
  pass("printenv TERM inside the shell", `${TERM}, with TERM_PROGRAM_VERSION set`);

  const leaked = await runOnPty(host, 'printenv ELECTRON_RUN_AS_NODE || echo ABSENT', { env: dirty });
  report.electronRunAsNode = leaked.out.trim();
  assert(/ABSENT/.test(leaked.out), `ELECTRON_RUN_AS_NODE reached the user's shell as ${JSON.stringify(leaked.out)}`);
  assert(dirty.ELECTRON_RUN_AS_NODE === "1", "the control for case 5 was not set, so its deletion was never exercised");
  pass("ELECTRON_RUN_AS_NODE", "set on the way in, absent inside the shell");

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
    host
      .open({ shell: "/bin/sh", args: ["-c", "stty size; sleep 1; stty size"], cols: 123, rows: 45, env: dirty })
      .then((opened) => setTimeout(() => host.resize(opened.id, 99, 33), 400), reject);
  });
  const sizes = sized.out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  report.sizes = sizes;
  assert(sizes[0] === "45 123", `the pty opened at ${JSON.stringify(sizes[0])}, not "45 123"`);
  assert(sizes[1] === "33 99", `the pty did not resize: stty says ${JSON.stringify(sizes[1])}, not "33 99"`);
  pass("stty size before and after resize", `${sizes[0]} then ${sizes[1]}`);

  const clean = await runOnPty(host, "exit 7", { env: dirty });
  report.clean = clean.ending;
  assert(clean.ending.fate === TerminalFate.EXITED, `a shell that ran \`exit 7\` reported ${clean.ending.fate}`);
  assert(clean.ending.exitCode === 7, `the exit code came back as ${clean.ending.exitCode}`);
  pass("a shell that exits 7", `fate=${clean.ending.fate} exitCode=${clean.ending.exitCode}`);

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
    host.open({ shell: "/bin/sh", args: ["-c", "sleep 20 & echo CHILD=$!; wait"], env: dirty }).catch(reject);
  });
  const live = host.list()[0];
  assert(live && typeof live.pid === "number", "the terminal with a backgrounded child is not listed as live");
  assert(!isGone(grandchild.pid), `the backgrounded sleep (pid ${grandchild.pid}) was already gone before the kill`);

  const killed = endingOf(host, live.id, "case 8");
  host.kill(live.id, "SIGKILL");
  for (let attempt = 0; attempt < 50 && !isGone(grandchild.pid); attempt += 1) await sleep(100);
  const killEnding = await killed;
  report.groupKill = { grandchild: grandchild.pid, gone: isGone(grandchild.pid), ending: killEnding };
  assert(isGone(grandchild.pid), `pid ${grandchild.pid} survived the kill — the signal reached the shell but not its process group`);

  assert(killEnding.fate === TerminalFate.EXITED, `the killed terminal reported ${JSON.stringify(killEnding)}`);
  assert(killEnding.signal === "9", `SIGKILL came back as signal ${JSON.stringify(killEnding.signal)}, not "9"`);
  assert(
    killEnding.exitCode === 0,
    `a SIGKILLed shell reported exitCode ${killEnding.exitCode} — the premise that a signalled child carries code 0 is what case 9 is read against`,
  );
  pass("kill reaches the process group", `the backgrounded pid ${grandchild.pid} is gone; the shell ended signal=9 exitCode=0`);

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

  const usable = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "telar-usable-cwd-845-")));
  const entered = await runOnPty(host, "pwd -P", { cwd: usable, env: dirty });
  report.usableCwd = { asked: usable, ending: entered.ending, pwd: entered.out.trim() };

  fs.rmSync(usable, { recursive: true, force: true });
  assert(entered.ending.fate === TerminalFate.EXITED, `a usable cwd reported ${JSON.stringify(entered.ending)} — the refusal is refusing everything`);
  assert(entered.ending.exitCode === 0, `a shell in a usable directory exited ${entered.ending.exitCode}`);
  assert(entered.out.split(/\r?\n/)[0].trim() === usable, `the shell says it is in ${JSON.stringify(entered.out.trim())}, not ${JSON.stringify(usable)}`);
  pass("a usable cwd is entered, not refused", `the shell's own pwd is ${usable}`);

  const orphan = await new Promise((resolve) => {
    let ours = null;
    host.onData = () => {};
    host.onExit = (id, ending) => {
      if (id === ours) resolve({ id, ending });
    };
    host.open({ shell: "/bin/sh", args: ["-c", "sleep 20"], env: dirty }).then((opened) => {
      ours = opened.id;
      setTimeout(() => host.dispose(), 300);
    });
  });
  report.dispose = orphan.ending;
  assert(orphan.ending.fate === TerminalFate.EXITED, `a live terminal at shutdown reported ${JSON.stringify(orphan.ending)} — dispose must end it and report the real exit`);

  assert(
    orphan.ending.signal === "1" || orphan.ending.signal === "15",
    `dispose's hangup/SIGTERM came back as signal ${JSON.stringify(orphan.ending.signal)}, not "1" or "15"`,
  );
  for (let attempt = 0; attempt < 50 && !isGone(orphan.ending.pid); attempt += 1) await sleep(100);
  assert(isGone(orphan.ending.pid), `pid ${orphan.ending.pid} survived dispose — the host went away and left it running`);
  pass("dispose with a terminal still live", `fate=${orphan.ending.fate} signal=${orphan.ending.signal}, the process is gone`);

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
