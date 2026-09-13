/**
 * The unhappy half of a run's life: shells that die while their children do not,
 * daemons that die while the run does not, and secrets that must not survive
 * either. Every fixture here is a temp directory and a process this file kills
 * in a `finally`, however the assertions go.
 */
import { afterAll, afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunManager, type StartRunInput } from "../src/run/manager";
import { RunJournalFile } from "../src/run/journal";
import { RunConfigurationInput, type RunConfiguration, type RunProbeResult } from "../src/run/types";

const temp = (label: string) => track(fs.mkdtempSync(path.join(os.tmpdir(), `telar-run-${label}-`)));

const track = (dir: string): string => (tempDirs.push(dir), dir);
/**
 * NOTHING THIS FILE STARTS OUTLIVES IT, and nothing it writes stays on disk.
 * Every run here is a real process in a real temp directory: a test that fails
 * midway used to leave a `sleep` holding a process group and a directory in
 * `/tmp`, so the next reader of a failure was also debugging the litter from
 * the last one. Managers are shut down after each test and the directories go
 * at the end — after, not during, because a manager still draining a group
 * needs its cwd to exist.
 */
const managers: RunManager[] = [];
const tempDirs: string[] = [];

function runManager(...args: ConstructorParameters<typeof RunManager>): RunManager {
  const manager = new RunManager(...args);
  managers.push(manager);
  return manager;
}

afterEach(async () => {
  while (managers.length) {
    try {
      await managers.pop()!.shutdown();
    } catch {
      /* a manager that already failed is not a second failure */
    }
  }
});

afterAll(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});


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

/**
 * The ceiling on one wait, NOT a performance assertion. Every signal in this
 * file is scheduler-bound — a shell spawning, a shell exiting, a process group
 * draining — and when this machine is idle they all arrive in well under a
 * second (the group-drain verdict below measures at ~165 ms, which is its
 * `groupDrainMs` plus scheduling). The budget is two orders of magnitude above
 * that on purpose, so that reaching it means something is WEDGED rather than
 * that the runner was busy.
 *
 * SIZING THIS UP DOES NOT FIX #266, and was never going to: the orphan test
 * below stalls because the manager sometimes never receives the shell's `exit`
 * event at all, so the run sits at `running` for as long as anything cares to
 * wait — 34 s, in the measurement on that issue. A budget only decides how long
 * the suite takes to notice.
 */
const SETTLE_MS = 10_000;

/** A test's own timeout, with room for `waits` of them to expire and still report. */
const settling = (waits = 1) => waits * SETTLE_MS + 10_000;

/**
 * Poll for a signal and SAY WHAT WAS MISSING if it never comes. The old shape,
 * `expect(await until(…)).toBe(true)`, failed as "expected true, got false" —
 * which reads like a blown assertion and cost two sessions the time to work out
 * that it was a timeout. Throwing names the wait, how long it got, and how many
 * times it actually managed to look.
 */
