// M11 — the PURE deliverable signal (docs/adaptive-verification.md §3.2, §8).
// Every case here defends one of the module's frozen guarantees: purity/never-
// throws (malformed inputs degrade to "no signal"), greenfield charter-intent
// plannability, brownfield filesystem evidence + precedence, the web-shape
// conservative short-circuit (worst case = today's exact park), and the
// strategy-derived last-resort escalation copy.
import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  blockedStrategyQuestion,
  deriveDeliverableSignal,
  type CharterProofIntent,
  type DeliverableSignal,
} from "../src/deliverable-signal";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

function makeRoot(files: Record<string, string> = {}, dirs: string[] = []): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-deliverable-signal-"));
  roots.push(root);
  for (const d of dirs) fs.mkdirSync(path.join(root, d), { recursive: true });
  for (const [name, contents] of Object.entries(files)) fs.writeFileSync(path.join(root, name), contents);
  return root;
}

function pkg(json: Record<string, unknown>): string {
  return JSON.stringify(json, null, 2);
}

const gateCharter: CharterProofIntent = { proofStrategy: "quickfix" };

describe("purity / never-throws (fail-closed degradation)", () => {
  test("nonexistent root -> plannable:false, shape unknown, no throw", () => {
    const s = deriveDeliverableSignal(path.join(os.tmpdir(), "telar-does-not-exist-xyz"));
    expect(s.plannable).toBe(false);
    expect(s.shape).toBe("unknown");
  });

  test("malformed package.json is treated as absent, never a throw", () => {
    const root = makeRoot({ "package.json": "{ not json !!" });
    const s = deriveDeliverableSignal(root);
    expect(s.plannable).toBe(false);
    expect(s.shape).toBe("unknown");
  });

  test("non-object package.json (array / scalar) is treated as absent", () => {
    expect(deriveDeliverableSignal(makeRoot({ "package.json": "[1,2]" })).plannable).toBe(false);
    expect(deriveDeliverableSignal(makeRoot({ "package.json": '"hi"' })).plannable).toBe(false);
  });

  test("empty dir with no charter -> not plannable, reason reports what was checked", () => {
    const s = deriveDeliverableSignal(makeRoot());
    expect(s.plannable).toBe(false);
    expect(s.reason).toContain("test script");
    expect(s.reason).toContain("charter proof intent");
  });
});

