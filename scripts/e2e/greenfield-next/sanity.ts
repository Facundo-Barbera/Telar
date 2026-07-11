import assert from "node:assert/strict";
import { validateContract, validateCharter, isWoven, partitionAssertions } from "@telar/core";
import { buildContract, buildWovenCharter } from "./spec";

const c = buildContract();
assert(validateContract(c).length === 0, "contract must be falsifiable-valid");

const ch = buildWovenCharter();
const v = validateCharter(ch);
assert(v.ok, "charter must validate: " + v.errors.join("; "));
assert(isWoven(ch), "charter must be woven (>=1 subgoal)");
assert(ch.decomposition.length === 2, "expect two threads");

// per-thread slices == wireChildBundle's filter (subGoalId === id || "ALL" || unlabelled)
for (const id of ["s1", "s2"]) {
  const slice = { version: 1, assertions: c.assertions.filter(a => a.subGoalId === id || a.subGoalId === "ALL" || !a.subGoalId?.trim()) };
  assert(validateContract(slice).length === 0, `thread ${id} slice must be falsifiable-valid`);
}
const allSlice = { version: 1, assertions: c.assertions.filter(a => a.subGoalId === "ALL" || !a.subGoalId?.trim()) };
assert(validateContract(allSlice).length === 0, "ALL slice must be a real deterministic gate");
assert(partitionAssertions(allSlice.assertions).agentJudged.length === 0, "ALL slice must be zero-browser (deterministic-only)");

// s2 slice must require the panel (exercises invariant #2's live path)
const s2 = c.assertions.filter(a => a.subGoalId === "s2" || a.subGoalId === "ALL");
assert(partitionAssertions(s2).agentJudged.length > 0, "s2 must require the critic panel");

// spec<->charter id consistency
const ids = new Set(c.assertions.map(a => a.subGoalId).filter(x => x && x !== "ALL"));
for (const sg of ch.decomposition) assert(ids.has(sg.id), `charter subgoal ${sg.id} has no contract assertions`);

console.log("SANITY OK");
