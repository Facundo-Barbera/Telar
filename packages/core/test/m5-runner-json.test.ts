// M5 runner discovery + single-instance guard. Real fs in a tmp dir exercises
// the REAL O_EXCL (flag:"wx") lock; the pid-liveness probe is injected.
import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  writeRunnerJson,
  readRunnerJson,
  acquireRunnerLock,
  releaseRunnerLock,
  reclaimStaleLock,
  runnerJsonPath,
} from "../src/runner/runner-json";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-runnerjson-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

let n = 0;
const freshDir = () => {
  n++;
  return path.join(root, `d${n}`);
};

describe("runner.json", () => {
  test("write then read round-trips {pid,port,token}; file is 0600", () => {
    const dir = freshDir();
    writeRunnerJson(dir, { pid: 100, port: 51000, token: "secret" });
    expect(readRunnerJson(dir)).toEqual({ pid: 100, port: 51000, token: "secret" });
    const mode = fs.statSync(runnerJsonPath(dir)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("readRunnerJson returns null when absent", () => {
    expect(readRunnerJson(freshDir())).toBeNull();
  });
});

describe("runner.lock (O_EXCL single-instance)", () => {
  test("first acquire wins; a second concurrent acquire fails", () => {
    const dir = freshDir();
    expect(acquireRunnerLock(dir, 111)).toBe(true);
    expect(acquireRunnerLock(dir, 222)).toBe(false); // O_EXCL: lock already held
    releaseRunnerLock(dir);
    expect(acquireRunnerLock(dir, 333)).toBe(true); // released → reacquirable
  });

  test("reclaimStaleLock: a DEAD owner is reclaimed, a LIVE owner is refused", () => {
    const dir = freshDir();
    expect(acquireRunnerLock(dir, 111)).toBe(true);
    // Live owner (recycled pid still running) → do not steal.
    expect(reclaimStaleLock(dir, 999, () => true)).toBe(false);
    // Dead owner → reclaim for the new pid.
    expect(reclaimStaleLock(dir, 999, () => false)).toBe(true);
  });

  test("reclaimStaleLock acquires fresh when there is no existing lock", () => {
    const dir = freshDir();
    expect(reclaimStaleLock(dir, 5, () => true)).toBe(true);
  });
});
