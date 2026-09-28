import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { StorageCategory } from "@telar/engine-client";
import { measureStorage } from "./measure";

let root: string;

const write = (relative: string, bytes: number) => {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, Buffer.alloc(bytes, 7));
};

const bytesOf = (report: Awaited<ReturnType<typeof measureStorage>>, category: string) =>
  report.entries.find((entry) => entry.category === category)?.bytes ?? 0;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-storage-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("what Telar is keeping", () => {
  test("every byte under the root lands in exactly one category, and they sum to the total", async () => {
    write("sessions/a/transcript.json", 64 * 1024);
    write("execution.sqlite", 256 * 1024);
    write("execution.sqlite-wal", 32 * 1024);
    write("python/bin/python", 16 * 1024);
    write("projects.json", 4 * 1024);
    write("usage-scan-cache.json", 48 * 1024);
    write("worktrees/one/file.ts", 8 * 1024);
    write("something-new.bin", 12 * 1024);

    const report = await measureStorage({ root, worktreesRoot: path.join(root, "worktrees") });

    expect(report.total).toBe(report.entries.reduce((sum, entry) => sum + entry.bytes, 0));
    expect(report.entries.map((entry) => entry.category).sort()).toEqual(
      (["journal", "other", "python", "sessions", "settings", "usage", "worktrees"] satisfies StorageCategory[]).sort(),
    );
    expect(report.partial).toBe(false);
    expect(bytesOf(report, "other")).toBeGreaterThan(0);
  });

  test("the WAL is the journal's, not a row of its own", async () => {
    write("execution.sqlite", 128 * 1024);
    write("execution.sqlite-wal", 64 * 1024);
    write("execution.sqlite-shm", 8 * 1024);

    const report = await measureStorage({ root, worktreesRoot: path.join(root, "worktrees") });

    expect(report.entries.map((entry) => entry.category)).toEqual(["journal"]);
    expect(bytesOf(report, "journal")).toBeGreaterThanOrEqual(192 * 1024);
  });

  test("Reveal lands on the database itself, not merely on the folder it is in", async () => {
    write("execution.sqlite", 4 * 1024);
    const report = await measureStorage({ root, worktreesRoot: path.join(root, "worktrees") });
    const journal = report.entries.find((entry) => entry.category === "journal");
    expect(journal?.kind).toBe("file");
    expect(journal?.path).toBe(path.join(root, "execution.sqlite"));
  });

  test("a directory category opens its own folder", async () => {
    write("sessions/a/transcript.json", 4 * 1024);
    const report = await measureStorage({ root, worktreesRoot: path.join(root, "worktrees") });
    const sessions = report.entries.find((entry) => entry.category === "sessions");
    expect(sessions).toMatchObject({ kind: "directory", path: path.join(root, "sessions") });
  });

  test("the biggest category is first, because it is the one nobody knew about", async () => {
    write("sessions/a.json", 8 * 1024);
    write("execution.sqlite", 512 * 1024);
    write("worktrees/one/file.ts", 64 * 1024);

    const report = await measureStorage({ root, worktreesRoot: path.join(root, "worktrees") });

    expect(report.entries.map((entry) => entry.category)).toEqual(["journal", "worktrees", "sessions"]);
  });

  test("a worktrees root OUTSIDE the store is measured and reported all the same", async () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "telar-checkouts-"));
    try {
      fs.mkdirSync(path.join(elsewhere, "one"), { recursive: true });
      fs.writeFileSync(path.join(elsewhere, "one", "file.ts"), Buffer.alloc(32 * 1024, 7));
      write("sessions/a.json", 4 * 1024);

      const report = await measureStorage({ root, worktreesRoot: elsewhere });

      expect(bytesOf(report, "worktrees")).toBeGreaterThan(0);
      expect(report.entries.find((entry) => entry.category === "worktrees")?.path).toBe(path.resolve(elsewhere));
      expect(report.total).toBe(report.entries.reduce((sum, entry) => sum + entry.bytes, 0));
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test("during a move, BOTH roots count as checkouts — the row is about disk, not bookkeeping", async () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "telar-newroot-"));
    try {
      fs.mkdirSync(path.join(elsewhere, "new"), { recursive: true });
      fs.writeFileSync(path.join(elsewhere, "new", "file.ts"), Buffer.alloc(32 * 1024, 7));
      write("worktrees/old/file.ts", 64 * 1024);

      const report = await measureStorage({ root, worktreesRoot: elsewhere, alsoWorktrees: [path.join(root, "worktrees")] });

      expect(report.entries.map((entry) => entry.category)).toEqual(["worktrees"]);
      expect(bytesOf(report, "worktrees")).toBeGreaterThanOrEqual(96 * 1024);
      expect(report.total).toBe(bytesOf(report, "worktrees"));
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test("a second root that is the same root is not counted twice", async () => {
    write("worktrees/one/file.ts", 64 * 1024);
    const both = await measureStorage({ root, worktreesRoot: path.join(root, "worktrees"), alsoWorktrees: [path.join(root, "worktrees")] });
    const once = await measureStorage({ root, worktreesRoot: path.join(root, "worktrees") });
    expect(both.total).toBe(once.total);
  });

  test("checkouts are counted once, not twice, when their root is inside the store", async () => {
    write("worktrees/one/file.ts", 128 * 1024);
    const report = await measureStorage({ root, worktreesRoot: path.join(root, "worktrees") });
    expect(report.entries.map((entry) => entry.category)).toEqual(["worktrees"]);
    expect(report.total).toBe(bytesOf(report, "worktrees"));
  });

  test("a symlink is never followed, so a link into a project never becomes Telar's footprint", async () => {
    const foreign = fs.mkdtempSync(path.join(os.tmpdir(), "telar-foreign-"));
    try {
      fs.writeFileSync(path.join(foreign, "big.bin"), Buffer.alloc(1024 * 1024, 7));
      fs.mkdirSync(path.join(root, "sessions"), { recursive: true });
      fs.symlinkSync(foreign, path.join(root, "sessions", "link"));

      const report = await measureStorage({ root, worktreesRoot: path.join(root, "worktrees") });

      expect(report.total).toBeLessThan(1024 * 1024);
    } finally {
      fs.rmSync(foreign, { recursive: true, force: true });
    }
  });

  test("a hard link is counted once — the rows may not add up to more disk than exists", async () => {
    write("sessions/original.bin", 512 * 1024);
    fs.linkSync(path.join(root, "sessions", "original.bin"), path.join(root, "sessions", "same-file.bin"));

    const report = await measureStorage({ root, worktreesRoot: path.join(root, "worktrees") });

    expect(bytesOf(report, "sessions")).toBeLessThan(1024 * 1024);
  });

  test("an empty store measures zero rather than failing", async () => {
    const report = await measureStorage({ root, worktreesRoot: path.join(root, "worktrees") });
    expect(report).toMatchObject({ total: 0, entries: [], partial: false });
    expect(report.root).toBe(path.resolve(root));
  });

  test("a root that does not exist is reported, not thrown", async () => {
    const missing = path.join(root, "gone");
    const report = await measureStorage({ root: missing, worktreesRoot: path.join(missing, "worktrees") });
    expect(report.total).toBe(0);
    expect(report.partial).toBe(true);
  });

  test("the answer carries the moment it was taken, which is what the pane shows", async () => {
    write("projects.json", 1024);
    let first = true;
    const clock = spyOn(Date, "now").mockImplementation(() => {
      const at = first ? 1_000 : 1_250;
      first = false;
      return at;
    });
    try {
      const report = await measureStorage({ root, worktreesRoot: path.join(root, "worktrees"), now: 1_700_000_000_000 });
      expect(report.measuredAt).toBe(1_700_000_000_000);
      expect(report.tookMs).toBe(250);
    } finally {
      clock.mockRestore();
    }
  });

  test("nothing is written to the store it measures", async () => {
    write("projects.json", 1024);
    write("sessions/a.json", 1024);
    const before = fs.readdirSync(root).sort();
    const sessionsBefore = fs.readdirSync(path.join(root, "sessions")).sort();

    await measureStorage({ root, worktreesRoot: path.join(root, "worktrees") });

    expect(fs.readdirSync(root).sort()).toEqual(before);
    expect(fs.readdirSync(path.join(root, "sessions")).sort()).toEqual(sessionsBefore);
  });
});
