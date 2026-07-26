// THE BUDGET GUARD'S READ LEG — weave.ts's `spentUsd()` against a ledger that
// cannot be read (docs/loom-orchestrator.md §7, AD-18).
//
// WHAT THIS FILE EXISTS TO KEEP FIXED, measured end-to-end rather than argued:
// usage-ledger.ts's readFold answers an I/O failure with a FOLD and never a
// throw, so a try/catch around ledgerSpendUsd can never fire for the failure it
// names. With $100 already on the ledger, a $1 maxCostUsd and an EACCES on the
// first ledger touch of a fresh process, that 0 arrived as a SUCCESS: the cap
// stopped binding, a child spawned, and the woven root reached `ready` — with
// no event anywhere. The fix reads ledgerReadUnavailable() (the port's own
// "that 0 was not a real 0" predicate) and fails CLOSED when there is no
// last-known value to serve instead.
//
// The four cases below are the whole contract, and three of them are the ones a
// fail-closed rule gets WRONG if it is written carelessly: a stale figure still
// binds (never fail-close over a value you already have), a genuinely empty
// ledger really is 0 (never block a fresh run), and an UNCAPPED weave has no
// guard to un-bind (never stop work over an accounting defect that constrains
// nothing).
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-budget-read-"));
process.env.TELAR_HOME = home;
// bun test runs all files in one process — re-pin the env before every test
beforeEach(() => {
  process.env.TELAR_HOME = home;
});

const { runWeave } = await import("../src/weave");
import type { Loom } from "../src/looms";
import type { Charter, SubGoal } from "../src/schemas";

// Every root minted here gets its OWN TELAR_HOME, because "cold" is a property
// of the ledger's per-file projection cache: a home this process already read
// successfully would serve its cached fold and the read would not be cold at
// all. Tracked so afterAll can remove them (a chmod-000 FILE still unlinks —
// unlink needs write on the directory, not on the file).
const roots: string[] = [];
function newHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telar-budget-read-case-"));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  process.env.TELAR_HOME = home;
});

afterAll(() => {
  for (const dir of [...roots, home]) fs.rmSync(dir, { recursive: true, force: true });
});

// One loom-owned row worth `costUsd`, written by hand: the point of these cases
// is a ledger that is ALREADY populated before the process that reads it opens
// it, which is exactly what logUsage cannot do from inside this process without
// leaving a warm cache behind.
function seedLedger(dir: string, ownerId: string, costUsd: number) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "usage.ndjson"),
    JSON.stringify({
      ts: Date.now(),
      account: "personal",
      model: "",
      sessionId: "",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
      costUsd,
      ownerKind: "loom",
      ownerId,
    }) + "\n",
  );
}

// EACCES, not a missing file: an absent ledger is a legitimate 0 (ENOENT), and
// conflating the two is the exact confusion this file pins apart. chmod 000
// denies the owner too (verified: open -> EACCES, stat still answers).
function makeUnreadable(dir: string) {
  fs.chmodSync(path.join(dir, "usage.ndjson"), 0o000);
}

function subGoal(overrides: Partial<SubGoal> = {}): SubGoal {
  return {
    id: overrides.id ?? "s1",
    title: "title",
    detail: "detail",
    proofStrategy: "custom",
    acceptanceCriteria: [],
    dependsOn: [],
    required: true,
    status: "pending",
    ...overrides,
  };
}

let rootN = 0;
function wovenRoot(decomposition: SubGoal[], budget: Partial<Charter["budget"]> = {}): Loom {
  rootN++;
  return {
    id: `budget_read_root_${rootN}`,
    project: "p",
    kind: "custom",
    title: "root",
    prompt: "x",
    account: "personal",
    state: "queued",
    createdAt: 0,
    updatedAt: 0,
    attempts: [],
    error: null,
    charter: {
      objective: "o",
      proofStrategy: "custom",
      scope: { allowedPaths: [], forbiddenPaths: [] },
      budget: { maxParallelThreads: 3, maxAgents: 12, maxCriticAgents: 3, ...budget },
      decomposition,
      version: 1,
    },
  };
}

