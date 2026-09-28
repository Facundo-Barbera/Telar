const { describe, expect, test } = require("bun:test");
const { TerminalHost, parseProcessTable, terminalActivity, decideQuit, busyTerminals } = require("./terminal-host");
const { fakePty, anyCwdIsFine, hostWith } = require("../../test/terminal-host-fakes");

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

describe("busyTerminals — what the restart-to-update dialog prints", () => {
  test("counts only the busy ones, and names at most five commands", () => {
    expect(busyTerminals([])).toEqual({ count: 0, commands: [] });
    const many = Array.from({ length: 7 }, (_, index) => ({ active: true, command: `job ${index}` }));
    expect(busyTerminals([{ active: false, command: "zsh" }, ...many])).toEqual({ count: 7, commands: ["job 0", "job 1", "job 2", "job 3", "job 4"] });
    expect(busyTerminals([{ active: true }]).commands).toEqual(["a command"]);
  });
});
