const { describe, expect, test } = require("bun:test");
const { TERM } = require("./terminal-host");
const { fakePty, hostWith } = require("../../test/terminal-host-fakes");

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
    expect(a.pid).toBe(b.pid);
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
  });

  test("a disposed host will not start another shell", () => {
    const { host } = hostWith(fakePty());
    host.dispose();
    expect(() => host.open({ shell: "/bin/zsh", env: {} })).toThrow(/shutting down/);
  });
});