type Run = {
  loom: Loom;
  spawned: string[];
  events: Array<{ type: string } & Record<string, unknown>>;
  decisions: Array<Record<string, any>>;
};

// A weave whose children always settle `done` and cost nothing, so the ONLY
// thing under test is what the budget read answers. `onSpawn` is the seam a
// case uses to change the world between a successful read and the next one.
async function runCase(
  root: Loom,
  decomposition: SubGoal[],
  opts: { onSpawn?: () => void } = {},
): Promise<Run> {
  const spawned: string[] = [];
  const events: Array<{ type: string } & Record<string, unknown>> = [];
  const loom = await runWeave(root, decomposition, {
    spawnChild: (sg) => {
      spawned.push(sg.id);
      opts.onSpawn?.();
      return {
        id: `child_${root.id}_${sg.id}`,
        project: "p",
        kind: "custom",
        title: sg.title,
        prompt: "x",
        account: "personal",
        state: "queued",
        createdAt: 0,
        updatedAt: 0,
        attempts: [],
        error: null,
        parentLoomId: root.id,
        subGoalId: sg.id,
      } satisfies Loom;
    },
    // costUsd 0 => recordSpend writes no row, so no WRITE failure can be
    // mistaken for the READ failure these cases are about.
    runChild: async (child) => ({
      ...child,
      state: "done" as const,
      attempts: [{ id: `att_${child.id}`, n: 1, startedAt: 1, endedAt: 2, costUsd: 0 }],
    }),
    onEvent: (ev) => events.push(ev),
    now: () => 1_700_000_000_000,
  });
  return {
    loom,
    spawned,
    events,
    decisions: events.filter((e) => e.type === "decision") as Array<Record<string, any>>,
  };
}

const spendReadFailures = (r: Run) => r.events.filter((e) => e.type === "spend-read-failed");

