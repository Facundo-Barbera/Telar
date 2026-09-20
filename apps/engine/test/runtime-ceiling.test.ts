/**
 * THE PRIVILEGE CEILING ON DELEGATION — issue #541 G1.
 *
 * The owner's decision, in his words: a session created by an agent must never
 * have more permissions than its creator. If the creator has to ask, the child
 * asks too.
 *
 * ── WHAT WAS LIVE BEFORE THIS ───────────────────────────────────────────────
 * `createSession` picked its mode from `detached` alone, `detached` defaulted to
 * true, and `sessions_create` could not pass it — so EVERY session an agent made
 * landed in `auto`, which `autoResolution` defines as everything inside the
 * session's boundary passing. A session that had to ask a person before running
 * a command could create one that never would.
 *
 * ── THE ASSERTION IS THAT THE MODE IS A FUNCTION OF THE CREATOR'S ───────────
 * Not that it is some particular constant. Both directions are exercised —
 * a narrow creator cannot make a wide child, and a wide creator CAN still make
 * a narrow one — because a rule that only clamps downward and a rule that just
 * copies the creator look identical from one direction.
 *
 * ── AND `detached: true` IS PASSED EXPLICITLY, WHICH IS THE POINT ───────────
 * Against `main` that yields `auto` unconditionally. Stating it here is what
 * makes these tests about the CEILING rather than about the default: if the
 * ceiling were dropped from `createSession` they would go red, and that was
 * verified by dropping it.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { autoResolution, narrowerRuntimeMode, type RequestKind, type RuntimeMode } from "@telar/engine-client";
import { EngineStateError, EngineStore } from "../src/state";

const homes: string[] = [];
const stores: EngineStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.closeExecutionStore();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

function setup(creatorMode: RuntimeMode): EngineStore {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-ceiling-"));
  homes.push(home);
  const store = new EngineStore(home, () => 1_000, { executionStorage: "sqlite" });
  stores.push(store);
  store.registerProject({ id: "project_one", name: "One", root: "/tmp" });
  store.createSession({ id: "session_creator", projectId: "project_one", title: "Coordinator" });
  store.updateSession("session_creator", { runtimeMode: creatorMode });
  return store;
}

const ALL_MODES: RuntimeMode[] = ["approval-required", "auto-accept-edits", "auto", "full-access"];
const ALL_KINDS: RequestKind[] = ["command_execution", "file_change", "file_read", "tool_call", "user_input", "secret_access"];

/* ------------------------------------------------------------------ *
 * The two directions.
 * ------------------------------------------------------------------ */

/**
 * THE ONE THAT GOES RED AGAINST `main`.
 *
 * `detached: true` is stated outright, so the posture this is capping is
 * unambiguously `auto` — the value the line produced unconditionally before the
 * ceiling existed.
 */
test("a creator that has to ask cannot produce a child that does not", () => {
  const store = setup("approval-required");
  const child = store.createSession({
    id: "session_child",
    projectId: "project_one",
    detached: true,
    ceilingFrom: "session_creator",
  });
  expect(child.runtimeMode).toBe("approval-required");
  // The posture is unchanged — it is the PERMISSION that narrowed, not the
  // question of whether anybody is watching.
  expect(child.detached).toBe(true);
});

test("a creator with full access can still produce a narrower child", () => {
  const store = setup("full-access");
  // Attended: the posture's own default is `approval-required`, which is
  // narrower than the ceiling. A ceiling that CLAMPED UP would widen this to
  // full-access, which is the rule this test exists to refuse.
  const attended = store.createSession({
    id: "session_attended",
    projectId: "project_one",
    detached: false,
    ceilingFrom: "session_creator",
  });
  expect(attended.runtimeMode).toBe("approval-required");

  // And a detached child under the same creator keeps the posture's own answer
  // rather than being raised to the creator's.
  const detached = store.createSession({
    id: "session_detached",
    projectId: "project_one",
    detached: true,
    ceilingFrom: "session_creator",
  });
  expect(detached.runtimeMode).toBe("auto");
});

/**
 * EVERY CREATOR MODE, AGAINST THE SAME POSTURE.
 *
 * One case is not a function. This is: the detached posture is `auto` in all
 * four rows, and the child's mode moves only with the creator's.
 */
test("the child's mode is a function of the creator's, across the whole ladder", () => {
  const seen: Array<[RuntimeMode, RuntimeMode]> = [];
  for (const creatorMode of ALL_MODES) {
    const store = setup(creatorMode);
    const child = store.createSession({
      id: "session_child",
      projectId: "project_one",
      detached: true,
      ceilingFrom: "session_creator",
    });
    seen.push([creatorMode, child.runtimeMode]);
  }
  expect(seen).toEqual([
    ["approval-required", "approval-required"],
    ["auto-accept-edits", "auto-accept-edits"],
    // At and above the detached posture the posture is what binds, not the
    // ceiling — a ceiling is a maximum, not an assignment.
    ["auto", "auto"],
    ["full-access", "auto"],
  ]);
});

