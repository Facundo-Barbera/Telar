// The expert-consultation seam (story 5.8 / CAP-9) — lib/workspace-expert.ts.
//
// WHAT THIS FILE OWNS, and it is narrow on purpose: the two things that layer
// adds (a project's checkout resolved from the registry, and a sentence for
// every refusal) and the one rule it exists to make structural — THE EXPERT'S
// PROJECT IS THE ITEM'S, NEVER THE CALLER'S. Everything below it is proved
// elsewhere: the pass's disk behaviour in
// packages/core/test/workspace-expert.test.ts (real TELAR_HOME, real packets),
// and the tool wrapping in workspace-mcp.test.ts.
//
// WHY THAT ONE RULE NEEDS ITS OWN SUITE. SPEC.md: "Sub-agents normally inherit
// the caller's project; in this module the master has NO project and each expert
// it calls is scoped to its own. Any agent plumbing that assumes a sub-agent
// inherits the caller's project breaks the master." The master mounts the
// workspace server UNSCOPED, so a consultation that took its scope from the
// caller would dispatch a project-less expert — and a project-less expert reads
// no digest, which is the whole capability. It is a one-line mistake and a
// silent one; these assertions are what make it loud.
//
// HARNESS: workspace-mcp.test.ts's, minus the server — mock.module is
// process-global, so the real namespace is snapshotted and restored, and the
// last test is a vacuity guard. NO STATE ROOT IS TOUCHED, and `runExpertPass` is
// doubled because the real one calls a MODEL: an omitted stub here is a paid
// provider call per test, not a slow one.
// @ts-expect-error no @types/bun in this workspace
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realCore from "@telar/core";

const realCoreSnapshot = { ...realCore };

type FakeItem = Record<string, unknown> & { id: string; title: string };

let items: FakeItem[] = [];
let projectRoots: Record<string, string> = {};
let passCalls: Array<{ req: Record<string, unknown>; deps: unknown }> = [];
let outcome: Record<string, unknown> | null = null;

const stubRunExpertPass = async (req: Record<string, unknown>, deps?: unknown) => {
  passCalls.push({ req, deps });
  return (
    outcome ?? {
      ok: true,
      project: req.project,
      verdict: "loom",
      verdictHeld: false,
      cold: true,
      digest: { project: req.project, updated: "Tue 16:42" },
      applied: {
        item: { ...(items.find((i) => i.id === req.itemId) ?? {}), verdict: "loom" },
        verdict: "loom",
        verdictHeld: false,
        events: 2,
        commitments: 0,
      },
    }
  );
};

// THE REGISTRY, AS TWO DOUBLES THAT DISAGREE ON PURPOSE. `listProjects` says
// which names the registry HOLDS (it never throws — that is why projectRoot uses
// it as its discriminator) and `getProject` says what loading one YIELDS, which
// for a registered project with a broken telar.yaml is a throw. Keeping them
// separate is what lets this suite exercise all three arms: unregistered
// (undefined), registered-and-loadable (a root), and registered-but-broken (a
// throw manifest.ts says must never be masked).
let brokenManifests: Set<string> = new Set();

mock.module("@telar/core", () => ({
  getWorkspaceItem: (id: string) => items.find((i) => i.id === id) ?? null,
  listProjects: () =>
    Object.entries(projectRoots).map(([name, root]) => ({
      entry: { name, root, addedAt: 0 },
      manifest: brokenManifests.has(name) ? null : { root },
      error: brokenManifests.has(name) ? "telar.yaml is not valid" : null,
    })),
  // The REAL getProject THROWS both for a project that is not in the registry and
  // for one whose manifest is present but malformed, and the seam depends on
  // telling those apart: the first must degrade to "no cwd" (CAP-9 says the digest
  // is enough), the second must stay loud. A double returning null instead would
  // let this suite prove a degradation the real function cannot reach.
  getProject: (name: string) => {
    const root = projectRoots[name];
    if (!root) throw new Error(`Unknown project "${name}" — not in the registry.`);
    if (brokenManifests.has(name)) throw new Error(`telar.yaml at ${root} is not a valid manifest.`);
    return { entry: { root }, manifest: { root } };
  },
  // The real sentence, not a copy of its words: this is what pins the refusal
  // consultExpert returns to the one core exports.
  floatingExpertRefusal: realCoreSnapshot.floatingExpertRefusal,
  runExpertPass: stubRunExpertPass,
}));

afterAll(() => {
  mock.module("@telar/core", () => realCoreSnapshot);
});

const { consultExpert, passSummary, projectRoot } = await import("./workspace-expert");

