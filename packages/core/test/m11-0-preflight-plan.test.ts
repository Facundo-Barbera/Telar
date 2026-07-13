// M11.0 (docs/adaptive-verification.md §3.2, §7) — the pre-flight REFRAME:
// proceed-and-defer + escalate-last-resort. Fakes only (no live agent, no live
// server; tmp dirs fs-removed). Proves, end to end through startLoom:
//   A. proceed-on-signal — a live-critic contract that would have parked under
//      M10.4 now PROCEEDS when a non-server plan is formable: brownfield
//      (package.json test script) AND greenfield (gate-mechanism charter intent
//      only, the loom_mrigs3zo_vxgrsr shape). Proceeding is NOT unconditional:
//      a verifier-mechanism greenfield still parks (last resort preserved).
//   B. the park is the LAST RESORT with STRATEGY-DERIVED copy — a library is
//      asked for a test command (never a dev command), a web deliverable keeps
//      today's dev-command ask verbatim, unknown asks openly; the blockedReason
//      reports what the signal checked ("after trying + reporting what it tried").
//   C. no spend before the decision — a park fires ZERO builders/children and
//      never consults the scoping LLM; the signal read is bounded to the top
//      level (a nested package.json cannot widen viability — no recursion).
//   D. no double-fire — a plannable deliverable + setupAgent ON dispatches
//      exactly once (the proceed short-circuit and the setup-agent operand
//      cannot both park/provision); unplannable + setupAgent ON still defers to
//      the setup agent exactly as M10.4 (zero lane-escalation events).
//   E. flag-off byte-identical — laneEscalation OFF never parks and never
//      surfaces signal-derived copy, plannable or not.
//   F. isLaneViable (pure) — the widened third true-path: filesystem signal
//      fires even on the 2-arg legacy call; charter gate intent needs the new
//      optional 3rd param; the widening only ADDS viability (empty root + no
//      intent is still unviable).
//   G. accept-guard consistency — an accepted devCommand answer to a
//      strategy-derived park re-dispatches and can NEVER re-park (the widening
//      is one-directional: it only adds viable paths, so isLaneViable still
//      accepts everything the answerBlocked guard accepts).
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-m110-home-"));
process.env.TELAR_HOME = home;
beforeEach(() => {
  process.env.TELAR_HOME = home;
  delete process.env.TELAR_LANE_ESCALATION;
  delete process.env.TELAR_SETUP_AGENT;
});
afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.TELAR_LANE_ESCALATION;
  delete process.env.TELAR_SETUP_AGENT;
});

const { answerBlocked, startLoom } = await import("../src/dispatcher");
const { isLaneViable } = await import("../src/executor");
const { getLoom, listChildLooms, readEvents } = await import("../src/looms");
const { createProject, getProject } = await import("../src/manifest");
const { ProjectManifest } = await import("../src/schemas");
import type { Loom } from "../src/looms";
import type { Charter, ContractAssertion } from "../src/schemas";

let n = 0;
// A real on-disk project root, optionally pre-seeded with files/dirs BEFORE
// startLoom so the pre-flight's deliverable signal reads real evidence.
function makeProject(
  partial: Record<string, unknown> = {},
  files: Record<string, string> = {},
  dirs: string[] = [],
) {
  n++;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `telar-m110-proj-${n}-`));
  for (const d of dirs) fs.mkdirSync(path.join(root, d), { recursive: true });
  for (const [name, contents] of Object.entries(files)) fs.writeFileSync(path.join(root, name), contents);
  const m = createProject(root, { name: `m110-${n}`, ...partial });
  return { name: m.name, root, manifest: m };
}

const pkg = (json: Record<string, unknown>) => JSON.stringify(json, null, 2);

