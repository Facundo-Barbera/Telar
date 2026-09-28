import { afterAll, afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunManager } from "./manager";
import { type StartRunInput } from "./live-run";
import { RunJournalFile } from "./journal";
import { RunConfigurationInput, type RunConfiguration, type RunProbeResult } from "./types";

const temp = (label: string) => track(fs.mkdtempSync(path.join(os.tmpdir(), `telar-run-${label}-`)));

const track = (dir: string): string => (tempDirs.push(dir), dir);
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

const SETTLE_MS = 10_000;

const settling = (waits = 1) => waits * SETTLE_MS + 10_000;

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

function reap(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
  }
}

test("a shell that exits leaving a child behind is recorded as the exit it was, and blocks nothing", async () => {
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
  const tree = temp("tree");
  const manager = runManager({ stopGraceMs: 500 });
  const run = await manager.start(input(tree, config(`sh -c 'trap "" TERM; echo armed; echo $$ > child.pid; while :; do sleep 1; done' & wait`)));
  const pid = manager.run(run.terminalId).pid;
  const pidFile = path.join(tree, "child.pid");
  let child: number | undefined;
  try {
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
  expect(fs.existsSync(marker)).toBe(false);

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

  await new Promise((resolve) => setTimeout(resolve, 50));
  fs.rmSync(doomed, { recursive: true, force: true });
  release({ answered: false, serving: false });

  const view = await starting;
  await until("the spawn failure to be reported", () => manager.run(view.terminalId).status === "failed");
  expect(manager.run(view.terminalId).pid).toBeUndefined();
  await manager.shutdown();
}, settling());

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

test("a working directory that is a symlink out of the worktree is refused", async () => {
  const tree = temp("tree");
  const outside = temp("outside");
  fs.symlinkSync(outside, path.join(tree, "escape"));

  const manager = runManager();
  await expect(manager.start(input(tree, config("pwd", { cwd: "escape" })))).rejects.toThrow(/is a link out of the worktree/);
  fs.mkdirSync(path.join(tree, "real"));
  fs.symlinkSync(path.join(tree, "real"), path.join(tree, "inside"));
  const run = await manager.start(input(tree, config("pwd", { cwd: "inside" })));
  expect(run.status).not.toBe("failed");
  await manager.shutdown();
}, 15_000);

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
    expect(manager.run(run.terminalId).status).toBe("running");
    expect(manager.run(run.terminalId).readiness.kind).toBe("pending");
  } finally {
    await manager.shutdown();
  }
}, 15_000);
