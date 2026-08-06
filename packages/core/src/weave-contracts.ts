// Per-Thread bundle wiring (docs/loom-model.md §2, §M.1, §W) plus the M1/M11
// contract synthesis and tightening machinery. Full design reasoning — the
// M-series finding history, the conservatism arguments and the sanctioned
// repair sources — lives in docs/weave-contracts.md; keep this file to
// point-of-use notes only.
import { CONTRACT_FILE, listBundleFiles, snapshotBundle, writeBundleFile } from "./bundle";
import { validateContract, type Charter, type ContractAssertion, type SubGoal, type VerificationContract } from "./schemas";
import { charterHasGateIntent, deriveDeliverableSignal } from "./deliverable-signal";
import { partitionAssertions } from "./executor";
import { isRunnableShape } from "./runnable-shape";
import type { Loom } from "./looms";

// M11 (finding 6). PURE. Is this set of validateContract errors
// AUTHOR-REPAIRABLE — every error one the sanctioned tightening machinery
// below can fix from the author's own material, so a readContract-null
// AUTHORED contract is worth REVIVING+repairing rather than thrown away and
// re-synthesized? Deliberately NARROW (two exact substrings only) — reasoning
// and the finding-6 dual-error case: docs/weave-contracts.md
export function contractErrorsRepairable(errors: string[]): boolean {
  if (errors.length === 0) return false; // nothing to repair ⇒ nothing to revive
  return errors.every(
    (e) => e.includes("non-runnable expected") || e.includes("observable is only valid on live-critic"),
  );
}

// PURE. An always-green runnable ("true", ":", "exit 0", "echo …") must never
// be honored as a proofHint — it would mint a `command` assertion that can
// never fail, silently replacing a real judge with an unconditional pass (a
// verdict-floor breach). Trivial-pass IFF every sequenced segment is a no-op;
// a single real segment makes the whole thing a genuine check. Full
// reasoning: docs/weave-contracts.md
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

// M11.1. PURE. Flattens the charter's per-criterion proof hints into ONE
// criterion-text → runnable map. First hint wins on a duplicate criterion.
// Blank, trivially-passing, or non-runnable-shaped entries are dropped — a
// degenerate hint must never mint a broken or always-green command
// assertion, nor one carrying prose that would reach sh -c verbatim. An
// unmatched criterion is simply inert (fail-safe). Both synthesizeContract
// and tightenAuthoredContract read through here, so this is the ONE place a
// hint is content-checked. Full reasoning: docs/weave-contracts.md
function collectProofHints(charter: Charter | undefined): Map<string, string> {
  const hints = new Map<string, string>();
  if (!charter) return hints;
  const all = [...(charter.proofHints ?? []), ...(charter.decomposition ?? []).flatMap((sg) => sg.proofHints ?? [])];
  for (const h of all) {
    const criterion = h.criterion.trim();
    const run = h.run.trim();
    if (criterion && run && !isTrivialPass(run) && isRunnableShape(run) && !hints.has(criterion)) hints.set(criterion, run);
  }
  return hints;
}

