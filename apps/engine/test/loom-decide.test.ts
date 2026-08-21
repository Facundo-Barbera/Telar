/**
 * What the machinery refuses, and why it says so out loud.
 *
 * Every drop asserted here also asserts a `rejected` sentence. A silent drop is
 * the failure this file exists to prevent: "the orchestrator did not dispatch
 * #457" and "the orchestrator asked to dispatch #457 and was refused" are
 * indistinguishable in an empty result and mean completely different things.
 *
 * `slugify` is tested adversarially because its output reaches `git worktree
 * add` and a shell — Spanish, emoji, punctuation-only and absurd length are all
 * real inputs from a real backlog.
 */
import { describe, expect, test } from "bun:test";
import type { Loom } from "@telar/engine-client";
import { slugify, validateDecision, type TickContext } from "../src/loom/decide";

const at = 1_700_000_000_000;

const loom = (id: string, item: string, state: Loom["state"]): Loom => ({
  id,
  projectId: "proj_1",
  item,
  title: item,
  state,
  attempts: 0,
  ladderRung: 0,
  createdAt: at,
  updatedAt: at,
});

const ctx = (looms: Loom[], concurrency = 4): TickContext => ({ looms, concurrency });

const dispatchOf = (item: string, title = `work on ${item}`) => ({ item, title, branchSlug: "", brief: "" });

describe("triage survives everything else", () => {
  test("a good classification lands even when the rest of the decision is refused", () => {
    const { decision, rejected } = validateDecision(
      {
        triage: [{ item: "#457", classification: "needs-decision", reason: "JMB's call", ask: "decide 2 and 3" }],
        park: [{ loomId: "loom_nope", reason: "gone" }],
      },
      ctx([]),
    );
    expect(decision.triage).toHaveLength(1);
    expect(decision.park).toEqual([]);
    expect(rejected).toHaveLength(1);
  });

  test("a malformed triage row is dropped on its own and reported", () => {
    const { decision, rejected } = validateDecision(
      {
        triage: [
          { item: "#1", classification: "dispatchable", reason: "clear" },
          { item: "#2", classification: "blocked", reason: "not a classification" },
          { classification: "done", reason: "no item" },
        ],
      },
      ctx([]),
    );
    expect(decision.triage.map((t) => t.item)).toEqual(["#1"]);
    expect(rejected).toHaveLength(2);
    expect(rejected.every((r) => r.includes("triage"))).toBe(true);
  });
});

describe("an item may not have two looms", () => {
  test("a dispatch for an item with a live loom is refused, and named", () => {
    const { decision, rejected } = validateDecision(
      { dispatch: [dispatchOf("#457")] },
      ctx([loom("loom_1", "#457", "working")]),
    );
    expect(decision.dispatch).toEqual([]);
    expect(rejected[0]).toContain("#457");
    expect(rejected[0]).toContain("loom_1");
    expect(rejected[0]).toContain("working");
  });

  test("every non-terminal state blocks, including stuck and asking", () => {
    for (const state of ["queued", "working", "gating", "publishing", "stuck", "asking"] as const) {
      const { decision } = validateDecision({ dispatch: [dispatchOf("#1")] }, ctx([loom("l", "#1", state)]));
      expect(decision.dispatch).toEqual([]);
    }
  });

  test("a TERMINAL loom does not block — an item that came back is new work", () => {
    for (const state of ["published", "parked", "cancelled"] as const) {
      const { decision, rejected } = validateDecision(
        { dispatch: [dispatchOf("#1")] },
        ctx([loom("l", "#1", state)]),
      );
      expect(decision.dispatch).toHaveLength(1);
      expect(rejected).toEqual([]);
    }
  });

  test("the same item proposed twice in one tick keeps the first", () => {
    const { decision, rejected } = validateDecision(
      { dispatch: [dispatchOf("#1", "first"), dispatchOf("#1", "second")] },
      ctx([]),
    );
    expect(decision.dispatch).toHaveLength(1);
    expect(decision.dispatch[0]?.title).toBe("first");
    expect(rejected[0]).toContain("proposed twice");
  });
});