describe("spentUsd() — the budget guard's read leg", () => {
  test("P12b: a COLD unreadable ledger under a maxCostUsd never reaches ready and never spawns", async () => {
    const dir = newHome();
    const decomposition = [subGoal({ id: "s1" })];
    const root = wovenRoot(decomposition, { maxCostUsd: 1 });
    // $100 already spent by this very loom, and a $1 cap: the honest answer is
    // "no headroom". The first ledger touch of this process is the EACCES.
    seedLedger(dir, root.id, 100);
    makeUnreadable(dir);
    process.env.TELAR_HOME = dir;

    const r = await runCase(root, decomposition);

    // THE REGRESSION: this run reached `ready` (having spawned its child) while
    // $100 of a $1 budget was unreadable. `ready` is the state that presents an
    // accept affordance, so it is the one that must be unreachable here.
    expect(r.loom.state).not.toBe("ready");
    expect(r.loom.state).toBe("failed");
    expect(r.spawned).toEqual([]);
    expect(String(r.loom.error)).toContain("spend read unavailable");
    // Not silent — the one-shot audit event fires on the path that now runs.
    expect(spendReadFailures(r).length).toBe(1);
    // ...and it fires BEFORE the loom is failed, so the stream reads cause-first.
    const types = r.events.map((e) => e.type);
    expect(types.indexOf("spend-read-failed")).toBeLessThan(types.indexOf("error"));
    // No decision was ever taken against a fabricated 0.
    expect(r.decisions.length).toBe(0);
  });

  test("a WARM unreadable ledger serves the last-known value and keeps binding — it never fails closed", async () => {
    const readable = newHome();
    const unreadable = newHome();
    const decomposition = [subGoal({ id: "s1" }), subGoal({ id: "s2" }), subGoal({ id: "s3" })];
    const root = wovenRoot(decomposition, { maxCostUsd: 1.2 });
    seedLedger(readable, root.id, 0.6);
    // A SECOND root, unreadable. Swapping to it is the honest way to reach
    // "unavailable with a last-known value": usage-ledger.ts serves its cached
    // fold for the SAME file (identity-checked), so only a read of a file this
    // process has no fold for can be unavailable after a successful read — and
    // two live roots in one process is a case usage-ledger.ts's cache comment
    // names explicitly (the root resolves lazily).
    seedLedger(unreadable, root.id, 999);
    makeUnreadable(unreadable);
    process.env.TELAR_HOME = readable;

    // The FIRST spawn is strictly after the first successful read (tick only
    // schedules once it has a budget), so this is the exact hand-off point.
    let swapped = false;
    const r = await runCase(root, decomposition, {
      onSpawn: () => {
        if (swapped) return;
        swapped = true;
        process.env.TELAR_HOME = unreadable;
      },
    });

    expect(spendReadFailures(r).length).toBe(1); // one-shot, not once per tick
    // Warm failure NEVER fails closed: there is a real lower bound to serve.
    expect(r.loom.state).toBe("ready");
    expect(r.spawned.sort()).toEqual(["s1", "s2", "s3"]);
    // EVERY decision — before and after the ledger went dark — was taken against
    // the last-known $0.60, never a reset-to-zero and never the unreadable
    // root's $999.
    for (const d of r.decisions) {
      expect(d.rationale.budget.spentUsd).toBeCloseTo(0.6, 10);
      expect(d.rationale.budget.budgetLeftUsd).toBeCloseTo(0.6, 10);
    }
    // ...and it BINDS: $0.60 left over EST_COST_PER_AGENT ($0.50) is one agent
    // per tick. A false 0 would have made it floor(1.2/0.5) = 2 and fanned out.
    const schedules = r.decisions.filter((d) => d.decision.action === "schedule");
    expect(schedules.length).toBe(3);
    for (const d of schedules) expect(d.decision.agents).toBe(1);
  });

  test("a genuinely EMPTY ledger still reads 0 and does not block a capped run", async () => {
    const dir = newHome();
    fs.mkdirSync(dir, { recursive: true });
    const decomposition = [subGoal({ id: "s1" })];
    const root = wovenRoot(decomposition, { maxCostUsd: 1 });
    process.env.TELAR_HOME = dir;

    // (a) no ledger file at all — ENOENT is the legitimate empty state.
    const absent = await runCase(root, decomposition);
    expect(absent.loom.state).toBe("ready");
    expect(absent.spawned).toEqual(["s1"]);
    expect(spendReadFailures(absent).length).toBe(0);
    for (const d of absent.decisions) expect(d.rationale.budget.spentUsd).toBe(0);

    // (b) a ledger file that exists and is readable but holds no rows.
    const dir2 = newHome();
    fs.mkdirSync(dir2, { recursive: true });
    fs.writeFileSync(path.join(dir2, "usage.ndjson"), "");
    const decomposition2 = [subGoal({ id: "s1" })];
    const root2 = wovenRoot(decomposition2, { maxCostUsd: 1 });
    process.env.TELAR_HOME = dir2;
    const empty = await runCase(root2, decomposition2);
    expect(empty.loom.state).toBe("ready");
    expect(empty.spawned).toEqual(["s1"]);
    expect(spendReadFailures(empty).length).toBe(0);
    for (const d of empty.decisions) expect(d.rationale.budget.spentUsd).toBe(0);
  });

  test("a loom with NO maxCostUsd is unaffected by an unreadable ledger — it still runs, and still reports", async () => {
    const dir = newHome();
    const decomposition = [subGoal({ id: "s1" }), subGoal({ id: "s2" })];
    const root = wovenRoot(decomposition); // no maxCostUsd: nothing to un-bind
    seedLedger(dir, root.id, 100);
    makeUnreadable(dir);
    process.env.TELAR_HOME = dir;

    const r = await runCase(root, decomposition);

    expect(r.loom.state).toBe("ready");
    expect(r.spawned.sort()).toEqual(["s1", "s2"]);
    expect(r.loom.error).toBeNull();
    // Fail-closed is scoped to a real cap, but the defect is still REPORTED.
    expect(spendReadFailures(r).length).toBe(1);
    for (const d of r.decisions) {
      expect(d.rationale.budget.spentUsd).toBe(0);
      expect(d.rationale.budget.maxCostUsd).toBeUndefined();
    }
  });
});
