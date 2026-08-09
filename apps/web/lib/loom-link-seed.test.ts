// The turn-1 loom SEED gate — every refusal, and the one that CAP-11 depends on.
//
// WHAT THIS IS DEFENDING. Story 5.5's weave writes a DRAFT loom holding a
// packet's premise and stops at the detach boundary; `start_loom`'s CONTRACT
// GATE refuses a bundle with no Verification Contract, and nothing in the
// workspace may author one. So the woven draft's ONLY route to a start button is
// a planning session that adopts it — /looms/[id]'s "Continue planning" →
// /looms/plan/<project>?loom=<id> → this gate → the planner's own
// draft_bundle_file + human-approved start_loom. If this function stops saying
// yes, the weave becomes the trap the review called it; if it starts saying yes
// too widely, a fresh planning conversation can rewrite the spec of work already
// running. Both directions are pinned below.
//
// PURE, WITH THE STORE INJECTED (INV-7's sanctioned mechanism). The reader is a
// fake, so this suite reaches no state root, and the module under test imports
// nothing at all.
// @ts-expect-error no @types/bun in this workspace
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { seedLoomIdForTurnOne, type SeedableLoom } from "./loom-link-seed";

const WEB_ROOT = new URL("../", import.meta.url);

// The store as this gate sees it: three looms in "aurora", one in "office".
const LOOMS: Record<string, SeedableLoom> = {
  "loom-draft": { project: "aurora", draft: true },
  "loom-running": { project: "aurora" },
  "loom-done": { project: "aurora", draft: false },
  "loom-foreign-draft": { project: "office", draft: true },
};

// Counts its own calls, so "the read happens once, and only after the cheap
// checks pass" is a measurement rather than a claim.
let reads: string[] = [];
const readLoom = (id: string): SeedableLoom => {
  reads.push(id);
  return LOOMS[id] ?? null;
};

const seed = (over: Partial<Parameters<typeof seedLoomIdForTurnOne>[0]> = {}) => {
  reads = [];
  return seedLoomIdForTurnOne(
    { hasExistingChat: false, role: "planner", rawLoomId: "loom-draft", project: "aurora", ...over },
    readLoom,
  );
};

describe("a planner adopts a DRAFT — the workspace weave's only door", () => {
  test("a fresh planner bound to a draft of its own project adopts it", () => {
    expect(seed()).toBe("loom-draft");
    expect(reads).toEqual(["loom-draft"]);
  });

  test("a planner may NOT adopt a loom that is already running — that is the steerer's job", () => {
    // THE LOAD-BEARING REFUSAL. A planning session writes bundle files and a
    // Verification Contract into whatever it is bound to, so binding one to live
    // work would let a fresh conversation rewrite the spec of a run in flight.
    expect(seed({ rawLoomId: "loom-running" })).toBeUndefined();
    // `draft: false` is the same answer as `draft` absent — the check is
    // `!== true`, so a loom that was started (startLoomFromBundle clears the
    // flag) cannot be re-adopted either.
    expect(seed({ rawLoomId: "loom-done" })).toBeUndefined();
  });

  test("a STEERER and an ESCALATION bind to a live loom, which is what they are for", () => {
    // The draft rule is planner-only, deliberately: these two roles exist to
    // talk ABOUT a loom that is running or blocked.
    expect(seed({ role: "steerer", rawLoomId: "loom-running" })).toBe("loom-running");
    expect(seed({ role: "escalation", rawLoomId: "loom-running" })).toBe("loom-running");
    // …and they may bind to a draft too — nothing about them narrows further.
    expect(seed({ role: "steerer", rawLoomId: "loom-draft" })).toBe("loom-draft");
  });

  test("never someone else's loom, whatever the role", () => {
    for (const role of ["planner", "steerer", "escalation"]) {
      expect(seed({ role, rawLoomId: "loom-foreign-draft" })).toBeUndefined();
    }
  });

  test("an id that resolves to nothing fails SAFE — a fresh session, never an error", () => {
    // AD-8's weak reference: getLoom answers null for a deleted id and for a
    // traversal-shaped one alike, and both land here as "as if no id was sent".
    expect(seed({ rawLoomId: "loom-deleted" })).toBeUndefined();
    expect(seed({ rawLoomId: "../../etc/passwd" })).toBeUndefined();
  });
});

describe("what is never consulted at all", () => {
  test("a RESUMED chat ignores the wire id entirely — and does not even read the store", () => {
    // The resumed chat's own persisted link wins upstream. If this returned an
    // id, a client holding a stale `?loom=` in its URL could re-point a
    // conversation mid-life.
    expect(seed({ hasExistingChat: true })).toBeUndefined();
    expect(reads).toEqual([]);
  });

  test("a role that may not arrive pre-bound is refused BEFORE the read", () => {
    // A plain project session and 5.6's project-less master are both here: the
    // master mounts no loom server and has no project, and neither may bind
    // itself to a loom by sending one field.
    for (const role of [undefined, "", "project", "master", "PLANNER"]) {
      expect(seed({ role })).toBeUndefined();
    }
    expect(reads).toEqual([]);
  });

  test("a missing or non-string loomId is refused before the read", () => {
    for (const rawLoomId of [undefined, null, "", 7, {}, ["loom-draft"]]) {
      expect(seed({ rawLoomId })).toBeUndefined();
    }
    expect(reads).toEqual([]);
  });

  test("a project-less session can never adopt, even if the loom would match", () => {
    // Belt and braces with the role check: `master` is not seedable, and a
    // session with no anchoring project is refused on its own terms — so a loom
    // whose own project field were somehow absent could not slip through by
    // matching `undefined === undefined`.
    expect(seed({ project: undefined })).toBeUndefined();
    expect(seed({ project: "" })).toBeUndefined();
    expect(reads).toEqual([]);
  });
});

describe("the route really goes through this gate", () => {
  test("the chat route calls it, and keeps no second copy of the conjuncts", () => {
    // A pure predicate nobody calls is the classic two-pass residue, and this
    // one's whole value is that route.ts stopped spelling the rule itself.
    const route = readFileSync(new URL("app/api/chat/route.ts", WEB_ROOT), "utf8");
    expect(route).toContain('from "@/lib/loom-link-seed"');
    expect(route).toContain("seedLoomIdForTurnOne(");
    // The old inline shape, gone: no second `l.draft === true` / role-triple
    // test living beside the call.
    expect(route).not.toMatch(/l\.draft === true/);
  });
});
