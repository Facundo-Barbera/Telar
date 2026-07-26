// The hoisted per-kind system-prompt appendices, and the fail-safe that keeps a
// pre-stream profile resolution from turning into a 500.
//
// WHAT THIS FILE IS FOR. session-prompts.ts is where story 2.2 put the three
// static prompts, the per-turn Ultra note and the two live-context readers when
// it removed the route's four-arm `systemPrompt` ternary. Two properties there
// are load-bearing and neither is checkable from the route (there is no test
// file for app/api/chat/route.ts anywhere in the tree):
//
//   1. COMPOSITION — each kind gets its own static prompt, in the route's own
//      order, and the Ultra note exactly when the kind and the flag both say
//      so. Escalation NEVER gets the note.
//   2. FAIL-SAFE — the live-context read moved from INSIDE `new ReadableStream`
//      (where a throw is an SSE `error` event on an open stream) to PRE-STREAM
//      (where a throw is a bare 500 with no SSE frame at all). A failure must
//      degrade to the static prompt and NEVER to "" — an empty appendix would
//      silently drop the moat language that IS the steerer and escalation
//      kinds, converting a 500 into a silent degradation, which is worse.
//
// NO FILESYSTEM, ANYWHERE IN THIS FILE. The real readers reach core's getLoom,
// whose ensureMigrated() can RENAME directories under the resolved state root —
// and outside a sandbox that root is the operator's real ~/.telar. Every test
// below drives the composers with an INJECTED reader, which is also what makes
// the throwing case expressible at all. The real readers are exercised in a
// sandboxed child process by session-profiles.test.ts.
// @ts-expect-error no @types/bun in this workspace
import { describe, expect, test } from "bun:test";
import {
  ESCALATION_SYSTEM_PROMPT,
  PLANNER_SYSTEM_PROMPT,
  STEERER_SYSTEM_PROMPT,
  ULTRA_ANNOTATION_NOTE,
  escalationAppendix,
  plannerAppendix,
  projectAppendix,
  safeLiveContext,
  steererAppendix,
  tail,
  safeRead,
  ultraNote,
} from "./session-prompts";

const LIVE = "\n\n--- LIVE CONTEXT SENTINEL ---";
const boom = () => {
  throw new Error("the loom store is unreachable");
};

describe("the three prompts survived the move from route.ts intact", () => {
  test("each is substantial, and each carries the moat sentence its kind is FOR", () => {
    // Anti-vacuity with teeth: an empty or truncated constant would satisfy a
    // bare `toBeTruthy`, and a retyped one would satisfy a length check. These
    // three phrases are the reason each prompt exists, so a paste that dropped
    // a paragraph is what this catches.
    expect(PLANNER_SYSTEM_PROMPT.length).toBeGreaterThan(500);
    expect(STEERER_SYSTEM_PROMPT.length).toBeGreaterThan(500);
    expect(ESCALATION_SYSTEM_PROMPT.length).toBeGreaterThan(500);
    // The planner cannot start a loom alone (docs/loom-model.md §M.6).
    expect(PLANNER_SYSTEM_PROMPT).toContain("that human approval is required by design");
    // The steerer can never accept, promote or mark done.
    expect(STEERER_SYSTEM_PROMPT).toContain("you can NEVER accept, promote, approve, or mark");
    // The escalation agent's one write lands only after the human approves.
    expect(ESCALATION_SYSTEM_PROMPT).toContain("call answer_blocked");
    expect(ESCALATION_SYSTEM_PROMPT).toContain("you can NEVER accept, promote, approve, or mark");
  });

  test("the three are distinct — no kind was pasted over another", () => {
    const all = [PLANNER_SYSTEM_PROMPT, STEERER_SYSTEM_PROMPT, ESCALATION_SYSTEM_PROMPT];
    expect(new Set(all).size).toBe(3);
  });

  test("the Ultra note is the per-turn REQUEST language, not a session-level flag", () => {
    // docs/plans/ultra-harness.md §4 — "opt-in is a REQUEST, not a behavior
    // flag". The "(this turn only)" and "Do not call it on a later turn" halves
    // are what make that true in the text the model actually reads.
    expect(ULTRA_ANNOTATION_NOTE).toContain("(this turn only)");
    expect(ULTRA_ANNOTATION_NOTE).toContain("Do not call it on a later turn");
  });
});

