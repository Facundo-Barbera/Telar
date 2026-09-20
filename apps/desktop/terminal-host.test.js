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
const { describe, expect, test } = require("bun:test");
const path = require("node:path");
const {
  TerminalHost,
  TerminalFate,
  TERM,
  TERM_PROGRAM,
  terminalEnv,
  killTerminalTree,
  ensureSpawnHelper,
  spawnHelperCandidates,
  defaultShell,
} = require("./terminal-host");
const { verifyPackagedPty, UNPACKED } = require("./after-pack");

/** A stand-in for node-pty's terminal: records what it was told, and lets a
 *  test decide when — and whether — it ever reports an exit. */
function fakePty(pid = 4242) {
  const calls = { writes: [], resizes: [] };
  const handlers = {};
  return {
    pid,
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

/** A host whose spawner hands back `pty` and records the options it got. */
function hostWith(pty, options = {}) {
  const spawned = [];
  const endings = [];
  const data = [];
  const host = new TerminalHost({
    platform: "darwin",
    version: "9.9.9",
    killTree: options.killTree ?? (() => {}),
    spawnPty: (file, args, opts) => {
      spawned.push({ file, args, opts });
      if (options.throws) throw options.throws;
      return pty;
    },
    onData: (id, chunk) => data.push([id, chunk]),
    onExit: (id, ending) => endings.push([id, ending]),
    ...options.host,
  });
  return { host, spawned, endings, data };
}

describe("the environment a Telar terminal starts in", () => {
  test("sets TERM and TERM_PROGRAM, and TERM_PROGRAM is the public string", () => {
    const env = terminalEnv({ PATH: "/usr/bin" }, "1.2.3");
    expect(env.TERM).toBe("xterm-256color");
    expect(env.TERM_PROGRAM).toBe("Telar");
    expect(env.TERM_PROGRAM_VERSION).toBe("1.2.3");
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
    test("the host shut down with a terminal still live", () => {
      const pty = fakePty(77);
      const { host, endings } = hostWith(pty);
      host.open({ shell: "/bin/zsh", env: {} });
      host.dispose("Telar quit");
      expect(endings).toHaveLength(1);
      const [, ending] = endings[0];
      expect(ending.fate).toBe(TerminalFate.UNKNOWN);
      expect(ending.exitCode).toBeUndefined();
      // The pid is in the sentence so a human can go and look for the process.
      expect(ending.reason).toContain("77");
      expect(ending.reason).toContain("Telar quit");
    });

    test("dispose does NOT kill — deciding that is the engine's job", () => {
      const killed = [];
      const pty = fakePty(78);
      const { host } = hostWith(pty, { killTree: (pid) => killed.push(pid) });
      host.open({ shell: "/bin/zsh", env: {} });
      host.dispose();
      expect(killed).toEqual([]);
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

    test("but a kill that DID land is an honest `exited`", async () => {
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
      { id, pid: 91, shell: "/bin/zsh", cwd: "/work", cols: 90, rows: 20, startedAt: expect.any(Number) },
    ]);
    expect(JSON.stringify(host.list())).not.toContain("pty");
  });

  test("a disposed host will not start another shell", () => {
    const { host } = hostWith(fakePty());
    host.dispose();
    expect(() => host.open({ shell: "/bin/zsh", env: {} })).toThrow(/shutting down/);
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
  const prebuilds = path.join(app, UNPACKED, "node_modules", "node-pty", "prebuilds", "darwin-arm64");

  const fakeFs = (present, mode = 0o100755, chmods = []) => ({
    existsSync: (target) => present.includes(target),
    statSync: () => ({ mode }),
    chmodSync: (target, next) => chmods.push([target, next]),
  });

  test("refuses an app whose addon is sealed inside the asar", () => {
    expect(() => verifyPackagedPty(app, { platform: "darwin", arch: "arm64", fs: fakeFs([]) })).toThrow(/asarUnpack/);
  });

  test("refuses an app with the addon but no spawn-helper", () => {
    const fs = fakeFs([path.join(prebuilds, "pty.node")]);
    expect(() => verifyPackagedPty(app, { platform: "darwin", arch: "arm64", fs })).toThrow(/spawn-helper/);
  });

  test("sets the executable bit on the packaged helper", () => {
    const chmods = [];
    const fs = fakeFs([path.join(prebuilds, "pty.node"), path.join(prebuilds, "spawn-helper")], 0o100644, chmods);
    const found = verifyPackagedPty(app, { platform: "darwin", arch: "arm64", fs });
    expect(found.chmodded).toBe(true);
    expect(chmods[0][0]).toBe(path.join(prebuilds, "spawn-helper"));
    expect(chmods[0][1]).toBe(0o755);
  });

  test("passes a well-formed app without touching it", () => {
    const chmods = [];
    const fs = fakeFs([path.join(prebuilds, "pty.node"), path.join(prebuilds, "spawn-helper")], 0o100755, chmods);
    expect(verifyPackagedPty(app, { platform: "darwin", arch: "arm64", fs }).chmodded).toBe(false);
    expect(chmods).toEqual([]);
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
