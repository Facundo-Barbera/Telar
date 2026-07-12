// M9.3 — pure unit tests for the deterministic template library + selection
// heuristic + graph validator (thread-templates.ts). No live model, no runner:
//   - single-build byte-identity to today's default template (guards M9.2);
//   - the 3-step understand→implement→check shape;
//   - the pickTemplate threshold (pure, no disk);
//   - validateWorkflow accept/reject (empty, dup ids, dangling dep, cycle, no-writing);
//   - selectTemplate reading the thread's contract from disk (no contract ⇒ 1 ⇒
//     single-build; 3 blocker assertions ⇒ escalate; blocker filter + threshold).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Loom } from "../src/looms";
import type { ThreadWorkflow } from "../src/schemas";

// M9.3 determinism fix: a FRESH TELAR_HOME per test (not one dir shared by
// every test in the file) — matches m9-thread-workflow.test.ts's isolation so
// a contract written by one test can never bleed into another's readContract()
// via a shared bundle dir, regardless of run order.
let home = "";
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-tmpl-home-"));
  process.env.TELAR_HOME = home;
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const { singleBuildTemplate, understandImplementCheckTemplate, pickTemplate, selectTemplate, validateWorkflow, COMPLEXITY_THRESHOLD } =
  await import("../src/thread-templates");
const { createLoom } = await import("../src/looms");
const { writeContract } = await import("../src/bundle");

let seq = 0;
function fakeLoom(over: Partial<Loom> = {}): Loom {
  seq++;
  return {
    id: `TL${seq}`,
    project: "p",
    kind: "custom",
    title: "t",
    prompt: "P",
    account: "personal",
    state: "queued",
    createdAt: 0,
    updatedAt: 0,
    attempts: [],
    error: null,
    ...over,
  } as Loom;
}

// A valid, offline-green blocker assertion shape (command → exit 0, non-live-critic,
// carries `expected`) that passes validateContract so writeContract persists it.
const blocker = (id: string) => ({ id, description: `check ${id}`, type: "command" as const, expected: "true", blocker: true });
const nonBlocker = (id: string) => ({ id, description: `check ${id}`, type: "command" as const, expected: "true", blocker: false });

describe("M9.3 template library — single-build byte-identity", () => {
  test("singleBuildTemplate is character-for-character today's default template", () => {
    expect(singleBuildTemplate(fakeLoom({ prompt: "P" }))).toEqual({
      version: 1,
      steps: [{ id: "build", goal: "P", kind: "build", agents: [], partition: "free", dependsOn: [] }],
    });
  });
});

describe("M9.3 template library — understand→implement→check 3-step shape", () => {
  test("ids / kinds / dependsOn / partition / implement.goal are the escalation DAG", () => {
    const wf = understandImplementCheckTemplate(fakeLoom({ prompt: "P" }));
    expect(wf.steps.map((s) => s.id)).toEqual(["understand", "implement", "check"]);
    expect(wf.steps.map((s) => s.kind)).toEqual(["research", "build", "check"]);
    expect(wf.steps.map((s) => s.dependsOn)).toEqual([[], ["understand"], ["implement"]]);
    expect(wf.steps[1]!.partition).toBe("disjoint-writer");
    expect(wf.steps[1]!.goal).toBe("P"); // implement carries the raw prompt (unprefixed)
    expect(wf.steps[0]!.goal).toBe("Understand: P");
    expect(wf.steps[2]!.goal).toBe("Check: P");
  });
});

describe("M9.3 selection heuristic — pickTemplate threshold (pure)", () => {
  test("escalates iff blockerCount >= COMPLEXITY_THRESHOLD (3), else single-build", () => {
    expect(COMPLEXITY_THRESHOLD).toBe(3);
    const loom = fakeLoom();
    expect(pickTemplate(loom, 0).steps.map((s) => s.id)).toEqual(["build"]);
    expect(pickTemplate(loom, 1).steps.map((s) => s.id)).toEqual(["build"]);
    expect(pickTemplate(loom, 2).steps.map((s) => s.id)).toEqual(["build"]);
    expect(pickTemplate(loom, 3).steps.map((s) => s.id)).toEqual(["understand", "implement", "check"]);
    expect(pickTemplate(loom, 5).steps.map((s) => s.id)).toEqual(["understand", "implement", "check"]);
  });
});

describe("M9.3 graph validator — validateWorkflow", () => {
  test("accepts a valid single-build and a valid 3-step graph", () => {
    expect(validateWorkflow(singleBuildTemplate(fakeLoom()))).toBe(true);
    expect(validateWorkflow(understandImplementCheckTemplate(fakeLoom()))).toBe(true);
  });

  const bstep = (id: string, dependsOn: string[] = [], kind = "build") =>
    ({ id, goal: id, kind, agents: [], partition: "free", dependsOn }) as any;

  test("rejects an empty graph", () => {
    expect(validateWorkflow({ version: 1, steps: [] } as ThreadWorkflow)).toBe(false);
  });
  test("rejects duplicate step ids", () => {
    expect(validateWorkflow({ version: 1, steps: [bstep("A"), bstep("A")] } as ThreadWorkflow)).toBe(false);
  });
  test("rejects a dependsOn pointing at a missing id", () => {
    expect(validateWorkflow({ version: 1, steps: [bstep("A", ["ghost"])] } as ThreadWorkflow)).toBe(false);
  });
  test("rejects a cyclic graph (A<->B), even with a writing step present", () => {
    expect(validateWorkflow({ version: 1, steps: [bstep("A", ["B"]), bstep("B", ["A"])] } as ThreadWorkflow)).toBe(false);
  });
  test("rejects a graph with NO writing step (all research/check)", () => {
    const noWriting = {
      version: 1,
      steps: [bstep("r", [], "research"), bstep("c", ["r"], "check")],
    } as ThreadWorkflow;
    expect(validateWorkflow(noWriting)).toBe(false);
  });
});

describe("M9.3 selection heuristic — selectTemplate reads the thread's contract from disk", () => {
  function loomWithContract(assertions: Array<ReturnType<typeof blocker> | ReturnType<typeof nonBlocker>>): Loom {
    const loom = createLoom({ project: "p", kind: "custom", title: "t", prompt: "P", account: "personal" });
    if (assertions.length) writeContract(loom.id, { version: 1, assertions });
    return loom as Loom;
  }

  test("no contract in the bundle ⇒ count defaults to 1 ⇒ single-build", () => {
    const loom = loomWithContract([]);
    expect(selectTemplate(loom).steps.map((s) => s.id)).toEqual(["build"]);
  });

  test("a valid 3-blocker contract ⇒ escalate to the 3-step template", () => {
    const loom = loomWithContract([blocker("a1"), blocker("a2"), blocker("a3")]);
    expect(selectTemplate(loom).steps.map((s) => s.id)).toEqual(["understand", "implement", "check"]);
  });

  test("only blocker===true assertions count: 2 blockers + 2 non-blockers ⇒ single-build", () => {
    const loom = loomWithContract([blocker("a1"), blocker("a2"), nonBlocker("a3"), nonBlocker("a4")]);
    expect(selectTemplate(loom).steps.map((s) => s.id)).toEqual(["build"]);
  });
});
