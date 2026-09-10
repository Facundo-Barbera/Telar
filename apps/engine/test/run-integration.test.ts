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
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRunMount } from "../src/run/mount";
import type { RunSessionContext } from "../src/run/store-capability";
import type { RunConfigurationView, RunOutputLine, RunView } from "../src/run/types";

const temp = (label: string) => fs.mkdtempSync(path.join(os.tmpdir(), `telar-run-${label}-`));

type Answer = { active?: RunView; history: RunView[]; sessionWorktreePath?: string };

/** One assembled surface over a fresh home, plus a request function. */
function surface(worktreePath: string, extra: Partial<RunSessionContext> = {}) {
  const root = temp("home");
  const mount = createRunMount({ root });
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
  await expect(call("POST", "/run/release", {})).rejects.toThrow(/runId/);
});

test("start, read output, restart and stop, all through the verbs", async () => {
  const tree = temp("tree");
  const { call } = surface(tree);
  const config = await call<RunConfigurationView>("POST", "/run/configs", { name: "server", command: 'echo up; sleep 30' });

  const started = await call<RunView>("POST", "/run/start", { configId: config.id });
  let pid = started.pid;
  try {
    expect(started.status).toBe("running");
    // The tree is captured on the run, not inferred by whoever reads it later.
    expect(started.worktreePath).toBe(tree);
    expect(started.cwd).toBe(tree);

    const status = await call<Answer>("GET", "/run/status");
    expect(status.active?.runId).toBe(started.runId);
    expect(status.sessionWorktreePath).toBe(tree);

    expect(
      await until(async () => (await call<{ lines: RunOutputLine[] }>("GET", "/run/output")).lines.some((line) => line.text === "up")),
    ).toBe(true);

    // A second start is refused: one deployment per project, enforced here
    // rather than by a disabled button in one of several clients.
    await expect(call("POST", "/run/start", { configId: config.id })).rejects.toThrow(/one local deployment/);

    const restarted = await call<RunView>("POST", "/run/restart", {});
    expect(restarted.runId).not.toBe(started.runId);
    reap(pid);
    pid = restarted.pid;
    expect((await call<Answer>("GET", "/run/status")).active?.runId).toBe(restarted.runId);

    const stopped = await call<RunView>("POST", "/run/stop", {});
    expect(["exited", "failed"]).toContain(stopped.status);
    expect((await call<Answer>("GET", "/run/status")).active).toBeUndefined();

    // Output outlives the process: reading a dead run is most of the value.
    const after = await call<{ lines: RunOutputLine[] }>("GET", "/run/output", { runId: started.runId });
    expect(after.lines.some((line) => line.text === "up")).toBe(true);
    // And the finished run is still in history, newest first.
    const history = (await call<Answer>("GET", "/run/status")).history;
    expect(history.length).toBe(2);
    expect(history[0]!.runId).toBe(restarted.runId);
  } finally {
    reap(pid);
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

test("a run from another worktree is reported as such, and is never taken over silently", async () => {
  // The session sits in one tree; the deployment came from another. The surface
  // has to say so, because "restart" on a run you did not start, from a branch
  // you are not on, is the failure this milestone exists to prevent.
  const theirs = temp("tree-theirs");
  const mine = temp("tree-mine");
  const root = temp("home");
  const mount = createRunMount({ root });
  const call = <T,>(worktreePath: string, method: string, tail: string, input: Record<string, unknown> = {}): Promise<T> =>
    mount.handle(method, tail, input, () => ({ sessionId: "s", projectId: "proj_1", worktreePath }))! as Promise<T>;

  const config = await call<RunConfigurationView>(theirs, "POST", "/run/configs", { name: "server", command: "sleep 30" });
  const started = await call<RunView>(theirs, "POST", "/run/start", { configId: config.id });
  try {
    const seen = await call<Answer>(mine, "GET", "/run/status");
    expect(seen.active?.runId).toBe(started.runId);
    // Both facts, side by side: where it runs, and where the reader is.
    expect(seen.active?.worktreePath).toBe(theirs);
    expect(seen.sessionWorktreePath).toBe(mine);
    await expect(call(mine, "POST", "/run/start", { configId: config.id })).rejects.toThrow(/one local deployment/);
  } finally {
    reap(started.pid);
    await mount.shutdown();
  }
}, 20_000);

test("a home with an unfinished run recovers it as unknown, and blocks the project until released", async () => {
  const tree = temp("tree");
  const root = temp("home");
  const first = createRunMount({ root });
  const context = (): RunSessionContext => ({ sessionId: "s", projectId: "proj_1", worktreePath: tree });
  const config = (await first.handle("POST", "/run/configs", { name: "server", command: "sleep 30" }, context)) as RunConfigurationView;
  const started = (await first.handle("POST", "/run/start", { configId: config.id }, context)) as RunView;

  try {
    // The daemon dies without stopping anything: a new mount over the same home
    // is the restart, and it reads the journal in its constructor.
    const second = createRunMount({ root });
    expect(second.recovered.map((run) => run.runId)).toEqual([started.runId]);
    expect(second.recovered[0]!.status).toBe("unknown");
    expect(second.recovered[0]!.error).toMatch(/restarted while/);

    const answer = (await second.handle("GET", "/run/status", {}, context)) as Answer;
    expect(answer.active?.runId).toBe(started.runId);
    await expect(second.handle("POST", "/run/start", { configId: config.id }, context)).rejects.toThrow(/lost contact/);
    // Nothing was signalled and nothing was adopted: the process this run
    // describes is still running right now, and only a human can say otherwise.
    const released = (await second.handle("POST", "/run/release", { runId: started.runId }, context)) as RunView;
    expect(released.status).toBe("unknown");
    expect((await second.handle("GET", "/run/status", {}, context) as Answer).active).toBeUndefined();
  } finally {
    reap(started.pid);
    await first.shutdown();
  }
}, 20_000);
