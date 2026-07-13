// Per-Thread bundle wiring (docs/loom-model.md §2, §M.1, §W). A woven root's
// children are created lazily in the weaver's spawnChild (dispatcher.ts:
// runWeaveWiring), NOT at charter-assign time — so this is where each Thread
// gets its OWN Spec Bundle: the root's context files copied in, its objective
// narrowed to the SubGoal, and its Verification Contract filtered down to just
// that workstream's slice (the assertions carrying its subGoalId, plus the
// cross-cutting ALL/unlabelled ones). The child then reads its own bundle via
// its own readContract in the executor — proving its SubGoal in isolation.
import { CONTRACT_FILE, listBundleFiles, snapshotBundle, writeBundleFile } from "./bundle";
import { validateContract, type Charter, type ContractAssertion, type SubGoal, type VerificationContract } from "./schemas";
import { adaptiveVerificationEnabled, subjectiveRoutingEnabled } from "./runner/flag";
import { charterHasGateIntent, deriveDeliverableSignal } from "./deliverable-signal";
import type { Loom } from "./looms";

// M11.1. PURE. Flattens the charter's per-criterion proof hints (charter-level
// plus every SubGoal's) into ONE criterion-text → runnable map, trimmed on both
// sides. First hint wins on a duplicate criterion (charter-level outranks
// subgoal, document order after that) — deterministic, never a merge surprise.
// Blank criterion/run entries are dropped: a degenerate hint must never mint a
// command assertion with an empty runnable (validateContract would reject it,
// but we never get there). A hint whose criterion matches nothing is simply
// inert — fail-safe, the unmatched criteria keep today's routing.
function collectProofHints(charter: Charter | undefined): Map<string, string> {
  const hints = new Map<string, string>();
  if (!charter) return hints;
  const all = [...(charter.proofHints ?? []), ...(charter.decomposition ?? []).flatMap((sg) => sg.proofHints ?? [])];
  for (const h of all) {
    const criterion = h.criterion.trim();
    const run = h.run.trim();
    if (criterion && run && !hints.has(criterion)) hints.set(criterion, run);
  }
  return hints;
}

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
//
// M11.1 (adaptiveVerification, docs/adaptive-verification.md §3.1) — the
// modality DERIVATION the M10.5 header above reserved. Flag-on (and only then),
// two additional PRECISE tightenings run, in order, after the exact-gate-name
// rule; everything they cannot map STAYS live-critic (worst case = today):
//   1. HONOR a charter-authored per-criterion proofHint (schemas.ProofHint):
//      a criterion whose exact text carries a hint becomes
//      {type:"command", expected: hint.run} — how a CLI/DS criterion gets its
//      concrete runnable (authored where the criteria live — by the proposer or
//      a human, never invented here from prose; the module's own conservatism
//      rule above).
//   2. DERIVE from the deliverable (deriveDeliverableSignal — the same PURE,
//      never-throwing, bounded-filesystem signal the M11.0 pre-flight reads;
//      flag-on this function trades strict purity for that bounded read):
//      when the signal says "test-gate" (a real test script exists TODAY) the
//      remaining criteria become {type:"command", expected: signal.run} (the
//      lockfile-aware `bun|pnpm|yarn|npm run test`) — but ONLY under an
//      explicit SANCTION, because "the suite proves it" must be a claim
//      somebody actually made, never an inference from the repo alone:
//        (a) the criteria are the PROMPT FALLBACK (zero authored
//            acceptanceCriteria — the loom_mrigs3zo_vxgrsr greenfield shape,
//            where the one synth-0 assertion IS "the deliverable works" and
//            the suite is exactly its proof), OR
//        (b) the charter carries gate-shaped proof intent
//            (charterHasGateIntent — PROOF_TEMPLATES.verifyMechanism==="gate"),
//            the same authored trust channel as a proofHint.
//      WITHOUT a sanction, authored multi-criteria prose keeps live-critic:
//      a pre-existing green suite must never rubber-stamp a criterion it says
//      nothing about (credentials-bound work, taste — doc §4 "a mis-derived
//      method can never rubber-stamp; the worst it can do is produce NO
//      evidence", §3.2 park semantics). Those criteria tighten only via an
//      exactly-matching proofHint, or land the fail-closed no-evidence demote.
//      The web shape short-circuits to plannable:false inside the signal, so a
//      dev-server app can never be blanket-tightened either way.
//      deferred-gate/cli-harness/sandbox-eval carry NO runnable today, so they
//      tighten ONLY via hints — never a fabricated command.
// Both directions are live-critic → gate/command TIGHTENINGS (the direction
// contractLoosenings never flags); the reverse (gate → live-critic) has no code
// path here — the exact-gate-name rule stays FIRST, so a criterion that is a
// named gate today is a named gate flag-on too. A derived gate/command never
// carries `subjective` (this deterministic path never authors the marker;
// validateContract additionally rejects it on any non-live-critic type).
// `synthesized: true` stays carried verbatim. The `manifest ? … : false` guard
// mirrors the M10.5 routing line: a bare 1-arg caller is byte-identical even
// under the TELAR_ADAPTIVE_VERIFY env override.
export function synthesizeContract(
  loom: Loom,
  manifest?: {
    subjectiveRouting?: boolean;
    adaptiveVerification?: boolean;
    gates?: { name: string }[];
    root?: string;
  },
): VerificationContract {
  const criteria = (loom.acceptanceCriteria ?? []).map((c) => c.trim()).filter(Boolean);
  const sources = criteria.length ? criteria : [loom.prompt?.trim() || loom.title];
  const routing = manifest ? subjectiveRoutingEnabled(manifest) : false;
  const gateNames = new Set((manifest?.gates ?? []).map((g) => g.name.trim()).filter(Boolean));
  // M11.1 — derivation inputs, resolved ONCE per synthesis. Flag-off (or no
  // manifest) both stay empty/null: zero filesystem reads, zero new branches
  // per criterion beyond a Map miss — byte-identical output.
  const adaptive = manifest ? adaptiveVerificationEnabled(manifest) : false;
  const hints = adaptive ? collectProofHints(loom.charter) : new Map<string, string>();
  // The blanket test-gate SANCTION (header rule 2): prompt-fallback criteria or
  // an explicit gate-mechanism charter. Unsanctioned ⇒ the signal is not even
  // derived (zero filesystem reads) and authored prose keeps live-critic.
  const blanketSanctioned = criteria.length === 0 || charterHasGateIntent(loom.charter);
  const signal =
    adaptive && blanketSanctioned && manifest?.root ? deriveDeliverableSignal(manifest.root, loom.charter) : null;
  const testRun = signal?.plannable && signal.strategy === "test-gate" ? signal.run : undefined;
  const assertions: ContractAssertion[] = sources.map((text, i) => {
    if (routing && gateNames.has(text)) {
      // Objective, machine-verifiable: route to the fail-closed exit-code gate.
      return { id: `synth-${i}`, subGoalId: "ALL", description: text, type: "gate", expected: text, blocker: true };
    }
    const hint = hints.get(text);
    if (hint) {
      // M11.1 tightening 1 — the charter authored THIS criterion's runnable.
      return { id: `synth-${i}`, subGoalId: "ALL", description: text, type: "command", expected: hint, blocker: true };
    }
    if (testRun) {
      // M11.1 tightening 2 — a test gate exists today; the suite is the proof.
      return { id: `synth-${i}`, subGoalId: "ALL", description: text, type: "command", expected: testRun, blocker: true };
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
