const { describe, expect, test } = require("bun:test");
const path = require("node:path");
const { TerminalFate, unusableCwd } = require("./terminal-host");
const { fakePty, hostWith } = require("../../test/terminal-host-fakes");

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

    expect(host.list()).toEqual([]);
  });

  describe("`unknown` is never rounded to `exited`", () => {
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

    test("a kill we could not deliver leaves the terminal open and closable", () => {
      const pty = fakePty(79);
      const { host, endings } = hostWith(pty, {
        killTree: () => {
          throw Object.assign(new Error("EPERM"), { code: "EPERM" });
        },
      });
      const { id } = host.open({ shell: "/bin/zsh", env: {} });
      expect(host.kill(id)).toBe(false);
      expect(endings).toEqual([]);
      expect(host.describe(id, "renderer")?.id).toBe(id);
    });

    test("a kill whose group is already empty counts as sent", () => {
      const pty = fakePty(79);
      const { host } = hostWith(pty, {
        killTree: () => {
          throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
        },
      });
      const { id } = host.open({ shell: "/bin/zsh", env: {} });
      expect(host.kill(id)).toBe(true);
    });

    test("a kill that was delivered and never reported an exit invents no ending", () => {
      const pty = fakePty(80);
      const { host, endings, clock } = hostWith(pty);
      const { id } = host.open({ shell: "/bin/zsh", env: {} });
      host.kill(id, "SIGTERM");
      clock.advance(60_000);
      expect(endings).toEqual([]);
      expect(host.describe(id, "renderer")?.id).toBe(id);
    });

    test("a kill that DID land is an honest `exited` — code 0 WITH a signal", async () => {
      const pty = fakePty(81);
      const { host, endings } = hostWith(pty);
      const { id } = host.open({ shell: "/bin/zsh", env: {} });
      host.kill(id, "SIGKILL");
      pty.emitExit({ exitCode: 0, signal: 9 });

      expect(endings).toHaveLength(1);
      expect(endings[0][1].fate).toBe(TerminalFate.EXITED);
      expect(endings[0][1].signal).toBe("9");
      expect(endings[0][1].exitCode).toBe(0);
      expect(endings[0][1].closed).toBeUndefined();
    });

    test("a pty whose fd raised an error is not an ending — the exit that follows is", () => {
      const pty = fakePty(82);
      const { host, endings } = hostWith(pty);
      const { id } = host.open({ shell: "/bin/zsh", env: {} });
      pty.emitError(new Error("read EIO"));
      expect(endings).toEqual([]);
      expect(host.describe(id, "renderer")?.id).toBe(id);
      pty.emitExit({ exitCode: 1 });
      expect(endings).toHaveLength(1);
      expect(endings[0][1].fate).toBe(TerminalFate.EXITED);
    });

    test("an ending says why the host was closing it, and says nothing when it was not", async () => {
      const cases = [
        ["close", (host, id) => host.close(id, "renderer")],
        ["session", (host) => host.killBySession("sess_1")],
        ["quit", (host) => host.closeAll()],
        ["quit", (host) => host.dispose()],
      ];
      for (const [reason, close] of cases) {
        const pty = fakePty(83);
        const signals = [];
        const { host, endings } = hostWith(pty, {
          killTree: (_pid, signal) => {
            if (signal === 0) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
            signals.push(signal);
          },
        });
        const { id } = host.open({ shell: "/bin/zsh", env: {}, sessionId: "sess_1" });
        const closing = close(host, id);

        while (!signals.includes("SIGTERM")) await new Promise((resolve) => setTimeout(resolve, 0));
        pty.emitExit({ exitCode: 0, signal: 1 });
        await closing;
        expect(endings[0][1].closed).toBe(reason);
      }
      const pty = fakePty(84);
      const { host, endings } = hostWith(pty);
      host.open({ shell: "/bin/zsh", env: {} });
      pty.emitExit({ exitCode: 0 });
      expect(endings[0][1].closed).toBeUndefined();
    });

    test("registers the TWO error listeners node-pty counts before it rethrows", () => {
      const pty = fakePty(84);
      const { host } = hostWith(pty);
      host.open({ shell: "/bin/zsh", env: {} });
      expect(pty.listenerCount("error")).toBeGreaterThanOrEqual(2);
    });

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

    expect(typeof refusal).toBe("string");
    expect(refusal).toContain("/gone");
    expect(refusal).toContain("ENOENT");
    expect(refusal).toContain("No process was started.");
  });

  test("a path UNDER a regular file is not a directory for anybody, root included", () => {
    const enotdir = () => {
      const error = new Error("ENOTDIR: not a directory, stat '/etc/passwd/nope'");
      error.code = "ENOTDIR";
      throw error;
    };
    const nested = unusableCwd("/etc/passwd/nope", { fs: { statSync: enotdir, accessSync: () => {} } });
    expect(typeof nested).toBe("string");
    expect(nested).toContain("ENOTDIR");

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
    expect(unusableCwd("/work", { fs: { statSync: () => ({ isDirectory: () => true }), accessSync: () => {} } })).toBeNull();

    expect(unusableCwd(path.dirname(__filename))).toBeNull();
  });

  test("the refusal is `failed`, carries no exit code, and never spawned", () => {
    const { host, spawned, endings } = hostWith(fakePty(99), {
      fs: { statSync: missing, accessSync: () => {} },
    });
    const opened = host.open({ shell: "/bin/zsh", cwd: "/gone", env: {} });

    expect(spawned).toHaveLength(0);
    expect(opened.pid).toBeUndefined();
    expect(opened.ending.fate).toBe(TerminalFate.FAILED);

    expect(opened.ending.exitCode).toBeUndefined();
    expect(opened.ending.error).toContain("/gone");

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
