import { expect, test } from "bun:test";
import { JobRunner } from "../src/ds/jobs";

const settle = async (runner: JobRunner, jobId: string) => runner.wait(jobId, 10_000);

test("steps run in order, every line lands in the log, and the result comes from onDone", async () => {
  const runner = new JobRunner();
  const { jobId } = runner.start({
    kind: "t",
    steps: [
      { title: "one", file: "sh", args: ["-c", "echo first; echo err >&2"] },
      { title: "two", file: "sh", args: ["-c", "printf 'no newline'"] },
    ],
    onDone: () => ({ made: true }),
  });
  const read = await settle(runner, jobId);
  expect(read.status).toBe("ok");
  expect(read.result).toEqual({ made: true });
  expect(read.lines[0]).toBe("$ sh -c echo first; echo err >&2");
  // Separate stdout/stderr pipes have no cross-stream arrival ordering.
  expect(read.lines.slice(1, 3).sort()).toEqual(["err", "first"]);
  expect(read.lines.slice(3)).toEqual(["$ sh -c printf 'no newline'", "no newline"]);
  expect(read.cursor).toBe(5);
  expect(read.finishedAt).toBeDefined();
});

test("a failing step stops the chain and names itself; onDone does not run", async () => {
  const runner = new JobRunner();
  let done = false;
  const { jobId } = runner.start({
    kind: "t",
    steps: [
      { title: "Installing seaborn", file: "sh", args: ["-c", "echo nope; exit 3"] },
      { title: "never", file: "sh", args: ["-c", "echo never"] },
    ],
    onDone: () => { done = true; },
  });
  const read = await settle(runner, jobId);
  expect(read.status).toBe("failed");
  expect(read.error).toBe("Installing seaborn failed (exit 3)");
  expect(read.lines).not.toContain("never");
  expect(done).toBe(false);
});

test("reading by cursor returns only new lines; a missing binary is a failure, not a crash", async () => {
  const runner = new JobRunner();
  const { jobId } = runner.start({ kind: "t", steps: [{ title: "a", file: "sh", args: ["-c", "echo a; echo b; echo c"] }] });
  const all = await settle(runner, jobId);
  const tail = runner.read(jobId, all.cursor - 1);
  expect(tail.lines).toEqual(["c"]);
  expect(runner.read(jobId, all.cursor).lines).toEqual([]);

  const missing = runner.start({ kind: "t", steps: [{ title: "ghost", file: "/nonexistent/tool", args: [] }] });
  const failed = await settle(runner, missing.jobId);
  expect(failed.status).toBe("failed");
});

test("cancel kills the running step and marks the job; one lock admits one job at a time", async () => {
  const runner = new JobRunner();
  const { jobId } = runner.start({ kind: "t", lock: "env:1", steps: [{ title: "sleep", file: "sleep", args: ["30"] }] });
  expect(() => runner.start({ kind: "t", lock: "env:1", steps: [] })).toThrow(/already running/);
  await new Promise((resolve) => setTimeout(resolve, 100));
  runner.cancel(jobId);
  const read = await settle(runner, jobId);
  expect(read.status).toBe("cancelled");
  expect(() => runner.read("job_nope")).toThrow(/no such job/);
});

test("the log is a ring buffer: only the last 2000 lines stay, and the cursor still counts from zero", async () => {
  const runner = new JobRunner();
  const { jobId } = runner.start({ kind: "t", steps: [{ title: "many", file: "sh", args: ["-c", "i=0; while [ $i -lt 2500 ]; do echo line$i; i=$((i+1)); done"] }] });
  const read = await settle(runner, jobId);
  expect(read.lines.length).toBe(2000);
  expect(read.lines[0]).toBe("line500");
  expect(read.cursor).toBe(2501);
});