describe("concurrency is a ceiling no tick may raise", () => {
  test("dispatches beyond the limit are dropped, in list order", () => {
    const { decision, rejected } = validateDecision(
      { dispatch: [dispatchOf("#1"), dispatchOf("#2"), dispatchOf("#3")] },
      ctx([], 2),
    );
    expect(decision.dispatch.map((d) => d.item)).toEqual(["#1", "#2"]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toContain("#3");
    expect(rejected[0]).toContain("concurrency 2");
  });

  test("in-flight looms count against the limit", () => {
    const inFlight = [loom("l1", "#a", "working"), loom("l2", "#b", "gating"), loom("l3", "#c", "queued")];
    const { decision, rejected } = validateDecision(
      { dispatch: [dispatchOf("#1"), dispatchOf("#2")] },
      ctx(inFlight, 4),
    );
    expect(decision.dispatch.map((d) => d.item)).toEqual(["#1"]);
    expect(rejected[0]).toContain("3 in flight");
  });

  test("terminal looms do NOT count against it", () => {
    const done = [loom("l1", "#a", "published"), loom("l2", "#b", "parked"), loom("l3", "#c", "cancelled")];
    const { decision } = validateDecision({ dispatch: [dispatchOf("#1"), dispatchOf("#2")] }, ctx(done, 2));
    expect(decision.dispatch).toHaveLength(2);
  });

  test("a full queue drops everything and says why for each one", () => {
    const full = [loom("l1", "#a", "working"), loom("l2", "#b", "working")];
    const { decision, rejected } = validateDecision(
      { dispatch: [dispatchOf("#1"), dispatchOf("#2")] },
      ctx(full, 2),
    );
    expect(decision.dispatch).toEqual([]);
    expect(rejected).toHaveLength(2);
  });

  test("concurrency 0 is a pause, not a bug", () => {
    const { decision, rejected } = validateDecision({ dispatch: [dispatchOf("#1")] }, ctx([], 0));
    expect(decision.dispatch).toEqual([]);
    expect(rejected).toHaveLength(1);
  });
});

describe("park and ask must name a loom that exists", () => {
  const looms = [loom("loom_1", "#1", "stuck"), loom("loom_2", "#2", "published")];

  test("a park for an unknown loom is refused", () => {
    const { decision, rejected } = validateDecision({ park: [{ loomId: "loom_x", reason: "?" }] }, ctx(looms));
    expect(decision.park).toEqual([]);
    expect(rejected[0]).toContain("loom_x");
    expect(rejected[0]).toContain("no such loom");
  });

  test("a park of an already-terminal loom is refused — it would overwrite an outcome", () => {
    const { decision, rejected } = validateDecision(
      { park: [{ loomId: "loom_2", reason: "changed my mind" }] },
      ctx(looms),
    );
    expect(decision.park).toEqual([]);
    expect(rejected[0]).toContain("published");
  });

  test("a park of a live loom lands", () => {
    const { decision, rejected } = validateDecision(
      { park: [{ loomId: "loom_1", reason: "conflicts with #409" }] },
      ctx(looms),
    );
    expect(decision.park).toHaveLength(1);
    expect(rejected).toEqual([]);
  });

  test("an ask for an unknown loom is refused", () => {
    const { decision, rejected } = validateDecision(
      { ask: [{ loomId: "loom_x", question: "what now?", why: "" }] },
      ctx(looms),
    );
    expect(decision.ask).toEqual([]);
    expect(rejected[0]).toContain("no such loom");
  });

  test("an ask with NO loom id is legal — the best questions have no loom", () => {
    const { decision, rejected } = validateDecision(
      {
        ask: [
          { item: "#464", question: "do you want a throwaway Ads campaign?", why: "needs live quota" },
          { question: "which branch should PRs target?", why: "the Program says main" },
        ],
      },
      ctx(looms),
    );
    expect(decision.ask).toHaveLength(2);
    expect(rejected).toEqual([]);
  });
});

describe("the branch slug is normalized, never trusted", () => {
  test("a model-authored slug is re-slugified", () => {
    const { decision } = validateDecision(
      { dispatch: [{ item: "#1", title: "t", branchSlug: "../../etc/passwd", brief: "" }] },
      ctx([]),
    );
    expect(decision.dispatch[0]?.branchSlug).toBe("etc-passwd");
  });

  test("an empty slug falls back to the title", () => {
    const { decision } = validateDecision({ dispatch: [dispatchOf("#457", "Fix the login redirect")] }, ctx([]));
    expect(decision.dispatch[0]?.branchSlug).toBe("fix-the-login-redirect");
  });

  test("an unusable title falls back to the item ref", () => {
    const { decision } = validateDecision({ dispatch: [dispatchOf("#457", "🔥🔥🔥")] }, ctx([]));
    expect(decision.dispatch[0]?.branchSlug).toBe("457");
  });
});

describe("degrade, never throw", () => {
  test("a non-object payload returns an empty decision plus a reason", () => {
    for (const raw of [null, undefined, "a string", 42, [], true]) {
      const { decision, rejected } = validateDecision(raw, ctx([]));
      expect(decision).toEqual({ triage: [], dispatch: [], park: [], ask: [], note: "" });
      expect(rejected).toHaveLength(1);
    }
  });

  test("a field that should be a list but is not is ignored, loudly", () => {
    const { decision, rejected } = validateDecision({ dispatch: "everything", triage: {} }, ctx([]));
    expect(decision.dispatch).toEqual([]);
    expect(rejected).toHaveLength(2);
    expect(rejected.some((r) => r.includes("not a list"))).toBe(true);
  });

  test("a missing field is simply empty, with no complaint", () => {
    const { decision, rejected } = validateDecision({ note: "quiet tick" }, ctx([]));
    expect(decision.note).toBe("quiet tick");
    expect(rejected).toEqual([]);
  });

  test("a non-string note is ignored rather than stringified into the ledger", () => {
    const { decision, rejected } = validateDecision({ note: { text: "hi" } }, ctx([]));
    expect(decision.note).toBe("");
    expect(rejected).toHaveLength(1);
  });

  test("a huge malformed row does not produce a huge rejection message", () => {
    const { rejected } = validateDecision({ park: [{ reason: "x".repeat(5000) }] }, ctx([]));
    expect(rejected[0]!.length).toBeLessThan(200);
  });

  test("every rejection is a sentence, never an empty string", () => {
    const { rejected } = validateDecision(
      { dispatch: [dispatchOf("#1")], park: [{ loomId: "nope", reason: "r" }] },
      ctx([loom("l", "#1", "working")]),
    );
    expect(rejected).toHaveLength(2);
    for (const r of rejected) expect(r.trim().length).toBeGreaterThan(10);
  });
});

describe("slugify", () => {
  test("ordinary English", () => {
    expect(slugify("Fix the login redirect")).toBe("fix-the-login-redirect");
    expect(slugify("  Trailing and leading  ")).toBe("trailing-and-leading");
  });

  test("Spanish folds its accents instead of losing the letters", () => {
    expect(slugify("Añadir búsqueda de campañas")).toBe("anadir-busqueda-de-campanas");
    expect(slugify("Corregir la sesión del día")).toBe("corregir-la-sesion-del-dia");
    expect(slugify("¿Por qué falla el informe?")).toBe("por-que-falla-el-informe");
  });

  test("emoji drop out, and a title that is only emoji uses the fallback", () => {
    expect(slugify("🔥 hotfix 🔥")).toBe("hotfix");
    expect(slugify("🎉🎉🎉", "#88")).toBe("88");
    expect(slugify("🎉🎉🎉")).toBe("item");
  });

  test("a title of only punctuation uses the fallback", () => {
    expect(slugify("!!! ??? ...", "#457")).toBe("457");
    expect(slugify("---", "#457")).toBe("457");
    expect(slugify("", "#457")).toBe("457");
    // and if even the fallback reduces to nothing, it is still never empty
    expect(slugify("...", "###")).toBe("item");
    expect(slugify("...", "")).toBe("item");
  });

  test("the result is always a legal branch component", () => {
    for (const title of [
      "feature/nested/path",
      "..dots..",
      "spaces   and\ttabs",
      "UPPER lower MiXeD",
      "trailing-hyphen-",
      "-leading-hyphen",
      "日本語のタイトル",
      "a".repeat(300),
      "@#$%^&*()",
    ]) {
      const slug = slugify(title, "#1");
      expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(slug.length).toBeGreaterThan(0);
      expect(slug.length).toBeLessThanOrEqual(48);
    }
  });

  test("long titles are truncated without leaving a trailing hyphen", () => {
    const slug = slugify("the quick brown fox jumps over the lazy dog and keeps on going forever");
    expect(slug.length).toBeLessThanOrEqual(48);
    expect(slug.endsWith("-")).toBe(false);
  });

  test("CJK has no ascii fold, so it falls back rather than emitting nothing", () => {
    expect(slugify("日本語のタイトル", "#12")).toBe("12");
  });
});
