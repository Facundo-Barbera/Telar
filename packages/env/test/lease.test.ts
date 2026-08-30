import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { acquire, downStale, reclaimStale, release, renew } from "../src/lease.ts";
import { projectIdentity } from "../src/id.ts";
import { snapshotState, withState } from "../src/state.ts";
import { fakeProject, freshHome, sidecarFor } from "./helpers.ts";

function addWorktree(repo: string, branch: string): string {
  const path = `${repo}-wt-${branch}`;
  const r = spawnSync("git", ["worktree", "add", "-q", path, "-b", branch], { cwd: repo, encoding: "utf8" });
  expect(r.status).toBe(0);
  return path;
}

describe("lease lifecycle", () => {
  beforeEach(() => {
    freshHome();
  });

  test("cost none grants without an environment", async () => {
    const repo = fakeProject({ cost: "none" });
    const result = await acquire({ cwd: repo });
    expect(result.granted).toBeTrue();
    expect(result.lease).toBeUndefined();
  });

  test("heavy: grant runs up, records ports; repair exception returns the same lease", async () => {
    const repo = fakeProject();
    const first = await acquire({ cwd: repo });
    expect(first.granted).toBeTrue();
    expect(first.lease!.slot).toBe(0); // primary checkout
    expect(existsSync(join(repo, "up-0"))).toBeTrue();
    expect(first.lease!.portBase).toBeGreaterThanOrEqual(40000);

    const again = await acquire({ cwd: repo });
    expect(again.existing).toBeTrue();
    expect(again.lease!.id).toBe(first.lease!.id);

    const released = await release(first.lease!.id, { down: true });
    expect(released.released).toBeTrue();
    expect(released.keptWarm).toBeUndefined();
    expect(existsSync(join(repo, "up-0"))).toBeFalse(); // forced down ran
  });

  test("release with an empty queue keeps the env warm; re-lease reuses it without up", async () => {
    const repo = fakeProject();
    const first = await acquire({ cwd: repo });
    const released = await release(first.lease!.id);
    expect(released.keptWarm).toBeTrue();
    expect(existsSync(join(repo, "up-0"))).toBeTrue(); // still running

    const second = await acquire({ cwd: repo });
    expect(second.granted).toBeTrue();
    expect(second.reusedWarm).toBeTrue();
    expect(second.lease!.slot).toBe(0);
    expect(second.verbs!.map((v) => v.verb)).toEqual(["ready"]); // no up
    await release(second.lease!.id, { down: true });
  });

  test("a warm env is evicted when another worktree needs the pool", async () => {
    const repo = fakeProject();
    const wt = addWorktree(repo, "evictor");
    const first = await acquire({ cwd: repo });
    await release(first.lease!.id); // kept warm, occupies the k=1 pool

    const second = await acquire({ cwd: wt });
    expect(second.granted).toBeTrue(); // warm env evicted, not queued
    expect(existsSync(join(repo, "up-0"))).toBeFalse(); // evicted env torn down
    expect(existsSync(join(wt, "up-1"))).toBeTrue();
    await release(second.lease!.id, { down: true });
  });

  test("heavy pool k=1: second worktree queues FIFO, acquires after release", async () => {
    const repo = fakeProject();
    const wt = addWorktree(repo, "feature");

    const first = await acquire({ cwd: repo });
    expect(first.granted).toBeTrue();

    const queued = await acquire({ cwd: wt });
    expect(queued.granted).toBeFalse();
    expect(queued.queuePosition).toBe(1);

    await release(first.lease!.id);
    const second = await acquire({ cwd: wt });
    expect(second.granted).toBeTrue();
    expect(second.lease!.slot).toBe(1); // linked worktree, distinct slot
    expect(second.lease!.portBase).not.toBe(first.lease!.portBase);
    expect(existsSync(join(wt, "up-1"))).toBeTrue();
    await release(second.lease!.id);
  });

  test("slot and port assignments are stable across leases", async () => {
    const repo = fakeProject();
    const a = await acquire({ cwd: repo });
    await release(a.lease!.id);
    const b = await acquire({ cwd: repo });
    expect(b.lease!.slot).toBe(a.lease!.slot);
    expect(b.lease!.portBase).toBe(a.lease!.portBase);
    await release(b.lease!.id);
  });

  test("reclaim is TTL-only: a dead holder pid never kills a live lease", async () => {
    const repo = fakeProject();
    const granted = await acquire({ cwd: repo });
    withState((state) => {
      state.leases[granted.lease!.id]!.pid = 99_999_999; // grant process long gone — the CLI case
    });
    expect(reclaimStale().staleLeases).toEqual([]); // still leased
    expect(existsSync(join(repo, "up-0"))).toBeTrue();

    withState((state) => {
      state.leases[granted.lease!.id]!.expiresAt = Date.now() - 1;
    });
    const stale = reclaimStale();
    expect(stale.staleLeases.map((l) => l.id)).toEqual([granted.lease!.id]);
    await downStale(stale);
    expect(existsSync(join(repo, "up-0"))).toBeFalse();
    expect(Object.keys(snapshotState().leases)).toHaveLength(0);
  });

  test("renew extends the TTL", async () => {
    const repo = fakeProject();
    const granted = await acquire({ cwd: repo });
    const before = granted.lease!.expiresAt;
    await Bun.sleep(5);
    const renewed = renew(granted.lease!.id);
    expect(renewed.renewed).toBeTrue();
    expect(renewed.expiresAt!).toBeGreaterThan(before);
    await release(granted.lease!.id);
  });

  test("a failing ready rolls the reservation back and reports the verb", async () => {
    const repo = fakeProject();
    const { id } = projectIdentity(repo);
    sidecarFor(process.env.TELAR_HOME!, id, [
      "version: 1",
      "env:",
      "  cost: heavy",
      "  up: 'true'",
      "  ready: 'false'",
      "  down: touch down-ran",
      "",
    ].join("\n"));
    const result = await acquire({ cwd: repo, readyTimeoutMs: 100 });
    expect(result.granted).toBeFalse();
    expect(result.error).toContain("ready");
    expect(existsSync(join(repo, "down-ran"))).toBeTrue(); // rollback tore down
    expect(Object.keys(snapshotState().leases)).toHaveLength(0);
  });

  test("sidecar takes precedence over repo telar.yaml", async () => {
    const repo = fakeProject({ cost: "heavy" });
    const { id } = projectIdentity(repo);
    sidecarFor(process.env.TELAR_HOME!, id, "version: 1\nenv:\n  cost: none\n");
    const result = await acquire({ cwd: repo });
    expect(result.granted).toBeTrue();
    expect(result.cost).toBe("none");
  });

  test("light pool allows several concurrent leases in one project", async () => {
    const repo = fakeProject({ cost: "light" });
    const wt = addWorktree(repo, "parallel");
    const a = await acquire({ cwd: repo });
    const b = await acquire({ cwd: wt });
    expect(a.granted).toBeTrue();
    expect(b.granted).toBeTrue();
    await release(a.lease!.id);
    await release(b.lease!.id);
  });
});
