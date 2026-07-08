import { describe, expect, test } from "bun:test";
import os from "node:os";
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
});
