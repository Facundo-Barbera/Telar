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
      "A small, self-contained leaf fix. No decomposition — one builder attempt, " +
      "proven by the project's deterministic gates (lint/typecheck/test/build) plus " +
      "an independent Verifier pass when acceptance criteria and a target URL are " +
      "given. Keep scope minimal: touch only what the fix requires.",
    verifyMechanism: "gate",
  },
  "bmad-story": {
    strategy: "bmad-story",
    label: "BMAD story",
    guidance:
      "A BMAD story (leaf or epic). Translate the story into concrete acceptance " +
      "criteria before building; for an epic, decompose into SubGoals that each map " +
      "to their own story slice. Each leaf/SubGoal is proven by the independent " +
      "Verifier driving the running app against its acceptance criteria — the " +
      "story is done only when the Verifier confirms it, never on the builder's " +
      "self-report alone.",
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
      "Write a proofPlan in prose describing exactly how this leaf/SubGoal will be " +
      "proven done, and choose the verifyMechanism that actually enforces it: " +
      "\"gate\" (a deterministic check), \"verifier\" (the independent Verifier), or " +
      "\"human-signoff\" (a human must approve before this can be marked done).",
    verifyMechanism: "verifier",
  },
};

export function proofTemplate(s: ProofStrategy): ProofTemplate {
  return PROOF_TEMPLATES[s];
}