beforeEach(() => {
  items = [
    {
      id: "i-a1",
      title: "Exports: CSV",
      project: "aurora",
      provenance: "note",
      captured: "Tue 16:42",
      schemaVersion: 1,
    },
    { id: "i-o1", title: "Other project's", project: "borealis", provenance: "note", captured: "Tue 16:42", schemaVersion: 1 },
    { id: "i-f1", title: "Floating thought", provenance: "note", captured: "Tue 16:42", schemaVersion: 1 },
  ];
  // borealis is deliberately NOT here: the unscoped-master test below needs an
  // item whose project has no checkout on this machine.
  projectRoots = { aurora: "/tmp/aurora" };
  brokenManifests = new Set();
  passCalls = [];
  outcome = null;
});

describe("projectRoot — the registry lookup that is allowed to fail", () => {
  test("a registered project resolves to its checkout", () => {
    expect(projectRoot("aurora")).toBe("/tmp/aurora");
  });

  test("an unknown project is undefined, never a throw — CAP-9 says the DIGEST is enough", () => {
    // A mirrored project may have no clone on this machine at all, and that is
    // the case the capability is FOR. Throwing here would make "an expert
    // invoked cold works from the on-disk digest alone" false for exactly those
    // projects.
    expect(projectRoot("nowhere")).toBeUndefined();
  });

  test("a REGISTERED project with a broken manifest still throws — manifest.ts says that must never be masked", async () => {
    // The two throws getProject can raise are not the same fact, and the blanket
    // `catch { return undefined }` this replaced could not tell them apart:
    // manifest.ts, verbatim — "A present-but-malformed/schema-invalid manifest is
    // a real config error and must still throw (loadManifest surfaces it) — never
    // mask that." Masked, a project with a broken telar.yaml degraded silently to
    // a cwd-less expert that still wrote a digest, and no surface said the expert
    // never saw the tree.
    brokenManifests = new Set(["aurora"]);
    expect(() => projectRoot("aurora")).toThrow(/not a valid manifest/);
    // And the consultation carries it out rather than swallowing it: the tool
    // surface turns a throw into a sentence, a broken config is not a state a pass
    // should quietly succeed in.
    await expect(consultExpert("i-a1", "aurora")).rejects.toThrow(/not a valid manifest/);
    expect(passCalls).toEqual([]);
  });
});

describe("consultExpert — one call, scoped to the ITEM's project", () => {
  test("the master (no scope) consults about any item, and the expert is the ITEM's", async () => {
    const out = await consultExpert("i-o1", undefined);
    expect(out).toMatchObject({ ok: true });
    // borealis, not the caller's — the caller has none. This is the inverted
    // scope rule, and it is the assertion this file exists for.
    expect(passCalls[0]!.req).toMatchObject({ itemId: "i-o1", project: "borealis" });
    // No checkout registered for it: the pass still runs, without a cwd.
    expect(passCalls[0]!.req.cwd).toBeUndefined();
  });

  test("a project session may consult only its own items, and an out-of-scope id costs no pass", async () => {
    const mine = await consultExpert("i-a1", "aurora");
    expect(mine).toMatchObject({ ok: true });
    expect(passCalls[0]!.req).toMatchObject({ project: "aurora", cwd: "/tmp/aurora" });

    passCalls = [];
    const theirs = await consultExpert("i-o1", "aurora");
    const missing = await consultExpert("i-nope", "aurora");
    // THE SAME SENTENCE FOR BOTH — the anti-oracle wording the rest of the
    // workspace surface uses, so this never becomes a way to learn what another
    // project holds. And the refusal comes BEFORE the model call.
    expect(theirs).toEqual({ ok: false, reason: 'No workspace item found with id "i-o1".' });
    expect(missing).toEqual({ ok: false, reason: 'No workspace item found with id "i-nope".' });
    expect(passCalls).toEqual([]);
  });

  test("a floating item is refused with what the human can do about it", async () => {
    const out = await consultExpert("i-f1", undefined);
    expect(out).toMatchObject({ ok: false });
    const reason = (out as { reason: string }).reason;
    // Floating is a RESTING STATE (item-model.md), not an error — so the
    // sentence offers a move rather than reporting a fault, and no pass is
    // spent on an item that has no expert to answer for it.
    expect(reason).toContain("floating");
    expect(reason).toContain("File it into a project first");
    expect(passCalls).toEqual([]);
    // AND IT IS CORE'S SENTENCE, CHARACTER FOR CHARACTER — the cross-layer pin.
    // Both layers refuse a floating item (this one first, to save a registry
    // lookup), and until they shared one function they carried the same words as
    // two literals either side of a package boundary with nothing but substring
    // checks on each. Rewording one would have left every suite green.
    expect(reason).toBe(realCoreSnapshot.floatingExpertRefusal("Floating thought"));
  });

  test("the account rides through, and the test seam replaces the model call", async () => {
    const deps = { invoke: async () => null };
    await consultExpert("i-a1", "aurora", {
      account: { name: "facundo" } as never,
      deps: deps as never,
    });
    expect(passCalls[0]!.req).toMatchObject({ account: { name: "facundo" } });
    expect(passCalls[0]!.deps).toBe(deps);
  });

  test("with no deps the seam never names the live model call — core's default stands", async () => {
    await consultExpert("i-a1", "aurora");
    // `undefined`, not an object this layer composed: the one non-deterministic
    // step has exactly one definition, and it is core's.
    expect(passCalls[0]!.deps).toBeUndefined();
  });
});

