/**
 * What happens when the durable record itself misbehaves.
 *
 * The journal exists so a crashed daemon cannot lose a running server. That only
 * holds if the failures AROUND it fail in the safe direction: an unreadable file
 * must not read as "nothing is running", a write that fails must not disown a
 * live child, and an exit must never be mistaken for a group that has finished.
 * Every fixture is a temp directory and a process killed in a `finally`.
 */
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunJournalFile, RunJournalUnreadable, type RunJournal, type RunRecord } from "../src/run/journal";
import { RunManager, type StartRunInput } from "../src/run/manager";
import type { RunConfiguration } from "../src/run/types";

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

const input = (tree: string, cfg: RunConfiguration): StartRunInput => ({ projectId: "proj_1", config: cfg, worktreePath: tree });

const record = (extra: Partial<RunRecord> = {}): RunRecord => ({
  runId: "run_old",
  projectId: "proj_1",
  configId: "runcfg_test",
  configName: "fixture",
  command: "sleep 30",
  worktreePath: "/tmp/tree",
  cwd: "/tmp/tree",
  startedAt: 1,
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

function reap(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

// ── an unreadable journal is not an empty one ──────────────────────────────

test("a missing journal is empty; every other read failure is refused", () => {
  const dir = temp("journal-missing");
  expect(new RunJournalFile(dir).list()).toEqual([]);

  // Anything but ENOENT means the records may exist and be hidden from us —
  // the one case where answering "empty" would let a second server launch.
  const blocked = temp("journal-eisdir");
  fs.mkdirSync(path.join(blocked, "open-runs.json"));
  expect(() => new RunJournalFile(blocked).list()).toThrow(RunJournalUnreadable);
});

test("a corrupt journal is refused AND left on disk, rather than overwritten", () => {
  const dir = temp("journal-corrupt");
  const file = path.join(dir, "open-runs.json");
  fs.writeFileSync(file, '{"runs": [{"runId": "run_old", "projec');
  const journal = new RunJournalFile(dir);

  expect(() => journal.list()).toThrow(/not valid JSON/);
  // `open()` reads before it writes, so a silent read would have destroyed the
  // only evidence of what was running.
  expect(() => journal.open(record())).toThrow(RunJournalUnreadable);
  expect(fs.readFileSync(file, "utf8")).toBe('{"runs": [{"runId": "run_old", "projec');
  expect(() => journal.close("run_old")).toThrow(RunJournalUnreadable);
});

test("an entry that is not a record is refused, not quietly dropped", () => {
  const dir = temp("journal-entry");
  const file = path.join(dir, "open-runs.json");
  // Dropping this would free the slot the record was written to hold.
  fs.writeFileSync(file, JSON.stringify({ runs: [record(), { runId: "run_two", projectId: "proj_1" }] }));
  expect(() => new RunJournalFile(dir).list()).toThrow(/malformed/);

  fs.writeFileSync(file, JSON.stringify({ runs: [{ ...record(), startedAt: "yesterday" }] }));
  expect(() => new RunJournalFile(dir).list()).toThrow(/startedAt/);

  fs.writeFileSync(file, JSON.stringify({ runs: [{ ...record(), pid: "1234" }] }));
  expect(() => new RunJournalFile(dir).list()).toThrow(/pid/);

  fs.writeFileSync(file, JSON.stringify({ runs: "none" }));
  expect(() => new RunJournalFile(dir).list()).toThrow(/list of runs/);
});

test("a manager whose journal cannot be read refuses to start anything, and says why", async () => {
  const dir = temp("journal-fault");
  fs.writeFileSync(path.join(dir, "open-runs.json"), "not json at all");
  const manager = new RunManager({ journal: new RunJournalFile(dir) });

  // It does not throw: one bad file must not stop the daemon booting.
  expect(manager.recover()).toEqual([]);
  // It fails closed on the one verb that could collide with whatever the file
  // was describing, and the message says what to do about it.
  await expect(manager.start(input(temp("tree"), config("echo hi")))).rejects.toThrow(/cannot read its record/);
  await expect(manager.start(input(temp("tree"), config("echo hi")))).rejects.toThrow(/still alive/);
  // Reading is untouched.
  expect(manager.activeRun("proj_1")).toBeUndefined();
  await manager.shutdown();
});

// ── a failed write never disowns a live child ──────────────────────────────

/** A journal that throws on the Nth `open` (1-based), or on `close`. */
function faultyJournal(fault: { openCall?: number; onClose?: boolean }): RunJournal & { opens: number; closes: number } {
  const runs = new Map<string, RunRecord>();
  return {
    opens: 0,
    closes: 0,
    open(entry: RunRecord) {
      this.opens += 1;
      if (this.opens === fault.openCall) throw new Error("disk is full");
      runs.set(entry.runId, entry);
    },
    close(runId: string) {
      this.closes += 1;
      if (fault.onClose) throw new Error("disk is full");
      runs.delete(runId);
    },
    list: () => [...runs.values()],
  };
}

test("a journal write that fails BEFORE the spawn fails the launch, with nothing left running", async () => {
  const journal = faultyJournal({ openCall: 1 });
  const manager = new RunManager({ journal });
  const tree = temp("tree");

  await expect(manager.start(input(tree, config("sleep 30")))).rejects.toThrow(/disk is full/);
  // Nothing was spawned, so the slot is the one thing that must NOT be held.
  expect(manager.activeRun("proj_1")).toBeUndefined();
  const [view] = manager.history("proj_1");
  expect(view?.status).toBe("failed");
  expect(view?.pid).toBeUndefined();
  await manager.shutdown();
});

test("a journal write that fails AFTER the spawn keeps the run — the child is already alive", async () => {
  // The old code called `finish(failed)` here: the slot was freed and the next
  // start would have launched a second server next to this one.
  const journal = faultyJournal({ openCall: 2 });
  const manager = new RunManager({ journal });
  const run = await manager.start(input(temp("tree"), config("sleep 30")));
  const pid = manager.run(run.runId).pid;
  try {
    expect(manager.run(run.runId).status).toBe("running");
    expect(pid).toBeGreaterThan(0);
    expect(manager.activeRun("proj_1")?.runId).toBe(run.runId);
    // The loss is reported rather than hidden: what a crash could no longer tell
    // the human is the pid, and that is what the note says.
    expect(manager.output(run.runId).lines.some((line) => /Telar: this run's process id could not be written/.test(line.text))).toBe(true);
    // And the pre-spawn record is still there to block a restarted daemon.
    expect(journal.list().map((entry) => entry.runId)).toEqual([run.runId]);
  } finally {
    reap(pid);
    await manager.shutdown();
  }
}, 15_000);

test("a journal close that fails does not reject out of an exit handler", async () => {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);
  const manager = new RunManager({ journal: faultyJournal({ onClose: true }), groupDrainMs: 100 });
  try {
    const run = await manager.start(input(temp("tree"), config("echo done")));
    expect(await until(() => manager.run(run.runId).status === "exited")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(rejections).toEqual([]);
    // The record stays open, which is the safe direction: the next daemon asks.
    expect(manager.activeRun("proj_1")).toBeUndefined();
  } finally {
    process.off("unhandledRejection", onRejection);
    await manager.shutdown();
  }
}, 15_000);

// ── an exit is evidence about the shell, never about the group ─────────────

test("a stop whose signal is refused stays blocked when the shell dies and a child does not", async () => {
  // EPERM on the way out, then the parent goes anyway: the old settle() read
  // that exit as "accounted for" and handed the project's slot back while a
  // process was still holding the port.
  const manager = new RunManager({
    groupDrainMs: 200,
    stopGraceMs: 1000,
    kill: (pid, signal) => {
      if (signal === 0) {
        process.kill(pid, 0);
        return;
      }
      const error = new Error("operation not permitted") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    },
  });
  const run = await manager.start(input(temp("tree"), config(`sh -c 'echo armed; while :; do sleep 1; done' & wait`)));
  const pid = manager.run(run.runId).pid;
  try {
    expect(await until(() => manager.output(run.runId).lines.some((line) => line.text === "armed"))).toBe(true);
    await expect(manager.stop(run.runId)).rejects.toThrow(/lost contact/);
    expect(manager.run(run.runId).status).toBe("unknown");

    // The shell exits — but its child is still there in the group.
    process.kill(pid!, "SIGKILL");
    expect(await until(() => manager.run(run.runId).endedAt !== undefined)).toBe(true);

    expect(manager.run(run.runId).status).toBe("unknown");
    expect(manager.activeRun("proj_1")?.runId).toBe(run.runId);
    await expect(manager.start(input(temp("tree"), config("echo hi")))).rejects.toThrow(/lost contact/);
  } finally {
    reap(pid);
    await manager.shutdown();
  }
}, 30_000);