describe("brownfield filesystem evidence", () => {
  test("test script -> plannable test-gate with a lockfile-aware runnable (bun)", () => {
    const root = makeRoot({
      "package.json": pkg({ scripts: { test: "bun test" } }),
      "bun.lock": "",
    });
    const s = deriveDeliverableSignal(root);
    expect(s).toMatchObject({ plannable: true, strategy: "test-gate", shape: "library", run: "bun run test" });
  });

  test("lockfile detection: pnpm / yarn / npm-fallback", () => {
    const base = { "package.json": pkg({ scripts: { test: "vitest run" } }) };
    const run = (extra: Record<string, string>) => {
      const s = deriveDeliverableSignal(makeRoot({ ...base, ...extra }));
      return s.plannable ? s.run : undefined;
    };
    expect(run({ "pnpm-lock.yaml": "" })).toBe("pnpm run test");
    expect(run({ "yarn.lock": "" })).toBe("yarn run test");
    expect(run({})).toBe("npm run test"); // no lockfile -> the universal fallback
  });

  test("the npm scaffold placeholder is NOT a test command", () => {
    const root = makeRoot({
      "package.json": pkg({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
    });
    const s = deriveDeliverableSignal(root);
    expect(s.plannable).toBe(false);
  });

  test("bin entry (string or map) -> cli-harness, shape cli", () => {
    const str = deriveDeliverableSignal(makeRoot({ "package.json": pkg({ bin: "./cli.js" }) }));
    expect(str).toMatchObject({ plannable: true, strategy: "cli-harness", shape: "cli" });
    const map = deriveDeliverableSignal(makeRoot({ "package.json": pkg({ bin: { tool: "./cli.js" } }) }));
    expect(map).toMatchObject({ plannable: true, strategy: "cli-harness", shape: "cli" });
  });

  test("notebook / notebooks dir / dataset markers -> sandbox-eval, shape data-science", () => {
    expect(deriveDeliverableSignal(makeRoot({ "analysis.ipynb": "{}" }))).toMatchObject({
      plannable: true,
      strategy: "sandbox-eval",
      shape: "data-science",
    });
    expect(deriveDeliverableSignal(makeRoot({}, ["notebooks"]))).toMatchObject({
      plannable: true,
      strategy: "sandbox-eval",
      shape: "data-science",
    });
    expect(deriveDeliverableSignal(makeRoot({ "train.csv": "a,b\n1,2" }))).toMatchObject({
      plannable: true,
      strategy: "sandbox-eval",
      shape: "data-science",
    });
  });

  test("precedence: establishable-now test gate wins over bin and notebook markers", () => {
    const root = makeRoot({
      "package.json": pkg({ scripts: { test: "pytest" }, bin: { t: "./t.js" } }),
      "eval.ipynb": "{}",
    });
    const s = deriveDeliverableSignal(root);
    expect(s.plannable).toBe(true);
    if (s.plannable) expect(s.strategy).toBe("test-gate");
    // ...while the SHAPE keeps its own strongest-marker precedence (DS > CLI).
    expect(s.shape).toBe("data-science");
  });
});

describe("greenfield charter proof intent (the loom_mrigs3zo_vxgrsr case)", () => {
  test("empty dir + gate-mechanism charter -> deferred-gate, plannable, no run yet", () => {
    const s = deriveDeliverableSignal(makeRoot(), gateCharter);
    expect(s).toMatchObject({ plannable: true, strategy: "deferred-gate", shape: "unknown" });
    if (s.plannable) expect(s.run).toBeUndefined();
  });

  test("gate intent on ANY SubGoal fires, not just the charter root", () => {
    const charter: CharterProofIntent = {
      proofStrategy: "verifier-criteria",
      decomposition: [{ proofStrategy: "verifier-criteria" }, { proofStrategy: "quickfix" }],
    };
    const s = deriveDeliverableSignal(makeRoot(), charter);
    expect(s).toMatchObject({ plannable: true, strategy: "deferred-gate" });
  });

  test("verifier-mechanism-only charter forms NO plan (today's park preserved)", () => {
    const charter: CharterProofIntent = {
      proofStrategy: "verifier-criteria",
      decomposition: [{ proofStrategy: "bmad-story" }],
    };
    expect(deriveDeliverableSignal(makeRoot(), charter).plannable).toBe(false);
  });

  test("null / undefined charter never throws; filesystem signals still fire", () => {
    expect(deriveDeliverableSignal(makeRoot(), null).plannable).toBe(false);
    const root = makeRoot({ "package.json": pkg({ scripts: { test: "bun test" } }) });
    expect(deriveDeliverableSignal(root, undefined).plannable).toBe(true);
  });

  test("filesystem evidence outranks charter intent (establishable-now first)", () => {
    const root = makeRoot({ "package.json": pkg({ scripts: { test: "bun test" } }) });
    const s = deriveDeliverableSignal(root, gateCharter);
    expect(s.plannable).toBe(true);
    if (s.plannable) expect(s.strategy).toBe("test-gate");
  });
});

describe("web-shape conservative short-circuit (worst case = today)", () => {
  test("a dev script makes the deliverable web-shaped and NOT plannable — even with a test script", () => {
    const root = makeRoot({
      "package.json": pkg({ scripts: { dev: "next dev", test: "bun test" } }),
    });
    const s = deriveDeliverableSignal(root);
    expect(s).toMatchObject({ plannable: false, shape: "web" });
  });

  test("a start script alone is web-shaped; even a gate charter cannot override it", () => {
    const root = makeRoot({ "package.json": pkg({ scripts: { start: "node server.js" } }) });
    const s = deriveDeliverableSignal(root, gateCharter);
    expect(s).toMatchObject({ plannable: false, shape: "web" });
  });

  test("a bin outranks a dev script (CLI with a dev loop stays plannable)", () => {
    const root = makeRoot({
      "package.json": pkg({ bin: { t: "./t.js" }, scripts: { dev: "bun --watch src/cli.ts" } }),
    });
    const s = deriveDeliverableSignal(root);
    expect(s).toMatchObject({ plannable: true, strategy: "cli-harness", shape: "cli" });
  });
});

describe("blockedStrategyQuestion — the strategy-derived last-resort ask", () => {
  const notPlannable = (shape: DeliverableSignal["shape"]): DeliverableSignal => ({
    plannable: false,
    shape,
    reason: "r",
  });

  test("library asks for a test command, never a dev command", () => {
    const q = blockedStrategyQuestion(notPlannable("library"));
    expect(q).toContain("test command");
    expect(q).not.toContain("dev command");
  });

  test("cli asks for commands + expected exit/output", () => {
    const q = blockedStrategyQuestion(notPlannable("cli"));
    expect(q).toContain("exit code");
    expect(q).not.toContain("dev command");
  });

  test("data-science asks for an eval command + threshold", () => {
    const q = blockedStrategyQuestion(notPlannable("data-science"));
    expect(q).toContain("threshold");
    expect(q).not.toContain("dev command");
  });

  test("web keeps today's dev-command ask verbatim", () => {
    const q = blockedStrategyQuestion(notPlannable("web"));
    expect(q).toContain("dev command");
    expect(q).toContain("servers recipe");
  });

  test("unknown asks openly for a verification command first", () => {
    const q = blockedStrategyQuestion(notPlannable("unknown"));
    expect(q).toContain("verification command");
  });
});
