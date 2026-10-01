const { afterAll, describe, expect, test } = require("bun:test");
const { spawn } = require("node:child_process");
const { TerminalHost, TerminalFate, CLOSE_GRACE_MS } = require("./terminal-host");
const { fakePty, hostWith } = require("../../test/terminal-host-fakes");

describe("closing a terminal ends what runs in it", () => {
  const busyTable = [
    { pid: 900, ppid: 1, pgid: 900, tpgid: 910, tty: "ttys009", command: "-zsh" },
    { pid: 910, ppid: 900, pgid: 910, tpgid: 910, tty: "ttys009", command: "bun run dev" },
    { pid: 911, ppid: 910, pgid: 910, tpgid: 910, tty: "ttys009", command: "node vite" },
    { pid: 1200, ppid: 1, pgid: 1200, tpgid: 0, tty: "??", command: "unrelated" },
  ];

  async function closeHost(table = busyTable, killTree) {
    const killed = [];
    const pty = fakePty(900, "/dev/ttys009");
    const made = hostWith(pty, {
      listProcesses: async () => table,
      killTree: killTree ?? ((pid, signal) => killed.push([pid, signal])),
    });
    const { id } = await made.host.open({ shell: "/bin/zsh", env: {} });
    return { ...made, pty, id, killed };
  }

  const settle = async () => {
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
  };

  test("SIGTERM reaches the job's group too, not just the shell's", async () => {
    const { host, id, killed, clock } = await closeHost();
    const closing = host.close(id);
    await settle();

    expect(killed).toEqual([
      [900, "SIGHUP"],
      [900, "SIGTERM"],
      [910, "SIGTERM"],
    ]);

    expect(killed.some(([pid]) => pid === 1200)).toBe(false);
    clock.advance(CLOSE_GRACE_MS);
    expect(await closing).toBe(true);
  });

  test("SIGKILL follows after the grace, and not a moment before", async () => {
    const { host, id, killed, clock } = await closeHost();
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
    const signals = [];
    const gone = Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    const { host, id, pty, clock, endings } = await closeHost(busyTable, (pid, signal) => {
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
    const signals = [];
    const gone = Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    const { host, id, pty, clock } = await closeHost(busyTable, (pid, signal) => {
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
    const { host, id, killed, clock } = await closeHost(null);
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
    const { host, id, killed } = await closeHost();
    expect(await host.close(id, "engine")).toBe(false);
    expect(await host.close("term_nope")).toBe(false);
    expect(killed).toEqual([]);
  });

  test("closing twice is one close", async () => {
    const { host, id, killed, clock } = await closeHost();
    const first = host.close(id);
    const second = host.close(id);
    await settle();
    clock.advance(CLOSE_GRACE_MS);
    await Promise.all([first, second]);
    expect(killed.filter(([, signal]) => signal === "SIGTERM")).toHaveLength(2);
    expect(killed.filter(([, signal]) => signal === "SIGKILL")).toHaveLength(2);
  });

  test("closeAll({ final }) refuses a new shell before it reads the table", async () => {
    const { host, clock } = await closeHost();
    const closing = host.closeAll({ final: true });
    await expect(host.open({ shell: "/bin/zsh", env: {} })).rejects.toThrow(/shutting down/);
    await settle();
    clock.advance(CLOSE_GRACE_MS);
    expect(await closing).toBe(1);
  });

  test("win32 has no gentler first step, so nothing is escalated", async () => {
    const killed = [];
    const pty = fakePty(42);
    const { host, clock } = hostWith(pty, { killTree: (pid, signal) => killed.push([pid, signal]), host: { platform: "win32" } });
    const { id } = await host.open({ shell: "cmd.exe", env: {} });
    expect(await host.close(id)).toBe(true);
    expect(clock.pending()).toBe(0);
    expect(killed).toEqual([[42, "SIGTERM"]]);
  });
});

describe("closing a real process group that ignores SIGTERM", () => {
  const spawnedGroups = [];
  afterAll(() => {
    for (const pgid of spawnedGroups) {
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {
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
      await host.open({ shell: "/bin/sh", env: {}, sessionId: "s_fixture" });
      await ready;
      grandchild = Number(/CHILD=(\d+)/.exec(out)[1]);
      [active] = await host.activeProcesses();
      const started = Date.now();
      await host.killBySession("s_fixture");

      expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    }

    const end = await exited;
    expect(end.error).toBeUndefined();

    expect(active.active).toBe(true);
    expect(active.processes).toBeGreaterThanOrEqual(1);
    expect(ending.fate).toBe(TerminalFate.EXITED);
    expect(ending.signal).toBe("SIGKILL");

    for (let attempt = 0; attempt < 40 && !isGone(grandchild); attempt += 1) await new Promise((r) => setTimeout(r, 25));
    expect(isGone(grandchild)).toBe(true);
  });

  test.skipIf(process.platform === "win32")("a lone process with nothing under it is not active", async () => {
    const host = new TerminalHost({ version: "9.9.9", closeGraceMs: 150, spawnPty: () => childAsPty("exec sleep 30") });
    await host.open({ shell: "/bin/sh", env: {} });
    const [entry] = await host.activeProcesses();
    expect(entry.active).toBe(false);
    await host.closeAll();
  });
});
