import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { init } from "../src/init.ts";
import { release } from "../src/lease.ts";
import { snapshotState } from "../src/state.ts";
import { runTier } from "../src/tiers.ts";
import { fakeProject, freshHome } from "./helpers.ts";

const TIERS = {
  unit: "touch tier-unit-ran",
  live: 'test -f "up-$TELAR_SLOT" && touch tier-live-ran',
};

describe("verification tiers", () => {
  beforeEach(() => {
    freshHome();
  });

  test("unit tier runs unleased — no environment comes up", async () => {
    const repo = fakeProject({ tiers: TIERS });
    const result = await runTier({ cwd: repo, tier: "unit" });
    expect(result.ok).toBeTrue();
    expect(result.leaseId).toBeUndefined();
    expect(existsSync(join(repo, "tier-unit-ran"))).toBeTrue();
    expect(existsSync(join(repo, "up-0"))).toBeFalse(); // never leased
  });

  test("live tier auto-leases, runs inside the env, releases warm", async () => {
    const repo = fakeProject({ tiers: TIERS });
    const result = await runTier({ cwd: repo, tier: "live" });
    expect(result.ok).toBeTrue();
    expect(result.leaseId).toBeDefined();
    expect(existsSync(join(repo, "tier-live-ran"))).toBeTrue(); // ran with env up
    const state = snapshotState();
    expect(Object.keys(state.leases)).toHaveLength(0); // released
    expect(Object.keys(state.warm)).toHaveLength(1); // kept warm
  });

  test("keepLease hands the live environment to the caller", async () => {
    const repo = fakeProject({ tiers: TIERS });
    const result = await runTier({ cwd: repo, tier: "live", keepLease: true });
    expect(result.ok).toBeTrue();
    expect(result.leaseKept).toBeTrue();
    expect(Object.keys(snapshotState().leases)).toHaveLength(1); // still held
    await release(result.leaseId!, { down: true });
  });

  test("an undeclared tier fails with the declared list", async () => {
    const repo = fakeProject({ tiers: TIERS });
    const result = await runTier({ cwd: repo, tier: "integration" });
    expect(result.ok).toBeFalse();
    expect(result.error).toContain("unit, live");
  });
});

describe("init", () => {
  beforeEach(() => {
    freshHome();
  });

  test("dry-run returns the template without writing", () => {
    const repo = fakeProject();
    Bun.spawnSync(["rm", `${repo}/telar.yaml`]); // un-onboard it
    const result = init(repo);
    expect(result.written).toBeFalse();
    expect(result.template).toContain("version: 1");
    expect(existsSync(result.sidecarPath)).toBeFalse();
  });

  test("--write scaffolds the sidecar; a second init reports it as existing", () => {
    const repo = fakeProject();
    Bun.spawnSync(["rm", `${repo}/telar.yaml`]);
    const written = init(repo, { write: true });
    expect(written.written).toBeTrue();
    expect(readFileSync(written.sidecarPath, "utf8")).toContain("cost: heavy");
    const again = init(repo, { write: true });
    expect(again.existing?.source).toBe("sidecar");
    expect(again.written).toBeFalse();
  });

  test("never scaffolds over a repo-committed contract", () => {
    const repo = fakeProject();
    const result = init(repo, { write: true });
    expect(result.existing?.source).toBe("repo");
    expect(existsSync(result.sidecarPath)).toBeFalse();
  });
});
