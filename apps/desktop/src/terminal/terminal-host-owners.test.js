const { describe, expect, test } = require("bun:test");
const { TerminalHost, CLOSE_GRACE_MS } = require("./terminal-host");
const { fakePty, anyCwdIsFine, fakeClock } = require("../../test/terminal-host-fakes");

describe("a terminal has an owner, and only its owner may reach it", () => {
  async function twoOwnerHost() {
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
    const mine = await host.open({ shell: "/bin/zsh", env: {}, owner: "renderer" });
    const theirs = await host.open({ shell: "/bin/sh", args: ["-c", "bun run dev"], env: {}, owner: "engine" });
    return { host, mine, theirs, ptys };
  }

  test("write refuses the other owner's id and still delivers to its own", async () => {
    const { host, mine, theirs, ptys } = await twoOwnerHost();

    expect(host.write(theirs.id, "rm -rf /\r", "renderer")).toBe(false);

    expect(host.write(mine.id, "ls\r", "renderer")).toBe(true);

    expect(ptys[0].calls.writes).toEqual(["ls\r"]);
    expect(ptys[1].calls.writes).toEqual([]);
  });

  test("resize and kill are scoped the same way, in both directions", async () => {
    const { host, mine, theirs, ptys } = await twoOwnerHost();
    expect(host.resize(theirs.id, 10, 10, "renderer")).toBe(false);
    expect(host.resize(mine.id, 100, 40, "renderer")).toBe(true);
    expect(ptys[1].calls.resizes).toEqual([]);
    expect(ptys[0].calls.resizes).toEqual([[100, 40]]);

    expect(host.kill(theirs.id, "SIGTERM", "renderer")).toBe(false);
    expect(host.kill(theirs.id, "SIGTERM", "engine")).toBe(true);
  });

  test("the engine reaches its own terminal, which is the other direction of the same guard", async () => {
    const { host, mine, theirs, ptys } = await twoOwnerHost();
    expect(host.write(theirs.id, "y\r", "engine")).toBe(true);
    expect(host.write(mine.id, "y\r", "engine")).toBe(false);
    expect(ptys[1].calls.writes).toEqual(["y\r"]);
    expect(ptys[0].calls.writes).toEqual([]);
  });

  test("list omits the other owner's terminals and keeps its own", async () => {
    const { host, mine, theirs } = await twoOwnerHost();
    const rendererIds = host.list("renderer").map((entry) => entry.id);
    const engineIds = host.list("engine").map((entry) => entry.id);

    expect(rendererIds).not.toContain(theirs.id);
    expect(engineIds).not.toContain(mine.id);

    expect(rendererIds).toEqual([mine.id]);
    expect(engineIds).toEqual([theirs.id]);
  });

  test("the default scope is the renderer's, so a caller that forgets is refused rather than trusted", async () => {
    const { host, mine, theirs } = await twoOwnerHost();
    expect(host.write(theirs.id, "x", undefined)).toBe(false);
    expect(host.write(mine.id, "x", undefined)).toBe(true);
    expect(host.list().map((entry) => entry.id)).toEqual([mine.id]);
  });

  test("an owner that is neither throws rather than being rounded to one", async () => {
    const { host, mine } = await twoOwnerHost();
    await expect(host.open({ shell: "/bin/zsh", env: {}, owner: "engine " })).rejects.toThrow(/owner/);
    expect(() => host.write(mine.id, "x", "ENGINE")).toThrow(/owner/);
    expect(() => host.list("agent")).toThrow(/owner/);
  });

  test("dispose ends every terminal, whoever opened it", async () => {
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
    await host.open({ shell: "/bin/zsh", env: {}, owner: "renderer" });
    await host.open({ shell: "/bin/sh", env: {}, owner: "engine" });
    host.dispose();
    expect(killed).toEqual([
      [701, "SIGHUP"],
      [701, "SIGTERM"],
      [702, "SIGHUP"],
      [702, "SIGTERM"],
    ]);
  });
});

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

    const finished = async (closing) => {
      for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
      clock.advance(CLOSE_GRACE_MS);
      return closing;
    };
    return { host, killed, clock, finished };
  }

  test("each owner gets the only origin it ever had when it does not say", async () => {
    const { host } = sessionHost();
    const shell = await host.open({ shell: "/bin/zsh", env: {}, owner: "renderer" });
    const run = await host.open({ shell: "/bin/sh", env: {}, owner: "engine" });
    expect(host.describe(shell.id, "renderer").origin).toBe("user");
    expect(host.describe(run.id, "engine").origin).toBe("run");
  });

  test("session, origin and title are recorded and listed", async () => {
    const { host } = sessionHost();
    const { id } = await host.open({ shell: "/bin/sh", env: {}, owner: "engine", origin: "agent", sessionId: " s_1 ", title: "web dev" });
    expect(host.list("engine")).toEqual([
      expect.objectContaining({ id, sessionId: "s_1", origin: "agent", title: "web dev" }),
    ]);
    expect(host.describe(id, "engine")).toEqual(expect.objectContaining({ sessionId: "s_1", origin: "agent", title: "web dev" }));
  });

  test("describe is scoped like every verb — the other owner's id is not there", async () => {
    const { host } = sessionHost();
    const run = await host.open({ shell: "/bin/sh", env: {}, owner: "engine" });
    const shell = await host.open({ shell: "/bin/zsh", env: {}, owner: "renderer" });
    expect(host.describe(run.id, "renderer")).toBeUndefined();
    expect(host.describe(shell.id, "renderer")).toBeDefined();
  });

  test("an origin the owner could not have is refused, in both directions", async () => {
    const { host } = sessionHost();
    await expect(host.open({ shell: "/bin/zsh", env: {}, owner: "renderer", origin: "agent" })).rejects.toThrow(/origin/);
    await expect(host.open({ shell: "/bin/zsh", env: {}, owner: "renderer", origin: "run" })).rejects.toThrow(/origin/);
    await expect(host.open({ shell: "/bin/sh", env: {}, owner: "engine", origin: "user" })).rejects.toThrow(/origin/);
    await expect(host.open({ shell: "/bin/sh", env: {}, owner: "engine", origin: "bogus" })).rejects.toThrow(/origin/);
    expect((await host.open({ shell: "/bin/sh", env: {}, owner: "engine", origin: "run" })).pid).toBeDefined();
    expect((await host.open({ shell: "/bin/zsh", env: {}, owner: "renderer", origin: "user" })).pid).toBeDefined();
  });

  test("a session id that is not a string is dropped, not coerced", async () => {
    const { host } = sessionHost();
    const { id } = await host.open({ shell: "/bin/zsh", env: {}, sessionId: { toString: () => "s_1" } });
    expect(host.describe(id).sessionId).toBeUndefined();
  });

  test("killBySession closes that session's terminals, every owner, and nobody else's", async () => {
    const { host, killed, finished } = sessionHost();
    const shell = await host.open({ shell: "/bin/zsh", env: {}, owner: "renderer", sessionId: "s_a" });
    const run = await host.open({ shell: "/bin/sh", env: {}, owner: "engine", sessionId: "s_a" });
    const other = await host.open({ shell: "/bin/zsh", env: {}, owner: "renderer", sessionId: "s_b" });
    expect(await finished(host.killBySession("s_a"))).toBe(2);
    expect(killed.filter(([, signal]) => signal === "SIGTERM")).toEqual([
      [shell.pid, "SIGTERM"],
      [run.pid, "SIGTERM"],
    ]);

    expect(killed.some(([pid]) => pid === other.pid)).toBe(false);
  });

  test("countBySession counts every owner's terminals per session, and none in no session (#883)", async () => {
    const { host } = sessionHost();
    await host.open({ shell: "/bin/zsh", env: {}, owner: "renderer", sessionId: "s_a" });
    await host.open({ shell: "/bin/sh", env: {}, owner: "engine", sessionId: "s_a" });
    await host.open({ shell: "/bin/zsh", env: {}, owner: "renderer", sessionId: "s_b" });
    await host.open({ shell: "/bin/zsh", env: {} });
    expect(host.countBySession()).toEqual({ s_a: 2, s_b: 1 });
  });

  test("killBySession can be narrowed to one owner", async () => {
    const { host, killed, finished } = sessionHost();
    await host.open({ shell: "/bin/zsh", env: {}, owner: "renderer", sessionId: "s_a" });
    const run = await host.open({ shell: "/bin/sh", env: {}, owner: "engine", sessionId: "s_a" });
    expect(await finished(host.killBySession("s_a", { owner: "engine" }))).toBe(1);
    expect(killed).toEqual([
      [run.pid, "SIGHUP"],
      [run.pid, "SIGTERM"],
      [run.pid, "SIGKILL"],
    ]);
  });

  test("no session never matches no session", async () => {
    const { host, killed } = sessionHost();
    await host.open({ shell: "/bin/zsh", env: {} });
    for (const missing of [undefined, null, "", "   ", 7]) {
      expect(await host.killBySession(missing)).toBe(0);
    }
    expect(killed).toEqual([]);
  });

  test("killBySession escalates like any close", async () => {
    const { host, killed, finished } = sessionHost();
    const { pid } = await host.open({ shell: "/bin/zsh", env: {}, sessionId: "s_a" });
    expect(await finished(host.killBySession("s_a"))).toBe(1);
    expect(killed).toEqual([
      [pid, "SIGHUP"],
      [pid, "SIGTERM"],
      [pid, "SIGKILL"],
    ]);
  });
});