// A fake runLoomFn (records builder spend) + a draftCharterFn TRIPWIRE: every
// start below supplies acceptanceCriteria or a charter, so the scoping LLM must
// NEVER be consulted — the M11.0 no-spend guarantee is "zero LLM, zero builder
// before the pre-flight decision", and `scoped` proves the LLM half.
function fakeDeps() {
  let calls = 0;
  let scoped = false;
  const runLoomFn = async (l: Loom) => {
    calls++;
    l.state = "ready";
    return l;
  };
  const draftCharterFn = async () => {
    scoped = true;
    throw new Error("scoping LLM must never run in the M11.0 pre-flight tests");
  };
  return {
    deps: { accounts: {}, runLoomFn, draftCharterFn } as any,
    get calls() { return calls; },
    get scoped() { return scoped; },
  };
}

// Prose acceptance criteria synthesize to a live-critic assertion (agentJudged
// non-empty ⇒ a live target is needed) — the exact shape that parked the
// loom_mrigs3zo_vxgrsr prove-run at the M10.4 pre-flight.
const LIVE_AC = ["arithmetic expressions evaluate correctly end to end"];

// A minimal NON-woven charter carrying the gate-mechanism proof intent
// (PROOF_TEMPLATES.quickfix.verifyMechanism === "gate"): ensureWoven keeps its
// proofStrategy when it wraps the loom into a weave-of-one, so the pre-flight's
// deriveDeliverableSignal sees the greenfield "deferred-gate" intent.
const gateCharter: Charter = {
  objective: "greenfield arithmetic-expression library",
  proofStrategy: "quickfix",
  scope: { allowedPaths: [], forbiddenPaths: [] },
  budget: { maxParallelThreads: 1, maxAgents: 12, maxCriticAgents: 3 },
  decomposition: [],
  version: 1,
};

async function settle() {
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 20));
}

// ── A. proceed-on-signal ─────────────────────────────────────────────────────
describe("pre-flight proceeds when a non-server plan is formable", () => {
  test("brownfield: package.json test script → PROCEEDS (no park, children spawn)", async () => {
    const { name } = makeProject(
      { laneEscalation: true },
      { "package.json": pkg({ name: "lib", main: "index.js", scripts: { test: "bun test" } }), "bun.lock": "" },
    );
    const f = fakeDeps();
    const loom = startLoom({ project: name, kind: "custom", title: "t", prompt: "x", acceptanceCriteria: LIVE_AC }, f.deps);
    await settle();
    const after = getLoom(loom.id)!;
    expect(after.state).not.toBe("blocked"); // M10.4 would have parked here
    expect(after.blockedQuestion).toBeUndefined();
    expect(f.calls).toBeGreaterThanOrEqual(1); // the build actually proceeded
    const { events } = readEvents(loom.id);
    expect(events.filter((e) => e.type === "lane-escalation").length).toBe(0);
  });

  test("greenfield: EMPTY root + gate-mechanism charter intent → PROCEEDS (the prove-run case)", async () => {
    // "Greenfield" = no deliverable evidence: createProject scaffolds only the
    // telar.yaml manifest, which the pure signal never reads as evidence.
    const { name, root } = makeProject({ laneEscalation: true });
    expect(fs.existsSync(path.join(root, "package.json"))).toBe(false);
    const f = fakeDeps();
    const loom = startLoom(
      { project: name, kind: "custom", title: "t", prompt: "build the library", acceptanceCriteria: LIVE_AC, charter: gateCharter },
      f.deps,
    );
    await settle();
    const after = getLoom(loom.id)!;
    expect(after.state).not.toBe("blocked"); // deferred-gate: establish when the artifact appears
    expect(f.calls).toBeGreaterThanOrEqual(1);
    expect(f.scoped).toBe(false);
  });

  test("proceeding is NOT unconditional: greenfield with NO gate intent still parks (last resort intact)", async () => {
    // ensureWoven's default charter is proofStrategy "custom" → verifyMechanism
    // "verifier" → no deferred-gate plan → the park stays reachable.
    const { name } = makeProject({ laneEscalation: true });
    const f = fakeDeps();
    const loom = startLoom({ project: name, kind: "custom", title: "t", prompt: "x", acceptanceCriteria: LIVE_AC }, f.deps);
    await settle();
    expect(getLoom(loom.id)!.state).toBe("blocked");
    expect(f.calls).toBe(0);
  });
});

