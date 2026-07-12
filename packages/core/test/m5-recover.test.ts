// M5 recovery — the moat-critical pure reconciler. Locks the per-state table,
// proves NO state maps to `done`, and proves sweep never strands a live-runner
// loom nor double-executes (in /active or fresh-lease looms are skipped).
import { describe, expect, test } from "bun:test";
import { reconcileState, sweep, type RecoverAction, type SweepActions } from "../src/runner/recover";
import { WorkUnitState } from "../src/schemas";
import type { Loom } from "../src/looms";

let n = 0;
function loom(state: Loom["state"], overrides: Partial<Loom> = {}): Loom {
  n++;
  return {
    id: `R${n}`,
    project: "p",
    kind: "custom",
    title: "t",
    prompt: "x",
    account: "personal",
    state,
    createdAt: 0,
    updatedAt: 0,
    attempts: [],
    error: null,
    ...overrides,
  };
}

const EXPECTED: Record<Loom["state"], RecoverAction> = {
  queued: "resume",
  scoping: "queued",
  preparing: "resume",
  running: "halt",
  verifying: "halt",
  "charter-review": "leave",
  "env-review": "leave", // M7 — awaiting a human on the env proposal
  ready: "leave",
  blocked: "leave",
  "needs-review": "leave",
  done: "skip",
  failed: "skip",
  skipped: "skip",
  halted: "skip",
};

describe("reconcileState (pure table)", () => {
  test("matches the recovery table for EVERY WorkUnitState", () => {
    for (const state of WorkUnitState.options) {
      expect(reconcileState(state)).toBe(EXPECTED[state]);
    }
  });

  test("MOAT: no state maps to a terminal-success — `done` is never returned", () => {
    for (const state of WorkUnitState.options) {
      expect(reconcileState(state)).not.toBe("done" as unknown as RecoverAction);
    }
  });
});

function recordingActions(): { calls: { verb: keyof SweepActions; id: string }[] } & SweepActions {
  const calls: { verb: keyof SweepActions; id: string }[] = [];
  return {
    calls,
    resume: (l) => calls.push({ verb: "resume", id: l.id }),
    queued: (l) => calls.push({ verb: "queued", id: l.id }),
    halt: (l) => calls.push({ verb: "halt", id: l.id }),
  };
}

describe("sweep", () => {
  test("(a) an in-flight loom with a fresh lease / in /active (LIVE) is NOT touched", () => {
    const running = loom("running");
    const live = new Set([running.id]);
    const actions = recordingActions();
    const applied = sweep([running], (id) => live.has(id), actions);
    expect(applied).toEqual([]);
    expect(actions.calls).toEqual([]);
  });

  test("(b) an in-flight, not-live loom gets its table action (running → halt)", () => {
    const running = loom("running");
    const verifying = loom("verifying");
    const queued = loom("queued");
    const scoping = loom("scoping");
    const actions = recordingActions();
    const applied = sweep([running, verifying, queued, scoping], () => false, actions);
    expect(actions.calls).toEqual([
      { verb: "halt", id: running.id },
      { verb: "halt", id: verifying.id },
      { verb: "resume", id: queued.id },
      { verb: "queued", id: scoping.id },
    ]);
    expect(applied.map((a) => a.action)).toEqual(["halt", "halt", "resume", "queued"]);
  });

  test("(c) awaiting-human / terminal looms are left alone", () => {
    const looms = (["ready", "blocked", "needs-review", "charter-review", "done", "failed", "skipped", "halted"] as const).map(
      (s) => loom(s),
    );
    const actions = recordingActions();
    const applied = sweep(looms, () => false, actions);
    expect(applied).toEqual([]);
    expect(actions.calls).toEqual([]);
  });

  test("(d) a child (parentLoomId) loom is skipped — recovers via its root's re-weave", () => {
    const child = loom("running", { parentLoomId: "root1", subGoalId: "s1" });
    const actions = recordingActions();
    const applied = sweep([child], () => false, actions);
    expect(applied).toEqual([]);
    expect(actions.calls).toEqual([]);
  });
});