describe("passSummary — the sentence every caller repeats", () => {
  const base = {
    ok: true as const,
    project: "aurora",
    verdict: "loom" as const,
    verdictHeld: false,
    cold: false,
    // The ordinary case: a registered project, so the pass had its files. The
    // no-checkout arm is its own test below.
    cwd: "/tmp/aurora",
    digest: {} as never,
    applied: { item: { verdict: "loom" }, verdict: "loom", verdictHeld: false, events: 2, commitments: 0 } as never,
  };

  test("a first pass says so rather than implying a memory it did not have", () => {
    expect(passSummary({ ...base, cold: true })).toContain("first pass");
    expect(passSummary(base)).not.toContain("first pass");
  });

  test("a pass with no checkout says so — `cold` is about the digest, not about the tree", () => {
    const { cwd, ...noTree } = base;
    // The dropped key, asserted rather than discarded: `passSummary` branches on
    // ABSENCE, so a fixture that still carried a root would prove nothing.
    expect(cwd).toBe("/tmp/aurora");
    expect("cwd" in noTree).toBe(false);
    const said = passSummary(noTree);
    // The two facts are independent: an unregistered or un-cloned project (the
    // mirrored case CAP-9 is built for) gets an expert with a digest and no files.
    // Unsaid, a master reading this summary can tell the user the expert looked at
    // the repo — the one thing this pass could not do.
    expect(said).toContain("no checkout of aurora");
    expect(said).toContain("not the project's files");
    expect(passSummary(base)).not.toContain("no checkout");
  });

  test("a held verdict is narrated as held — the model must not announce a change that did not happen", () => {
    const held = passSummary({
      ...base,
      verdictHeld: true,
      applied: { item: { verdict: "session" }, verdict: "loom", verdictHeld: true, events: 2, commitments: 0 } as never,
    });
    // CAP-9: "a human override is durable, and a later expert pass does not
    // re-flip it." Both readings are in the sentence — the expert's, and the
    // user's, which is the one that stands.
    expect(held).toContain("reads this as loom");
    expect(held).toContain("session");
    expect(held).toContain("stands");
    expect(held).not.toContain("Its advisory verdict");
  });

  test("mined commitments are counted, and the pass always ends on what it did NOT do", () => {
    const mined = passSummary({
      ...base,
      applied: { item: { verdict: "loom" }, verdict: "loom", verdictHeld: false, events: 3, commitments: 1 } as never,
    });
    expect(mined).toContain("1 time-commitment");
    expect(mined).not.toContain("1 time-commitments");
    // NFR-OW-2 in the words the model reads back. Every summary carries it,
    // held or not, cold or not.
    for (const s of [mined, passSummary(base), passSummary({ ...base, cold: true })]) {
      expect(s).toContain("Nothing was started, accepted or completed.");
    }
  });
});

// VACUITY GUARD (T2). Without this, every assertion above could be measuring
// the operator's own state root — or, for runExpertPass, a live model.
describe("the harness itself", () => {
  test("the doubles really are what the seam reached", async () => {
    const core = (await import("@telar/core")) as unknown as Record<string, unknown>;
    expect(core.runExpertPass).toBe(stubRunExpertPass);
    expect(core.runExpertPass).not.toBe(realCoreSnapshot.runExpertPass);
    expect(typeof realCoreSnapshot.runExpertPass).toBe("function");
    expect(core.getProject).not.toBe(realCoreSnapshot.getProject);
    expect(core.listProjects).not.toBe(realCoreSnapshot.listProjects);
    expect(core.getWorkspaceItem).not.toBe(realCoreSnapshot.getWorkspaceItem);
    // …EXCEPT the refusal sentence, which is the REAL one on purpose: doubling it
    // would make the cross-layer equality assertion above compare two copies of
    // this file's own words instead of core's.
    expect(core.floatingExpertRefusal).toBe(realCoreSnapshot.floatingExpertRefusal);
    expect(typeof realCoreSnapshot.floatingExpertRefusal).toBe("function");
  });
});
