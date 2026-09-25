/**
 * Telar's own computer use — cua-driver, and the gate that decides whether a
 * claim gets it.
 *
 * Pinned against the REAL layout on this machine: cua-driver installs a
 * symlink in ~/.local/bin pointing at CuaDriver.app. NOTHING HERE SPAWNS: the
 * gate is driven with an injected `status`, never the real probe.
 */
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ComputerUseStatus, McpServer } from "@telar/engine-client";
import {
  bundledHelper,
  claimHasComputerUse,
  classifyProbeError,
  COMPUTER_USE_HELPER_BUNDLE_ID,
  COMPUTER_USE_SERVER_ID,
  computerUseStatus,
  createComputerUseGate,
  ensureHelperDaemon,
  grantComputerUseAccess,
  helperDaemonLaunch,
  helperDaemonPids,
  helperResetCommands,
  interpretListApps,
  resetComputerUseAccess,
  resolveComputerUse,
  resolveComputerUseServer,
  revealComputerUseHelper,
  SETTINGS_PANE_URL,
  type HelperDeps,
  withComputerUse,
  type ComputerUseProbe,
  type ResolvedComputerUse,
} from "../src/computer-use";

const HOME = "/Users/tester";
const CUA_SYMLINK = `${HOME}/.local/bin/cua-driver`;

/** cua installed. */
const cuaOnly = (overrides: Partial<ComputerUseProbe> = {}): ComputerUseProbe => ({
  env: {},
  home: HOME,
  platform: "darwin",
  exists: (candidate: string) => candidate === CUA_SYMLINK,
  now: () => 1_000,
  ...overrides,
});

describe("resolveComputerUse", () => {
  test("cua-driver resolves as a plain stdio `mcp` server", () => {
    const resolved = resolveComputerUse(cuaOnly());
    expect(resolved?.backend).toBe("cua");
    expect(resolved?.server.id).toBe("mac");
    expect(resolved?.server.spec).toEqual({ transport: "stdio", command: CUA_SYMLINK, args: ["mcp"] });
  });

  test("CUA_DRIVER_BIN overrides the search — a bundled app can point here", () => {
    const bundled = "/Applications/Telar.app/Contents/Resources/cua-driver";
    const resolved = resolveComputerUse(cuaOnly({ env: { CUA_DRIVER_BIN: bundled }, exists: (c: string) => c === bundled }));
    expect(resolved?.backend).toBe("cua");
    expect(resolved?.server.spec.transport === "stdio" && resolved.server.spec.command).toBe(bundled);
  });

  test("no driver, nothing — kill switch and platform guard too", () => {
    expect(resolveComputerUse(cuaOnly({ exists: () => false }))).toBeUndefined();
    expect(resolveComputerUse(cuaOnly({ env: { TELAR_COMPUTER_USE: "0" } }))).toBeUndefined();
    expect(resolveComputerUse(cuaOnly({ platform: "linux" }))).toBeUndefined();
  });

  test("resolveComputerUseServer is the server half, for the claim", () => {
    expect(resolveComputerUseServer(cuaOnly())?.id).toBe("mac");
    expect(resolveComputerUseServer(cuaOnly({ exists: () => false }))).toBeUndefined();
  });
});