describe("the two moved helpers behave as they did in route.ts", () => {
  test("tail truncates to the LAST max bytes and marks the elision", () => {
    expect(tail("short", 100)).toBe("short");
    const long = "x".repeat(50) + "END";
    const cut = tail(long, 10);
    expect(cut.startsWith("…(truncated)…\n")).toBe(true);
    expect(cut.endsWith("END")).toBe(true);
    expect(cut.length).toBeLessThan(long.length);
  });

  test("safeRead swallows a throw and normalises undefined to null", () => {
    expect(safeRead(() => "value")).toBe("value");
    expect(safeRead(() => undefined)).toBeNull();
    expect(safeRead(() => null)).toBeNull();
    expect(safeRead(boom)).toBeNull();
  });
});

describe("ultraNote / safeLiveContext — the pure half and the guarded half", () => {
  test("ultraNote is exactly the note, or exactly nothing", () => {
    expect(ultraNote(true)).toBe(ULTRA_ANNOTATION_NOTE);
    expect(ultraNote(false)).toBe("");
  });

  test("safeLiveContext returns the read on success and \"\" on ANY throw", () => {
    expect(safeLiveContext(() => LIVE)).toBe(LIVE);
    expect(safeLiveContext(boom)).toBe("");
    // Not just Error: the readers cross a JSON.parse and an fs boundary, and a
    // thrown string or a thrown undefined must not escape either.
    expect(
      safeLiveContext(() => {
        throw "a bare string";
      }),
    ).toBe("");
    expect(
      safeLiveContext(() => {
        // eslint-disable-next-line no-throw-literal
        throw undefined;
      }),
    ).toBe("");
  });
});

describe("composition per kind — the route's four-arm ternary, one arm per builder", () => {
  test("project: the appendix IS the Ultra note, and \"\" without it", () => {
    expect(projectAppendix({ ultraAnnotated: false })).toBe("");
    expect(projectAppendix({ ultraAnnotated: true })).toBe(ULTRA_ANNOTATION_NOTE);
  });

  test("planner: static prompt, then the note — in the route's own order", () => {
    expect(plannerAppendix({ ultraAnnotated: false })).toBe(PLANNER_SYSTEM_PROMPT);
    expect(plannerAppendix({ ultraAnnotated: true })).toBe(
      PLANNER_SYSTEM_PROMPT + ULTRA_ANNOTATION_NOTE,
    );
  });

  test("steerer: static prompt, then LIVE CONTEXT, then the note — that exact order", () => {
    // Order is not cosmetic: the route composed
    // `STEERER_SYSTEM_PROMPT + buildSteererContext(id) + ultraAnnotationNote`,
    // so the live block sits between the two static texts and the Ultra note is
    // last. A reordering changes what the model reads last, which is the part
    // it weights most.
    expect(steerer({ ultraAnnotated: true })).toBe(
      STEERER_SYSTEM_PROMPT + LIVE + ULTRA_ANNOTATION_NOTE,
    );
    expect(steerer({ ultraAnnotated: false })).toBe(STEERER_SYSTEM_PROMPT + LIVE);
  });

  test("steerer: no loomId means no live block, and never a crash", () => {
    // The route used to write `buildSteererContext(loomLink.loomId!)` under a
    // comment claiming the id is always present for this kind. That holds for
    // the turn-1 wire seed (role and loomId are set together) but the RESUMED
    // arm reads existingChat?.role and existingChat?.loomId independently, so
    // the claim was about the store's shape rather than about the code.
    expect(steererAppendixNoId({ ultraAnnotated: false })).toBe(STEERER_SYSTEM_PROMPT);
    expect(steererAppendixNoId({ ultraAnnotated: true })).toBe(
      STEERER_SYSTEM_PROMPT + ULTRA_ANNOTATION_NOTE,
    );
  });

  test("escalation: static prompt then LIVE CONTEXT, and NEVER an Ultra note", () => {
    const appendix = escalationAppendix({
      loomId: "loom_1",
      cwd: "/repos/demo",
      read: () => LIVE,
    });
    expect(appendix).toBe(ESCALATION_SYSTEM_PROMPT + LIVE);
    expect(appendix).not.toContain(ULTRA_ANNOTATION_NOTE);
    // …and there is no way to ASK for one. The signature has no
    // `ultraAnnotated` parameter at all, so this is enforced by the type rather
    // than remembered — a caller that tries gets a compile error, and
    // `bunx tsc --noEmit` in THIS workspace does see test files, which is what
    // makes the line below a real proof rather than a comment. Measured from
    // the route's own `ultraAnnotated && !isEscalationSession`.
    // @ts-expect-error escalation never carries the Ultra note — by signature
    escalationAppendix({ loomId: "loom_1", cwd: "/repos/demo", ultraAnnotated: true });
  });

  test("escalation: the reader is handed the loomId AND the cwd, in that order", () => {
    // buildEscalationContext(loomId, root) — the root is the project root the
    // deliverable-signal is derived from, and it comes from the profile's cwd
    // (which the fold sets from manifest.root). Passing them the wrong way
    // round would silently derive the signal from a loom id.
    const seen: Array<[string, string]> = [];
    escalationAppendix({
      loomId: "loom_1",
      cwd: "/repos/demo",
      read: (id, root) => {
        seen.push([id, root]);
        return LIVE;
      },
    });
    expect(seen).toEqual([["loom_1", "/repos/demo"]]);
  });

  test("escalation: no loomId means no live block, and never a crash", () => {
    expect(escalationAppendix({ cwd: "/repos/demo", read: () => LIVE })).toBe(
      ESCALATION_SYSTEM_PROMPT,
    );
  });
});

