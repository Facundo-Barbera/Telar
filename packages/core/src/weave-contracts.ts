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
import type { Loom } from "./looms";

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
  const contract: VerificationContract = { version: 1, assertions: filtered };
  const errors = validateContract(contract, { existingFiles: new Set(listBundleFiles(child.id)) });

  if (errors.length === 0) {
    writeBundleFile(child.id, CONTRACT_FILE, JSON.stringify(contract, null, 2));
    child.contractRequired = true;
  } else {
    // No falsifiable slice for this Thread — degrade to the legacy path.
    child.acceptanceCriteria = sg.acceptanceCriteria;
  }
}