// ── B. the park is the LAST RESORT with strategy-derived copy ────────────────
describe("last-resort park asks for what the derived strategy needs", () => {
  test("library-shaped but unplannable → asks for a TEST command, never a dev command", async () => {
    // A package entry point but only the npm scaffold placeholder test script:
    // library shape, no formable plan.
    const { name } = makeProject(
      { laneEscalation: true },
      { "package.json": pkg({ name: "lib", main: "index.js", scripts: { test: 'echo "Error: no test specified" && exit 1' } }) },
    );
    const f = fakeDeps();
    const loom = startLoom({ project: name, kind: "custom", title: "t", prompt: "x", acceptanceCriteria: LIVE_AC }, f.deps);
    await settle();
    const after = getLoom(loom.id)!;
    expect(after.state).toBe("blocked");
    expect(after.blockedQuestion).toContain("test command");
    expect(after.blockedQuestion).not.toContain("dev command"); // never the web-shaped ask
    // The reason reports what was tried (doc §3.2 "after trying + reporting").
    expect(after.blockedReason).toContain("No verification plan can be formed");
    expect(after.blockedReason).toContain("no non-server verification strategy is derivable");
  });

  test("web-shaped deliverable keeps today's dev-command ask verbatim", async () => {
    const { name } = makeProject(
      { laneEscalation: true },
      { "package.json": pkg({ name: "app", scripts: { dev: "next dev" } }) },
    );
    const f = fakeDeps();
    const loom = startLoom({ project: name, kind: "custom", title: "t", prompt: "x", acceptanceCriteria: LIVE_AC }, f.deps);
    await settle();
    const after = getLoom(loom.id)!;
    expect(after.state).toBe("blocked");
    expect(after.blockedQuestion).toContain("dev command");
    expect(after.blockedQuestion).toContain("servers recipe");
    expect(after.blockedReason).toContain("web-shaped");
  });

  test("unknown greenfield asks openly for a verification command first", async () => {
    const { name } = makeProject({ laneEscalation: true });
    const f = fakeDeps();
    const loom = startLoom({ project: name, kind: "custom", title: "t", prompt: "x", acceptanceCriteria: LIVE_AC }, f.deps);
    await settle();
    const after = getLoom(loom.id)!;
    expect(after.state).toBe("blocked");
    expect(after.blockedQuestion).toContain("verification command");
  });
});

// ── C. no spend before the decision ──────────────────────────────────────────
describe("the pre-flight decision itself spends nothing", () => {
  test("a park fires ZERO builders, ZERO children, and never consults the scoping LLM", async () => {
    const { name } = makeProject({ laneEscalation: true });
    const f = fakeDeps();
    const loom = startLoom({ project: name, kind: "custom", title: "t", prompt: "x", acceptanceCriteria: LIVE_AC }, f.deps);
    await settle();
    expect(getLoom(loom.id)!.state).toBe("blocked");
    expect(f.calls).toBe(0); // no builder ran
    expect(f.scoped).toBe(false); // no LLM ran
    expect(listChildLooms(loom.id).length).toBe(0); // no child forked
    expect(getLoom(loom.id)!.baseSha).toBeUndefined(); // parked BEFORE any pin/branch
    const { events } = readEvents(loom.id);
    expect(events.filter((e) => e.type === "lane-escalation").length).toBe(1); // exactly one park
  });

  test("the signal read is BOUNDED to the top level: a nested package.json cannot widen viability", async () => {
    // A perfectly plannable package.json one directory down: the pure signal
    // must NOT recurse into it (purity/no-spend — one top-level readdir), so
    // the pre-flight still parks.
    const { name, root } = makeProject({ laneEscalation: true }, {}, ["packages/lib"]);
    fs.writeFileSync(
      path.join(root, "packages/lib/package.json"),
      pkg({ name: "lib", scripts: { test: "bun test" } }),
    );
    const f = fakeDeps();
    const loom = startLoom({ project: name, kind: "custom", title: "t", prompt: "x", acceptanceCriteria: LIVE_AC }, f.deps);
    await settle();
    expect(getLoom(loom.id)!.state).toBe("blocked");
    expect(f.calls).toBe(0);
  });
});

