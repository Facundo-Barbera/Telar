// M5 per-loom disk lease — round-trip, heartbeat, freshness. Real fs against a
// throwaway tmp dir (fs-removed after); the clock is injected.
import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeLease, heartbeatLease, readLease, isLeaseFresh } from "../src/runner/lease";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telar-lease-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("lease round-trip", () => {
  test("writeLease then readLease returns pid/token/ts", () => {
    const d = path.join(dir, "L1");
    const written = writeLease(d, { pid: 42, token: "tok" }, () => 1000);
    expect(written).toEqual({ pid: 42, token: "tok", ts: 1000 });
    expect(readLease(d)).toEqual({ pid: 42, token: "tok", ts: 1000 });
  });

  test("heartbeatLease refreshes ts, keeps pid/token", () => {
    const d = path.join(dir, "L2");
    writeLease(d, { pid: 7, token: "k" }, () => 1000);
    const beat = heartbeatLease(d, () => 5000);
    expect(beat).toEqual({ pid: 7, token: "k", ts: 5000 });
    expect(readLease(d)!.ts).toBe(5000);
  });

  test("heartbeatLease returns null with no lease to beat", () => {
    expect(heartbeatLease(path.join(dir, "missing"), () => 1)).toBeNull();
  });

  test("readLease returns null for an absent / unreadable lease", () => {
    expect(readLease(path.join(dir, "nope"))).toBeNull();
  });
});

describe("isLeaseFresh", () => {
  test("fresh within ttl, stale past it, null never fresh", () => {
    const lease = { pid: 1, token: "t", ts: 1000 };
    expect(isLeaseFresh(lease, 100, 1050)).toBe(true);
    expect(isLeaseFresh(lease, 100, 1100)).toBe(true);
    expect(isLeaseFresh(lease, 100, 1101)).toBe(false);
    expect(isLeaseFresh(null, 100, 1000)).toBe(false);
  });
});
