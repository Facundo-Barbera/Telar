import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TASK_OUTPUT_TAIL_BYTES, readTaskOutput, resolveTaskOutputFile, taskOutputFileFrom } from "../src/task-output";

/** A temp root laid out the way Claude Code lays out its own. */
function claudeRoot(): { root: string; tasks: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "telar-task-output-")));
  const tasks = path.join(root, "-Users-me-project", "session-1", "tasks");
  fs.mkdirSync(tasks, { recursive: true });
  return { root, tasks };
}

test("the path is read out of a backgrounded Bash result, as Claude Code words it", () => {
  const text =
    "Command running in background with ID: bo7nb5zjq. Output is being written to: /private/tmp/claude-502/-Volumes-HD-live/238c/tasks/bo7nb5zjq.output. You will be notified when it completes.";
  expect(taskOutputFileFrom(text)).toBe("/private/tmp/claude-502/-Volumes-HD-live/238c/tasks/bo7nb5zjq.output");
  expect(taskOutputFileFrom("Output is being written to: /tmp/x/tasks/a.output")).toBe("/tmp/x/tasks/a.output");
  expect(taskOutputFileFrom("hello")).toBeUndefined();
  // Relative paths are not a statement of where anything is.
  expect(taskOutputFileFrom("Output is being written to: tasks/a.output.")).toBeUndefined();
});

test("only a task's own log under Claude's temp root resolves", () => {
  const { root, tasks } = claudeRoot();
  const file = path.join(tasks, "b1.output");
  fs.writeFileSync(file, "hi\n");
  expect(resolveTaskOutputFile(file, "b1", [root])).toBe(file);
  // Another task's file, a file outside the root, a file with no provider id.
  expect(resolveTaskOutputFile(file, "b2", [root])).toBeUndefined();
  expect(resolveTaskOutputFile(file, "b1", ["/somewhere/else"])).toBeUndefined();
  expect(resolveTaskOutputFile(file, undefined, [root])).toBeUndefined();
  // `..` cannot climb out: the directory is resolved before the root check.
  expect(resolveTaskOutputFile(path.join(tasks, "..", "..", "..", "..", "etc", "tasks", "b1.output"), "b1", [root])).toBeUndefined();
  // A symlink is refused — an agent's `.output` is one, pointing at its transcript.
  const secret = path.join(root, "secret.txt");
  fs.writeFileSync(secret, "no");
  fs.symlinkSync(secret, path.join(tasks, "b3.output"));
  expect(resolveTaskOutputFile(path.join(tasks, "b3.output"), "b3", [root])).toBeUndefined();
  // A log not written yet still resolves; the read answers `missing`.
  expect(resolveTaskOutputFile(path.join(tasks, "b4.output"), "b4", [root])).toBe(path.join(tasks, "b4.output"));
});

test("reads page from a byte cursor, and a missing file says so", async () => {
  const { tasks } = claudeRoot();
  const file = path.join(tasks, "b1.output");
  expect(await readTaskOutput(file)).toMatchObject({ missing: true, text: "" });
  fs.writeFileSync(file, "one\n");
  const first = await readTaskOutput(file);
  expect(first).toMatchObject({ text: "one\n", cursor: 4, truncated: false, more: false, missing: false });
  fs.appendFileSync(file, "two\n");
  expect(await readTaskOutput(file, first.cursor)).toMatchObject({ text: "two\n", cursor: 8 });
  // Nothing new is an empty page, not an error.
  expect(await readTaskOutput(file, 8)).toMatchObject({ text: "", cursor: 8, more: false });
});

test("a long log opens at its tail, on a whole line", async () => {
  const { tasks } = claudeRoot();
  const file = path.join(tasks, "b1.output");
  const line = "x".repeat(99) + "\n";
  fs.writeFileSync(file, line.repeat(Math.ceil((TASK_OUTPUT_TAIL_BYTES * 2) / line.length)));
  const page = await readTaskOutput(file);
  expect(page.truncated).toBe(true);
  expect(page.cursor).toBe(page.size);
  expect(page.text.length).toBeLessThanOrEqual(TASK_OUTPUT_TAIL_BYTES);
  expect(page.text.startsWith("x".repeat(99) + "\n")).toBe(true);
});

test("a page never ends inside a UTF-8 character", async () => {
  const { tasks } = claudeRoot();
  const file = path.join(tasks, "b1.output");
  const bytes = Buffer.from("héllo", "utf8");
  // Half of "é" is on disk; the other half not yet.
  fs.writeFileSync(file, bytes.subarray(0, 2));
  const partial = await readTaskOutput(file);
  expect(partial).toMatchObject({ text: "h", cursor: 1, more: false });
  fs.writeFileSync(file, bytes);
  expect(await readTaskOutput(file, partial.cursor)).toMatchObject({ text: "éllo", cursor: bytes.length });
});

test("a cursor past the end means the file was rewritten, so the read starts over", async () => {
  const { tasks } = claudeRoot();
  const file = path.join(tasks, "b1.output");
  fs.writeFileSync(file, "fresh\n");
  expect(await readTaskOutput(file, 500)).toMatchObject({ text: "fresh\n", cursor: 6 });
});
