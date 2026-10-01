import { afterEach, expect, jest, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Session } from "@telar/engine-client";
import { mountRootsFor } from "../../platform/fs/volumes";
import { probeVolume, VolumeGate } from "../../platform/fs/volume-gate";
import { liveCheckouts, lockCheckouts, type LiveCheckout } from "./boot-pass";

afterEach(() => jest.useRealTimers());

const AT = { now: 1_000_000, autoSettleAfterHours: null };
const SLOW = path.join(mountRootsFor(process.platform)[0]!, "Slow");

const session = (id: string, worktree: string, patch: Partial<Session> = {}): Session =>
  ({
    id,
    projectId: "project_one",
    state: "active",
    activity: "idle",
    createdAt: 1,
    updatedAt: AT.now,
    workspace: { mode: "worktree", path: worktree, branch: `telar/${id}` },
    ...patch,
  }) as Session;

test("a thousand settled sessions cost no probe, no fs call and no lock", async () => {
  const sessions = Array.from({ length: 1_000 }, (_, index) => session(`settled_${index}`, `${SLOW}/wt/${index}`, { settledOverride: "settled", settledAt: 1 }));
  sessions.push(...Array.from({ length: 50 }, (_, index) => session(`archived_${index}`, `${SLOW}/a/${index}`, { state: "archived" })));
  const probes: string[] = [];
  const locks: LiveCheckout[] = [];
  const gate = new VolumeGate(async (mount) => (probes.push(mount), "ok"));
  const checkouts = liveCheckouts(sessions, AT);
  expect(await lockCheckouts(checkouts, gate, async (checkout) => locks.push(checkout))).toEqual([]);
  expect(checkouts).toEqual([]);
  expect(probes).toEqual([]);
  expect(locks).toEqual([]);
});

test("a volume that never answers is skipped, and the live checkouts elsewhere are still locked", async () => {
  const here = fs.mkdtempSync(path.join(os.tmpdir(), "telar-boot-pass-"));
  try {
    jest.useFakeTimers();
    const stat = (target: string) => (target.startsWith(SLOW) ? new Promise<never>(() => {}) : Promise.resolve({ dev: 1 }));
    const gate = new VolumeGate((mount) => probeVolume(mount, stat));
    const sessions = [session("on_slow", `${SLOW}/wt/one`), session("on_disk", here)];
    const locked: string[] = [];
    const pass = lockCheckouts(liveCheckouts(sessions, AT), gate, async (checkout) => locked.push(checkout.sessionId));
    for (let tick = 0; tick < 10; tick++) await Promise.resolve();
    jest.advanceTimersByTime(2_000);
    expect(await pass).toEqual(["on_disk"]);
    expect(locked).toEqual(["on_disk"]);
    expect(gate.degraded.get(SLOW)).toBe("slow");
  } finally {
    fs.rmSync(here, { recursive: true, force: true });
  }
});