/* ------------------------------------------------------------------ *
 * What the ceiling is NOT.
 * ------------------------------------------------------------------ */

/**
 * A HUMAN'S OWN CLICK IS UNCHANGED, and this is the regression that matters
 * most: the cockpit's create path passes no ceiling, and a person creating a
 * detached session must still get the mode they have always got.
 */
test("with no ceiling the line is exactly what it was", () => {
  const store = setup("approval-required");
  expect(store.createSession({ id: "session_plain", projectId: "project_one" }).runtimeMode).toBe("auto");
  expect(store.createSession({ id: "session_attended", projectId: "project_one", detached: false }).runtimeMode).toBe("approval-required");
});

/**
 * THE CEILING IS READ ONCE, AT CREATION.
 *
 * `startedFrom`'s note says no permission travels with it, and that stays true
 * here: there is no live link, so a creator that widens itself afterwards does
 * nothing to a session already made. A ceiling that was re-read would be one
 * session holding standing authority over another, which is the relationship
 * this codebase spent a milestone refusing.
 */
test("a creator widening itself later does not widen a session it already made", () => {
  const store = setup("approval-required");
  const child = store.createSession({
    id: "session_child",
    projectId: "project_one",
    detached: true,
    ceilingFrom: "session_creator",
  });
  expect(child.runtimeMode).toBe("approval-required");
  store.updateSession("session_creator", { runtimeMode: "full-access" });
  expect(store.getSession("session_child").runtimeMode).toBe("approval-required");
});

/**
 * A CEILING THAT NAMES NOTHING IS A REFUSAL, NOT A SHRUG.
 *
 * It is supplied by engine code from a verified claim, never by a model, so an
 * id that does not resolve means something is wrong — and the failure mode of
 * ignoring it is the widest session the engine can make, which is the one
 * outcome this whole change exists to prevent.
 */
test("an unreadable ceiling refuses rather than falling back to the widest mode", () => {
  const store = setup("approval-required");
  expect(() =>
    store.createSession({ id: "session_child", projectId: "project_one", ceilingFrom: "session_nope" }),
  ).toThrow(EngineStateError);
  expect(() => store.getSession("session_child")).toThrow();
});

/* ------------------------------------------------------------------ *
 * The ladder itself, held against `autoResolution` rather than itself.
 * ------------------------------------------------------------------ */

/**
 * THE PROPERTY THAT MAKES THE ORDER A LADDER.
 *
 * `narrowerRuntimeMode` ranks four strings, and a test that only re-stated that
 * order would be the array compared with itself. What the order has to MEAN is
 * this: for every request kind, the mode it calls narrower never auto-accepts
 * where the other one parks. That is read off `autoResolution`, which is the
 * thing the engine actually enforces — so if somebody reorders the ladder, or
 * changes what a mode resolves, the two stop agreeing here.
 */
test("the mode narrowerRuntimeMode picks never auto-accepts where the other parks", () => {
  for (const left of ALL_MODES) {
    for (const right of ALL_MODES) {
      const narrower = narrowerRuntimeMode(left, right);
      const wider = narrower === left ? right : left;
      for (const kind of ALL_KINDS) {
        if (autoResolution(narrower, kind) !== null) {
          expect(autoResolution(wider, kind)).not.toBeNull();
        }
      }
    }
  }
});

test("narrowerRuntimeMode is total, symmetric, and fails towards asking", () => {
  for (const left of ALL_MODES) {
    for (const right of ALL_MODES) {
      expect(narrowerRuntimeMode(left, right)).toBe(narrowerRuntimeMode(right, left));
    }
    expect(narrowerRuntimeMode(left, left)).toBe(left);
  }
  expect(narrowerRuntimeMode("approval-required", "full-access")).toBe("approval-required");
  expect(narrowerRuntimeMode("auto", "auto-accept-edits")).toBe("auto-accept-edits");
  // A MODE FROM A NEWER ENGINE IS TREATED AS THE NARROWEST. An engine reading a
  // value it has never heard of must fail towards asking, never towards acting.
  expect(narrowerRuntimeMode("full-access", "something-newer" as RuntimeMode)).toBe("something-newer");
  expect(narrowerRuntimeMode("something-newer" as RuntimeMode, "approval-required")).toBe("something-newer");
});
