import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AsyncGitRunner, GitResult } from "../../platform/git/runner";
import { FolderStatus } from "./folder-status";

let clock = 0;
let folder = "";
beforeEach(() => {
  jest.useFakeTimers();
  clock = 1_000;
  folder = fs.mkdtempSync(path.join(os.tmpdir(), "telar-status-"));
});
afterEach(() => {
  jest.useRealTimers();
  fs.rmSync(folder, { recursive: true, force: true });
});

function fakeGit(stdout = "# branch.oid abc\0") {
  const runs: string[] = [];
  let answer: GitResult = { status: 0, stdout, stderr: "" };
  let hold: Promise<void> | undefined;
  const git: AsyncGitRunner = async (cwd, args) => {
    runs.push(`${cwd} ${args.join(" ")}`);
    if (hold) await hold;
    return answer;
  };
  return {
    git,
    runs,
    answer: (next: string) => (answer = { status: 0, stdout: next, stderr: "" }),
    hold: () => {
      let release = () => {};
      hold = new Promise((resolve) => (release = resolve));
      return () => {
        hold = undefined;
        release();
      };
    },
  };
}

const flush = async () => {
  for (let index = 0; index < 5; index++) await Promise.resolve();
};

test("every reader of one folder shares one git status", async () => {
  const fake = fakeGit("# branch.oid abc\0" + "1 .M N... 100644 100644 100644 a b a.ts\0? b.ts\0");
  const status = new FolderStatus(fake.git, () => clock);
  const release = fake.hold();
  const together = [status.read(folder), status.read(folder)];
  release();
  const [one, two] = await Promise.all(together);
  expect(one).toEqual(two);
  expect(one!.dirtyFiles).toBe(2);
  expect(await status.read(folder)).toEqual(one!);
  expect(fake.runs).toEqual([`${folder} status --porcelain=v2 --branch -z`]);
});

test("a stale folder is recomputed, but not sooner than three seconds after the last run", async () => {
  const fake = fakeGit();
  const status = new FolderStatus(fake.git, () => clock);
  const first = await status.read(folder);
  fake.answer("# branch.oid abc\0? new.ts\0");
  status.markStaleUnder(folder);
  clock += 1_000;
  const pending = status.read(folder);
  await flush();
  expect(fake.runs).toHaveLength(1);
  clock += 2_000;
  jest.advanceTimersByTime(2_000);
  const second = await pending;
  expect(fake.runs).toHaveLength(2);
  expect(second.dirtyFiles).toBe(1);
  expect(second.etag).not.toBe(first.etag);
});

test("an unchanged folder keeps its tag, and an old entry is read again", async () => {
  const fake = fakeGit();
  const status = new FolderStatus(fake.git, () => clock);
  const first = await status.read(folder);
  clock += 11_000;
  expect((await status.read(folder)).etag).toBe(first.etag);
  expect(fake.runs).toHaveLength(2);
});

test("a second edit to a file already listed as modified changes the tag", async () => {
  fs.writeFileSync(path.join(folder, "a.ts"), "one");
  const fake = fakeGit("# branch.oid abc\0" + "1 .M N... 100644 100644 100644 a b a.ts\0");
  const status = new FolderStatus(fake.git, () => clock);
  const first = await status.read(folder);
  fs.writeFileSync(path.join(folder, "a.ts"), "one, then two");
  status.markStaleUnder(folder);
  clock += 3_000;
  const second = await status.read(folder);
  expect(second.dirtyFiles).toBe(first.dirtyFiles!);
  expect(second.etag).not.toBe(first.etag);
});

test("a change marked while a run is in flight is not lost to that run's answer", async () => {
  const fake = fakeGit();
  const status = new FolderStatus(fake.git, () => clock);
  const release = fake.hold();
  const running = status.read(folder);
  await flush();
  status.markStaleUnder(folder);
  release();
  await running;
  clock += 3_000;
  await status.read(folder);
  expect(fake.runs).toHaveLength(2);
});

test("a folder git cannot read answers no count", async () => {
  const status = new FolderStatus(async () => ({ status: 128, stdout: "", stderr: "fatal" }), () => clock);
  expect((await status.read(folder)).dirtyFiles).toBeUndefined();
});