describe("THE FAIL-SAFE — a throwing reader degrades the live block, never the appendix", () => {
  test("steerer: a throwing reader still yields the static prompt", () => {
    const appendix = steererAppendixThrowing({ ultraAnnotated: false });
    expect(appendix).toContain(STEERER_SYSTEM_PROMPT);
    // The negative that matters: NOT "" and NOT a throw. Either would drop the
    // moat language — "you can NEVER accept, promote, approve, or mark this
    // loom done" — from a session whose entire purpose is that constraint.
    expect(appendix).not.toBe("");
    expect(appendix).toContain("you can NEVER accept, promote, approve, or mark");
  });

  test("steerer: the PURE half survives the IMPURE half's failure — the Ultra note is still there", () => {
    // safeLiveContext wraps the live read and NOTHING ELSE, precisely so a
    // failure drops exactly the part that failed. ultraNote is a pure function
    // of the wire flag and cannot fail, so wrapping it in the same try would
    // lose it for no reason.
    const appendix = steererAppendixThrowing({ ultraAnnotated: true });
    expect(appendix).toContain(STEERER_SYSTEM_PROMPT);
    expect(appendix).toContain(ULTRA_ANNOTATION_NOTE);
    // And it is EXACTLY the two, with the failed live block simply absent.
    expect(appendix).toBe(STEERER_SYSTEM_PROMPT + ULTRA_ANNOTATION_NOTE);
  });

  test("escalation: a throwing reader still yields the static prompt", () => {
    const appendix = escalationAppendix({
      loomId: "loom_1",
      cwd: "/repos/demo",
      read: boom,
    });
    expect(appendix).toBe(ESCALATION_SYSTEM_PROMPT);
    expect(appendix).toContain("call answer_blocked");
  });

  test("the fail-safe DISCRIMINATES — a working reader really does add its block", () => {
    // Without this, a composer that ignored its reader entirely would satisfy
    // every assertion above: the static prompt would be there, nothing would
    // throw, and the tests would read as a passing fail-safe proof.
    expect(steererAppendixThrowing({ ultraAnnotated: false })).not.toContain(LIVE);
    expect(steerer({ ultraAnnotated: false })).toContain(LIVE);
  });
});

// Small named helpers so the assertions above read as claims rather than as
// argument objects. `read` is the injectable seam; production never passes one.
function steerer(opts: { ultraAnnotated: boolean }): string {
  return steererAppendix({ loomId: "loom_1", ultraAnnotated: opts.ultraAnnotated, read: () => LIVE });
}
function steererAppendixThrowing(opts: { ultraAnnotated: boolean }): string {
  return steererAppendix({ loomId: "loom_1", ultraAnnotated: opts.ultraAnnotated, read: boom });
}
function steererAppendixNoId(opts: { ultraAnnotated: boolean }): string {
  return steererAppendix({ ultraAnnotated: opts.ultraAnnotated, read: () => LIVE });
}
