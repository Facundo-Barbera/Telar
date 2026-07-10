// docs/loom-model.md D13 (run initializer): unit tests for the port-finding,
// poll/timeout, and stop() logic. Every test injects a fake `spawnFn` (a
// plain EventEmitter standing in for a ChildProcess) and a fake `pollFn` —
// nothing here ever spawns a real, long-running process.
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { startProjectServer } from "../src/run-server";

// A minimal stand-in for node's ChildProcess: enough surface for run-server's
// killTree (pid, kill(), 'exit'/'error' events) without spawning anything.
class FakeChild extends EventEmitter {
  pid = 100_000 + Math.floor(Math.random() * 50_000); // never a real process group
  exitCode: number | null = null;
  killed = false;
  kill(_signal?: string): boolean {
    this.killed = true;
    this.exitCode = 0;
    queueMicrotask(() => this.emit("exit", 0));
    return true;
  }
}

function fakeSpawn(): { spawnFn: () => ChildProcess; child: FakeChild } {
  const child = new FakeChild();
  return { spawnFn: () => child as unknown as ChildProcess, child };
}

describe("startProjectServer", () => {
  test("picks a free port per call (no hardcoded/reused port)", async () => {
    const a = fakeSpawn();
    const b = fakeSpawn();
    const alwaysReady = async () => true;

    const [serverA, serverB] = await Promise.all([
      startProjectServer("/tmp/proj-a", "fake dev a", { spawnFn: a.spawnFn, pollFn: alwaysReady }),
      startProjectServer("/tmp/proj-b", "fake dev b", { spawnFn: b.spawnFn, pollFn: alwaysReady }),
    ]);

    expect(serverA.port).toBeGreaterThan(0);
    expect(serverB.port).toBeGreaterThan(0);
    expect(serverA.port).not.toBe(serverB.port);
    expect(serverA.url).toBe(`http://localhost:${serverA.port}`);

    await serverA.stop();
    await serverB.stop();
    expect(a.child.killed).toBe(true);
    expect(b.child.killed).toBe(true);
  });

  test("times out and stops the process when the server never answers", async () => {
    const { spawnFn, child } = fakeSpawn();
    const neverReady = async () => false;

    await expect(
      startProjectServer("/tmp/proj", "fake dev that never comes up", {
        spawnFn,
        pollFn: neverReady,
        timeoutMs: 300,
      }),
    ).rejects.toThrow(/did not respond/);

    // Timeout must tear the process down, not leave it running.
    expect(child.killed).toBe(true);
  });

  test("stop() tears the process down and is idempotent", async () => {
    const { spawnFn, child } = fakeSpawn();
    let polls = 0;
    const readyOnSecondPoll = async () => {
      polls++;
      return polls >= 2;
    };

    const server = await startProjectServer("/tmp/proj", "fake dev", {
      spawnFn,
      pollFn: readyOnSecondPoll,
      timeoutMs: 5_000,
    });

    expect(child.killed).toBe(false); // still "running" until stop()
    await server.stop();
    expect(child.killed).toBe(true);

    // A second stop() must not throw or attempt to kill again.
    child.killed = false;
    await server.stop();
    expect(child.killed).toBe(false);
  });
});
