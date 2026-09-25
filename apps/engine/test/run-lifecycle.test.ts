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
  sessionId: "sess_a",
  config: cfg,
  worktreePath: tree,
  ...extra,
});

/**
 * The ceiling on one wait, NOT a performance assertion. Every signal in this
 * file is scheduler-bound — a shell spawning, a shell exiting, a group being
 * closed — and when this machine is idle they all arrive in well under a
 * second. The budget is two orders of magnitude above that on purpose, so that
 * reaching it means something is WEDGED rather than that the runner was busy.
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

// ── the shell dying, and what Telar does NOT do about it ───────────────────

test("a shell that exits leaving a child behind is recorded as the exit it was, and blocks nothing", async () => {
  /**
   * `cmd &` returns 0 at once with the real process still running. This used
   * to be asked about — the group probed for survivors, the run held
   * `unknown` with the project's slot — and it is not any more: Telar does not
   * track liveness. The record says what was observed (the shell exited 0),
   * and the next start goes ahead. On the desktop the terminal stays open
   * around the survivor and closing it ends it; the pipe fallback has no
   * terminal, which is the honest limit of running without one.
   */
  const tree = temp("tree");
  const manager = runManager();
  const run = await manager.start(input(tree, config("sleep 30 & echo $! > child.pid")));
  const pidFile = path.join(tree, "child.pid");
  let child: number | undefined;
  try {
    await until("the shell to exit", () => manager.run(run.terminalId).status === "exited");
    await until("the child's pid to be written", () => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim().length > 0);
    child = Number(fs.readFileSync(pidFile, "utf8").trim());
    expect(manager.run(run.terminalId).exitCode).toBe(0);
    const next = await manager.start(input(tree, config("sleep 1")));
    expect(next.status).toBe("running");
  } finally {
    reap(child);
    await manager.shutdown();
  }
}, settling(2));

test("closing a terminal whose child ignores SIGTERM ends the child too, and records the close", async () => {
  /**
   * The parent dies on TERM; the child traps it. The shell's exit inside the
   * grace is when the group is asked, ONCE, whether it is empty — and it is
   * not, so SIGKILL follows. The same rule the desktop host's close follows.
   */
  const tree = temp("tree");
  const manager = runManager({ stopGraceMs: 500 });
  // The loop matters: `trap` protects the shell, not the `sleep` it is waiting
  // on, so a child that means to survive has to keep going after that dies.
  const run = await manager.start(input(tree, config(`sh -c 'trap "" TERM; echo armed; echo $$ > child.pid; while :; do sleep 1; done' & wait`)));
  const pid = manager.run(run.terminalId).pid;
  const pidFile = path.join(tree, "child.pid");
  let child: number | undefined;
  try {
    // Wait for the trap to actually be installed: a TERM that arrives while the
    // child is still starting kills it, and would test nothing.
    await until('the child to print "armed", proving its TERM trap is installed', () =>
      manager.output(run.terminalId).lines.some((line) => line.text === "armed") && fs.existsSync(pidFile),
    );
    child = Number(fs.readFileSync(pidFile, "utf8").trim());
    const closed = await manager.close(run.terminalId, "person");
    expect(closed.status).toBe("closed");
    expect(closed.closedBy).toBe("person");
    await until("the trapping child to be gone", () => {
      try {
        process.kill(child!, 0);
        return false;
      } catch {
        return true;
      }
    });
  } finally {
    reap(pid);
    reap(child);
    await manager.shutdown();
  }
  // Two waits' worth: the `armed` poll, then the close's own grace.
}, settling(2));

test("an ordinary run still exits cleanly", async () => {
  const manager = runManager();
  const run = await manager.start(input(temp("tree"), config("echo done")));
  try {
    await until("the ordinary run to be reported as exited", () => manager.run(run.terminalId).status === "exited");
    expect(manager.run(run.terminalId).exitCode).toBe(0);
    expect(manager.run(run.terminalId).closedBy).toBeUndefined();
  } finally {
    await manager.shutdown();
  }
}, settling());

// ── surviving the daemon ───────────────────────────────────────────────────

test("the pipe fallback writes no name tag — there is no host to keep its terminal across a restart", async () => {
  const dir = temp("journal");
  const manager = runManager({ journal: new RunJournalFile(dir) });
  const run = await manager.start(input(temp("tree"), config("sleep 5")));
  try {
    expect(run.status).toBe("running");
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

test("a spawn that fails outright is reported as failed", async () => {
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
  await until("the spawn failure to be reported", () => manager.run(view.terminalId).status === "failed");
  expect(manager.run(view.terminalId).pid).toBeUndefined();
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
  const manager = runManager();
  const run = await manager.start(
    input(
      temp("tree"),
      config('echo "auth sk_live_secret"', { name: "curl sk_live_secret", env: [{ key: "TOKEN", value: "sk_live_secret", secret: true }] }),
    ),
  );
  try {
    const view = manager.run(run.terminalId);
    expect(view.command).not.toContain("sk_live_secret");
    expect(view.command).toContain("«redacted»");
    expect(view.configName).not.toContain("sk_live_secret");
    expect(JSON.stringify(view)).not.toContain("sk_live_secret");
  } finally {
    await manager.shutdown();
  }
}, 15_000);

test("a run that never emits a newline is still bounded, and still scrubbed", async () => {
  const manager = runManager();
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
    await until("the unbuffered run to exit", () => manager.run(run.terminalId).status === "exited");
    // `exit` can beat the last `data` events out of the pipe, so the captured
    // output is not complete just because the process is gone. Waiting on the
    // status alone made this assertion fail on a loaded machine — which is a
    // flaky test, not a flaky splitter.
    await until("the pipe to deliver the output the exit raced", () => manager.output(run.terminalId).lines.length > 1);
    const output = manager.output(run.terminalId);
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
    
    probe: async () => (up ? { answered: true, serving: false } : { answered: false, serving: false }),
  });
  const run = await manager.start(input(temp("tree"), config("sleep 5", { readinessUrl: "http://localhost:65012" })));
  try {
    up = true;
    await new Promise((resolve) => setTimeout(resolve, 150));
    // A crashing dev server answers every request; it is the state the human is
    // waiting to leave, so the run stays `running` and readiness stays pending.
    expect(manager.run(run.terminalId).status).toBe("running");
    expect(manager.run(run.terminalId).readiness.kind).toBe("pending");
  } finally {
    await manager.shutdown();
  }
}, 15_000);
