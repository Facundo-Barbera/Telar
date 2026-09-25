// THE TERMINAL HOST'S LOGIC, WITH NO NATIVE MODULE ANYWHERE NEAR IT.
//
// This file runs in the `test` matrix on UBUNTU, and node-pty publishes no
// linux prebuild — so a single stray `require("node-pty")` would take the whole
// desktop suite red on a platform the product does not even ship to. Every case
// here injects a fake spawner, which is also what makes the states that matter
// reachable: `failed` needs a spawn that throws, and `unknown` needs a process
// whose end we never see. Neither can be staged against a real shell.
//
// The other half — that it is a REAL pty — cannot be asserted here at all, and
// is not attempted. `test -t 1` under real Electron lives in
// pty-host.electron-test.js, which the `electron` CI job gates on.
const { afterAll, describe, expect, test } = require("bun:test");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  TerminalHost,
  TerminalFate,
  CLOSE_GRACE_MS,
  parseProcessTable,
  terminalActivity,
  decideQuit,
  TERM,
  TERM_PROGRAM,
  terminalEnv,
  killTerminalTree,
  ensureSpawnHelper,
  spawnHelperCandidates,
  unusableCwd,
  defaultShell,
} = require("./terminal-host");
const { verifyPackagedPty, UNPACKED } = require("./after-pack");

/** A stand-in for node-pty's terminal: records what it was told, and lets a
 *  test decide when — and whether — it ever reports an exit. */
function fakePty(pid = 4242, ptsName) {
  const calls = { writes: [], resizes: [] };
  const handlers = {};
  return {
    pid,
    ptsName,
    calls,
    write: (data) => calls.writes.push(data),
    resize: (cols, rows) => calls.resizes.push([cols, rows]),
    // AN ARRAY PER EVENT, NOT ONE HANDLER. node-pty counts `error` listeners
    // and the host has to register two of them (see the host's comment); a fake
    // that kept only the last would hide both the count and the real handler.
    on: (event, handler) => {
      (handlers[event] ??= []).push(handler);
    },
    listenerCount: (event) => (handlers[event] ?? []).length,
    onData: (handler) => {
      handlers.data = [handler];
    },
    onExit: (handler) => {
      handlers.exit = [handler];
    },
    emitData: (data) => handlers.data.forEach((handler) => handler(data)),
    emitExit: (ending) => handlers.exit.forEach((handler) => handler(ending)),
    emitError: (error) => handlers.error.forEach((handler) => handler(error)),
  };
}

/** A filesystem where every path is a directory this process may enter, so the
 *  cwd refusal (#845) stays out of the way of cases about something else. The
 *  cases that are ABOUT the refusal inject their own. */
const anyCwdIsFine = {
  statSync: () => ({ isDirectory: () => true }),
  accessSync: () => {},
};

/**
 * A clock the test turns by hand. The close escalation is "SIGKILL one second
 * after SIGTERM", and asserting that against the wall would mean a test that
 * sleeps a second — or one that races it.
 */