describe("the helper bundled inside Telar.app", () => {
  const APP = "/Applications/Telar.app/Contents/Helpers/Computer Use for Telar.app";
  const BINARY = `${APP}/Contents/MacOS/cua-driver`;
  const bundled = (overrides: Partial<ComputerUseProbe> = {}) =>
    cuaOnly({ env: { TELAR_COMPUTER_USE_HELPER: APP, CUA_DRIVER_BIN: "/opt/cua-driver" }, exists: () => true, ...overrides });

  test("precedence: bundled, then CUA_DRIVER_BIN, then the external install", () => {
    expect(resolveComputerUse(bundled())?.helper?.binary).toBe(BINARY);
    const env = resolveComputerUse(cuaOnly({ env: { CUA_DRIVER_BIN: "/opt/cua-driver" }, exists: () => true }));
    expect(env?.helper).toBeUndefined();
    expect(env?.server.spec.transport === "stdio" && env.server.spec.command).toBe("/opt/cua-driver");
    expect(resolveComputerUse(cuaOnly())?.server.spec).toEqual({ transport: "stdio", command: CUA_SYMLINK, args: ["mcp"] });
  });

  test("a packaged Telar with a helper never falls back, even with cua installed and CUA_DRIVER_BIN set", () => {
    expect(resolveComputerUse(bundled({ exists: (c: string) => c !== BINARY }))).toBeUndefined();
  });

  test("its socket, pid file and state are its own, never cua's shared ones", () => {
    const helper = bundledHelper(APP, HOME);
    expect(helper.bundleId).toBe(COMPUTER_USE_HELPER_BUNDLE_ID);
    expect(helper.socket).toBe(`${HOME}/Library/Caches/com.telar.desktop.computer-use/driver.sock`);
    expect(helper.pidFile).toBe(`${HOME}/Library/Caches/com.telar.desktop.computer-use/driver.pid`);
    // cua's defaults, which a separately installed CuaDriver.app uses.
    for (const shared of [`${HOME}/Library/Caches/cua-driver`, `${HOME}/.cua-driver`]) {
      expect([helper.socket, helper.pidFile, helper.stateDir].some((p) => p.startsWith(shared))).toBe(false);
    }
    for (const key of ["CUA_DRIVER_RS_HOME", "CUA_DRIVER_HOME", "CUA_DRIVER_TELEMETRY_HOME"]) expect(helper.env[key]).toBe(helper.stateDir);
    expect(helper.env.CUA_DRIVER_RS_TELEMETRY_ENABLED).toBe("false");
    expect(helper.env.CUA_DRIVER_RS_UPDATE_CHECK).toBe("false");
    // A socket path must fit sockaddr_un (104 bytes on macOS) for a long home.
    expect(bundledHelper(APP, "/Users/a-rather-long-account-name-for-this").socket.length).toBeLessThan(104);
  });

  test("the MCP proxy talks to OUR socket and may never launch CuaDriver.app", () => {
    const spec = resolveComputerUse(bundled())!.server.spec;
    expect(spec.transport === "stdio" && spec.args).toEqual(["mcp", "--socket", bundledHelper(APP, HOME).socket]);
    expect(spec.transport === "stdio" && spec.env?.CUA_DRIVER_EMBEDDED).toBe("1");
  });

  test("the daemon is launched through LaunchServices from the helper's own bundle, gate off, on our socket", () => {
    const helper = bundledHelper(APP, HOME);
    const { command, args } = helperDaemonLaunch(helper);
    expect(command).toBe("/usr/bin/open");
    expect(args.slice(0, 4)).toEqual(["-n", "-g", "-a", APP]);
    expect(args).not.toContain("CuaDriver");
    const after = args.slice(args.indexOf("--args") + 1);
    expect(after).toEqual(["serve", "--socket", helper.socket, "--pid-file", helper.pidFile, "--no-permissions-gate"]);
    expect(args).toContain(`CUA_DRIVER_RS_TELEMETRY_ENABLED=false`);
  });

  test("ensureHelperDaemon launches once for concurrent callers, and not at all when it is up", async () => {
    const helper = bundledHelper(APP, fs.mkdtempSync(path.join(os.tmpdir(), "telar-cu-home-")));
    const spawned: string[][] = [];
    let up = false;
    const deps = {
      spawn: ((command: string, args: string[]) => {
        spawned.push([command, ...args]);
        up = true;
        return { unref() {} };
      }) as never,
      listening: async () => up,
      sleep: async () => {},
    };
    expect(await Promise.all([ensureHelperDaemon(helper, deps), ensureHelperDaemon(helper, deps)])).toEqual([true, true]);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]![0]).toBe("/usr/bin/open");
    expect(await ensureHelperDaemon(helper, deps)).toBe(true);
    expect(spawned).toHaveLength(1);
  });

  test("one daemon per socket across processes: a launch lock held elsewhere is waited on, not doubled", async () => {
    const helper = bundledHelper(APP, fs.mkdtempSync(path.join(os.tmpdir(), "telar-cu-home-")));
    fs.mkdirSync(path.dirname(helper.socket), { recursive: true });
    // Another engine is mid-launch: it holds the lock, and its daemon comes up.
    fs.writeFileSync(`${helper.socket}.launch.lock`, "");
    const spawned: string[][] = [];
    let polls = 0;
    const deps: HelperDeps = {
      spawn: ((command: string, args: string[]) => (spawned.push([command, ...args]), { unref() {} })) as never,
      listening: async () => (polls += 1) > 3,
      sleep: async () => {},
      processes: () => [],
    };
    expect(await ensureHelperDaemon(helper, deps)).toBe(true);
    expect(spawned).toEqual([]);
    // The lock is the other launcher's to release, not ours.
    expect(fs.existsSync(`${helper.socket}.launch.lock`)).toBe(true);
  });

  test("a helper already running but not yet listening is waited on, not launched again", async () => {
    const helper = bundledHelper(APP, fs.mkdtempSync(path.join(os.tmpdir(), "telar-cu-home-")));
    const spawned: string[][] = [];
    let polls = 0;
    const deps: HelperDeps = {
      spawn: ((command: string, args: string[]) => (spawned.push([command, ...args]), { unref() {} })) as never,
      listening: async () => (polls += 1) > 2,
      sleep: async () => {},
      processes: () => [{ pid: 9, command: `${helper.binary} serve --socket ${helper.socket} --no-permissions-gate` }],
    };
    expect(await ensureHelperDaemon(helper, deps)).toBe(true);
    expect(spawned).toEqual([]);
  });

  test("a stale lock from a crashed launcher is taken over, and released after the launch", async () => {
    const helper = bundledHelper(APP, fs.mkdtempSync(path.join(os.tmpdir(), "telar-cu-home-")));
    fs.mkdirSync(path.dirname(helper.socket), { recursive: true });
    const lock = `${helper.socket}.launch.lock`;
    fs.writeFileSync(lock, "");
    const old = new Date(Date.now() - 60 * 60_000);
    fs.utimesSync(lock, old, old);
    let up = false;
    const spawned: string[][] = [];
    const deps: HelperDeps = {
      spawn: ((command: string, args: string[]) => (spawned.push([command, ...args]), (up = true), { unref() {} })) as never,
      listening: async () => up,
      sleep: async () => {},
      processes: () => [],
    };
    expect(await ensureHelperDaemon(helper, deps)).toBe(true);
    expect(spawned).toHaveLength(1);
    expect(fs.existsSync(lock)).toBe(false);
  });

  test("Remove permissions resets exactly the helper's two grants", () => {
    expect(helperResetCommands(COMPUTER_USE_HELPER_BUNDLE_ID)).toEqual([
      { command: "/usr/bin/tccutil", args: ["reset", "Accessibility", "com.telar.desktop.computer-use"] },
      { command: "/usr/bin/tccutil", args: ["reset", "ScreenCapture", "com.telar.desktop.computer-use"] },
    ]);
  });

  test("resetComputerUseAccess runs them with a stubbed spawn, and refuses without a bundled helper", async () => {
    const ran: string[][] = [];
    const spawnStub = ((command: string, args: string[]) => {
      ran.push([command, ...args]);
      const child = { once: (event: string, fn: (code: number) => void) => (event === "exit" && queueMicrotask(() => fn(0)), child) };
      return child;
    }) as never;
    const killed: number[] = [];
    const processes = () => [
      { pid: 400, command: "/Applications/CuaDriver.app/Contents/MacOS/cua-driver serve" },
      { pid: 501, command: `${BINARY} serve --socket ${bundledHelper(APP, HOME).socket} --no-permissions-gate` },
    ];
    expect(await resetComputerUseAccess(bundled(), { spawn: spawnStub, processes, kill: (pid) => void killed.push(pid) })).toEqual({ reset: true });
    // Our daemon stops so nothing holds the old grants; the person's own cua is untouched.
    expect(killed).toEqual([501]);
    expect(ran.map((argv) => argv.slice(0, 3))).toEqual([
      ["/usr/bin/tccutil", "reset", "Accessibility"],
      ["/usr/bin/tccutil", "reset", "ScreenCapture"],
    ]);
    ran.length = 0;
    expect((await resetComputerUseAccess(cuaOnly(), { spawn: spawnStub })).reset).toBe(false);
    expect(ran).toEqual([]);
  });

  /**
   * A stand-in for macOS: `open` runs the helper's hidden probe (answering
   * `grants` into the `--stdout` file) or opens a Settings pane / Finder; the
   * MCP proxy answers `check_permissions` with the daemon's (possibly stale)
   * view. Records everything, spawns nothing.
   */
  const fakeMac = (
    options: {
      grants?: { accessibility: boolean; screen_recording: boolean } | "silent";
      daemonSees?: { accessibility: boolean; screen_recording: boolean };
      /** Whether each successive window capture brings a frame back. */
      captures?: boolean[];
      windows?: { window_id: number; pid: number; bounds: { width: number; height: number } }[];
      up?: boolean;
      processes?: { pid: number; command: string }[];
    } = {},
  ) => {
    const captures = [...(options.captures ?? [true])];
    const opened: string[][] = [];
    const tools: { name: string; args: unknown }[] = [];
    const killed: number[] = [];
    const launched: string[][] = [];
    let up = options.up ?? true;
    const deps: HelperDeps = {
      listening: async () => up,
      sleep: async () => {},
      processes: () => (options.processes ?? []).filter(({ pid }) => !killed.includes(pid)),
      kill: (pid) => {
        killed.push(pid);
        up = false;
      },
      open: async (args) => {
        opened.push(args);
        const out = args[args.indexOf("--stdout") + 1];
        if (args.includes("--stdout") && out && options.grants !== "silent") fs.writeFileSync(out, JSON.stringify(options.grants ?? { accessibility: false, screen_recording: false }) + "\n");
        return true;
      },
      spawn: ((command: string, args: string[]) => {
        if (command === "/usr/bin/open") {
          launched.push(args);
          up = true;
          return { unref() {} };
        }
        // The MCP proxy: initialize, then one tool call.
        const child = Object.assign(new EventEmitter(), {
          stdout: new EventEmitter(),
          kill() {},
          stdin: {
            write(line: string) {
              const msg = JSON.parse(line) as { id?: number; params?: { name: string; arguments: unknown } };
              if (msg.id === 1) queueMicrotask(() => child.stdout.emit("data", Buffer.from(JSON.stringify({ id: 1, result: {} }) + "\n")));
              if (msg.id === 2) {
                const name = msg.params!.name;
                tools.push({ name, args: msg.params!.arguments });
                const result =
                  name === "list_windows"
                    ? { content: [], structuredContent: { windows: options.windows ?? [{ window_id: 77, pid: 4242, bounds: { width: 800, height: 600 } }] } }
                    : name === "get_window_state"
                      ? (captures.shift() ?? true)
                        ? { content: [{ type: "text", text: "ok" }], structuredContent: { screenshot_width: 800 } }
                        : { content: [{ type: "text", text: "px_capture_unavailable: SCShareableContent::get failed" }], structuredContent: {} }
                      : { content: [], structuredContent: options.daemonSees ?? { accessibility: true, screen_recording: true } };
                queueMicrotask(() => child.stdout.emit("data", Buffer.from(JSON.stringify({ id: 2, result }) + "\n")));
              }
            },
          },
        });
        void args;
        return child;
      }) as never,
    };
    return { deps, opened, tools, killed, launched };
  };

  test("Grant asks through the helper's own fresh probe, never `check_permissions {prompt:true}` and never `permissions grant`", async () => {
    // THE BUG: cua refuses prompt:true on the tool path
    // (`os_permission_prompt_requires_trusted_host`), and the refusal was swallowed.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-cu-grant-"));
    const mac = fakeMac();
    const answer = await grantComputerUseAccess(bundled({ home }), mac.deps);
    expect(mac.tools).toEqual([]);
    const probe = mac.opened[0]!;
    // Through LaunchServices from the helper's bundle, so the prompts name it.
    expect(probe.slice(0, 3)).toEqual(["-n", "-g", "-W"]);
    expect(probe.slice(probe.indexOf("-a"))).toEqual(["-a", APP, "--args", "--cua-internal-permission-probe-request"]);
    expect(mac.opened.flat()).not.toContain("grant");
    expect(answer).toEqual({ started: true, backend: "cua", daemon: true, prompted: true, permission: "denied", opened: "accessibility" });
  });

  test("Grant always leaves the person in the Settings list still missing a grant", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-cu-grant-"));
    const both = fakeMac();
    await grantComputerUseAccess(bundled({ home }), both.deps);
    expect(both.opened.at(-1)).toEqual([SETTINGS_PANE_URL.accessibility]);

    const screen = fakeMac({ grants: { accessibility: true, screen_recording: false } });
    expect((await grantComputerUseAccess(bundled({ home }), screen.deps)).opened).toBe("screen-recording");
    expect(screen.opened.at(-1)).toEqual([SETTINGS_PANE_URL["screen-recording"]]);
    expect(SETTINGS_PANE_URL["screen-recording"]).toBe("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");

    const done = fakeMac({ grants: { accessibility: true, screen_recording: true } });
    const answer = await grantComputerUseAccess(bundled({ home }), done.deps);
    expect(answer.permission).toBe("granted");
    expect(answer.opened).toBeUndefined();
    expect(done.opened).toHaveLength(1);
  });

  test("Grant says what went wrong instead of swallowing it — and still opens Accessibility", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-cu-grant-"));
    const silent = fakeMac({ grants: "silent", up: false });
    // The daemon never comes up: `open` for the daemon is stubbed not to raise it.
    silent.deps.spawn = (() => ({ unref() {} })) as never;
    const answer = await grantComputerUseAccess(bundled({ home }), silent.deps);
    expect(answer.daemon).toBe(false);
    expect(answer.prompted).toBe(false);
    expect(answer.opened).toBe("accessibility");
    expect(answer.message).toContain("helper did not start");
    expect(answer.message).toContain("permission check gave no answer");
  });

  test("Show in Finder reveals the helper, and nothing without one", async () => {
    const mac = fakeMac();
    expect(await revealComputerUseHelper(bundled(), mac.deps)).toEqual({ revealed: true });
    expect(mac.opened).toEqual([["-R", APP]]);
    expect(await revealComputerUseHelper(cuaOnly(), mac.deps)).toEqual({ revealed: false });
  });

  describe("the status probe", () => {
    const helper = bundledHelper(APP, HOME);
    const ours = [
      { pid: 501, command: `${BINARY} serve --socket ${helper.socket} --pid-file ${helper.pidFile} --no-permissions-gate` },
      { pid: 502, command: `${BINARY} serve --socket ${helper.socket} --pid-file ${helper.pidFile} --no-permissions-gate` },
    ];
    const theirs = [
      { pid: 400, command: "/Applications/CuaDriver.app/Contents/MacOS/cua-driver serve" },
      { pid: 600, command: `${BINARY} mcp --socket ${helper.socket}` },
      { pid: 700, command: `/usr/bin/vim ${BINARY} serve` },
    ];

    const home = () => fs.mkdtempSync(path.join(os.tmpdir(), "telar-cu-status-"));
    const withSocket = (list: { pid: number; command: string }[], at: string) =>
      list.map((p) => ({ ...p, command: p.command.replaceAll(helper.socket, bundledHelper(APP, at).socket) }));
    const granted = { accessibility: true, screen_recording: true };

    test("reads the grants from a fresh process, and never captures while one is missing", async () => {
      const before = fakeMac();
      expect(await computerUseStatus(bundled({ home: home() }), 1_000, before.deps)).toMatchObject({ permission: "denied", missing: ["accessibility", "screen-recording"], hostRunning: true });
      expect(before.opened[0]!.at(-1)).toBe("--cua-internal-permission-probe");
      expect(before.tools).toEqual([]);
    });

    test("Ready is a real capture by the daemon, of Telar's own window when there is one — never check_permissions", async () => {
      const mac = fakeMac({
        grants: granted,
        windows: [
          { window_id: 1, pid: 999, bounds: { width: 10, height: 10 } },
          { window_id: 2, pid: process.ppid, bounds: { width: 900, height: 700 } },
        ],
      });
      expect(await computerUseStatus(bundled({ home: home() }), 1_000, mac.deps)).toMatchObject({ permission: "granted", missing: [], hostRunning: true });
      expect(mac.tools.map((t) => t.name)).toEqual(["list_windows", "get_window_state"]);
      expect(mac.tools[1]!.args).toEqual({ pid: process.ppid, window_id: 2, include_accessibility_tree: false });
      expect(mac.killed).toEqual([]);
    });

    test("a daemon that cannot capture despite the grant is restarted — ours only, both processes — and tried again", async () => {
      const at = home();
      const mac = fakeMac({ grants: granted, captures: [false, true], processes: withSocket([...theirs, ...ours], at) });
      expect(await computerUseStatus(bundled({ home: at }), 1_000, mac.deps)).toMatchObject({ permission: "granted", hostRunning: true });
      expect(mac.killed.sort()).toEqual([501, 502]);
      expect(mac.launched).toHaveLength(1);
      expect(mac.launched[0]).toContain("serve");
    });

    test("still no frame after the restart: not Ready, says why, and is not restarted again on the next poll", async () => {
      const at = home();
      const mac = fakeMac({ grants: granted, captures: [false, false, false], processes: withSocket(ours, at) });
      const status = await computerUseStatus(bundled({ home: at }), 1_000, mac.deps);
      expect(status.permission).toBe("denied");
      expect(status.message).toContain("could not capture a window");
      expect(status.message).toContain("SCShareableContent");
      expect(mac.launched).toHaveLength(1);
      await computerUseStatus(bundled({ home: at }), 1_000, mac.deps);
      expect(mac.launched).toHaveLength(1);
    });

    test("a daemon that captured once is not asked to capture again", async () => {
      const at = home();
      const mac = fakeMac({ grants: granted, processes: withSocket(ours, at) });
      await computerUseStatus(bundled({ home: at }), 1_000, mac.deps);
      await computerUseStatus(bundled({ home: at }), 1_000, mac.deps);
      expect(mac.tools.filter((t) => t.name === "get_window_state")).toHaveLength(1);
    });

    test("no window to test with is Unknown, not a denial, and restarts nothing", async () => {
      const at = home();
      const mac = fakeMac({ grants: granted, windows: [], processes: withSocket(ours, at) });
      expect(await computerUseStatus(bundled({ home: at }), 1_000, mac.deps)).toMatchObject({ permission: "unknown" });
      expect(mac.killed).toEqual([]);
    });

    test("helperDaemonPids finds our serve on our socket and nothing else", () => {
      expect(helperDaemonPids(helper, { processes: () => [...theirs, ...ours] })).toEqual([501, 502]);
      expect(helperDaemonPids(helper, { processes: () => theirs })).toEqual([]);
    });
  });

  test("the external route keeps reading list_apps", () => {
    expect(interpretListApps({ kind: "result", isError: false, text: "[]" })).toEqual({ permission: "granted" });
    expect(interpretListApps({ kind: "timeout" }).permission).toBe("unknown");
  });
});