// ── D. no setupAgent double-fire ─────────────────────────────────────────────
describe("proceed path and setupAgent never double-fire", () => {
  test("plannable + setupAgent OFF → dispatches EXACTLY once (one child, one run — no second fire)", async () => {
    // The proceed path alone must be a SINGLE dispatch: one weave-of-one child,
    // one builder run, zero parks.
    const { name } = makeProject(
      { laneEscalation: true },
      { "package.json": pkg({ name: "lib", main: "index.js", scripts: { test: "bun test" } }) },
    );
    const f = fakeDeps();
    const loom = startLoom({ project: name, kind: "custom", title: "t", prompt: "x", acceptanceCriteria: LIVE_AC }, f.deps);
    await settle();
    const after = getLoom(loom.id)!;
    expect(after.state).not.toBe("blocked");
    expect(f.calls).toBe(1); // a weave-of-one runs its single child exactly once
    expect(listChildLooms(loom.id).length).toBe(1);
    expect(readEvents(loom.id).events.filter((e) => e.type === "lane-escalation").length).toBe(0);
  });

  test("plannable + setupAgent ON → the gate short-circuits at !isLaneViable: never a park, never a double park event", async () => {
    // With BOTH the proceed signal and the setupAgent auto-provision path
    // available, neither may fire a park: isLaneViable is TRUE (test-gate
    // signal), so the pre-flight condition short-circuits before the setupAgent
    // operand ever decides — exactly zero lane-escalation events, no blocked
    // state, regardless of what the M5 preparing-window setup then does.
    const { name } = makeProject(
      { laneEscalation: true, setupAgent: true },
      { "package.json": pkg({ name: "lib", main: "index.js", scripts: { test: "bun test" } }) },
    );
    const f = fakeDeps();
    const loom = startLoom({ project: name, kind: "custom", title: "t", prompt: "x", acceptanceCriteria: LIVE_AC }, f.deps);
    await settle();
    const after = getLoom(loom.id)!;
    expect(after.state).not.toBe("blocked");
    expect(after.blockedQuestion).toBeUndefined();
    expect(readEvents(loom.id).events.filter((e) => e.type === "lane-escalation").length).toBe(0);
  });

  test("UNplannable + setupAgent ON → still defers to the setup agent (M10.4 behavior preserved)", async () => {
    const { name } = makeProject({ laneEscalation: true, setupAgent: true });
    const f = fakeDeps();
    const loom = startLoom({ project: name, kind: "custom", title: "t", prompt: "x", acceptanceCriteria: LIVE_AC }, f.deps);
    await settle();
    const after = getLoom(loom.id)!;
    expect(after.state).not.toBe("blocked"); // the auto-provision path exists — never park over it
    expect(readEvents(loom.id).events.filter((e) => e.type === "lane-escalation").length).toBe(0);
  });
});

