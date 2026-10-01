const { describe, expect, test } = require("bun:test");
const { TERM, TERM_PROGRAM, terminalEnv, killTerminalTree, defaultShell } = require("./terminal-host");
const { fakePty, hostWith } = require("../../test/terminal-host-fakes");

describe("the environment a Telar terminal starts in", () => {
  test("sets TERM and TERM_PROGRAM, and TERM_PROGRAM is the public string", async () => {
    const env = terminalEnv({ PATH: "/usr/bin" }, "1.2.3");
    expect(env.TERM).toBe("xterm-256color");
    expect(env.TERM_PROGRAM).toBe("Telar");
    expect(env.TERM_PROGRAM_VERSION).toBe("1.2.3");

    expect(env.COLORTERM).toBe("truecolor");
    expect(env.PATH).toBe("/usr/bin");

    expect(TERM).toBe("xterm-256color");
    expect(TERM_PROGRAM).toBe("Telar");
  });

  test("takes Telar's OWN marker back out", async () => {
    const env = terminalEnv({ ELECTRON_RUN_AS_NODE: "1", SHELL: "/bin/zsh" }, "1.0.0");
    expect("ELECTRON_RUN_AS_NODE" in env).toBe(false);
    expect(env.SHELL).toBe("/bin/zsh");
  });

  test("passes everything else through untouched, and drops non-strings", async () => {
    const env = terminalEnv({ ZDOTDIR: "/home/x/.config/zsh", PS1: "weird$ ", NOPE: undefined, ALSO: 7 }, "1.0.0");
    expect(env.ZDOTDIR).toBe("/home/x/.config/zsh");
    expect(env.PS1).toBe("weird$ ");

    expect("NOPE" in env).toBe(false);
    expect("ALSO" in env).toBe(false);
  });

  test("an inherited COLORTERM is left alone — we fill a silence, we do not argue", async () => {
    expect(terminalEnv({ COLORTERM: "8bit" }, "1.0.0").COLORTERM).toBe("8bit");
    expect(terminalEnv({ COLORTERM: "truecolor" }, "1.0.0").COLORTERM).toBe("truecolor");
  });

  test("an EMPTY inherited COLORTERM is a silence, not an answer", async () => {
    expect(terminalEnv({ COLORTERM: "" }, "1.0.0").COLORTERM).toBe("truecolor");
    expect(terminalEnv({ COLORTERM: "   " }, "1.0.0").COLORTERM).toBe("truecolor");
  });

  test("omits TERM_PROGRAM_VERSION rather than claiming a fake one", async () => {
    expect("TERM_PROGRAM_VERSION" in terminalEnv({}, undefined)).toBe(false);
  });
});

describe("killing a terminal's whole tree", () => {
  test("posix signals the GROUP, not the pid", async () => {
    const calls = [];
    killTerminalTree(321, "SIGTERM", { platform: "darwin", kill: (pid, signal) => calls.push([pid, signal]) });
    expect(calls).toEqual([[-321, "SIGTERM"]]);
  });

  test("win32 reaches taskkill /T /F, from a Mac", async () => {
    const calls = [];
    killTerminalTree(321, "SIGTERM", { platform: "win32", spawnSync: (file, args, opts) => calls.push([file, args, opts]) });
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("taskkill");
    expect(calls[0][1]).toEqual(["/pid", "321", "/t", "/f"]);
    expect(calls[0][2]).toEqual({ windowsHide: true });
  });

  test("refuses a pid it cannot signal rather than signalling something else", async () => {
    for (const bad of [0, -1, undefined, null, "123", 1.5]) {
      expect(() => killTerminalTree(bad, "SIGTERM", { platform: "darwin", kill: () => {} })).toThrow(/process id/);
    }
  });

  test("surfaces a taskkill that could not even be launched", async () => {
    const boom = new Error("spawnSync taskkill ENOENT");
    expect(() => killTerminalTree(9, "SIGTERM", { platform: "win32", spawnSync: () => ({ error: boom }) })).toThrow(boom);
  });
});

describe("the shell we fall back to", () => {
  test("$SHELL is the person's own choice and wins", async () => {
    expect(defaultShell("darwin", { SHELL: "/opt/homebrew/bin/fish" })).toBe("/opt/homebrew/bin/fish");
  });

  test("/bin/sh is the floor, not a guess at zsh", async () => {
    expect(defaultShell("darwin", {})).toBe("/bin/sh");
    expect(defaultShell("linux", { SHELL: "  " })).toBe("/bin/sh");
  });

  test("win32 has a different answer entirely", async () => {
    expect(defaultShell("win32", {})).toBe("cmd.exe");
    expect(defaultShell("win32", { COMSPEC: "C:\\Windows\\System32\\cmd.exe" })).toBe("C:\\Windows\\System32\\cmd.exe");
  });

  test("open resolves it against the environment the CHILD gets", async () => {
    const pty = fakePty();
    const { host, spawned } = hostWith(pty);
    await host.open({ env: { SHELL: "/opt/homebrew/bin/fish" } });
    expect(spawned[0].file).toBe("/opt/homebrew/bin/fish");
  });
});
