import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { runGate, runGates } from "../src/gates";

const cwd = os.tmpdir();

describe("gates", () => {
  test("passing gate", async () => {
    const r = await runGate({ name: "pass", run: "echo hello" }, cwd);
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("hello");
    expect(r.timedOut).toBe(false);
  });

  test("failing gate captures merged output and exit code", async () => {
    const r = await runGate({ name: "fail", run: "echo oops >&2; exit 1" }, cwd);
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("oops");
  });

  test("timeout kills the command", async () => {
    const r = await runGate({ name: "slow", run: "sleep 5" }, cwd, 200);
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(r.durationMs).toBeLessThan(4000);
  });

  test("runGates runs every gate even after a failure", async () => {
    const seen: string[] = [];
    const { ok, results } = await runGates(
      [
        { name: "a", run: "exit 1" },
        { name: "b", run: "echo fine" },
      ],
      cwd,
      (r) => seen.push(r.name),
    );
    expect(ok).toBe(false);
    expect(results.map((r) => r.ok)).toEqual([false, true]);
    expect(seen).toEqual(["a", "b"]);
  });

  test("runGates with no gates is ok", async () => {
    const { ok, results } = await runGates([], cwd);
    expect(ok).toBe(true);
    expect(results).toEqual([]);
  });

  test("missing working directory fails closed with a truthful error", async () => {
    // A cwd that was reaped out from under the gate (TELAR_HOME/tmpdir wipe)
    // used to surface as the misleading `spawn /bin/sh ENOENT`. It must instead
    // fail closed naming the real culprit — the absent directory — never pass.
    const gone = path.join(cwd, `telar-missing-cwd-${process.pid}`);
    const r = await runGate({ name: "gone", run: "echo should-not-run" }, gone);
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBeNull();
    expect(r.timedOut).toBe(false);
    expect(r.output).toContain(gone);
    expect(r.output).not.toContain("/bin/sh");
    expect(r.output).not.toContain("should-not-run");
  });
});