// ── E. flag-off byte-identical ───────────────────────────────────────────────
describe("laneEscalation OFF: the signal changes nothing", () => {
  test("flag OFF + plannable root → proceeds exactly as today (no park, no signal copy)", async () => {
    const { name } = makeProject(
      { laneEscalation: false },
      { "package.json": pkg({ name: "lib", main: "index.js", scripts: { test: "bun test" } }) },
    );
    const f = fakeDeps();
    const loom = startLoom({ project: name, kind: "custom", title: "t", prompt: "x", acceptanceCriteria: LIVE_AC }, f.deps);
    await settle();
    const after = getLoom(loom.id)!;
    expect(after.state).not.toBe("blocked");
    expect(after.blockedQuestion).toBeUndefined();
    expect(after.blockedReason).toBeUndefined();
    expect(f.calls).toBeGreaterThanOrEqual(1);
  });

  test("flag OFF + UNplannable root → still never parks (byte-identical to today)", async () => {
    const { name } = makeProject({ laneEscalation: false });
    const f = fakeDeps();
    const loom = startLoom({ project: name, kind: "custom", title: "t", prompt: "x", acceptanceCriteria: LIVE_AC }, f.deps);
    await settle();
    const after = getLoom(loom.id)!;
    expect(after.state).not.toBe("blocked");
    expect(after.blockedQuestion).toBeUndefined();
    expect(readEvents(loom.id).events.filter((e) => e.type === "lane-escalation").length).toBe(0);
    expect(f.calls).toBeGreaterThanOrEqual(1);
  });
});

