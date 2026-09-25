/**
 * The whole run surface, assembled the way the daemon assembles it: a real
 * engine home, a real store, a real manager, real processes, and requests that
 * arrive as a method and a session-scoped tail.
 *
 * WHAT THIS COVERS THAT THE UNIT TESTS DO NOT: that the pieces fit. Each half is
 * tested next door — the route table matches, the capability resolves, the
 * manager spawns — and a surface can still be broken end to end because a route
 * hands the capability a field it does not read, or because recovery never runs
 * on the path the daemon actually takes. So this drives verbs, not functions.
 *
 * Every home is a temp directory and every process is reaped in a `finally`.
 */
import { afterAll, afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRunMount, type RunMount } from "../src/run/mount";
import type { RunSessionContext } from "../src/run/store-capability";
import type { RunConfigurationView, RunOutputLine, RunView } from "../src/run/types";

const track = (dir: string): string => (tempDirs.push(dir), dir);
const temp = (label: string) => track(fs.mkdtempSync(path.join(os.tmpdir(), `telar-run-${label}-`)));

/**
 * NOTHING THIS FILE ASSEMBLES OUTLIVES IT. Every surface here owns a manager
 * that owns real process groups, and a mount left running after its test keeps
 * a `sleep` alive in a directory this file is about to delete — which then
 * shows up as a mysterious failure two tests later, in the one that recovers a
 * home from disk. Mounts are shut down after each test; the temp homes go at
 * the end, once no manager is still draining a group inside one.
 */
const mounts: RunMount[] = [];
const tempDirs: string[] = [];

/**
 * THE ENVIRONMENT A MOUNT SEES, WITHOUT THE DESKTOP'S TERMINAL CHANNEL.
 *
 * `createRunMount` reads `TELAR_DESKTOP_RUN_TERMINAL_PORT` / `_TOKEN` from the
 * environment and, when they are there, launches every run on the desktop
 * shell's PTY host. A suite started from inside a Telar session INHERITS both
 * from the running app — so these tests were opening real terminal sessions in
 * the live app, and asserting pipe behaviour (`«redacted»`) against the PTY
 * redactor, which masks cell for cell instead (`pty-stream.ts`). On CI neither
 * variable exists, which is why it only ever failed on a Mac running Telar.
 * Every mount here is the pipe launcher, on purpose, wherever the suite runs.
 */
function hermeticEnv(): NodeJS.ProcessEnv {
  const { TELAR_DESKTOP_RUN_TERMINAL_PORT: _port, TELAR_DESKTOP_RUN_TERMINAL_TOKEN: _token, ...rest } = process.env;
  return rest;
}

function mountRun(options: { root: string }): RunMount {
  const mount = createRunMount({ ...options, env: hermeticEnv() });
  mounts.push(mount);
  return mount;
}

