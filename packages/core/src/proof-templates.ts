// Proof templates (docs/loom-orchestrator.md §5) — the selectable, Telar-native
// guidance behind each ProofStrategy. draftCharter folds a template's `guidance`
// into the scoping prompt so the drafting agent (and any human reviewing the
// Charter) knows exactly how a SubGoal/leaf is meant to be proven "done".
import type { ProofStrategy } from "./schemas";

export type ProofTemplate = {
  strategy: ProofStrategy;
  label: string;
  guidance: string;
  verifyMechanism: "gate" | "verifier" | "human-signoff";
};

export const PROOF_TEMPLATES: Record<ProofStrategy, ProofTemplate> = {
  quickfix: {
    strategy: "quickfix",
    label: "Quickfix",
    guidance:
      "A small, self-contained fix. No decomposition — one builder attempt, " +
      "proven by the project's deterministic gates (lint/typecheck/test/build) plus " +
      "an independent Verifier pass when acceptance criteria and a target URL are " +
      "given. Keep scope minimal: touch only what the fix requires.",
    verifyMechanism: "gate",
  },
  "bmad-story": {
    strategy: "bmad-story",
    label: "BMAD story",
    guidance:
      "A BMAD story (self-contained or decomposed). Translate the story into " +
      "concrete acceptance criteria before building; when it decomposes, break it " +
      "into SubGoals that each map to their own story slice. Each SubGoal is proven " +
      "by the independent Verifier driving the running app against its acceptance " +
      "criteria — the story is done only when the Verifier confirms it, never on " +
      "the builder's self-report alone.",
    verifyMechanism: "verifier",
  },
  "verifier-criteria": {
    strategy: "verifier-criteria",
    label: "Verifier criteria",
    guidance:
      "Proof is carried ENTIRELY by the independent Verifier: write acceptance " +
      "criteria that are concretely checkable against the running app (assertable " +
      "UI state, not implementation detail). There are no deterministic gates in " +
      "this proof — every criterion must be something the Verifier can drive and " +
      "assert through the accessibility tree.",
    verifyMechanism: "verifier",
  },
  custom: {
    strategy: "custom",
    label: "Custom",
    guidance:
      "An open escape hatch for a proof shape that doesn't fit the other templates. " +
      "Write a proofPlan in prose describing exactly how this SubGoal (or the whole " +
      "Charter, when it doesn't decompose) will be proven done, and choose the " +
      "verifyMechanism that actually enforces it: " +
      "\"gate\" (a deterministic check), \"verifier\" (the independent Verifier), or " +
      "\"human-signoff\" (a human must approve before this can be marked done).",
    verifyMechanism: "verifier",
  },
};

export function proofTemplate(s: ProofStrategy): ProofTemplate {
  return PROOF_TEMPLATES[s];
}

// M10.0 (Finding 3) — the executable-preference guidance folded into the
// scoping prompt (scoping.draftCharter). The finding: a criterion a machine can
// check on its own should be proven by a deterministic, exit-code check (a
// runnable command or a named project gate — no LLM in the loop), and the
// live/prose Verifier should be RESERVED for criteria that genuinely need a
// running surface (observable UI/UX behavior an exit code can't capture).
//
// This is PROMPT GUIDANCE ONLY. It steers how the drafting agent PHRASES each
// acceptanceCriterion and picks its verifyMechanism ("gate" vs "verifier"); it
// changes NO deterministic assertion-type routing. The structural fix — the
// deterministic proposer (weave-contracts.synthesizeContract) emitting
// command/gate assertions for independently-verifiable criteria instead of a
// blanket live-critic — is a separate routing change reserved for M10.5.
export const EXECUTABLE_PREFERENCE_GUIDANCE =
  "Proof preference — choose the cheapest SOUND proof per criterion. When a " +
  "criterion is independently and deterministically checkable (a file/symbol " +
  "exists, a test passes, a build/typecheck/lint gate is green, an exit code is " +
  "0), PREFER proving it with a runnable command or a named project gate " +
  "(verifyMechanism \"gate\") — an offline, exit-code check with no LLM " +
  "judgment. RESERVE the live Verifier and prose judgment (verifyMechanism " +
  "\"verifier\") for criteria that genuinely require observing a running " +
  "surface: UI/UX behavior in the accessibility tree that an exit code cannot " +
  "capture. Write each acceptance criterion so its cheapest sound proof is " +
  "obvious — do not route a machine-checkable criterion through a live critic.";

// M10.5 (subjectiveRouting) — the STRUCTURAL extension M10.0 deferred. Appended to
// the charter drafting prompt ONLY when the flag is on (scoping.draftCharter), so
// flag-off the prompt is byte-identical to today. It instructs the proposer to
// classify each criterion by objective-vs-human-judgment and set the per-criterion
// `subjective` marker CONSERVATIVELY — the default is OBJECTIVE; mark subjective
// only when a criterion is unmistakably a matter of human taste ("premium feel",
// "cohesive UX") that no exit code or falsifiable observation can settle. This is
// PROMPT GUIDANCE ONLY; the fail-closed routing keys on the resulting
// subjective===true marker, never on this prose.
export const SUBJECTIVE_ROUTING_GUIDANCE =
  "Objective vs. subjective — classify EACH criterion. DEFAULT TO OBJECTIVE: if a " +
  "criterion can be settled by a runnable command, a named gate, a test, an exit " +
  "code, or a falsifiable observation of a running surface (\"the API returns 200\", " +
  "\"the error path throws\", \"the list re-renders after delete\"), keep it objective — " +
  "emit a command/gate assertion for the independently-checkable ones and a plain " +
  "live-critic for the behavioral-but-observable ones. RESERVE the subjective marker " +
  "(set `subjective: true` on a live-critic assertion) ONLY for genuine matters of " +
  "human judgment that NO machine check can honestly settle — \"feels premium\", " +
  "\"the visual design is cohesive\", \"the copy has the right tone\". A subjective " +
  "criterion is carried to the HUMAN to judge holistically at accept; it is NEVER " +
  "turned into a machine gate. When in doubt, leave it OBJECTIVE (unmarked) — a " +
  "mis-marked objective criterion silently loses its fail-closed gate, so mark " +
  "subjective only when it is unmistakable.";
