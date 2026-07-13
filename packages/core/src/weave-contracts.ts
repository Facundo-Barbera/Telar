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
import { partitionAssertions } from "./executor";
import type { Loom } from "./looms";

// PURE. A runnable that ALWAYS exits 0 without checking anything — `true`, `:`,
// `exit 0`, `echo …` — is an always-green "check": honoring it as a proofHint
// would mint a `command` assertion that can never fail, silently REPLACING a real
// judge (a live-critic) or a real runnable with an unconditional pass. That is a
// verdict-floor breach (adaptive-verification review, finding 2: a hallucinated
// `run:"true"` neuters the floor with only a mislabeled "tightening" event). A
// proofHint is agent-supplied (planWeaveFromBundle emit); its criterion→runnable
// is trusted for ROUTING, but its content must still be a genuine check. A command
// is trivial-pass IFF EVERY sequenced segment is such a no-op — a single real
// segment (e.g. `node cli.js --nope; test $? -eq 2`) makes the whole thing a
// genuine check and is honored. Rejecting a trivial-pass hint makes it INERT (as
// if unauthored) so the criterion keeps today's routing — fail-safe, worst case
// unchanged, never always-green.
function isTrivialPass(run: string): boolean {
  const segments = run.split(/&&|\|\||;|\||\n/).map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) return true; // nothing actually runs
  return segments.every((seg) => {
    const [tok, ...rest] = seg.split(/\s+/);
    if (tok === "true" || tok === ":" || tok === "echo") return true;
    if (tok === "exit") return rest.length === 0 || rest[0] === "0";
    return false;
  });
}