async function until(what: string, predicate: () => boolean, ms = SETTLE_MS): Promise<void> {
  const started = Date.now();
  let polls = 0;
  while (Date.now() - started < ms) {
    polls += 1;
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (predicate()) return;
  throw new Error(`waited ${Date.now() - started}ms over ${polls} polls for ${what}, and it never happened`);
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
  const manager = runManager({ groupDrainMs: 150 });
  const run = await manager.start(input(temp("tree"), config("sleep 30 &")));
  const pid = manager.run(run.runId).pid;
  try {
    // THIS WAIT IS STILL FLAKY, AND THE FLAKE IS NOT THE BUDGET (#266). The
    // chain is: the shell is scheduled, backgrounds its child, exits, that exit
    // is delivered to us, and only then does the manager spend `groupDrainMs`
    // asking the group whether anything is left. Idle, it completes in ~165 ms.
    //
    // It failed 3 times in ~130 local runs while this machine was busy with
    // other bun processes, and each time the run was still `running` with the
    // shell already dead and reaped — the surviving `sleep` reparented to ppid
    // 1 — meaning the manager never received the shell's `exit` event at all.
    // One was watched for 34 s and never got a verdict, and `shutdown()` then
    // hangs waiting for the same thing, which is the afterEach hook timeout
    // that rides along with this failure. CI's 6.2 s failures are that stall
    // meeting the 6 s budget this wait used to have. It did not reproduce in
    // 70 consecutive runs afterwards, 20 of them under a load average of 11,
    // so the trigger is not plain CPU contention and is not yet pinned.
    await until("the surviving child to keep the run from settling clean", () => manager.run(run.runId).status === "unknown");
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
}, settling());

test("stopping a run whose child ignores SIGTERM reports unknown rather than success", async () => {
  // The parent has the default disposition and dies on TERM; the child traps it
  // and does not. The old code called that a clean stop, because the handle it
  // was watching had closed.
  const manager = runManager({ groupDrainMs: 200, stopGraceMs: 1500 });
  // The loop matters: `trap` protects the shell, not the `sleep` it is waiting
  // on, so a child that means to survive has to keep going after that dies.
  const run = await manager.start(input(temp("tree"), config(`sh -c 'trap "" TERM; echo armed; while :; do sleep 1; done' & wait`)));
  const pid = manager.run(run.runId).pid;
  try {
    // Wait for the trap to actually be installed: a TERM that arrives while the
    // child is still starting kills it, and would test nothing.
    await until('the child to print "armed", proving its TERM trap is installed', () =>
      manager.output(run.runId).lines.some((line) => line.text === "armed"),
    );
    await expect(manager.stop(run.runId)).rejects.toThrow(/lost contact/);
    expect(manager.run(run.runId).status).toBe("unknown");
  } finally {
    reap(pid);
    await manager.shutdown();
  }
  // Two waits' worth: the `armed` poll, then `stop`'s own grace period.
}, settling(2));

test("an ordinary run still exits cleanly — the group check does not make everything unknown", async () => {
  const manager = runManager({ groupDrainMs: 200 });
  const run = await manager.start(input(temp("tree"), config("echo done")));
  try {
    await until("the ordinary run to be reported as exited", () => manager.run(run.runId).status === "exited");
    expect(manager.run(run.runId).exitCode).toBe(0);
    expect(manager.activeRun("proj_1")).toBeUndefined();
  } finally {
    await manager.shutdown();
  }
}, settling());

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

  const manager = runManager({ journal });
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
  const manager = runManager({ journal: new RunJournalFile(dir), groupDrainMs: 100 });
  const run = await manager.start(input(temp("tree"), config("echo hi")));
  try {
    await until("the run to exit, which is what closes its journal record", () => manager.run(run.runId).status === "exited");
    expect(new RunJournalFile(dir).list()).toHaveLength(0);
  } finally {
    await manager.shutdown();
  }
}, settling());

// ── shutting down mid-launch ───────────────────────────────────────────────

test("a start still probing when shutdown arrives never spawns anything", async () => {
  const tree = temp("tree");
  const marker = path.join(tree, "spawned");
  let release!: (value: RunProbeResult) => void;
  const deferred = new Promise<RunProbeResult>((resolve) => {
    release = resolve;
  });

  const manager = runManager({ probe: () => deferred });
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

  const manager = runManager({ probe: () => deferred });
  const starting = manager.start(input(tree, config("echo hi", { cwd: "gone", readinessUrl: "http://localhost:65011" })));

  // The directory passes validation and is gone by the time the shell is asked
  // to start in it — the window an unhandled `error` event used to live in.
  await new Promise((resolve) => setTimeout(resolve, 50));
  fs.rmSync(doomed, { recursive: true, force: true });
  release({ answered: false, serving: false });

  const view = await starting;
  await until("the spawn failure to be reported", () => manager.run(view.runId).status === "failed");
  expect(manager.activeRun("proj_1")).toBeUndefined();
  await manager.shutdown();
}, settling());

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
  const manager = runManager({ groupDrainMs: 100 });
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
  const manager = runManager({ groupDrainMs: 100 });
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
    await until("the unbuffered run to exit", () => manager.run(run.runId).status === "exited");
    // `exit` can beat the last `data` events out of the pipe, so the captured
    // output is not complete just because the process is gone. Waiting on the
    // status alone made this assertion fail on a loaded machine — which is a
    // flaky test, not a flaky splitter.
    await until("the pipe to deliver the output the exit raced", () => manager.output(run.runId).lines.length > 1);
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
}, settling(2));

// ── the working directory really is inside the tree ────────────────────────

test("a working directory that is a symlink out of the worktree is refused", async () => {
  const tree = temp("tree");
  const outside = temp("outside");
  fs.symlinkSync(outside, path.join(tree, "escape"));

  const manager = runManager();
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
  const manager = runManager({
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
