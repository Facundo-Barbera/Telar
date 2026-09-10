/**
 * The unhappy half of a run's life: shells that die while their children do not,
 * daemons that die while the run does not, and secrets that must not survive
 * either. Every fixture here is a temp directory and a process this file kills
 * in a `finally`, however the assertions go.
 */
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunManager, type StartRunInput } from "../src/run/manager";
import { RunJournalFile } from "../src/run/journal";
import { RunConfigurationInput, type RunConfiguration, type RunProbeResult } from "../src/run/types";

const temp = (label: string) => fs.mkdtempSync(path.join(os.tmpdir(), `telar-run-${label}-`));

const config = (command: string, extra: Partial<RunConfiguration> = {}): RunConfiguration => ({
  id: "runcfg_test",
  projectId: "proj_1",
  name: "fixture",
  command,
  createdAt: 1,
  updatedAt: 1,
  ...extra,
});

const input = (tree: string, cfg: RunConfiguration, extra: Partial<StartRunInput> = {}): StartRunInput => ({
  projectId: "proj_1",
  config: cfg,
  worktreePath: tree,
  ...extra,
});

async function until(predicate: () => boolean, ms = 6000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

/** Kill anything the fixture left behind, without caring whether it was there. */
function reap(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

// ── the shell dying is not the group dying ─────────────────────────────────

test("a shell that exits leaving a child behind does NOT free the project", async () => {
  // `cmd &` is how half the world starts a dev server: the shell returns 0
  // immediately and the actual process is still there, holding the actual port.
  const manager = new RunManager({ groupDrainMs: 150 });
  const run = await manager.start(input(temp("tree"), config("sleep 30 &")));
  const pid = manager.run(run.runId).pid;
  try {
    expect(await until(() => manager.run(run.runId).status === "unknown")).toBe(true);
    const view = manager.run(run.runId);
    expect(view.error).toMatch(/still alive in its process group/);
    expect(view.endedAt).toBeGreaterThan(0);

    // The slot stays held: the port is still taken, so the answer to "start it
    // again" is no, not a second server.
    expect(manager.activeRun("proj_1")?.runId).toBe(run.runId);
    await expect(manager.start(input(temp("tree"), config("sleep 1")))).rejects.toThrow(/lost contact/);

    // And a human who has checked can free it — still without anything being
    // signalled on their behalf.
    expect(manager.release(run.runId).status).toBe("unknown");
    expect(manager.activeRun("proj_1")).toBeUndefined();
  } finally {
    reap(pid);
    await manager.shutdown();
  }
}, 20_000);

test("stopping a run whose child ignores SIGTERM reports unknown rather than success", async () => {
  // The parent has the default disposition and dies on TERM; the child traps it
  // and does not. The old code called that a clean stop, because the handle it
  // was watching had closed.
  const manager = new RunManager({ groupDrainMs: 200, stopGraceMs: 1500 });
  // The loop matters: `trap` protects the shell, not the `sleep` it is waiting
  // on, so a child that means to survive has to keep going after that dies.
  const run = await manager.start(input(temp("tree"), config(`sh -c 'trap "" TERM; echo armed; while :; do sleep 1; done' & wait`)));
  const pid = manager.run(run.runId).pid;
  try {
    // Wait for the trap to actually be installed: a TERM that arrives while the
    // child is still starting kills it, and would test nothing.
    expect(await until(() => manager.output(run.runId).lines.some((line) => line.text === "armed"))).toBe(true);
    await expect(manager.stop(run.runId)).rejects.toThrow(/lost contact/);
    expect(manager.run(run.runId).status).toBe("unknown");
  } finally {
    reap(pid);
    await manager.shutdown();
  }
}, 30_000);

test("an ordinary run still exits cleanly — the group check does not make everything unknown", async () => {
  const manager = new RunManager({ groupDrainMs: 200 });
  const run = await manager.start(input(temp("tree"), config("echo done")));
  try {
    expect(await until(() => manager.run(run.runId).status === "exited")).toBe(true);
    expect(manager.run(run.runId).exitCode).toBe(0);
    expect(manager.activeRun("proj_1")).toBeUndefined();
  } finally {
    await manager.shutdown();
  }
}, 15_000);

// ── surviving the daemon ───────────────────────────────────────────────────

test("a run open in the journal comes back as unknown and keeps blocking the project", async () => {
  const dir = temp("journal");
  const journal = new RunJournalFile(dir);
  journal.open({
    runId: "run_ghost",
    projectId: "proj_1",
    configId: "runcfg_test",
    configName: "web dev",
    command: "bun run dev",
    worktreePath: "/tmp/tree",
    cwd: "/tmp/tree",
    startedAt: 1,
    pid: 4242,
  });

  const manager = new RunManager({ journal });
  const recovered = manager.recover();
  expect(recovered).toHaveLength(1);
  expect(recovered[0]!.status).toBe("unknown");
  // The pid is prose so a human can go and look — nothing signalled it.
  expect(recovered[0]!.error).toContain("4242");
  expect(recovered[0]!.error).toMatch(/restarted while "web dev" was running/);

  await expect(manager.start(input(temp("tree"), config("sleep 1")))).rejects.toThrow(/lost contact/);

  manager.release("run_ghost");
  // Released means checked: the record must not haunt the next start either.
  expect(new RunJournalFile(dir).list()).toHaveLength(0);
  await manager.shutdown();
}, 15_000);

test("a run that ends cleanly leaves nothing in the journal to recover", async () => {
  const dir = temp("journal");
  const manager = new RunManager({ journal: new RunJournalFile(dir), groupDrainMs: 100 });
  const run = await manager.start(input(temp("tree"), config("echo hi")));
  try {
    expect(await until(() => manager.run(run.runId).status === "exited")).toBe(true);
    expect(new RunJournalFile(dir).list()).toHaveLength(0);
  } finally {
    await manager.shutdown();
  }
}, 15_000);

// ── shutting down mid-launch ───────────────────────────────────────────────

test("a start still probing when shutdown arrives never spawns anything", async () => {
  const tree = temp("tree");
  const marker = path.join(tree, "spawned");
  let release!: (value: RunProbeResult) => void;
  const deferred = new Promise<RunProbeResult>((resolve) => {
    release = resolve;
  });

  const manager = new RunManager({ probe: () => deferred });
  const starting = manager.start(input(tree, config(`touch ${marker}`, { readinessUrl: "http://localhost:65010" })));
  const caught = starting.catch((error: Error) => error);

  await new Promise((resolve) => setTimeout(resolve, 50));
  const closing = manager.shutdown();
  release({ answered: false, serving: false });

  const error = await caught;
  await closing;
  expect(String((error as Error).message)).toMatch(/shutting down/);
  // The whole point: shutdown returned only after that decision was made.
  expect(fs.existsSync(marker)).toBe(false);

  // And it stays shut: a start after shutdown is refused, not queued.
  await expect(manager.start(input(tree, config("sleep 1")))).rejects.toThrow(/shutting down/);
}, 15_000);

test("a spawn that fails outright is reported as failed and frees the slot", async () => {
  const tree = temp("tree");
  const doomed = path.join(tree, "gone");
  fs.mkdirSync(doomed);
  let release!: (value: RunProbeResult) => void;
  const deferred = new Promise<RunProbeResult>((resolve) => {
    release = resolve;
  });

  const manager = new RunManager({ probe: () => deferred });
  const starting = manager.start(input(tree, config("echo hi", { cwd: "gone", readinessUrl: "http://localhost:65011" })));

  // The directory passes validation and is gone by the time the shell is asked
  // to start in it — the window an unhandled `error` event used to live in.
  await new Promise((resolve) => setTimeout(resolve, 50));
  fs.rmSync(doomed, { recursive: true, force: true });
  release({ answered: false, serving: false });

  const view = await starting;
  expect(await until(() => manager.run(view.runId).status === "failed")).toBe(true);
  expect(manager.activeRun("proj_1")).toBeUndefined();
  await manager.shutdown();
}, 15_000);

// ── secrets ────────────────────────────────────────────────────────────────

test("a secret Telar cannot scrub is refused when saved, not skipped when printed", () => {
  const short = RunConfigurationInput.safeParse({ name: "a", command: "b", env: [{ key: "P", value: "ab", secret: true }] });
  expect(short.success).toBe(false);
  expect(JSON.stringify(short.error?.issues)).toMatch(/at least 4 characters/);

  const multiline = RunConfigurationInput.safeParse({
    name: "a",
    command: "b",
    env: [{ key: "KEY", value: "-----BEGIN-----\nabcd\n", secret: true }],
  });
  expect(multiline.success).toBe(false);
  expect(JSON.stringify(multiline.error?.issues)).toMatch(/line break/);

  // The same values are perfectly fine when nobody promised to hide them.
  expect(RunConfigurationInput.safeParse({ name: "a", command: "b", env: [{ key: "P", value: "ab" }] }).success).toBe(true);
});

test("a readiness URL that an HTTP probe could never check is refused", () => {
  expect(RunConfigurationInput.safeParse({ name: "a", command: "b", readinessUrl: "ftp://example.com" }).success).toBe(false);
  expect(RunConfigurationInput.safeParse({ name: "a", command: "b", readinessUrl: "http://localhost:3000" }).success).toBe(true);
});

test("a secret value pasted into the command is gone from the view too", async () => {
  const manager = new RunManager({ groupDrainMs: 100 });
  const run = await manager.start(
    input(
      temp("tree"),
      config('echo "auth sk_live_secret"', { name: "curl sk_live_secret", env: [{ key: "TOKEN", value: "sk_live_secret", secret: true }] }),
    ),
  );
  try {
    const view = manager.run(run.runId);
    expect(view.command).not.toContain("sk_live_secret");
    expect(view.command).toContain("«redacted»");
    expect(view.configName).not.toContain("sk_live_secret");
    expect(JSON.stringify(view)).not.toContain("sk_live_secret");
  } finally {
    await manager.shutdown();
  }
}, 15_000);

test("a run that never emits a newline is still bounded, and still scrubbed", async () => {
  const manager = new RunManager({ groupDrainMs: 100 });
  // 40k characters, no newline anywhere, with the secret buried in the middle
  // where a chunk boundary is most likely to cut it in half.
  const run = await manager.start(
    input(
      temp("tree"),
      config('i=0; while [ $i -lt 20 ]; do printf "%01000d" 0; printf "%s" "$TOKEN"; i=$((i+1)); done; echo', {
        env: [{ key: "TOKEN", value: "sk_live_secret", secret: true }],
      }),
    ),
  );
  try {
    expect(await until(() => manager.run(run.runId).status === "exited")).toBe(true);
    // `exit` can beat the last `data` events out of the pipe, so the captured
    // output is not complete just because the process is gone. Waiting on the
    // status alone made this assertion fail on a loaded machine — which is a
    // flaky test, not a flaky splitter.
    expect(await until(() => manager.output(run.runId).lines.length > 1)).toBe(true);
    const output = manager.output(run.runId);
    expect(output.lines.length).toBeGreaterThan(1);
    for (const line of output.lines) {
      expect(line.text.length).toBeLessThanOrEqual(4000);
      expect(line.text).not.toContain("sk_live_secret");
    }
    expect(output.lines.some((line) => line.text.includes("«redacted»"))).toBe(true);
  } finally {
    await manager.shutdown();
  }
}, 20_000);

// ── the working directory really is inside the tree ────────────────────────

test("a working directory that is a symlink out of the worktree is refused", async () => {
  const tree = temp("tree");
  const outside = temp("outside");
  fs.symlinkSync(outside, path.join(tree, "escape"));

  const manager = new RunManager();
  await expect(manager.start(input(tree, config("pwd", { cwd: "escape" })))).rejects.toThrow(/is a link out of the worktree/);
  // A symlink that stays inside is fine — the rule is containment, not links.
  fs.mkdirSync(path.join(tree, "real"));
  fs.symlinkSync(path.join(tree, "real"), path.join(tree, "inside"));
  const run = await manager.start(input(tree, config("pwd", { cwd: "inside" })));
  expect(run.status).not.toBe("failed");
  await manager.shutdown();
}, 15_000);

// ── readiness is a claim, and a weak one ───────────────────────────────────

test("something answering with a 500 is listening, not ready", async () => {
  let up = false;
  const manager = new RunManager({
    readyPollMs: 20,
    groupDrainMs: 100,
    probe: async () => (up ? { answered: true, serving: false } : { answered: false, serving: false }),
  });
  const run = await manager.start(input(temp("tree"), config("sleep 5", { readinessUrl: "http://localhost:65012" })));
  try {
    up = true;
    await new Promise((resolve) => setTimeout(resolve, 150));
    // A crashing dev server answers every request; it is the state the human is
    // waiting to leave, so the run stays `running` and readiness stays pending.
    expect(manager.run(run.runId).status).toBe("running");
    expect(manager.run(run.runId).readiness.kind).toBe("pending");
  } finally {
    await manager.shutdown();
  }
}, 15_000);