function fakeClock() {
  let now = 0;
  const timers = [];
  return {
    setTimeout: (fn, ms) => {
      const timer = { fn, at: now + ms, done: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      if (timer) timer.done = true;
    },
    advance(ms) {
      now += ms;
      for (const timer of timers) {
        if (!timer.done && timer.at <= now) {
          timer.done = true;
          timer.fn();
        }
      }
    },
    pending: () => timers.filter((timer) => !timer.done).length,
  };
}

/** A host whose spawner hands back `pty` and records the options it got. */
function hostWith(pty, options = {}) {
  const spawned = [];
  const endings = [];
  const data = [];
  const clock = fakeClock();
  const host = new TerminalHost({
    platform: "darwin",
    version: "9.9.9",
    fs: options.fs ?? anyCwdIsFine,
    killTree: options.killTree ?? (() => {}),
    // An empty table unless the case is ABOUT the table: every close then
    // signals the shell's own group, which is what the older cases assume.
    listProcesses: options.listProcesses ?? (async () => []),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    spawnPty: (file, args, opts) => {
      spawned.push({ file, args, opts });
      if (options.throws) throw options.throws;
      return pty;
    },
    onData: (id, chunk) => data.push([id, chunk]),
    onExit: (id, ending) => endings.push([id, ending]),
    ...options.host,
  });
  return { host, spawned, endings, data, clock };
}

describe("the environment a Telar terminal starts in", () => {
  test("sets TERM and TERM_PROGRAM, and TERM_PROGRAM is the public string", () => {
    const env = terminalEnv({ PATH: "/usr/bin" }, "1.2.3");
    expect(env.TERM).toBe("xterm-256color");
    expect(env.TERM_PROGRAM).toBe("Telar");
    expect(env.TERM_PROGRAM_VERSION).toBe("1.2.3");
    // Neovim with `termguicolors`, delta, bat, oh-my-posh — every truecolour
    // program keys on COLORTERM and falls back to a 256-colour approximation
    // without it. xterm.js paints 24-bit natively, so the fallback was a lie.
    // Nothing said it here, so we say it.
    expect(env.COLORTERM).toBe("truecolor");
    expect(env.PATH).toBe("/usr/bin");
    // The exported constants are what everything else keys off; if either ever
    // changes, it changes here and in a release note, not by accident.
    expect(TERM).toBe("xterm-256color");
    expect(TERM_PROGRAM).toBe("Telar");
  });

  test("takes Telar's OWN marker back out", () => {
    // main.js's childEnv sets this for the processes it forks, so a shell
    // opened inside Telar inherits it and every `electron` the user then runs
    // silently becomes a bare node. Removing our own pollution is not
    // configuring their shell.
    const env = terminalEnv({ ELECTRON_RUN_AS_NODE: "1", SHELL: "/bin/zsh" }, "1.0.0");
    expect("ELECTRON_RUN_AS_NODE" in env).toBe(false);
    expect(env.SHELL).toBe("/bin/zsh");
  });

  test("passes everything else through untouched, and drops non-strings", () => {
    const env = terminalEnv({ ZDOTDIR: "/home/x/.config/zsh", PS1: "weird$ ", NOPE: undefined, ALSO: 7 }, "1.0.0");
    expect(env.ZDOTDIR).toBe("/home/x/.config/zsh");
    expect(env.PS1).toBe("weird$ ");
    // A non-string would reach execve as garbage; there is no repair to make,
    // only a value not to pass on.
    expect("NOPE" in env).toBe(false);
    expect("ALSO" in env).toBe(false);
  });

  test("an inherited COLORTERM is left alone — we fill a silence, we do not argue", () => {
    // The other direction of the same rule. An inherited value is a statement
    // somebody already made about this environment, and a terminal that
    // overwrites it is a terminal arguing with the shell that launched it.
    // T3 Code sets COLORTERM only when the inherited one is absent or empty
    // (Manager.ts:1300); this matches.
    expect(terminalEnv({ COLORTERM: "8bit" }, "1.0.0").COLORTERM).toBe("8bit");
    expect(terminalEnv({ COLORTERM: "truecolor" }, "1.0.0").COLORTERM).toBe("truecolor");
  });

  test("an EMPTY inherited COLORTERM is a silence, not an answer", () => {
    // `COLORTERM=` in a parent's environment says nothing about what anything
    // can paint, and passing it through would leave every truecolour program
    // guessing 256 colours.
    expect(terminalEnv({ COLORTERM: "" }, "1.0.0").COLORTERM).toBe("truecolor");
    expect(terminalEnv({ COLORTERM: "   " }, "1.0.0").COLORTERM).toBe("truecolor");
  });

  test("omits TERM_PROGRAM_VERSION rather than claiming a fake one", () => {
    expect("TERM_PROGRAM_VERSION" in terminalEnv({}, undefined)).toBe(false);
  });
});

describe("killing a terminal's whole tree", () => {
  test("posix signals the GROUP, not the pid", () => {
    // A bare kill(pid) strands the bun/node/vite descendants; node-pty's child
    // is a group leader precisely so this works.
    const calls = [];
    killTerminalTree(321, "SIGTERM", { platform: "darwin", kill: (pid, signal) => calls.push([pid, signal]) });
    expect(calls).toEqual([[-321, "SIGTERM"]]);
  });

  test("win32 reaches taskkill /T /F, from a Mac", () => {
    // Windows packaging does not exist and this does not add it. What the
    // injected platform buys is that the branch is not dark until it does.
    const calls = [];
    killTerminalTree(321, "SIGTERM", { platform: "win32", spawnSync: (file, args, opts) => calls.push([file, args, opts]) });
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("taskkill");
    expect(calls[0][1]).toEqual(["/pid", "321", "/t", "/f"]);
    expect(calls[0][2]).toEqual({ windowsHide: true });
  });

  test("refuses a pid it cannot signal rather than signalling something else", () => {
    // kill(-0) is "every process in MY group", which on a bad id would be
    // Telar signalling itself.
    for (const bad of [0, -1, undefined, null, "123", 1.5]) {
      expect(() => killTerminalTree(bad, "SIGTERM", { platform: "darwin", kill: () => {} })).toThrow(/process id/);
    }
  });

  test("surfaces a taskkill that could not even be launched", () => {
    const boom = new Error("spawnSync taskkill ENOENT");
    expect(() => killTerminalTree(9, "SIGTERM", { platform: "win32", spawnSync: () => ({ error: boom }) })).toThrow(boom);
  });
});

describe("what the host will say about a terminal that is no longer running", () => {
  test("`exited` comes ONLY from the pty's own exit event", () => {
    const pty = fakePty(11);
    const { host, endings } = hostWith(pty);
    const { id } = host.open({ shell: "/bin/zsh", env: {} });
    expect(endings).toEqual([]);
    pty.emitExit({ exitCode: 3, signal: 0 });
    expect(endings).toHaveLength(1);
    expect(endings[0][0]).toBe(id);
    expect(endings[0][1].fate).toBe(TerminalFate.EXITED);
    expect(endings[0][1].exitCode).toBe(3);
    expect(endings[0][1].pid).toBe(11);
  });

  test("a spawn that threw is `failed` — there is no process to be unsure about", () => {
    const { host, endings } = hostWith(null, { throws: new Error("posix_spawnp failed.") });
    const opened = host.open({ shell: "/bin/zsh", env: {} });
    expect(opened.pid).toBeUndefined();
    expect(opened.ending.fate).toBe(TerminalFate.FAILED);
    expect(opened.ending.error).toContain("posix_spawnp");
    expect(endings).toHaveLength(1);
    // And it is not tracked: nothing can be written to, resized or killed.
    expect(host.list()).toEqual([]);
  });

  /**
   * THE ONE THE WHOLE MODEL EXISTS FOR.
   *
   * `unknown` in apps/engine/src/run/types.ts means "we cannot vouch that this
   * is dead", and an `unknown` run KEEPS HOLDING its project's slot. If the
   * host collapsed these into `exited`, something downstream would free a slot
   * for a dev server that is still listening on the port.
   */
  describe("`unknown` is never rounded to `exited`", () => {
    /**
     * THE HOST GOING AWAY IS A CLOSE, NOT A SHRUG ("Run = a new terminal").
     *
     * This pair used to pin the opposite: dispose marked every live terminal
     * `unknown` and signalled nothing. A terminal now owns its process, so
     * the host going away ends it — and invents no ending while doing so: the
     * terminal settles when the pty reports its exit, like any other.
     */
    test("dispose ends a live terminal's group and invents no ending", () => {
      const killed = [];
      const pty = fakePty(77);
      const { host, endings } = hostWith(pty, { killTree: (pid, signal) => killed.push([pid, signal]) });
      host.open({ shell: "/bin/zsh", env: {} });
      host.dispose();
      expect(killed).toEqual([
        [77, "SIGHUP"],
        [77, "SIGTERM"],
      ]);
      expect(endings).toEqual([]);
      pty.emitExit({ exitCode: 0, signal: 15 });
      expect(endings).toHaveLength(1);
      expect(endings[0][1].fate).toBe(TerminalFate.EXITED);
      expect(endings[0][1].signal).toBe("15");
    });

    test("dispose escalates to SIGKILL when the group outlives the grace", () => {
      const killed = [];
      const pty = fakePty(78);
      const { host, clock } = hostWith(pty, { killTree: (pid, signal) => killed.push([pid, signal]) });
      host.open({ shell: "/bin/zsh", env: {} });
      host.dispose();
      clock.advance(999);
      expect(killed).toEqual([
        [78, "SIGHUP"],
        [78, "SIGTERM"],
      ]);
      clock.advance(1);
      expect(killed).toEqual([
        [78, "SIGHUP"],
        [78, "SIGTERM"],
        [78, "SIGKILL"],
      ]);
    });

    test("a kill we could not deliver", () => {
      const pty = fakePty(79);
      const { host, endings } = hostWith(pty, {
        killTree: () => {
          throw new Error("EPERM");
        },
      });
      const { id } = host.open({ shell: "/bin/zsh", env: {} });
      host.kill(id);
      expect(endings[0][1].fate).toBe(TerminalFate.UNKNOWN);
      expect(endings[0][1].reason).toContain("79");
      expect(endings[0][1].reason).toContain("EPERM");
    });

    test("a kill that was delivered and never reported an exit", async () => {
      const pty = fakePty(80);
      const { host, endings } = hostWith(pty, { host: { killObserveMs: 10 } });
      const { id } = host.open({ shell: "/bin/zsh", env: {} });
      host.kill(id, "SIGTERM");
      expect(endings).toEqual([]);
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(endings).toHaveLength(1);
      expect(endings[0][1].fate).toBe(TerminalFate.UNKNOWN);
      expect(endings[0][1].reason).toContain("may still be running");
    });

    /**
     * A KILLED TERMINAL REPORTS EXIT CODE 0, AND THAT IS NOT SUCCESS (#845).
     *
     * node-pty initialises `exit_code` to 0 and only assigns it under
     * `WIFEXITED` (1.1.0, src/unix/pty.cc:110 and :189-194). A process that was
     * SIGNALLED never satisfies that, so its ending is `{exitCode: 0, signal:
     * 9}` — indistinguishable, on the exit code alone, from a command that
     * succeeded. #845 was an hour of CI spent on exactly that confusion, so the
     * pair is pinned here as VALUES rather than left implied: whoever reads an
     * `exited` must look at `signal` before believing the 0.
     */
    test("a kill that DID land is an honest `exited` — code 0 WITH a signal", async () => {
      const pty = fakePty(81);
      const { host, endings } = hostWith(pty, { host: { killObserveMs: 10 } });
      const { id } = host.open({ shell: "/bin/zsh", env: {} });
      host.kill(id, "SIGKILL");
      pty.emitExit({ exitCode: 0, signal: 9 });
      await new Promise((resolve) => setTimeout(resolve, 60));
      // One ending, and it is the observed one — the pending timer must not
      // fire a second, contradictory verdict afterwards.
      expect(endings).toHaveLength(1);
      expect(endings[0][1].fate).toBe(TerminalFate.EXITED);
      expect(endings[0][1].signal).toBe("9");
      expect(endings[0][1].exitCode).toBe(0);
    });

    test("a pty whose fd raised an error", () => {
      const pty = fakePty(82);
      const { host, endings } = hostWith(pty);
      host.open({ shell: "/bin/zsh", env: {} });
      pty.emitError(new Error("read EIO"));
      expect(endings[0][1].fate).toBe(TerminalFate.UNKNOWN);
      expect(endings[0][1].reason).toContain("EIO");
    });

    /**
     * TWO LISTENERS, BECAUSE NODE-PTY COUNTS THEM.
     *
     * It rethrows out of its socket handler while
     * `listeners('error').length < 2` (lib/unixTerminal.js:123 and :206), and
     * `Terminal._forwardEvents` registers only `data` and `exit` — so reaching
     * two is the caller's job. The second handler is empty and this test is
     * what stops it being tidied away as dead code.
     *
     * WHAT IT DOES NOT BUY, recorded because the tempting claim is false and
     * was measured to be false: reaching two listeners did NOT stop the
     * `Napi::Error` abort at shutdown. 4 aborts in 10 runs with two against 2
     * in 10 with one — no effect at n=10. That abort is a different thing
     * entirely (a callback landing in a dying V8) and `drain()` is what fixed
     * it: 0 in 12. This pin is about the stream-error path only.
     */
    test("registers the TWO error listeners node-pty counts before it rethrows", () => {
      const pty = fakePty(84);
      const { host } = hostWith(pty);
      host.open({ shell: "/bin/zsh", env: {} });
      expect(pty.listenerCount("error")).toBeGreaterThanOrEqual(2);
    });

    /**
     * `drain()` is what actually stopped the shutdown abort, so it is pinned.
     *
     * node-pty reaps on a background thread and calls back into JS; exiting
     * into an in-flight callback aborts the process AFTER whatever work it had
     * already finished — which is why the Electron job gates on the exit code
     * as well as the marker. Every aborted run had printed its marker.
     */
    test("drain waits, so a caller can let a pending exit callback land", async () => {
      const { host } = hostWith(fakePty());
      const started = Date.now();
      await host.drain(60);
      expect(Date.now() - started).toBeGreaterThanOrEqual(45);
    });
  });

  test("a terminal ends exactly once, whatever happens to it afterwards", () => {
    const pty = fakePty(83);
    const { host, endings } = hostWith(pty);
    host.open({ shell: "/bin/zsh", env: {} });
    pty.emitExit({ exitCode: 0, signal: 0 });
    pty.emitExit({ exitCode: 0, signal: 0 });
    pty.emitError(new Error("read EIO"));
    host.dispose();
    expect(endings).toHaveLength(1);
  });
});

/**
 * A CWD THE SHELL COULD NOT HAVE ENTERED (#845).
 *
 * On macOS node-pty hands the cwd to `spawn-helper`, whose whole reaction to a
 * `chdir` it cannot make is `_exit(1)` with nothing written anywhere
 * (1.1.0, src/unix/spawn-helper.cc) — so without this check a person opening a
 * terminal on a project directory that has been moved gets a blank window that
 * closes, and no sentence. Refusing first turns that into one.
 *
 * STAGED WITH AN INJECTED `fs`, for the same reason the spawner is injected:
 * a directory that is not there, a path under a regular file and a directory
 * this process may not enter are three DIFFERENT answers, and making the third
 * one for real requires a mode this suite's CI user could not reliably produce.
 */
describe("a terminal asked to start somewhere it cannot", () => {
  const missing = () => {
    const error = new Error("ENOENT: no such file or directory, stat '/gone'");
    error.code = "ENOENT";
    throw error;
  };

  test("no cwd at all is not a refusal — most terminals name none", () => {
    expect(unusableCwd(undefined)).toBeNull();
    expect(unusableCwd(null)).toBeNull();
    expect(unusableCwd("")).toBeNull();
  });

  test("a directory that is not there names itself and the errno", () => {
    const refusal = unusableCwd("/gone", { fs: { statSync: missing, accessSync: () => {} } });
    // A sentence, not a boolean and not a null: a guard that stopped refusing
    // must say so here rather than in `toContain`'s type error.
    expect(typeof refusal).toBe("string");
    expect(refusal).toContain("/gone");
    expect(refusal).toContain("ENOENT");
    expect(refusal).toContain("No process was started.");
  });

  test("a path UNDER a regular file is not a directory for anybody, root included", () => {
    // `/etc/passwd/nope` is the shape the Electron fixture uses precisely
    // because no privilege makes a regular file into a directory.
    const enotdir = () => {
      const error = new Error("ENOTDIR: not a directory, stat '/etc/passwd/nope'");
      error.code = "ENOTDIR";
      throw error;
    };
    const nested = unusableCwd("/etc/passwd/nope", { fs: { statSync: enotdir, accessSync: () => {} } });
    expect(typeof nested).toBe("string");
    expect(nested).toContain("ENOTDIR");
    // And the other shape of the same answer: stat SUCCEEDS on a plain file.
    const refusal = unusableCwd("/etc/passwd", {
      fs: { statSync: () => ({ isDirectory: () => false }), accessSync: () => {} },
    });
    expect(typeof refusal).toBe("string");
    expect(refusal).toContain("is not a directory");
  });

  test("a directory this process may not enter is refused, not attempted", () => {
    const refusal = unusableCwd("/private", {
      fs: {
        statSync: () => ({ isDirectory: () => true }),
        accessSync: () => {
          const error = new Error("EACCES: permission denied, access '/private'");
          error.code = "EACCES";
          throw error;
        },
      },
    });
    expect(typeof refusal).toBe("string");
    expect(refusal).toContain("may not enter");
    expect(refusal).toContain("EACCES");
  });

  test("a usable directory is NOT refused — the control arm", () => {
    // Without this the three above are satisfied by a function that refuses
    // everything, which would take every terminal in the product with it.
    expect(unusableCwd("/work", { fs: { statSync: () => ({ isDirectory: () => true }), accessSync: () => {} } })).toBeNull();
    // And against the REAL filesystem, on a directory that certainly exists.
    expect(unusableCwd(path.dirname(__filename))).toBeNull();
  });

  test("the refusal is `failed`, carries no exit code, and never spawned", () => {
    const { host, spawned, endings } = hostWith(fakePty(99), {
      fs: { statSync: missing, accessSync: () => {} },
    });
    const opened = host.open({ shell: "/bin/zsh", cwd: "/gone", env: {} });
    // NOTHING WAS SPAWNED. This is the half that makes the fate honest.
    expect(spawned).toHaveLength(0);
    expect(opened.pid).toBeUndefined();
    expect(opened.ending.fate).toBe(TerminalFate.FAILED);
    // A refusal cannot carry an exit code, because nothing exited. #845 failed
    // on an ending that claimed `exited` with code 0; the whole point of
    // refusing here is that this reading is impossible.
    expect(opened.ending.exitCode).toBeUndefined();
    expect(opened.ending.error).toContain("/gone");
    // Reported once, through the same channel every other ending uses, and not
    // tracked — there is no process to write to, resize or kill.
    expect(endings).toHaveLength(1);
    expect(endings[0][0]).toBe(opened.id);
    expect(host.list()).toEqual([]);
  });

  test("a terminal with a usable cwd still starts, and gets it", () => {
    const { host, spawned, endings } = hostWith(fakePty(100));
    const opened = host.open({ shell: "/bin/zsh", cwd: "/work", env: {} });
    expect(spawned).toHaveLength(1);
    expect(spawned[0].opts.cwd).toBe("/work");
    expect(opened.pid).toBe(100);
    expect(opened.ending).toBeUndefined();
    expect(endings).toEqual([]);
  });
});

describe("driving a live terminal", () => {
  test("open passes the size and the environment through to the spawner", () => {
    const pty = fakePty();
    const { host, spawned } = hostWith(pty);
    host.open({ shell: "/bin/zsh", args: ["-l"], cwd: "/work", cols: 120, rows: 40, env: { HOME: "/home/x" } });
    expect(spawned[0].file).toBe("/bin/zsh");
    expect(spawned[0].args).toEqual(["-l"]);
    expect(spawned[0].opts.cwd).toBe("/work");
    expect(spawned[0].opts.cols).toBe(120);
    expect(spawned[0].opts.rows).toBe(40);
    expect(spawned[0].opts.name).toBe(TERM);
    expect(spawned[0].opts.env.TERM_PROGRAM).toBe("Telar");
    expect(spawned[0].opts.env.TERM_PROGRAM_VERSION).toBe("9.9.9");
  });

  test("a terminal with no size still gets one, because 0x0 draws nothing", () => {
    const pty = fakePty();
    const { host, spawned } = hostWith(pty);
    host.open({ shell: "/bin/zsh", env: {}, cols: 0, rows: -5 });
    expect(spawned[0].opts.cols).toBe(80);
    expect(spawned[0].opts.rows).toBe(24);
  });

  test("write and resize reach the pty; both refuse an id that is not live", () => {
    const pty = fakePty();
    const { host } = hostWith(pty);
    const { id } = host.open({ shell: "/bin/zsh", env: {} });
    expect(host.write(id, "ls\r")).toBe(true);
    expect(host.resize(id, 100, 30)).toBe(true);
    expect(pty.calls.writes).toEqual(["ls\r"]);
    expect(pty.calls.resizes).toEqual([[100, 30]]);
    expect(host.write("term_nope", "x")).toBe(false);
    expect(host.resize("term_nope", 10, 10)).toBe(false);
    expect(host.kill("term_nope")).toBe(false);
  });

  test("a keystroke arriving after the exit is dropped, not thrown", () => {
    // The renderer learns of an exit asynchronously, so a key in flight across
    // that gap is normal. Throwing would turn it into an error dialog.
    const pty = fakePty();
    const { host } = hostWith(pty);
    const { id } = host.open({ shell: "/bin/zsh", env: {} });
    pty.emitExit({ exitCode: 0, signal: 0 });
    expect(host.write(id, "ls\r")).toBe(false);
    expect(pty.calls.writes).toEqual([]);
  });

  test("ids are not pids — a reused pid must not address a stranger", () => {
    const first = fakePty(500);
    const { host } = hostWith(first);
    const a = host.open({ shell: "/bin/zsh", env: {} });
    const b = host.open({ shell: "/bin/zsh", env: {} });
    expect(a.id).not.toBe(b.id);
    expect(a.pid).toBe(b.pid); // the same fake, standing in for a reused pid
  });

  test("data is forwarded while live and dropped after the ending", () => {
    const pty = fakePty();
    const { host, data } = hostWith(pty);
    const { id } = host.open({ shell: "/bin/zsh", env: {} });
    pty.emitData("hello");
    pty.emitExit({ exitCode: 0, signal: 0 });
    pty.emitData("after");
    expect(data).toEqual([[id, "hello"]]);
  });

  test("list reports facts, never handles", () => {
    const pty = fakePty(91);
    const { host } = hostWith(pty);
    const { id } = host.open({ shell: "/bin/zsh", cwd: "/work", cols: 90, rows: 20, env: {} });
    expect(host.list()).toEqual([
      {
        id,
        pid: 91,
        sessionId: undefined,
        origin: "user",
        title: undefined,
        shell: "/bin/zsh",
        cwd: "/work",
        cols: 90,
        rows: 20,
        startedAt: expect.any(Number),
      },
    ]);
    expect(JSON.stringify(host.list())).not.toContain("pty");
  });

  test("a disposed host will not start another shell", () => {
    const { host } = hostWith(fakePty());
    host.dispose();
    expect(() => host.open({ shell: "/bin/zsh", env: {} })).toThrow(/shutting down/);
  });
});

/**
 * WHO MAY REACH WHICH TERMINAL (#198).
 *
 * EVERY CASE HERE IS A PAIR, and that is the whole design of this block. An
 * assertion that an engine-owned id is refused passes just as well when `write`
 * is broken for everybody, and an assertion that a run's terminal is absent
 * from `list` passes against a `list` that returns nothing at all. So each test
 * carries its own positive control in the same call: the other owner's terminal
 * still works, and is still listed, in the same host, in the same test.
 */
describe("a terminal has an owner, and only its owner may reach it", () => {
  /** A host whose spawner mints a FRESH fake per open — two terminals here are
   *  two handles, which is what an ownership test is about. */
  function twoOwnerHost() {
    const ptys = [];
    const host = new TerminalHost({
      platform: "darwin",
      version: "9.9.9",
      killTree: () => {},
      spawnPty: () => {
        const pty = fakePty(500 + ptys.length);
        ptys.push(pty);
        return pty;
      },
    });
    const mine = host.open({ shell: "/bin/zsh", env: {}, owner: "renderer" });
    const theirs = host.open({ shell: "/bin/sh", args: ["-c", "bun run dev"], env: {}, owner: "engine" });
    return { host, mine, theirs, ptys };
  }

  test("write refuses the other owner's id and still delivers to its own", () => {
    const { host, mine, theirs, ptys } = twoOwnerHost();
    // The refusal…
    expect(host.write(theirs.id, "rm -rf /\r", "renderer")).toBe(false);
    // …and the permit, which is what makes the refusal mean something. Delete
    // the owner check in `_owned` and this line still passes while the one
    // above fails.
    expect(host.write(mine.id, "ls\r", "renderer")).toBe(true);
    // The bytes, not the booleans: a guard that returned the right answers and
    // wrote to the wrong pty would satisfy both lines above.
    expect(ptys[0].calls.writes).toEqual(["ls\r"]);
    expect(ptys[1].calls.writes).toEqual([]);
  });

  test("resize and kill are scoped the same way, in both directions", () => {
    const { host, mine, theirs, ptys } = twoOwnerHost();
    expect(host.resize(theirs.id, 10, 10, "renderer")).toBe(false);
    expect(host.resize(mine.id, 100, 40, "renderer")).toBe(true);
    expect(ptys[1].calls.resizes).toEqual([]);
    expect(ptys[0].calls.resizes).toEqual([[100, 40]]);

    // A renderer must not be able to stop a run's dev server by id, and the
    // engine must still be able to stop its own.
    expect(host.kill(theirs.id, "SIGTERM", "renderer")).toBe(false);
    expect(host.kill(theirs.id, "SIGTERM", "engine")).toBe(true);
  });

  test("the engine reaches its own terminal, which is the other direction of the same guard", () => {
    const { host, mine, theirs, ptys } = twoOwnerHost();
    expect(host.write(theirs.id, "y\r", "engine")).toBe(true);
    expect(host.write(mine.id, "y\r", "engine")).toBe(false);
    expect(ptys[1].calls.writes).toEqual(["y\r"]);
    expect(ptys[0].calls.writes).toEqual([]);
  });

  test("list omits the other owner's terminals and keeps its own", () => {
    const { host, mine, theirs } = twoOwnerHost();
    const rendererIds = host.list("renderer").map((entry) => entry.id);
    const engineIds = host.list("engine").map((entry) => entry.id);
    // The absence…
    expect(rendererIds).not.toContain(theirs.id);
    expect(engineIds).not.toContain(mine.id);
    // …and the presence. An absence assertion alone is satisfied by a `list`
    // that answers an empty array for everyone.
    expect(rendererIds).toEqual([mine.id]);
    expect(engineIds).toEqual([theirs.id]);
  });

  test("the default scope is the renderer's, so a caller that forgets is refused rather than trusted", () => {
    const { host, mine, theirs } = twoOwnerHost();
    expect(host.write(theirs.id, "x", undefined)).toBe(false);
    expect(host.write(mine.id, "x", undefined)).toBe(true);
    expect(host.list().map((entry) => entry.id)).toEqual([mine.id]);
  });

  test("an owner that is neither throws rather than being rounded to one", () => {
    // Rounding an unrecognised owner to `renderer` would be the guard failing
    // open on a typo, which is the failure mode a guard exists to not have.
    const { host, mine } = twoOwnerHost();
    expect(() => host.open({ shell: "/bin/zsh", env: {}, owner: "engine " })).toThrow(/owner/);
    expect(() => host.write(mine.id, "x", "ENGINE")).toThrow(/owner/);
    expect(() => host.list("agent")).toThrow(/owner/);
  });

  test("dispose ends every terminal, whoever opened it", () => {
    // The one place ownership deliberately does not apply: the host going away
    // is about every handle it holds. A run left running here would outlive
    // Telar with nothing left that can reach it.
    const killed = [];
    let pid = 700;
    const host = new TerminalHost({
      platform: "darwin",
      version: "9.9.9",
      fs: anyCwdIsFine,
      spawnPty: () => fakePty((pid += 1)),
      killTree: (target, signal) => killed.push([target, signal]),
      setTimeout: () => null,
      clearTimeout: () => {},
    });
    host.open({ shell: "/bin/zsh", env: {}, owner: "renderer" });
    host.open({ shell: "/bin/sh", env: {}, owner: "engine" });
    host.dispose();
    expect(killed).toEqual([
      [701, "SIGHUP"],
      [701, "SIGTERM"],
      [702, "SIGHUP"],
      [702, "SIGTERM"],
    ]);
  });
});

/**
 * A TERMINAL BELONGS TO A SESSION, AND SAYS WHY IT EXISTS.
 *
 * `sessionId` is what settling a session will close by; `origin` is what the
 * tab will say. Both are recorded at open and never change.
 */
describe("a terminal's session and origin", () => {
  function sessionHost() {
    let pid = 500;
    const killed = [];
    const clock = fakeClock();
    const host = new TerminalHost({
      platform: "darwin",
      version: "9.9.9",
      fs: anyCwdIsFine,
      spawnPty: () => fakePty((pid += 1)),
      killTree: (target, signal) => killed.push([target, signal]),
      listProcesses: async () => [],
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    /** Run a close to completion on the hand-turned clock. */
    const finished = async (closing) => {
      for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
      clock.advance(CLOSE_GRACE_MS);
      return closing;
    };
    return { host, killed, clock, finished };
  }

  test("each owner gets the only origin it ever had when it does not say", () => {
    // The engine client on main sends no origin today; its terminals must
    // still read as runs, or this change is not backward compatible.
    const { host } = sessionHost();
    const shell = host.open({ shell: "/bin/zsh", env: {}, owner: "renderer" });
    const run = host.open({ shell: "/bin/sh", env: {}, owner: "engine" });
    expect(host.describe(shell.id, "renderer").origin).toBe("user");
    expect(host.describe(run.id, "engine").origin).toBe("run");
  });

  test("session, origin and title are recorded and listed", () => {
    const { host } = sessionHost();
    const { id } = host.open({ shell: "/bin/sh", env: {}, owner: "engine", origin: "agent", sessionId: " s_1 ", title: "web dev" });
    expect(host.list("engine")).toEqual([
      expect.objectContaining({ id, sessionId: "s_1", origin: "agent", title: "web dev" }),
    ]);
    expect(host.describe(id, "engine")).toEqual(expect.objectContaining({ sessionId: "s_1", origin: "agent", title: "web dev" }));
  });

  test("describe is scoped like every verb — the other owner's id is not there", () => {
    const { host } = sessionHost();
    const run = host.open({ shell: "/bin/sh", env: {}, owner: "engine" });
    const shell = host.open({ shell: "/bin/zsh", env: {}, owner: "renderer" });
    expect(host.describe(run.id, "renderer")).toBeUndefined();
    expect(host.describe(shell.id, "renderer")).toBeDefined();
  });

  test("an origin the owner could not have is refused, in both directions", () => {
    // A renderer labelling its shell `agent`, or the engine claiming a person
    // typed a command, is a lie on screen. Both throw; the control arms open.
    const { host } = sessionHost();
    expect(() => host.open({ shell: "/bin/zsh", env: {}, owner: "renderer", origin: "agent" })).toThrow(/origin/);
    expect(() => host.open({ shell: "/bin/zsh", env: {}, owner: "renderer", origin: "run" })).toThrow(/origin/);
    expect(() => host.open({ shell: "/bin/sh", env: {}, owner: "engine", origin: "user" })).toThrow(/origin/);
    expect(() => host.open({ shell: "/bin/sh", env: {}, owner: "engine", origin: "bogus" })).toThrow(/origin/);
    expect(host.open({ shell: "/bin/sh", env: {}, owner: "engine", origin: "run" }).pid).toBeDefined();
    expect(host.open({ shell: "/bin/zsh", env: {}, owner: "renderer", origin: "user" }).pid).toBeDefined();
  });

  test("a session id that is not a string is dropped, not coerced", () => {
    const { host } = sessionHost();
    const { id } = host.open({ shell: "/bin/zsh", env: {}, sessionId: { toString: () => "s_1" } });
    expect(host.describe(id).sessionId).toBeUndefined();
  });

  test("killBySession closes that session's terminals, every owner, and nobody else's", async () => {
    const { host, killed, finished } = sessionHost();
    const shell = host.open({ shell: "/bin/zsh", env: {}, owner: "renderer", sessionId: "s_a" });
    const run = host.open({ shell: "/bin/sh", env: {}, owner: "engine", sessionId: "s_a" });
    const other = host.open({ shell: "/bin/zsh", env: {}, owner: "renderer", sessionId: "s_b" });
    expect(await finished(host.killBySession("s_a"))).toBe(2);
    expect(killed.filter(([, signal]) => signal === "SIGTERM")).toEqual([
      [shell.pid, "SIGTERM"],
      [run.pid, "SIGTERM"],
    ]);
    // The control arm: the other session's terminal was not touched.
    expect(killed.some(([pid]) => pid === other.pid)).toBe(false);
  });

  test("killBySession can be narrowed to one owner", async () => {
    const { host, killed, finished } = sessionHost();
    host.open({ shell: "/bin/zsh", env: {}, owner: "renderer", sessionId: "s_a" });
    const run = host.open({ shell: "/bin/sh", env: {}, owner: "engine", sessionId: "s_a" });
    expect(await finished(host.killBySession("s_a", { owner: "engine" }))).toBe(1);
    expect(killed).toEqual([
      [run.pid, "SIGHUP"],
      [run.pid, "SIGTERM"],
      [run.pid, "SIGKILL"],
    ]);
  });

  test("no session never matches no session", async () => {
    // A settle that passed `undefined` must close nothing — not every
    // terminal nobody labelled.
    const { host, killed } = sessionHost();
    host.open({ shell: "/bin/zsh", env: {} });
    for (const missing of [undefined, null, "", "   ", 7]) {
      expect(await host.killBySession(missing)).toBe(0);
    }
    expect(killed).toEqual([]);
  });

  test("killBySession escalates like any close", async () => {
    const { host, killed, finished } = sessionHost();
    const { pid } = host.open({ shell: "/bin/zsh", env: {}, sessionId: "s_a" });
    expect(await finished(host.killBySession("s_a"))).toBe(1);
    expect(killed).toEqual([
      [pid, "SIGHUP"],
      [pid, "SIGTERM"],
      [pid, "SIGKILL"],
    ]);
  });
});

/**
 * CLOSE = KILL, WITH ESCALATION.
 *
 * The contract a person relies on when they close a tab: SIGTERM to every
 * process group in the terminal, and SIGKILL a second later to whatever did not
 * go. Told against a hand-turned clock and a process table the test wrote.
 */
describe("closing a terminal ends what runs in it", () => {
  /** A table for a terminal at /dev/ttys009 whose shell (pid 900) has started
   *  `bun run dev` as a job in its OWN group (910), which is what an
   *  interactive shell does — plus that job's child. */
  const busyTable = [
    { pid: 900, ppid: 1, pgid: 900, tpgid: 910, tty: "ttys009", command: "-zsh" },
    { pid: 910, ppid: 900, pgid: 910, tpgid: 910, tty: "ttys009", command: "bun run dev" },
    { pid: 911, ppid: 910, pgid: 910, tpgid: 910, tty: "ttys009", command: "node vite" },
    { pid: 1200, ppid: 1, pgid: 1200, tpgid: 0, tty: "??", command: "unrelated" },
  ];

  function closeHost(table = busyTable, killTree) {
    const killed = [];
    const pty = fakePty(900, "/dev/ttys009");
    const made = hostWith(pty, {
      listProcesses: async () => table,
      killTree: killTree ?? ((pid, signal) => killed.push([pid, signal])),
    });
    const { id } = made.host.open({ shell: "/bin/zsh", env: {} });
    return { ...made, pty, id, killed };
  }

  /** Let `close`'s awaited snapshot resolve before the clock is turned. */
  const settle = async () => {
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
  };

  test("SIGTERM reaches the job's group too, not just the shell's", async () => {
    // Signalling -900 alone would leave `bun run dev` (group 910) running
    // behind a closed tab — an interactive shell puts each job in its own group.
    const { host, id, killed, clock } = closeHost();
    const closing = host.close(id);
    await settle();
    // The hangup goes to the SHELL's group only — it is what lets an idle
    // interactive shell, which ignores TERM, end without waiting for KILL.
    expect(killed).toEqual([
      [900, "SIGHUP"],
      [900, "SIGTERM"],
      [910, "SIGTERM"],
    ]);
    // The unrelated process on no tty is nobody's business here.
    expect(killed.some(([pid]) => pid === 1200)).toBe(false);
    clock.advance(CLOSE_GRACE_MS);
    expect(await closing).toBe(true);
  });

  test("SIGKILL follows after the grace, and not a moment before", async () => {
    const { host, id, killed, clock } = closeHost();
    const closing = host.close(id);
    await settle();
    clock.advance(CLOSE_GRACE_MS - 1);
    expect(killed.filter(([, signal]) => signal === "SIGKILL")).toEqual([]);
    clock.advance(1);
    expect(killed.filter(([, signal]) => signal === "SIGKILL")).toEqual([
      [900, "SIGKILL"],
      [910, "SIGKILL"],
    ]);
    expect(await closing).toBe(true);
  });

  test("a close that ended cleanly stops early and signals nothing more", async () => {
    // The shell's exit is the ONE moment we look: every group probes ESRCH, so
    // the close is over and no SIGKILL is ever aimed at a group id we have
    // seen go empty.
    const signals = [];
    const gone = Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    const { host, id, pty, clock, endings } = closeHost(busyTable, (pid, signal) => {
      signals.push([pid, signal]);
      if (signal === 0) throw gone;
    });
    const closing = host.close(id);
    await settle();
    pty.emitExit({ exitCode: 0, signal: 15 });
    expect(await closing).toBe(true);
    expect(clock.pending()).toBe(0);
    clock.advance(CLOSE_GRACE_MS * 5);
    expect(signals.filter(([, signal]) => signal === "SIGKILL")).toEqual([]);
    expect(endings[0][1].fate).toBe(TerminalFate.EXITED);
  });

  test("the shell exiting is NOT the end when something in the terminal ignored TERM", async () => {
    // Group 910 answers the probe — something in it is still alive — so the
    // SIGKILL still goes, to that group only.
    const signals = [];
    const gone = Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    const { host, id, pty, clock } = closeHost(busyTable, (pid, signal) => {
      signals.push([pid, signal]);
      if (signal === 0 && pid === 900) throw gone;
    });
    const closing = host.close(id);
    await settle();
    pty.emitExit({ exitCode: 0, signal: 15 });
    clock.advance(CLOSE_GRACE_MS);
    expect(await closing).toBe(true);
    expect(signals.filter(([, signal]) => signal === "SIGKILL")).toEqual([[910, "SIGKILL"]]);
  });

  test("a table that cannot be read still closes the shell's own group", async () => {
    const { host, id, killed, clock } = closeHost(null);
    host.listProcesses = async () => {
      throw new Error("ps: not found");
    };
    const closing = host.close(id);
    await settle();
    clock.advance(CLOSE_GRACE_MS);
    await closing;
    expect(killed).toEqual([
      [900, "SIGHUP"],
      [900, "SIGTERM"],
      [900, "SIGKILL"],
    ]);
  });

  test("closing somebody else's terminal is the same silence as writing to it", async () => {
    const { host, id, killed } = closeHost();
    expect(await host.close(id, "engine")).toBe(false);
    expect(await host.close("term_nope")).toBe(false);
    expect(killed).toEqual([]);
  });

  test("closing twice is one close", async () => {
    const { host, id, killed, clock } = closeHost();
    const first = host.close(id);
    const second = host.close(id);
    await settle();
    clock.advance(CLOSE_GRACE_MS);
    await Promise.all([first, second]);
    expect(killed.filter(([, signal]) => signal === "SIGTERM")).toHaveLength(2);
    expect(killed.filter(([, signal]) => signal === "SIGKILL")).toHaveLength(2);
  });

  test("closeAll({ final }) refuses a new shell before it reads the table", async () => {
    // A terminal opened during the second a quit takes would be its one survivor.
    const { host, clock } = closeHost();
    const closing = host.closeAll({ final: true });
    expect(() => host.open({ shell: "/bin/zsh", env: {} })).toThrow(/shutting down/);
    await settle();
    clock.advance(CLOSE_GRACE_MS);
    expect(await closing).toBe(1);
  });

  test("win32 has no gentler first step, so nothing is escalated", async () => {
    const killed = [];
    const pty = fakePty(42);
    const { host, clock } = hostWith(pty, { killTree: (pid, signal) => killed.push([pid, signal]), host: { platform: "win32" } });
    const { id } = host.open({ shell: "cmd.exe", env: {} });
    expect(await host.close(id)).toBe(true);
    expect(clock.pending()).toBe(0);
    expect(killed).toEqual([[42, "SIGTERM"]]);
  });
});

/**
 * IS SOMETHING RUNNING? — asked once, when a person is about to be asked.
 */
describe("whether a terminal has an active process", () => {
  test("an idle shell at its prompt is not active", () => {
    const rows = [{ pid: 300, ppid: 1, pgid: 300, tpgid: 300, tty: "ttys001", command: "-zsh" }];
    expect(terminalActivity({ pid: 300, tty: "/dev/ttys001" }, rows)).toEqual({
      active: false,
      processes: 0,
      command: undefined,
      groups: [300],
    });
  });

  test("a command holding the prompt is active, and named", () => {
    const rows = [
      { pid: 300, ppid: 1, pgid: 300, tpgid: 310, tty: "ttys001", command: "-zsh" },
      { pid: 310, ppid: 300, pgid: 310, tpgid: 310, tty: "ttys001", command: "bun run dev" },
      { pid: 311, ppid: 310, pgid: 310, tpgid: 310, tty: "ttys001", command: "next dev" },
    ];
    const activity = terminalActivity({ pid: 300, tty: "/dev/ttys001" }, rows);
    expect(activity.active).toBe(true);
    expect(activity.processes).toBe(2);
    expect(activity.command).toBe("bun run dev");
    expect(activity.groups).toEqual([300, 310]);
  });

  test("a backgrounded child makes a shell at its prompt active", () => {
    // `server &` then back at the prompt: the foreground is the shell again,
    // and closing would still end the server.
    const rows = [
      { pid: 300, ppid: 1, pgid: 300, tpgid: 300, tty: "ttys001", command: "-zsh" },
      { pid: 320, ppid: 300, pgid: 320, tpgid: 300, tty: "ttys001", command: "python -m http.server" },
    ];
    const activity = terminalActivity({ pid: 300, tty: "/dev/ttys001" }, rows);
    expect(activity.active).toBe(true);
    expect(activity.command).toBe("python -m http.server");
  });

  test("a run's `sh -c` with no tty known is judged by its group and children", () => {
    const rows = [
      { pid: 400, ppid: 1, pgid: 400, tpgid: 400, tty: "ttys002", command: "sh -c bun run dev" },
      { pid: 401, ppid: 400, pgid: 400, tpgid: 400, tty: "ttys002", command: "bun run dev" },
    ];
    expect(terminalActivity({ pid: 400 }, rows).active).toBe(true);
  });

  test("never names group 1 or 0 as something to signal", () => {
    // kill(-1) is every process this user owns; kill(-0) is Telar's own group.
    const rows = [
      { pid: 300, ppid: 1, pgid: 300, tpgid: 300, tty: "ttys001", command: "-zsh" },
      { pid: 330, ppid: 300, pgid: 1, tpgid: 300, tty: "ttys001", command: "odd" },
      { pid: 331, ppid: 300, pgid: 0, tpgid: 300, tty: "ttys001", command: "odder" },
    ];
    expect(terminalActivity({ pid: 300, tty: "ttys001" }, rows).groups).toEqual([300]);
  });

  test("parses ps's columns, including a command line with spaces", () => {
    const text = [
      "    1     0     1    0 ??       /sbin/launchd",
      "23273 23272 23273 23273 ttys000  -/bin/zsh",
      "86190 68985 86190 86190 ttys010  bun run dev --port 3000",
      "  777   1   777   -1 ?        linux-style",
      "not a row",
    ].join("\n");
    expect(parseProcessTable(text)).toEqual([
      { pid: 1, ppid: 0, pgid: 1, tpgid: 0, tty: "??", command: "/sbin/launchd" },
      { pid: 23273, ppid: 23272, pgid: 23273, tpgid: 23273, tty: "ttys000", command: "-/bin/zsh" },
      { pid: 86190, ppid: 68985, pgid: 86190, tpgid: 86190, tty: "ttys010", command: "bun run dev --port 3000" },
      { pid: 777, ppid: 1, pgid: 777, tpgid: -1, tty: "?", command: "linux-style" },
    ]);
  });

  test("the host answers from ONE table for every terminal asked about, scoped by owner", async () => {
    let reads = 0;
    let pid = 600;
    const host = new TerminalHost({
      platform: "darwin",
      version: "9.9.9",
      fs: anyCwdIsFine,
      spawnPty: () => fakePty((pid += 1)),
      killTree: () => {},
      listProcesses: async () => {
        reads += 1;
        return [
          { pid: 601, ppid: 1, pgid: 601, tpgid: 601, tty: "??", command: "zsh" },
          { pid: 602, ppid: 1, pgid: 602, tpgid: 602, tty: "??", command: "sh -c bun run dev" },
          { pid: 603, ppid: 602, pgid: 602, tpgid: 602, tty: "??", command: "bun run dev" },
        ];
      },
    });
    const shell = host.open({ shell: "/bin/zsh", env: {}, owner: "renderer", sessionId: "s_1" });
    const run = host.open({ shell: "/bin/sh", env: {}, owner: "engine", sessionId: "s_1", title: "web dev" });
    const all = await host.activeProcesses();
    expect(reads).toBe(1);
    expect(all).toEqual([
      { id: shell.id, sessionId: "s_1", origin: "user", title: undefined, active: false, processes: 0, command: undefined },
      { id: run.id, sessionId: "s_1", origin: "run", title: "web dev", active: true, processes: 1, command: "bun run dev" },
    ]);
    expect((await host.activeProcesses({ owner: "renderer" })).map((entry) => entry.id)).toEqual([shell.id]);
    expect((await host.activeProcesses({ ids: [run.id] })).map((entry) => entry.id)).toEqual([run.id]);
    // Nothing asked about, nothing read.
    reads = 0;
    expect(await host.activeProcesses({ ids: [] })).toEqual([]);
    expect(reads).toBe(0);
  });

  test("a table that cannot be read answers `active` — ask rather than lose a server", async () => {
    const { host } = hostWith(fakePty(1), {
      listProcesses: async () => {
        throw new Error("ps exploded");
      },
    });
    host.open({ shell: "/bin/zsh", env: {} });
    const [entry] = await host.activeProcesses();
    expect(entry.active).toBe(true);
  });
});

/**
 * QUIT, OR ASK FIRST. The pure half of main.js's `before-quit`.
 */
describe("deciding whether quitting has to ask", () => {
  test("nothing active: quit, and say how many idle terminals will close", () => {
    expect(decideQuit([])).toEqual({ action: "quit", closing: 0 });
    expect(decideQuit([{ active: false }, { active: false }])).toEqual({ action: "quit", closing: 2 });
  });

  test("anything active: ONE question, counting only what is running", () => {
    const plan = decideQuit([
      { active: true, command: "bun run dev" },
      { active: false },
      { active: true, command: "pytest -x" },
    ]);
    expect(plan.action).toBe("confirm");
    expect(plan.count).toBe(2);
    expect(plan.closing).toBe(3);
    expect(plan.dialog.message).toBe("2 processes are still running in Telar's terminals");
    expect(plan.dialog.detail).toContain("• bun run dev");
    expect(plan.dialog.detail).toContain("• pytest -x");
    expect(plan.dialog.detail).toContain("ends everything running in them");
    expect(plan.dialog.buttons).toEqual(["End them and quit", "Cancel"]);
    expect(plan.dialog.defaultId).toBe(0);
    expect(plan.dialog.cancelId).toBe(1);
  });

  test("one process reads as one, and a long list is cut with a count", () => {
    expect(decideQuit([{ active: true, command: "x" }]).dialog.message).toBe("1 process is still running in Telar's terminals");
    const many = Array.from({ length: 8 }, (_, index) => ({ active: true, command: `job ${index}` }));
    const detail = decideQuit(many).dialog.detail;
    expect(detail).toContain("• job 4");
    expect(detail).not.toContain("• job 5");
    expect(detail).toContain("…and 3 more");
  });

  test("a command with no name still reads as something", () => {
    expect(decideQuit([{ active: true }]).dialog.detail).toContain("• a command");
  });

  test("names no other product", () => {
    const plan = decideQuit([{ active: true, command: "bun run dev" }]);
    const copy = [plan.dialog.message, plan.dialog.detail.replace("bun run dev", ""), ...plan.dialog.buttons].join(" ");
    expect(copy).not.toMatch(/claude|codex|opencode|electron|node-pty|macos/i);
  });
});

/**
 * THE REAL THING, WITHOUT A PTY: a process group that ignores SIGTERM.
 *
 * node-pty has no linux prebuild, so the escalation is proven here on a plain
 * `detached` child — which, like node-pty's, leads its own process group —
 * wrapped in the shape the host expects. The shell ignores HUP and TERM, and so
 * does the `sleep` it starts (an ignored signal is inherited), so nothing in
 * the group ends until SIGKILL. The grace is 150 ms rather than a second; the escalation
 * is the same code either way.
 */
describe("closing a real process group that ignores SIGTERM", () => {
  const spawnedGroups = [];
  afterAll(() => {
    // Only groups this file started, by pgid. Nothing survives the suite.
    for (const pgid of spawnedGroups) {
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  });

  function childAsPty(script) {
    const child = spawn("/bin/sh", ["-c", script], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    spawnedGroups.push(child.pid);
    return {
      pid: child.pid,
      write: () => {},
      resize: () => {},
      onData: (handler) => child.stdout.on("data", (chunk) => handler(chunk.toString())),
      onExit: (handler) => child.on("exit", (code, signal) => handler({ exitCode: code ?? 0, signal })),
    };
  }

  function isGone(pid) {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return error.code === "ESRCH";
    }
  }

  test.skipIf(process.platform === "win32")("SIGTERM is ignored, SIGKILL ends the whole group", async () => {
    let out = "";
    let ending = null;
    let announced;
    const ready = new Promise((resolve) => (announced = resolve));
    const exited = new Promise((resolve) => {
      const host = new TerminalHost({
        version: "9.9.9",
        closeGraceMs: 150,
        spawnPty: () => childAsPty("trap '' HUP TERM; sleep 30 & echo CHILD=$!; wait; wait"),
        onData: (_id, data) => {
          out += data;
          if (/CHILD=\d+/.test(out)) announced();
        },
        onExit: (_id, end) => {
          ending = end;
          resolve(end);
        },
      });
      runCase(host).catch((error) => resolve({ error }));
    });

    let grandchild;
    let active;
    async function runCase(host) {
      const { id } = host.open({ shell: "/bin/sh", env: {}, sessionId: "s_fixture" });
      await ready;
      grandchild = Number(/CHILD=(\d+)/.exec(out)[1]);
      [active] = await host.activeProcesses();
      const started = Date.now();
      await host.killBySession("s_fixture");
      // The escalation waited for the grace: TERM alone did not end it.
      expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    }

    const end = await exited;
    expect(end.error).toBeUndefined();
    // The real table saw the backgrounded sleep, so the close had a reason to ask.
    expect(active.active).toBe(true);
    expect(active.processes).toBeGreaterThanOrEqual(1);
    expect(ending.fate).toBe(TerminalFate.EXITED);
    expect(ending.signal).toBe("SIGKILL");
    // The grandchild was in the group, and it is gone too. Reaped by init,
    // which can lag a moment behind the shell's own exit.
    for (let attempt = 0; attempt < 40 && !isGone(grandchild); attempt += 1) await new Promise((r) => setTimeout(r, 25));
    expect(isGone(grandchild)).toBe(true);
  });

  test.skipIf(process.platform === "win32")("a lone process with nothing under it is not active", async () => {
    const host = new TerminalHost({ version: "9.9.9", closeGraceMs: 150, spawnPty: () => childAsPty("exec sleep 30") });
    host.open({ shell: "/bin/sh", env: {} });
    const [entry] = await host.activeProcesses();
    expect(entry.active).toBe(false);
    await host.closeAll();
  });
});

describe("the shell we fall back to", () => {
  test("$SHELL is the person's own choice and wins", () => {
    expect(defaultShell("darwin", { SHELL: "/opt/homebrew/bin/fish" })).toBe("/opt/homebrew/bin/fish");
  });

  test("/bin/sh is the floor, not a guess at zsh", () => {
    expect(defaultShell("darwin", {})).toBe("/bin/sh");
    expect(defaultShell("linux", { SHELL: "  " })).toBe("/bin/sh");
  });

  test("win32 has a different answer entirely", () => {
    expect(defaultShell("win32", {})).toBe("cmd.exe");
    expect(defaultShell("win32", { COMSPEC: "C:\\Windows\\System32\\cmd.exe" })).toBe("C:\\Windows\\System32\\cmd.exe");
  });

  test("open resolves it against the environment the CHILD gets", () => {
    // Not against process.env. Reading $SHELL from one environment and handing
    // the child another answers /bin/sh for a person whose shell is fish.
    const pty = fakePty();
    const { host, spawned } = hostWith(pty);
    host.open({ env: { SHELL: "/opt/homebrew/bin/fish" } });
    expect(spawned[0].file).toBe("/opt/homebrew/bin/fish");
  });
});

describe("node-pty's spawn-helper, which the package ships un-executable", () => {
  /**
   * MEASURED FROM THE TARBALL, not inferred: node-pty 1.1.0 records both
   * `prebuilds/darwin-arm64/pty.node` and `spawn-helper` as mode 0644, and
   * nothing in the package chmods the helper. Without the bit, every terminal
   * dies with `posix_spawnp failed` — an error naming neither file nor mode.
   */
  const libDir = "/app/node_modules/node-pty/lib";

  test("searches the same places node-pty's own loader does", () => {
    const found = spawnHelperCandidates(libDir, "darwin", "arm64");
    expect(found).toContain("/app/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper");
    expect(found).toContain("/app/node_modules/node-pty/build/Release/spawn-helper");
    // `lib/`-relative as well as package-relative: `loadNativeModule` crosses
    // ['..','.'] with three build dirs, and the helper is a sibling of whichever
    // answered.
    expect(found).toContain("/app/node_modules/node-pty/lib/prebuilds/darwin-arm64/spawn-helper");
  });

  test("rewrites an asar path the way node-pty does", () => {
    // A .node cannot be read from inside an archive, so asarUnpack puts it
    // beside one and BOTH paths have to name the unpacked copy.
    const found = spawnHelperCandidates("/A/Contents/Resources/app.asar/node_modules/node-pty/lib", "darwin", "arm64");
    expect(found.every((candidate) => !candidate.includes("app.asar/"))).toBe(true);
    expect(found[4]).toContain("app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper");
  });

  test("adds the executable bit and leaves the rest of the mode alone", () => {
    const chmods = [];
    const result = ensureSpawnHelper({
      platform: "darwin",
      arch: "arm64",
      libDir,
      fs: {
        existsSync: (target) => target.endsWith("prebuilds/darwin-arm64/spawn-helper"),
        statSync: () => ({ mode: 0o100644 }),
        chmodSync: (target, mode) => chmods.push([target, mode]),
      },
    });
    expect(result.changed).toBe(true);
    expect(chmods).toHaveLength(1);
    expect(chmods[0][1]).toBe(0o755);
  });

  test("does nothing when the bit is already there", () => {
    const chmods = [];
    const result = ensureSpawnHelper({
      platform: "darwin",
      arch: "arm64",
      libDir,
      fs: {
        existsSync: () => true,
        statSync: () => ({ mode: 0o100755 }),
        chmodSync: (target, mode) => chmods.push([target, mode]),
      },
    });
    expect(result.changed).toBe(false);
    expect(chmods).toEqual([]);
  });

  test("a helper that is not there at all names every place it looked", () => {
    expect(() =>
      ensureSpawnHelper({ platform: "darwin", arch: "arm64", libDir, fs: { existsSync: () => false } }),
    ).toThrow(/posix_spawnp/);
  });

  test("a chmod that cannot be made says what the consequence is", () => {
    // A packaged app on a read-only volume. The bit was set at build time by
    // after-pack.js; if it somehow was not, the message has to name the cause
    // rather than let `posix_spawnp failed` out.
    expect(() =>
      ensureSpawnHelper({
        platform: "darwin",
        arch: "arm64",
        libDir,
        fs: {
          existsSync: () => true,
          statSync: () => ({ mode: 0o100644 }),
          chmodSync: () => {
            throw new Error("EROFS: read-only file system");
          },
        },
      }),
    ).toThrow(/spawn-helper executable/);
  });

  test("win32 has no helper and is not asked for one", () => {
    expect(ensureSpawnHelper({ platform: "win32" })).toEqual({ path: null, changed: false });
  });
});

describe("what a packaged .app has to contain before a terminal can run", () => {
  /**
   * Both facts fail at RUNTIME rather than at build time, which is the shape
   * this repo keeps getting caught by — so after-pack.js asserts them on the
   * artefact and a failure stops a package instead of shipping one.
   */
  const app = "/out/Telar.app";
  const root = path.join(app, UNPACKED, "node_modules", "node-pty");
  const prebuilds = path.join(root, "prebuilds", "darwin-arm64");
  const release = path.join(root, "build", "Release");
  const both = (dir) => [path.join(dir, "pty.node"), path.join(dir, "spawn-helper")];

  const fakeFs = (present, mode = 0o100755, chmods = []) => ({
    existsSync: (target) => present.includes(target),
    statSync: () => ({ mode }),
    chmodSync: (target, next) => chmods.push([target, next]),
  });

  test("refuses an app whose addon is sealed inside the asar", () => {
    expect(() => verifyPackagedPty(app, { platform: "darwin", arch: "arm64", fs: fakeFs([]) })).toThrow(/asarUnpack/);
  });

  test("refuses an app with the addon but no spawn-helper beside it", () => {
    const fs = fakeFs([path.join(prebuilds, "pty.node")]);
    expect(() => verifyPackagedPty(app, { platform: "darwin", arch: "arm64", fs })).toThrow(/spawn-helper/);
  });

  test("sets the executable bit on the packaged helper", () => {
    const chmods = [];
    const fs = fakeFs(both(prebuilds), 0o100644, chmods);
    const found = verifyPackagedPty(app, { platform: "darwin", arch: "arm64", fs });
    expect(found.chmodded).toBe(true);
    expect(chmods[0][0]).toBe(path.join(prebuilds, "spawn-helper"));
    expect(chmods[0][1]).toBe(0o755);
  });

  test("passes a well-formed app without touching it", () => {
    const chmods = [];
    const fs = fakeFs(both(prebuilds), 0o100755, chmods);
    expect(verifyPackagedPty(app, { platform: "darwin", arch: "arm64", fs }).chmodded).toBe(false);
    expect(chmods).toEqual([]);
  });

  /**
   * THE DIRECTORY THE LOADER PICKS, NOT THE ONE WE EXPECT.
   *
   * electron-builder's "installing native dependencies" step REBUILDS node-pty
   * against Electron's headers and writes `build/Release/` into the packaged
   * tree, so a real package has both that and the shipped `prebuilds/`. node-pty
   * tries `build/Release` FIRST. Measured on a real `.app`: the first version of
   * this check looked only at `prebuilds/` — a directory the packaged app never
   * opens — so it would have passed while the one actually loaded was broken.
   */
  test("checks build/Release first, because that is what node-pty loads first", () => {
    const chmods = [];
    const fs = fakeFs([...both(release), ...both(prebuilds)], 0o100644, chmods);
    const found = verifyPackagedPty(app, { platform: "darwin", arch: "arm64", fs });
    expect(found.from).toBe("build/Release");
    expect(found.addon).toBe(path.join(release, "pty.node"));
    // The one it repaired is the one that will be loaded, not the other.
    expect(chmods).toHaveLength(1);
    expect(chmods[0][0]).toBe(path.join(release, "spawn-helper"));
  });

  test("falls back to the shipped prebuild when nothing was rebuilt", () => {
    const found = verifyPackagedPty(app, { platform: "darwin", arch: "arm64", fs: fakeFs(both(prebuilds)) });
    expect(found.from).toBe("prebuilds/darwin-arm64");
  });
});

describe("the module keeps itself loadable where the native one is not", () => {
  /**
   * This suite runs on ubuntu-latest, where node-pty has no prebuild at all.
   * The guarantee is not "we tested it on linux" — it is that requiring this
   * file does not require node-pty, which is what lets the suite run there. The
   * assertion below is the only way to state that from inside the file: every
   * case above already passed, so the module was loaded and no addon came with
   * it.
   */
  test("requiring the host did not pull in a native addon", () => {
    expect(typeof TerminalHost).toBe("function");
    expect(Object.keys(require.cache).some((key) => key.includes(`${path.sep}node-pty${path.sep}`))).toBe(false);
  });

  test("constructing a host does not load one either — only spawning would", () => {
    const host = new TerminalHost({ platform: "linux", version: "1.0.0" });
    expect(host.list()).toEqual([]);
    expect(Object.keys(require.cache).some((key) => key.includes(`${path.sep}node-pty${path.sep}`))).toBe(false);
  });
});