// M1 (D0.2, D1.2). PURE. Forces a Verification Contract onto a loom created
// WITHOUT one — every acceptanceCriteria line becomes a `live-critic`
// assertion (falls back to prompt/title with zero criteria), scoped
// subGoalId:"ALL", synthesized:true. Never throws; always ≥1 assertion.
//
// M10.5 — `manifest` is OPTIONAL; flag-off (or no manifest) is byte-identical
// to the pre-M10.5 behavior. Flag-on this stays CONSERVATIVE by construction
// (never infers `subjective` from prose): the one structural tightening is a
// criterion whose text EXACTLY names a configured project gate → `gate`.
//
// M11.1 (docs/adaptive-verification.md §3.1) — two further PRECISE
// tightenings run when a manifest is present, after the exact-gate-name rule;
// anything they cannot map STAYS live-critic (worst case = today):
//   1. HONOR a charter-authored proofHint for this exact criterion text.
//   2. DERIVE from the deliverable when a real test script exists TODAY —
//      but ONLY under an explicit SANCTION (prompt-fallback criteria, or a
//      charter with gate-shaped proof intent), never as a blanket inference
//      from a green repo. Full sanction reasoning, the deferred-gate/
//      cli-harness/sandbox-eval carve-out, and why the web shape
//      short-circuits: docs/weave-contracts.md
// Both directions are live-critic → gate/command TIGHTENINGS only; the
// reverse has no code path here (the exact-gate-name rule stays FIRST).
export function synthesizeContract(
  loom: Loom,
  manifest?: {
    gates?: { name: string }[];
    root?: string;
  },
): VerificationContract {
  const criteria = (loom.acceptanceCriteria ?? []).map((c) => c.trim()).filter(Boolean);
  const sources = criteria.length ? criteria : [loom.prompt?.trim() || loom.title];
  const gateNames = new Set((manifest?.gates ?? []).map((g) => g.name.trim()).filter(Boolean));
  // Derivation inputs, resolved ONCE per synthesis.
  const hints = collectProofHints(loom.charter);
  // The blanket test-gate SANCTION (header rule 2): prompt-fallback criteria or
  // an explicit gate-mechanism charter. Unsanctioned ⇒ the signal is not even
  // derived (zero filesystem reads) and authored prose keeps live-critic.
  const blanketSanctioned = criteria.length === 0 || charterHasGateIntent(loom.charter);
  const signal =
    blanketSanctioned && manifest?.root ? deriveDeliverableSignal(manifest.root, loom.charter) : null;
  const testRun = signal?.plannable && signal.strategy === "test-gate" ? signal.run : undefined;
  const assertions: ContractAssertion[] = sources.map((text, i) => {
    if (gateNames.has(text)) {
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

// M11.1 (docs/adaptive-verification.md §3.1). PURE. The TIGHTENING-ONLY
// derivation over an AUTHORED contract (readContract non-null) — the
// choke-point sibling of synthesizeContract for the case it never reaches.
// Closes the gap where a human/agent-authored malformed command `expected`
// (prose, not a runnable) stays unrunnable forever, WITHOUT touching authored
// intent it cannot improve.
//
// Conservatism: the ONLY signal consulted is collectProofHints(loom.charter)
// — never inferred from the repo or from prose. Matched by exact criterion
// text against `id` (primary) or `description` (fallback), both trimmed.
//
// ONE direction only — CONVERT, never EDIT (adaptive-verification review,
// finding 1): an agent-judged assertion (live-critic/golden-diff, no runnable
// of its own) that matches a hint becomes {type:"command", expected:
// hint.run}. A DETERMINISTIC assertion with a RUNNABLE `expected` is NEVER
// touched — that runnable is a human/proposer-authored yardstick, and text
// cannot tell a stricter runnable from a looser one, so "tightening" it
// toward a hint could silently WEAKEN an approved gate (the original
// finding-1 breach).
//
// M11 finding 2c/3 — the ONE sanctioned exception: a DETERMINISTIC `command`
// whose `expected` is NON-runnable-shaped (a bug, not a yardstick — it can
// only ever fail closed) gets REPAIRED to a sanctioned runnable: a matching
// proofHint, the human-answered manifest.verifyCommand (finding 3), or a
// field-inverted `observable` already on the assertion (finding 6, see
// below). Scoped to `command` only; recorded as an event-trailed tightening,
// never a silent edit. Full reasoning for all three repair sources:
// docs/weave-contracts.md
//
// Every candidate is re-validated against the WHOLE contract; an invalid
// result discards that one tightening and keeps the original — fail-safe.
// IDEMPOTENT: a repaired/converted assertion is deterministic-with-runnable
// on the next pass, so a re-dispatch touches nothing and emits zero events.
export function tightenAuthoredContract(
  contract: VerificationContract,
  loom: Loom,
  // M11 finding 3 — the HUMAN-answered verification runnable (answerBlocked's
  // strategy answer, persisted to telar.yaml). The dispatcher already passes
  // the full ProjectManifest, so this widening needs no call-site change.
  manifest?: { verifyCommand?: string },
): {
  contract: VerificationContract;
  tightenings: { id: string; fromType: string; fromExpected?: string; toType: string; toExpected: string }[];
} {
  const hints = collectProofHints(loom.charter);
  const verifyCommand = manifest?.verifyCommand?.trim();
  const sanctionedVerify = verifyCommand && isRunnableShape(verifyCommand) ? verifyCommand : undefined;
  // M11 finding 6 — the THIRD sanctioned repair source: a command whose
  // runnable is field-inverted into `observable` (run #3, legacy shape).
  // Repairs even with no hint and no verifyCommand, so the no-op guard below
  // must let that case through too. Full reasoning: docs/weave-contracts.md
  const hasInvertibleObservable = contract.assertions.some(
    (a) =>
      a.type === "command" &&
      !!a.observable?.trim() &&
      isRunnableShape(a.observable!) &&
      !isTrivialPass(a.observable!) && // an always-green observable is not an adoptable check
      (a.expected == null || !isRunnableShape(a.expected)),
  );
  if (hints.size === 0 && !sanctionedVerify && !hasInvertibleObservable) return { contract, tightenings: [] };

  const working = contract.assertions.slice();
  const tightenings: { id: string; fromType: string; fromExpected?: string; toType: string; toExpected: string }[] = [];

  for (let i = 0; i < working.length; i++) {
    const a = working[i];
    const run = hints.get(a.id.trim()) ?? hints.get(a.description.trim());
    const deterministic = partitionAssertions([a]).deterministic.length === 1;

    let tightened: ContractAssertion | null = null;

    if (!deterministic) {
      // CONVERT (Direction 1). observable/expectedFile cleared + any stray
      // subjective marker stripped, so the result passes validateContract's
      // non-live-critic rules. A hint-less agent-judged assertion is skipped.
      if (!run) continue;
      tightened = { ...a, type: "command", expected: run, observable: undefined, expectedFile: undefined, subjective: undefined };
    } else {
      // REPAIR (finding 2c/3) — a runnable `expected` is never edited (§M.2).
      // The one exception: NON-runnable `expected` on a `command` (a bug).
      if (a.type !== "command") continue;
      if (a.expected == null || isRunnableShape(a.expected)) continue; // runnable/absent stays as-authored
      // Finding 6 — adopt a runnable, non-trivial `observable` as the repair
      // SOURCE (never as a live gate field): the author's runnable, just
      // mis-placed. Preferred ahead of the human-answered verifyCommand.
      const inverted =
        a.observable && isRunnableShape(a.observable) && !isTrivialPass(a.observable) ? a.observable : undefined;
      const repair = run ?? inverted ?? sanctionedVerify;
      if (!repair) continue; // no sanctioned runnable — leave to human escalation, fails closed
      // Clear any stray `observable`: validateContract rejects a non-blank
      // observable on a command, so leaving it would discard this repair.
      tightened = { ...a, expected: repair, observable: undefined };
    }

    // Fail-safe: validate the WHOLE candidate (prior tightenings applied,
    // this one replaced). Invalid ⇒ discard this tightening, keep original.
    const candidate: VerificationContract = {
      ...contract,
      assertions: working.map((x, j) => (j === i ? tightened! : x)),
    };
    if (validateContract(candidate).length > 0) continue;

    working[i] = tightened;
    tightenings.push({ id: a.id, fromType: a.type, fromExpected: a.expected, toType: tightened.type, toExpected: tightened.expected! });
  }

  if (tightenings.length === 0) return { contract, tightenings: [] };
  return { contract: { ...contract, assertions: working }, tightenings };
}

// PURE w.r.t. the child object except for the two fields it stamps
// (contractRequired / acceptanceCriteria) — the caller saves the child.
// Copies every root bundle file into the child EXCEPT contract.json and
// objective.md, which are set explicitly below so a child never inherits the
// root's whole contract or objective.
//
// The filtered slice = root assertions whose subGoalId is this SubGoal's id,
// OR "ALL", OR unlabelled (cross-cutting). A falsifiable hard-gate slice gets
// its own contract.json + contractRequired:true (panel path); otherwise no
// contract.json is written and the child falls back to the SubGoal's
// acceptanceCriteria (legacy verifier path).
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
