import { beforeEach, describe, expect, test } from "bun:test";
import { runConformance } from "../src/conformance.ts";
import { projectContext } from "../src/context.ts";
import { fakeProject, freshHome } from "./helpers.ts";

describe("conformance", () => {
  beforeEach(() => {
    freshHome();
  });

  test("a well-behaved contract passes the full sequence", async () => {
    const repo = fakeProject({ withReset: true });
    const report = await runConformance(repo);
    const names = report.steps.map((s) => s.name);
    expect(names).toEqual([
      "contract",
      "up",
      "ready",
      "up-idempotent",
      "reset",
      "down",
      "down-effective",
      "down-idempotent",
    ]);
    expect(report.ok).toBeTrue();
    expect(report.slot).toBeGreaterThanOrEqual(1); // never the primary's slot 0
  });

  test("cost none conforms trivially", async () => {
    const repo = fakeProject({ cost: "none" });
    const report = await runConformance(repo);
    expect(report.ok).toBeTrue();
    expect(report.steps.at(-1)!.name).toBe("no-env");
  });

  test("a missing contract fails with a pointer, not a crash", async () => {
    const repo = fakeProject();
    await Bun.$`rm ${repo}/telar.yaml`.quiet();
    const report = await runConformance(repo);
    expect(report.ok).toBeFalse();
    expect(report.steps[0]!.detail).toContain("no contract");
  });
});

describe("project context", () => {
  beforeEach(() => {
    freshHome();
  });

  test("briefing includes contract, worktrees, and empty pool", () => {
    const repo = fakeProject();
    const ctx = projectContext(repo);
    expect(ctx.contract?.env.cost).toBe("heavy");
    expect(ctx.worktrees.some((w) => w.isPrimary)).toBeTrue();
    expect(ctx.activeLeases).toHaveLength(0);
  });
});
