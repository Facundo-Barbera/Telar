// Boot reconciliation: a web restart wipes the in-process `active` map, so
// in-flight looms with no live runner must be marked `failed` (resumable),
// while paused/awaiting and terminal looms are left untouched.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorkUnitState } from "../src/schemas"; // type-only: fully erased, no early TELAR_HOME read

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-reconcile-"));
process.env.TELAR_HOME = home;
// bun test runs all files in one process — re-pin the env before every test
beforeEach(() => {
  process.env.TELAR_HOME = home;
});

const { reconcileStuckLooms } = await import("../src/dispatcher");
const { createLoom, getLoom, readEvents, saveLoom } = await import("../src/looms");

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

// Persist a loom directly in the given state, bypassing dispatch (so it never
// enters `active`) — exactly the on-disk shape a killed runner leaves behind.
function seed(state: WorkUnitState): string {
  const loom = createLoom({ project: "p", kind: "custom", title: "t", prompt: "x", account: "personal" });
  loom.state = state;
  saveLoom(loom);
  return loom.id;
}

const IN_FLIGHT: WorkUnitState[] = ["queued", "scoping", "preparing", "running", "verifying"];
const UNTOUCHED: WorkUnitState[] = ["done", "ready", "blocked", "needs-review", "charter-review", "halted"];

describe("reconcileStuckLooms", () => {
  test("(a) an in-flight loom with no live runner -> failed with a restart error", () => {
    const ids = IN_FLIGHT.map((s) => ({ id: seed(s), from: s }));

    reconcileStuckLooms();

    for (const { id } of ids) {
      const loom = getLoom(id)!;
      expect(loom.state).toBe("failed");
      expect(loom.error).toBe(
        "Interrupted by a server restart — resume to pick it back up (no work was lost that a re-run can't reproduce).",
      );
      const { events } = readEvents(id);
      const types = events.map((e) => e.type);
      expect(types).toContain("error");
      expect(events.filter((e) => e.type === "state").some((e) => e.state === "failed")).toBe(true);
    }
  });

  test("(b) terminal and paused/awaiting looms are left untouched", () => {
    const ids = UNTOUCHED.map((s) => ({ id: seed(s), from: s }));

    const reconciled = reconcileStuckLooms();

    for (const { id, from } of ids) {
      expect(getLoom(id)!.state).toBe(from); // unchanged
      expect(reconciled.some((r) => r.id === id)).toBe(false); // not reported
    }
  });

  test("(c) returns the reconciled { id, from } list", () => {
    const running = seed("running");
    const verifying = seed("verifying");

    const reconciled = reconcileStuckLooms();

    const mine = reconciled.filter((r) => r.id === running || r.id === verifying);
    expect(mine).toContainEqual({ id: running, from: "running" });
    expect(mine).toContainEqual({ id: verifying, from: "verifying" });
  });

  test("(d) safe on an empty store", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "telar-reconcile-empty-"));
    process.env.TELAR_HOME = empty;
    try {
      expect(reconcileStuckLooms()).toEqual([]);
    } finally {
      process.env.TELAR_HOME = home;
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});