describe("classifyProbeError", () => {
  test("cua's structured words map to a grant the person can flip", () => {
    expect(classifyProbeError("permissions_pending: macOS Accessibility or Screen Recording permission is still pending")).toBe("denied");
    expect(classifyProbeError("Screen Recording permission not granted")).toBe("denied");
    expect(classifyProbeError("something else entirely")).toBe("unknown");
  });

  test("a backend refusing the CALLER is its own state, not a denial", () => {
    expect(classifyProbeError("Computer Use server error -10000: Sender process is not authenticated")).toBe("unauthenticated");
    expect(classifyProbeError("Sender process is not authenticated")).toBe("unauthenticated");
    // A code must be a code, not a prefix of a longer number.
    expect(classifyProbeError("-100001")).toBe("unknown");
  });

  test("Sky's Apple-event codes are no longer read", () => {
    // Sky is gone, so -1743 (errAEEventNotPermitted) is just a number now.
    expect(classifyProbeError("Computer Use server error -1743 (unknown error)")).toBe("unknown");
  });
});

describe("the claim gate — no working computer use, no tools", () => {
  const status = (permission: ComputerUseStatus["permission"]): ComputerUseStatus => ({ installed: true, backend: "cua", hostRunning: true, permission });
  const gateAnswering = (answer: ComputerUseStatus, overrides: { hostRunning?: () => Promise<boolean>; probe?: ComputerUseProbe } = {}) => {
    const calls: ComputerUseProbe[] = [];
    const gate = createComputerUseGate(overrides.probe ?? cuaOnly(), {
      status: async (probe) => {
        calls.push(probe);
        return answer;
      },
      hostRunning: overrides.hostRunning ?? (async () => true),
      now: () => 42,
    });
    return { gate, calls };
  };

  test("before any measurement, a claim gets nothing", () => {
    const { gate } = gateAnswering(status("granted"));
    expect(gate.last()).toBeUndefined();
    expect(gate.forClaim()).toBeUndefined();
  });

  test("a measured `granted` injects the cua server", async () => {
    const { gate } = gateAnswering(status("granted"));
    await gate.measure();
    expect(gate.forClaim()?.backend).toBe("cua");
    expect(withComputerUse([], [], "claude", gate.forClaim()).map((s) => s.id)).toEqual([COMPUTER_USE_SERVER_ID]);
  });

  test("anything but `granted` injects nothing", async () => {
    const answers: ComputerUseStatus[] = [status("denied"), status("unknown"), status("unauthenticated"), { installed: false, hostRunning: false }];
    for (const answer of answers) {
      const { gate } = gateAnswering(answer);
      await gate.measure();
      expect(gate.forClaim()).toBeUndefined();
      expect(withComputerUse([], [], "claude", gate.forClaim())).toEqual([]);
    }
  });

  test("a user's own `mac` still wins over a granted gate — enabled or disabled", async () => {
    const { gate } = gateAnswering(status("granted"));
    await gate.measure();
    const theirs: McpServer = { id: COMPUTER_USE_SERVER_ID, label: "theirs", enabled: true, spec: { transport: "stdio", command: "/bin/echo" }, createdAt: 0, updatedAt: 0 };
    expect(withComputerUse([theirs], [theirs], "claude", gate.forClaim())).toEqual([theirs]);
    expect(withComputerUse([], [{ ...theirs, enabled: false }], "claude", gate.forClaim())).toEqual([]);
  });

  test("concurrent measurements share one probe, stamped with the injected clock", async () => {
    const { gate, calls } = gateAnswering(status("granted"));
    const [first, second] = await Promise.all([gate.measure(), gate.measure()]);
    expect(calls).toHaveLength(1);
    expect(first).toBe(second);
    expect(gate.last()).toEqual({ status: status("granted"), measuredAt: 42 });
  });

  test("the start-time probe never runs against a stopped daemon", async () => {
    const { gate, calls } = gateAnswering(status("granted"), { hostRunning: async () => false });
    expect(await gate.measureIfHostRunning()).toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(gate.forClaim()).toBeUndefined();
  });

  test("the start-time probe measures when the daemon is already up", async () => {
    const { gate, calls } = gateAnswering(status("granted"));
    expect(await gate.measureIfHostRunning()).toEqual(status("granted"));
    expect(calls).toHaveLength(1);
    expect(gate.forClaim()?.backend).toBe("cua");
  });

  test("the start-time probe spawns nothing on a machine without the driver", async () => {
    let asked = false;
    const { gate, calls } = gateAnswering(status("granted"), {
      probe: cuaOnly({ exists: () => false }),
      hostRunning: async () => ((asked = true), true),
    });
    expect(await gate.measureIfHostRunning()).toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(asked).toBe(false);
  });
});