// M11.1. PURE. Flattens the charter's per-criterion proof hints (charter-level
// plus every SubGoal's) into ONE criterion-text → runnable map, trimmed on both
// sides. First hint wins on a duplicate criterion (charter-level outranks
// subgoal, document order after that) — deterministic, never a merge surprise.
// Blank OR trivially-passing (isTrivialPass) run entries are dropped: a degenerate
// hint must never mint a command assertion with an empty runnable (validateContract
// would reject it) NOR an always-green one (validateContract would NOT catch it —
// see isTrivialPass). A hint whose criterion matches nothing is simply inert —
// fail-safe, the unmatched criteria keep today's routing. Both consumers
// (synthesizeContract tightening 1, tightenAuthoredContract) read through here, so
// the content check protects every hint-driven command mint in one place.
function collectProofHints(charter: Charter | undefined): Map<string, string> {
  const hints = new Map<string, string>();
  if (!charter) return hints;
  const all = [...(charter.proofHints ?? []), ...(charter.decomposition ?? []).flatMap((sg) => sg.proofHints ?? [])];
  for (const h of all) {
    const criterion = h.criterion.trim();
    const run = h.run.trim();
    if (criterion && run && !isTrivialPass(run) && !hints.has(criterion)) hints.set(criterion, run);
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

// M11.1 (adaptiveVerification, docs/adaptive-verification.md §3.1). PURE. The
// TIGHTENING-ONLY derivation over an AUTHORED contract — the choke-point sibling
// of synthesizeContract for the case synthesizeContract never reaches. Today
// synthesizeContract runs ONLY when readContract is null; a human/agent-AUTHORED
// bundle contract (readContract non-null) bypasses ALL derivation, so its golden-
// diff / live-critic assertions stay agent-judged and a malformed command
// assertion (expected = a PROSE description, not a runnable — the loom_mrinlb18
// "bun-test-suite-passes" case) stays unrunnable. This closes that gap WITHOUT
// touching authored intent it cannot improve: it only ever TIGHTENS toward a
// charter-authored proofHint (the same authored trust channel synthesizeContract
// honors), and only when the tightening still validates.
//
// Conservatism (mirrors synthesizeContract's header): the ONLY signal consulted
// is collectProofHints(loom.charter) — a hint is a claim SOMEBODY authored, never
// inferred from the repo or from prose, AND (collectProofHints) never a trivially-
// passing runnable. An assertion is matched to a hint by EXACT criterion text
// against its `id` (primary — the live evidence had id "bun-test-suite-passes" ==
// hint.criterion) OR `description` (fallback), both trimmed.
//
// ONE direction only — CONVERT, never EDIT (adaptive-verification review, finding 1):
//   An AGENT-JUDGED assertion (isDeterministic=false — a live-critic or golden-diff,
//   which carries NO runnable `expected` of its own) that matches a hint becomes
//   {type:"command", expected: hint.run}. observable/expectedFile are cleared and
//   any stray subjective marker stripped (validateContract rejects subjective on a
//   non-live-critic type). This is the live-critic → command TIGHTENING the design
//   doc blesses (§3.1) and contractLoosenings never flags — it ADDS a real,
//   validated (non-trivial) runnable check where there was only agent judgment.
//
// A DETERMINISTIC assertion (command/gate/db) is NEVER touched here. It already
// carries a human/proposer-authored runnable `expected`, and editing that expected
// is "editing the yardstick" — exactly what §M.2 exists to catch: text CANNOT tell
// a stricter runnable from a looser one, so replacing e.g. `bun test --coverage
// --min 90` with a charter hint's `bun test` would silently WEAKEN a human-approved
// gate under a "tightening" label (the original finding-1 breach). A broken/prose-
// `expected` authored command therefore stays as-authored (it fails closed and the
// loom blocks); its correct repair is a HUMAN one via the escalation surface, not a
// self-cosigned auto-rewrite. So: never a deterministic→live-critic downgrade,
// never any edit of a deterministic assertion, never touch a hint-LESS assertion —
// worst case is always unchanged.
//
// Every candidate is re-validated (validateContract over the whole contract with the
// one assertion replaced); if it would produce an INVALID contract the tightening
// for THAT assertion is DISCARDED and the original kept — fail-safe, an invalid
// contract is never emitted. Flag-off (or no manifest) is a strict no-op: the input
// contract is returned unchanged with an empty tightenings list.
//
// IDEMPOTENT: a re-dispatch reads the already-tightened contract from disk; a
// converted assertion is now a DETERMINISTIC `command`, which this function never
// touches → zero events, no rewrite. A tightening is recorded ONLY when an assertion
// actually converts.
export function tightenAuthoredContract(
  contract: VerificationContract,
  loom: Loom,
  manifest?: { adaptiveVerification?: boolean },
): {
  contract: VerificationContract;
  tightenings: { id: string; fromType: string; fromExpected?: string; toType: string; toExpected: string }[];
} {
  if (!(manifest && adaptiveVerificationEnabled(manifest))) return { contract, tightenings: [] };
  const hints = collectProofHints(loom.charter);
  if (hints.size === 0) return { contract, tightenings: [] };

  const working = contract.assertions.slice();
  const tightenings: { id: string; fromType: string; fromExpected?: string; toType: string; toExpected: string }[] = [];

  for (let i = 0; i < working.length; i++) {
    const a = working[i];
    const run = hints.get(a.id.trim()) ?? hints.get(a.description.trim());
    if (!run) continue; // hint-less assertion — keep today's routing untouched

    // A DETERMINISTIC assertion (command/gate/db) already carries an authored
    // runnable `expected`; editing it is "editing the yardstick" (§M.2), which text
    // can't tell stricter from looser — NEVER touched here (see header). This also
    // makes the function idempotent: a Direction-1 conversion produces a `command`,
    // which is deterministic, so a re-dispatch skips it → zero events, no rewrite.
    const deterministic = partitionAssertions([a]).deterministic.length === 1;
    if (deterministic) continue;

    // CONVERT — agent-judged (live-critic / golden-diff, no runnable of its own) →
    // command. Clear observable/expectedFile + strip any stray subjective marker so
    // the result passes validateContract's non-live-critic rules; the id/
    // description/subGoalId/blocker are preserved verbatim.
    const tightened: ContractAssertion = {
      ...a,
      type: "command",
      expected: run,
      observable: undefined,
      expectedFile: undefined,
      subjective: undefined,
    };

    // Fail-safe: validate the WHOLE candidate (prior tightenings applied, this one
    // replaced). If it would be invalid, DISCARD this tightening and keep the
    // original — never emit an invalid contract.
    const candidate: VerificationContract = {
      ...contract,
      assertions: working.map((x, j) => (j === i ? tightened : x)),
    };
    if (validateContract(candidate).length > 0) continue;

    working[i] = tightened;
    tightenings.push({ id: a.id, fromType: a.type, fromExpected: a.expected, toType: "command", toExpected: run });
  }

  if (tightenings.length === 0) return { contract, tightenings: [] };
  return { contract: { ...contract, assertions: working }, tightenings };
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
