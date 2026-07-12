// Per-Thread bundle wiring (docs/loom-model.md §2, §M.1, §W). A woven root's
// children are created lazily in the weaver's spawnChild (dispatcher.ts:
// runWeaveWiring), NOT at charter-assign time — so this is where each Thread
// gets its OWN Spec Bundle: the root's context files copied in, its objective
// narrowed to the SubGoal, and its Verification Contract filtered down to just
// that workstream's slice (the assertions carrying its subGoalId, plus the
// cross-cutting ALL/unlabelled ones). The child then reads its own bundle via
// its own readContract in the executor — proving its SubGoal in isolation.
import { CONTRACT_FILE, listBundleFiles, snapshotBundle, writeBundleFile } from "./bundle";
import { validateContract, type ContractAssertion, type SubGoal, type VerificationContract } from "./schemas";
import { subjectiveRoutingEnabled } from "./runner/flag";
import type { Loom } from "./looms";

// M1 (D0.2, D1.2). PURE. Forces a Verification Contract onto a loom that was
// created WITHOUT one (a plain custom loom with only acceptanceCriteria, or
// nothing) — the M1 creation-time invariant that EVERY loom ends up with a
// contract. Each acceptanceCriteria line becomes one `live-critic` assertion
// (the only kind that maps prose to live judgment without a fabricated exit-
// code gate); with zero criteria it falls back to a single assertion from the
// prompt/title. Every assertion is scoped subGoalId:"ALL" so (a) the weave-of-
// one child inherits the whole slice via wireChildBundle's ALL filter, and
// (b) runIntegrationVerify's ALL slice is non-empty → full re-verify fires.
// synthesized:true honestly labels the result so validateContract skips only
// the hard-gate floor (D0.1). Never throws; always ≥1 assertion (prompt/title
// always exist from createLoom, so this adds NO new mandatory user input).
// M10.5 — `manifest` is OPTIONAL (default undefined ⇒ existing callers
// byte-identical, e.g. m1-forced-contracts). It is the flag-gated structural hook
// (proposerStructuralPlan B). Flag-off (or no manifest) EVERY criterion still maps
// to type:"live-critic" / subGoalId:"ALL" / blocker:true / synthesized:true, so
// the m1/weave-planner/contract tests stay byte-identical. Flag-on, this
// DETERMINISTIC no-LLM fallback stays CONSERVATIVE by construction: it NEVER
// invents a `subjective` classification from prose (a keyword scan risks
// false-positives that would DROP an objective criterion — a moat violation). The
// one structural tightening it makes is precise and deterministic: a criterion
// whose text EXACTLY names a configured project gate becomes a `gate` assertion
// (an offline exit-code check) instead of a live-critic — a live-critic→gate
// TIGHTENING contractLoosenings never flags, and objective/fail-closed. Every
// other criterion keeps live-critic. The rich per-criterion authoring (command/
// gate + the subjective marker) lives in the LLM charter proposer.
export function synthesizeContract(
  loom: Loom,
  manifest?: { subjectiveRouting?: boolean; gates?: { name: string }[] },
): VerificationContract {
  const criteria = (loom.acceptanceCriteria ?? []).map((c) => c.trim()).filter(Boolean);
  const sources = criteria.length ? criteria : [loom.prompt?.trim() || loom.title];
  const routing = manifest ? subjectiveRoutingEnabled(manifest) : false;
  const gateNames = new Set((manifest?.gates ?? []).map((g) => g.name.trim()).filter(Boolean));
  const assertions: ContractAssertion[] = sources.map((text, i) => {
    if (routing && gateNames.has(text)) {
      // Objective, machine-verifiable: route to the fail-closed exit-code gate.
      return { id: `synth-${i}`, subGoalId: "ALL", description: text, type: "gate", expected: text, blocker: true };
    }
    return { id: `synth-${i}`, subGoalId: "ALL", description: text, type: "live-critic", observable: text, blocker: true };
  });
  return { version: 1, assertions, synthesized: true };
}

// PURE w.r.t. the child object except for the two fields it stamps
// (contractRequired / acceptanceCriteria) — the caller saves the child. Copies
// every root bundle file into the child EXCEPT contract.json and objective.md,
// which are set explicitly below so a child never inherits the root's whole
// contract or objective.
//
// The filtered slice = root assertions whose subGoalId is this SubGoal's id,
// OR "ALL", OR unlabelled (cross-cutting). If that slice has a falsifiable
// hard-gate (validateContract passes — needs >=1 non-live-critic assertion),
// the child gets its own contract.json and contractRequired:true (panel path).
// If it doesn't, no contract.json is written (readContract stays null) and the
// child falls back to the SubGoal's acceptanceCriteria (legacy verifier path).
export function wireChildBundle(
  rootId: string,
  child: Loom,
  sg: SubGoal,
  rootAssertions: ContractAssertion[],
  // M1 (D1.4): whether the root contract these assertions came from was
  // synthesized. Threaded onto the child contract so an all-live-critic
  // synthesized slice passes validateContract (the floor is skipped for it) and
  // the weave-of-one child takes the panel path instead of the legacy degrade.
  synthesized: boolean,
): void {
  // Copy the root's context files into the child's bundle. Skip contract.json
  // (filtered + rewritten below) and objective.md (narrowed to the SubGoal).
  for (const f of snapshotBundle(rootId).files) {
    if (f.path === CONTRACT_FILE || f.path === "objective.md") continue;
    writeBundleFile(child.id, f.path, f.contents);
  }
  writeBundleFile(child.id, "objective.md", sg.detail);

  const filtered = rootAssertions.filter(
    (a) => a.subGoalId === sg.id || a.subGoalId === "ALL" || !a.subGoalId?.trim(),
  );
  const contract: VerificationContract = { version: 1, assertions: filtered, synthesized };
  const errors = validateContract(contract, { existingFiles: new Set(listBundleFiles(child.id)) });

  if (errors.length === 0) {
    writeBundleFile(child.id, CONTRACT_FILE, JSON.stringify(contract, null, 2));
    child.contractRequired = true;
  } else {
    // No falsifiable slice for this Thread — degrade to the legacy path.
    child.acceptanceCriteria = sg.acceptanceCriteria;
  }
}
