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
//
// THIS CLAIM WAS FALSE ONCE, AND THE SHAPE THAT BROKE IT IS THE ONE TO WATCH
// FOR. The first draft of the "escalation never carries the Ultra note" proof
// was a bare `// @ts-expect-error` above a CALL. A ts directive is a comment to
// the compiler and NOTHING to the runtime: the call ran, passed no `read`, and
// fell through to buildEscalationContext -> getLoom -> ensureMigrated().
// Reproduced against a throwaway TELAR_HOME holding the legacy layout — one
// `bun test` of this file renamed `runs/` to `looms/`, left a `runs -> looms`
// symlink behind and renamed `run.json` to `loom.json`; with no TELAR_HOME set,
// as `bun test` runs it, that is the operator's real store. The compile claim
// survives below as a TYPE ANNOTATION on an object, which executes nothing, and
// the value is then fed through a call that injects `read` anyway. A negative
// COMPILE assertion must never be written as a live CALL in this file.
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
// Story 4.1 — the REAL formatter, so the injected read below renders what
// production renders rather than a stand-in the assertions could not tell apart.
import { formatUltraWakeAppendix } from "./ultra-wake";

const LIVE = "\n\n--- LIVE CONTEXT SENTINEL ---";
// Story 4.1's second, INDEPENDENT live block. A distinct sentinel so a test can
// tell which of the two reads produced what — the whole point of the pair being
// wrapped separately.
const WAKE = "\n\n--- WAKE CONTEXT SENTINEL ---";
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
    // …and there is no way to ASK for one. The signature has no
    // `ultraAnnotated` parameter at all, so this is enforced by the type rather
    // than remembered — a caller that tries gets a compile error, and
    // `bunx tsc --noEmit` in THIS workspace does see test files, which is what
    // makes the directive below a real proof rather than a comment. Measured
    // from the route's own `ultraAnnotated && !isEscalationSession`.
    //
    // It is written as a TYPE ANNOTATION rather than as a call, deliberately —
    // see this file's header: the call form executed and reached the real loom
    // store. `Parameters<typeof escalationAppendix>[0]` re-derives the opts type
    // from the function instead of restating it, so a signature that grew an
    // `ultraAnnotated` would stop erroring here and the unused-directive error
    // would fire. Nothing below runs a reader this file did not supply.
    const optsAskingForTheNote: Parameters<typeof escalationAppendix>[0] = {
      loomId: "loom_1",
      cwd: "/repos/demo",
      // @ts-expect-error escalation never carries the Ultra note — by signature
      ultraAnnotated: true,
    };
    // And the runtime agrees with the type: even when the property is smuggled
    // past the compiler, the composed appendix has no note in it.
    const appendix = escalationAppendix({ ...optsAskingForTheNote, read: () => LIVE });
    expect(appendix).toBe(ESCALATION_SYSTEM_PROMPT + LIVE);
    expect(appendix).not.toContain(ULTRA_ANNOTATION_NOTE);
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

  // ── Story 4.1 / AC2 — the completed-Ultra-run block ───────────────────────
  //
  // The proof that the outcome reaches the model as PER-TURN CONTEXT, driven
  // through the injectable `readWake` seam. That seam is also the INV-7
  // mechanism this file uses throughout: the composer never touches the state
  // root here, because the read it would perform is supplied.
  //
  // A test that asserted "the model did not call ultra_status" would not be a
  // test. A test that the APPENDIX carries the state and the result/error is the
  // honest proof, and it is this.

  test("4.1 the wake block reaches project, planner and steerer — every kind that can launch a run", () => {
    for (const appendix of [
      projectAppendix({ ultraAnnotated: false, sessionId: "sess-1", readWake: () => WAKE }),
      plannerAppendix({ ultraAnnotated: false, sessionId: "sess-1", readWake: () => WAKE }),
      steererAppendix({
        loomId: "loom_1",
        ultraAnnotated: false,
        sessionId: "sess-1",
        read: () => LIVE,
        readWake: () => WAKE,
      }),
    ]) {
      expect(appendix).toContain(WAKE);
    }
  });

  test("4.1 no sessionId means no wake block, and never a crash", () => {
    // Turn 1 of a fresh session has no id yet — the SDK mints it inside the
    // stream — and a session with no id has no pending wakes by construction.
    expect(projectAppendix({ ultraAnnotated: false })).toBe("");
    expect(projectAppendix({ ultraAnnotated: false, readWake: () => WAKE })).toBe("");
    expect(plannerAppendix({ ultraAnnotated: false })).toBe(PLANNER_SYSTEM_PROMPT);
  });

  test("4.1 an EMPTY wake block adds exactly nothing — a plain turn is byte-identical", () => {
    // This composes on every chat POST for every session, so the common case has
    // to be free. A stray header would be an instruction to talk about nothing.
    expect(projectAppendix({ ultraAnnotated: false, sessionId: "sess-1", readWake: () => "" })).toBe(
      "",
    );
    expect(plannerAppendix({ ultraAnnotated: false, sessionId: "sess-1", readWake: () => "" })).toBe(
      PLANNER_SYSTEM_PROMPT,
    );
  });

  test("4.1 a THROWING wake read drops only its own block — the static prompt and the note survive", () => {
    // The whole reason it gets its own safeLiveContext. This runs PRE-STREAM,
    // where an escaped throw is a bare 500 with no SSE frame at all.
    const appendix = plannerAppendix({
      ultraAnnotated: true,
      sessionId: "sess-1",
      readWake: boom,
    });
    expect(appendix).toBe(PLANNER_SYSTEM_PROMPT + ULTRA_ANNOTATION_NOTE);
    expect(appendix).not.toBe("");
  });

  test("4.1 the TWO live reads in one composer are INDEPENDENT — either can fail alone", () => {
    // Steerer is the first composer in this file to run two live reads, and they
    // are wrapped separately on purpose. A reader who finds one safeLiveContext
    // and "simplifies" them into one re-couples exactly these failures.
    const base = { loomId: "loom_1", ultraAnnotated: false, sessionId: "sess-1" } as const;
    // Loom read fails, wake read works: the wake block survives.
    const loomBroke = steererAppendix({ ...base, read: boom, readWake: () => WAKE });
    expect(loomBroke).not.toContain(LIVE);
    expect(loomBroke).toContain(WAKE);
    // Wake read fails, loom read works: the loom block survives.
    const wakeBroke = steererAppendix({ ...base, read: () => LIVE, readWake: boom });
    expect(wakeBroke).toContain(LIVE);
    expect(wakeBroke).not.toContain(WAKE);
    // Both fail: the static moat text is still there, which is the property
    // safeLiveContext exists for.
    const bothBroke = steererAppendix({ ...base, read: boom, readWake: boom });
    expect(bothBroke).toBe(STEERER_SYSTEM_PROMPT);
    // And both work: the order is static prompt, loom block, note, wake block.
    expect(
      steererAppendix({ ...base, ultraAnnotated: true, read: () => LIVE, readWake: () => WAKE }),
    ).toBe(STEERER_SYSTEM_PROMPT + LIVE + ULTRA_ANNOTATION_NOTE + WAKE);
  });

  test("4.1 AC2 proof 3 — the composed appendix carries the STATE and the result/error, with no ultra_status call", () => {
    // AC2's literal proof clause lives here: drive the composer with an
    // INJECTED read (this file's INV-7-sanctioned idiom) and assert the RENDERED
    // appendix contains the state and the result/error. The injected read runs
    // the REAL formatter over a real-shaped record, so this is the whole
    // delivery path minus the disk — which is the part session-profiles.test.ts
    // proves separately, in a sandboxed child.
    //
    // A test that asserted "the model did not call ultra_status" would not be a
    // test. That the outcome is IN the context is the honest proof, and it is
    // this one.
    const wakes = [
      { runId: "run_a", name: "alpha", state: "done" as const, spendUsd: 1.5, result: { files: 12 } },
      { runId: "run_b", name: "beta", state: "failed" as const, spendUsd: 0.25, error: "step 3 threw" },
      { runId: "run_c", name: "gamma", state: "stopped" as const, spendUsd: 0 },
    ];
    const appendix = projectAppendix({
      ultraAnnotated: false,
      sessionId: "sess-1",
      readWake: () => formatUltraWakeAppendix(wakes),
    });
    // Every STATE word reaches the model…
    expect(appendix).toContain("done");
    expect(appendix).toContain("failed");
    expect(appendix).toContain("stopped");
    // …and the result / error alongside it.
    expect(appendix).toContain('"files": 12');
    expect(appendix).toContain("step 3 threw");
    // …and the run's own identity, so the model can name what finished.
    expect(appendix).toContain("alpha");
    expect(appendix).toContain("run_a");
    // The instruction the model reads is the one that stops it polling.
    expect(appendix).toContain("do not call ultra_status");
    // Anti-vacuity: with nothing pending the same composer adds NOTHING, so the
    // assertions above are about the wakes and not about the composer.
    expect(
      projectAppendix({ ultraAnnotated: false, sessionId: "sess-1", readWake: () => formatUltraWakeAppendix([]) }),
    ).toBe("");
  });

  test("4.1 ESCALATION never carries a wake block — by signature, not by memory", () => {
    // Same reasoning as the Ultra note, and the same enforcement: this profile
    // HARD-DENIES all three ultra tools, so advertising a finished run to it is
    // advertising an outcome to a surface that cannot act on it.
    //
    // Written as a TYPE ANNOTATION on a data object rather than above a call —
    // see this file's header. A directive above a call still CALLS, and the call
    // it would make here falls through to a real state-root read.
    const optsAskingForAWake: Parameters<typeof escalationAppendix>[0] = {
      loomId: "loom_1",
      cwd: "/repos/demo",
      // @ts-expect-error escalation never carries the completed-run block — by signature
      sessionId: "sess-1",
    };
    const appendix = escalationAppendix({ ...optsAskingForAWake, read: () => LIVE });
    expect(appendix).toBe(ESCALATION_SYSTEM_PROMPT + LIVE);
    expect(appendix).not.toContain(WAKE);
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