// ── F. isLaneViable — the widened pure predicate ─────────────────────────────
describe("isLaneViable third true-path (pure, backward-compatible)", () => {
  const liveCritic: ContractAssertion[] = [
    { id: "g", subGoalId: "ALL", description: "cmd", type: "command", expected: "echo ok", blocker: true },
    { id: "lc", subGoalId: "ALL", description: "flow", type: "live-critic", observable: "flow works", blocker: true },
  ];
  const tmp = (files: Record<string, string> = {}) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-m110-viable-"));
    for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(root, f), c);
    return root;
  };

  test("filesystem signal fires even on the legacy 2-arg call (charter optional)", () => {
    const root = tmp({ "package.json": pkg({ scripts: { test: "bun test" } }) });
    const manifest = ProjectManifest.parse({ name: "v", root });
    expect(isLaneViable(manifest, liveCritic)).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("greenfield charter gate intent needs the 3rd param — and fires with it", () => {
    const root = tmp();
    const manifest = ProjectManifest.parse({ name: "v", root });
    expect(isLaneViable(manifest, liveCritic)).toBe(false); // 2-arg: no intent visible
    expect(isLaneViable(manifest, liveCritic, { proofStrategy: "quickfix" })).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("the widening only ADDS viability: empty root + verifier-mechanism charter stays unviable", () => {
    const root = tmp();
    const manifest = ProjectManifest.parse({ name: "v", root });
    expect(isLaneViable(manifest, liveCritic, { proofStrategy: "verifier-criteria" })).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("web-shaped root stays unviable (the conservative short-circuit reaches the predicate)", () => {
    const root = tmp({ "package.json": pkg({ scripts: { dev: "next dev", test: "bun test" } }) });
    const manifest = ProjectManifest.parse({ name: "v", root });
    expect(isLaneViable(manifest, liveCritic, { proofStrategy: "quickfix" })).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

// ── G. accept-guard consistency — no accepted-answer re-park loop ────────────
describe("answerBlocked stays consistent with the WIDENED isLaneViable", () => {
  test("a devCommand answer to a strategy-derived park re-dispatches and does NOT re-park", async () => {
    // Park through the REAL pre-flight (library-shaped, unplannable), then
    // answer with a devCommand: the widening only ever ADDS viable paths, so an
    // answer the guard accepts still satisfies isLaneViable path 2 verbatim —
    // the accepted-but-never-resolves loop the guard prevents cannot return.
    const { name } = makeProject(
      { laneEscalation: true },
      { "package.json": pkg({ name: "lib", main: "index.js" }) },
    );
    const f = fakeDeps();
    const loom = startLoom({ project: name, kind: "custom", title: "t", prompt: "x", acceptanceCriteria: LIVE_AC }, f.deps);
    await settle();
    expect(getLoom(loom.id)!.state).toBe("blocked");
    expect(getLoom(loom.id)!.blockedQuestion).toContain("test command"); // the strategy-derived ask

    const ok = await answerBlocked(loom.id, "you", { devCommand: "bun run dev" }, f.deps);
    expect(ok).toBe(true);
    await settle();
    const after = getLoom(loom.id)!;
    expect(after.state).not.toBe("blocked"); // never re-parks after a real accept
    expect(after.blockedQuestion).toBeUndefined();
    expect(getProject(name).manifest.devCommand).toBe("bun run dev"); // persisted — the next loom never re-asks
    expect(f.calls).toBeGreaterThanOrEqual(1); // the re-dispatch actually ran
  });

  test("the STRATEGY answer (verifyCommand) is accepted, persisted to telar.yaml, and never re-parks", async () => {
    // The strategy-derived ask ("what command proves this package?") is now
    // ANSWERABLE with exactly what it asks for: a test command. The answer
    // persists as manifest.verifyCommand — NEVER devCommand, so the M5
    // auto-spin can never run a test suite as a dev server — and isLaneViable's
    // verifyCommand path makes the re-dispatch proceed (consistency invariant).
    const { name } = makeProject(
      { laneEscalation: true },
      { "package.json": pkg({ name: "lib", main: "index.js" }) },
    );
    const f = fakeDeps();
    const loom = startLoom({ project: name, kind: "custom", title: "t", prompt: "x", acceptanceCriteria: LIVE_AC }, f.deps);
    await settle();
    expect(getLoom(loom.id)!.state).toBe("blocked");
    expect(getLoom(loom.id)!.blockedQuestion).toContain("test command");

    const ok = await answerBlocked(loom.id, "you", { verifyCommand: "bun test" }, f.deps);
    expect(ok).toBe(true);
    await settle();
    const after = getLoom(loom.id)!;
    expect(after.state).not.toBe("blocked"); // accepted answers never re-park
    expect(after.blockedQuestion).toBeUndefined();
    const persisted = getProject(name).manifest;
    expect(persisted.verifyCommand).toBe("bun test"); // promoted — a future loom never re-asks
    expect(persisted.devCommand).toBeUndefined(); // NEVER promoted as a dev server
    expect(f.calls).toBeGreaterThanOrEqual(1); // the re-dispatch actually ran
  });

  test("isLaneViable: a persisted verifyCommand is a viable path (pure, no filesystem signal needed)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-m110-vc-"));
    const liveCriticOnly: ContractAssertion[] = [
      { id: "lc", subGoalId: "ALL", description: "flow", type: "live-critic", observable: "flow works", blocker: true },
    ];
    const bare = ProjectManifest.parse({ name: "v", root });
    expect(isLaneViable(bare, liveCriticOnly)).toBe(false);
    const answered = ProjectManifest.parse({ name: "v", root, verifyCommand: "bun test" });
    expect(isLaneViable(answered, liveCriticOnly)).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("a viability-free answer is still refused (fail-closed, no accept-then-re-park)", async () => {
    const { name } = makeProject(
      { laneEscalation: true },
      { "package.json": pkg({ name: "lib", main: "index.js" }) },
    );
    const f = fakeDeps();
    const loom = startLoom({ project: name, kind: "custom", title: "t", prompt: "x", acceptanceCriteria: LIVE_AC }, f.deps);
    await settle();
    expect(getLoom(loom.id)!.state).toBe("blocked");

    const ok = await answerBlocked(loom.id, "you", { runbook: "just trust the tests" }, f.deps);
    expect(ok).toBe(false); // rejected — never accepted-then-re-parked
    expect(getLoom(loom.id)!.state).toBe("blocked"); // draft intact, still answerable
    expect(f.calls).toBe(0);
  });
});