describe("withComputerUse — who gets it", () => {
  const cua = resolveComputerUse(cuaOnly())!;
  const user = (id: string, enabled = true): McpServer => ({
    id,
    label: id,
    enabled,
    spec: { transport: "stdio", command: "/bin/echo" },
    createdAt: 0,
    updatedAt: 0,
  });

  test("it goes to every provider Telar drives", () => {
    expect(withComputerUse([], [], "claude", cua).map((s) => s.id)).toEqual([COMPUTER_USE_SERVER_ID]);
    expect(withComputerUse([], [], "opencode", cua).map((s) => s.id)).toEqual([COMPUTER_USE_SERVER_ID]);
  });

  test("Codex gets it too (#521)", () => {
    // #368 withheld it, reasoning that Codex ships its own provider and a second
    // desktop under a second name is the thing to avoid. The second desktop was
    // never the risk the withholding removed — the driver already switches the
    // native feature off whenever a `mac` server is in the claim — and what the
    // withholding did remove was the only desktop a Codex session had.
    expect(withComputerUse([], [], "codex", cua).map((s) => s.id)).toEqual([COMPUTER_USE_SERVER_ID]);
  });

  test("an uninstalled machine injects nothing, silently", () => {
    expect(withComputerUse([user("linear")], [user("linear")], "claude", undefined).map((s) => s.id)).toEqual(["linear"]);
  });

  test("a user's own entry wins — including a DISABLED one", () => {
    const theirs = user(COMPUTER_USE_SERVER_ID);
    expect(withComputerUse([theirs], [theirs], "claude", cua)).toEqual([theirs]);
    // Disabled is filtered out of the enabled list before the fold, so the
    // check reads the unfiltered one: switching the server off must not
    // resurrect the built-in.
    const disabled = user(COMPUTER_USE_SERVER_ID, false);
    expect(withComputerUse([], [disabled], "opencode", cua)).toEqual([]);
  });
});

describe("claimHasComputerUse — the Codex native-disable signal", () => {
  const mac: McpServer = { id: COMPUTER_USE_SERVER_ID, label: "mac", enabled: true, spec: { transport: "stdio", command: "cua-driver", args: ["mcp"] }, createdAt: 0, updatedAt: 0 };
  test("true only when Telar's own server is present", () => {
    expect(claimHasComputerUse([mac])).toBe(true);
    expect(claimHasComputerUse([{ ...mac, id: "linear" }])).toBe(false);
    expect(claimHasComputerUse([])).toBe(false);
    expect(claimHasComputerUse(undefined)).toBe(false);
  });
});

// A `ResolvedComputerUse` is `{ server, backend }` — pinned so a shape change
// is caught here rather than at the state.ts injection site.
const _shape: ResolvedComputerUse | undefined = resolveComputerUse(cuaOnly());
void _shape;