test("a mount in this suite never reaches a live desktop's terminal, even when the environment names one", () => {
  const saved = { port: process.env.TELAR_DESKTOP_RUN_TERMINAL_PORT, token: process.env.TELAR_DESKTOP_RUN_TERMINAL_TOKEN };
  process.env.TELAR_DESKTOP_RUN_TERMINAL_PORT = "59999";
  process.env.TELAR_DESKTOP_RUN_TERMINAL_TOKEN = "fixture-token";
  try {
    expect(mountRun({ root: temp("home") }).terminalChannel).toBe(false);
    // …and the channel IS what a bare mount would have taken, so the guard is
    // doing the work rather than the variables being ignored anyway.
    const bare = createRunMount({ root: temp("home"), env: process.env });
    mounts.push(bare);
    expect(bare.terminalChannel).toBe(true);
  } finally {
    for (const [key, value] of [["TELAR_DESKTOP_RUN_TERMINAL_PORT", saved.port], ["TELAR_DESKTOP_RUN_TERMINAL_TOKEN", saved.token]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

afterEach(async () => {
  while (mounts.length) {
    try {
      await mounts.pop()!.shutdown();
    } catch {
      /* a mount that already failed is not a second failure */
    }
  }
});

afterAll(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

type Answer = { terminals: RunView[]; sessionWorktreePath?: string };

/** One assembled surface over a fresh home, plus a request function. */
function surface(worktreePath: string, extra: Partial<RunSessionContext> = {}) {
  const root = temp("home");
  const mount = mountRun({ root });
  const context = (): RunSessionContext => ({ sessionId: "sess_1", projectId: "proj_1", worktreePath, ...extra });
  const call = <T,>(method: string, tail: string, input: Record<string, unknown> = {}): Promise<T> => {
    const answer = mount.handle(method, tail, input, context);
    if (answer === undefined) throw new Error(`no run route for ${method} ${tail}`);
    return answer as Promise<T>;
  };
  return { root, mount, call };
}

async function until(predicate: () => Promise<boolean>, ms = 6000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return await predicate();
}

function reap(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

test("a request that is not a run request is not answered — the caller keeps its own routing", async () => {
  const { mount } = surface(temp("tree"));
  const context = (): RunSessionContext => ({ sessionId: "s", projectId: "p", worktreePath: "/tmp" });
  expect(mount.handle("GET", "/messages", {}, context)).toBeUndefined();
  expect(mount.handle("GET", "/run/nonsense", {}, context)).toBeUndefined();
  // Method matters: the table is not a prefix match.
  expect(mount.handle("GET", "/run/start", {}, context)).toBeUndefined();

  // Ours, and answered — a refusal from inside is still an answer, which is the
  // distinction the caller's fall-through depends on.
  const answered = mount.handle("POST", "/run/start", {}, context);
  expect(answered).toBeDefined();
  await expect(answered).rejects.toThrow(/configId/);
});

test("a configuration is saved, listed, edited and deleted over the verbs", async () => {
  const tree = temp("tree");
  const { call } = surface(tree);

  expect(await call<{ configurations: RunConfigurationView[] }>("GET", "/run/configs")).toEqual({ configurations: [] });

  const saved = await call<RunConfigurationView>("POST", "/run/configs", {
    name: "web dev",
    command: "echo hi",
    env: [
      { key: "MODE", value: "dev" },
      { key: "TOKEN", value: "sk_live_secret", secret: true },
    ],
  });
  expect(saved.name).toBe("web dev");
  // A secret goes out with no value at all, not a masked one.
  expect(saved.env).toEqual([{ key: "MODE", value: "dev" }, { key: "TOKEN", secret: true }]);

  const edited = await call<RunConfigurationView>("POST", `/run/configs/${saved.id}`, { command: "echo bye" });
  expect(edited.command).toBe("echo bye");
  // The patch omitted `env`, so the stored secret survived — this is the exact
  // contract the cockpit's editor relies on to avoid erasing a token it was
  // never sent.
  expect(edited.env).toEqual([{ key: "MODE", value: "dev" }, { key: "TOKEN", secret: true }]);

  await call("DELETE", `/run/configs/${saved.id}`);
  expect((await call<{ configurations: RunConfigurationView[] }>("GET", "/run/configs")).configurations).toEqual([]);
});

test("a bad request is refused by the route, not by the manager", async () => {
  const { call } = surface(temp("tree"));
  await expect(call("POST", "/run/start", {})).rejects.toThrow(/configId/);
  await expect(call("POST", "/run/configs", { name: "", command: "x" })).rejects.toThrow(/name/);
  // A secret too short to scrub out of a log is refused at the door rather than
  // stored and then printed.
  await expect(call("POST", "/run/configs", { name: "n", command: "c", env: [{ key: "T", value: "ab", secret: true }] })).rejects.toThrow(
    /4 characters/,
  );
  // There is no release any more: nothing is ever held to release.
  expect(matchedRelease()).toBeUndefined();
});

function matchedRelease() {
  const { mount } = surface(temp("tree"));
  return mount.handle("POST", "/run/release", {}, () => ({ sessionId: "s", projectId: "p", worktreePath: "/tmp" }));
}

test("start, read output, start again, restart and close, all through the verbs", async () => {
  const tree = temp("tree");
  const { call } = surface(tree);
  const config = await call<RunConfigurationView>("POST", "/run/configs", { name: "server", command: 'echo up; sleep 30' });

  const started = await call<RunView>("POST", "/run/start", { configId: config.id });
  const pids = [started.pid];
  try {
    expect(started.status).toBe("running");
    // The tree is captured on the terminal, not inferred by whoever reads it later.
    expect(started.worktreePath).toBe(tree);
    expect(started.cwd).toBe(tree);
    expect(started.sessionId).toBe("sess_1");

    const status = await call<Answer>("GET", "/run/status");
    expect(status.terminals.map((run) => run.terminalId)).toEqual([started.terminalId]);
    expect(status.sessionWorktreePath).toBe(tree);

    expect(
      await until(async () => (await call<{ lines: RunOutputLine[] }>("GET", "/run/output")).lines.some((line) => line.text === "up")),
    ).toBe(true);

    // A second start is a second terminal — never a refusal.
    const again = await call<RunView>("POST", "/run/start", { configId: config.id });
    pids.push(again.pid);
    expect(again.title).toBe("server #2");
    expect(again.status).toBe("running");

    // With two open, a verb that acts must be told which one.
    await expect(call("POST", "/run/stop", {})).rejects.toThrow(/2 open terminals/);

    const restarted = await call<RunView>("POST", "/run/restart", { terminalId: started.terminalId });
    pids.push(restarted.pid);
    expect(restarted.terminalId).not.toBe(started.terminalId);

    const closed = await call<RunView>("POST", "/run/stop", { terminalId: again.terminalId });
    expect(closed.status).toBe("closed");
    expect(closed.closedBy).toBe("person");
    // The old name still works, for one release.
    const closedToo = await call<RunView>("POST", "/run/stop", { runId: restarted.terminalId, closedBy: "agent" });
    expect(closedToo.closedBy).toBe("agent");

    // Output outlives the process: reading an ended terminal is most of the value.
    const after = await call<{ lines: RunOutputLine[] }>("GET", "/run/output", { terminalId: started.terminalId });
    expect(after.lines.some((line) => line.text === "up")).toBe(true);
    // And every one of them is still listed, newest first.
    const terminals = (await call<Answer>("GET", "/run/status")).terminals;
    expect(terminals.length).toBe(3);
    expect(terminals.every((run) => run.status === "closed")).toBe(true);
  } finally {
    for (const pid of pids) reap(pid);
  }
}, 30_000);

test("a secret never appears in captured output, whatever the process prints", async () => {
  const tree = temp("tree");
  const { call } = surface(tree);
  const config = await call<RunConfigurationView>("POST", "/run/configs", {
    name: "leaky",
    command: 'echo "the token is $TOKEN"; printf "%s" "$TOKEN"; echo',
    env: [{ key: "TOKEN", value: "sk_live_secret", secret: true }],
  });
  const started = await call<RunView>("POST", "/run/start", { configId: config.id });
  try {
    expect(await until(async () => (await call<{ lines: RunOutputLine[] }>("GET", "/run/output")).lines.length >= 2)).toBe(true);
    const { lines } = await call<{ lines: RunOutputLine[] }>("GET", "/run/output");
    const text = lines.map((line) => line.text).join("\n");
    expect(text).not.toContain("sk_live_secret");
    expect(text).toContain("«redacted»");
  } finally {
    reap(started.pid);
  }
}, 20_000);

test("terminals are the session's: another session in the same project neither sees nor reaches them", async () => {
  const tree = temp("tree");
  const root = temp("home");
  const mount = mountRun({ root });
  const call = <T,>(sessionId: string, method: string, tail: string, input: Record<string, unknown> = {}): Promise<T> =>
    mount.handle(method, tail, input, () => ({ sessionId, projectId: "proj_1", worktreePath: tree }))! as Promise<T>;

  // The configuration is the PROJECT's: both sessions see it.
  const config = await call<RunConfigurationView>("sess_a", "POST", "/run/configs", { name: "server", command: "sleep 30" });
  expect((await call<{ configurations: RunConfigurationView[] }>("sess_b", "GET", "/run/configs")).configurations).toHaveLength(1);

  const mine = await call<RunView>("sess_a", "POST", "/run/start", { configId: config.id });
  const theirs = await call<RunView>("sess_b", "POST", "/run/start", { configId: config.id });
  try {
    // Each session numbers its own, and lists only its own.
    expect(mine.title).toBe("server");
    expect(theirs.title).toBe("server");
    expect((await call<Answer>("sess_a", "GET", "/run/status")).terminals.map((run) => run.terminalId)).toEqual([mine.terminalId]);
    await expect(call("sess_b", "POST", "/run/stop", { terminalId: mine.terminalId })).rejects.toThrow(/no terminal/);
  } finally {
    reap(mine.pid);
    reap(theirs.pid);
    await mount.shutdown();
  }
}, 20_000);

test("a home left by an engine that died re-lists nothing on the pipe fallback, and blocks nothing", async () => {
  const tree = temp("tree");
  const root = temp("home");
  const first = mountRun({ root });
  const context = (): RunSessionContext => ({ sessionId: "s", projectId: "proj_1", worktreePath: tree });
  const config = (await first.handle("POST", "/run/configs", { name: "server", command: "sleep 30" }, context)) as RunConfigurationView;
  const started = (await first.handle("POST", "/run/start", { configId: config.id }, context)) as RunView;
  // A liveness journal a previous build left behind is cleared, not read.
  fs.writeFileSync(path.join(root, "run", "open-runs.json"), JSON.stringify({ runs: [{ runId: "run_old" }] }));

  try {
    // The daemon dies without stopping anything: a new mount over the same home
    // is the restart. No orphan, no `unknown`, nothing held.
    const second = mountRun({ root });
    expect(await second.recovered).toEqual([]);
    expect(fs.existsSync(path.join(root, "run", "open-runs.json"))).toBe(false);
    expect(((await second.handle("GET", "/run/status", {}, context)) as Answer).terminals).toEqual([]);
    const next = (await second.handle("POST", "/run/start", { configId: config.id }, context)) as RunView;
    expect(next.status).toBe("running");
    reap(next.pid);
  } finally {
    reap(started.pid);
    await first.shutdown();
  }
}, 20_000);
