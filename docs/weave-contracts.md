# Weave contract wiring, tightening and synthesis

`packages/core/src/weave-contracts.ts` is where a Verification Contract gets
forced onto a loom that never authored one (`synthesizeContract`), where an
authored contract's agent-judged assertions get tightened toward a sanctioned
runnable (`tightenAuthoredContract`), and where a woven root's per-Thread
bundle gets its own filtered contract slice (`wireChildBundle`). This
document holds the M-series finding history and the full reasoning; the
source file holds only the point-of-use notes a reader needs while editing
it.

## Per-Thread bundle wiring, in context

A woven root's children are created lazily in the weaver's `spawnChild`
(`dispatcher.ts`: `runWeaveWiring`), NOT at charter-assign time — so
`wireChildBundle` is where each Thread gets its OWN Spec Bundle: the root's
context files copied in, its objective narrowed to the SubGoal, and its
Verification Contract filtered down to just that workstream's slice (the
assertions carrying its `subGoalId`, plus the cross-cutting ALL/unlabelled
ones). The child then reads its own bundle via its own `readContract` in the
executor — proving its SubGoal in isolation.

## `contractErrorsRepairable` (M11 finding 6)

Classifies a set of `validateContract` errors as AUTHOR-REPAIRABLE — every
error is one the sanctioned tightening machinery can fix from the author's
own material, so a `readContract`-null AUTHORED contract is worth
REVIVING+repairing instead of throwing away and re-synthesizing.

Two repairable classes, matched by their exact `validateContract`
substrings:

1. `"non-runnable expected"` — a command whose `expected` failed
   `isRunnableShape` (finding 2a/7): repaired to a matching hint / adopted
   observable / `manifest.verifyCommand` by `tightenAuthoredContract`.
2. `"observable is only valid on live-critic"` — a command/gate carrying a
   mis-placed runnable in `observable` (finding 6): the field-inverted run
   #3 shape, whose observable is adopted as the repair source.

A finding-6-shaped legacy contract yields BOTH errors at once (prose
`expected` + stray `observable`), so a naive
`.every(e => e.includes("non-runnable expected"))` would REFUSE to revive
it — this is why the function checks against two substrings, not one. The
check is deliberately NARROW: malformed JSON, a dangling `expectedFile`, a
prose-only assertion, an all-live-critic floor breach etc. are NOT
author-repairable and must still fall through to `synthesizeContract`.

## `isTrivialPass`

A runnable that ALWAYS exits 0 without checking anything — `true`, `:`,
`exit 0`, `echo …` — is an always-green "check": honoring it as a proofHint
would mint a `command` assertion that can never fail, silently REPLACING a
real judge (a live-critic) or a real runnable with an unconditional pass.
That is a verdict-floor breach (the adaptive-verification review's finding
2: a hallucinated `run:"true"` neuters the floor with only a mislabeled
"tightening" event).

A proofHint is agent-supplied (the `planWeaveFromBundle` emit); its
criterion→runnable mapping is trusted for ROUTING, but its content must
still be a genuine check. A command is trivial-pass IFF EVERY sequenced
segment is such a no-op — a single real segment (e.g.
`node cli.js --nope; test $? -eq 2`) makes the whole thing a genuine check
and is honored. Rejecting a trivial-pass hint makes it INERT (as if
unauthored) so the criterion keeps today's routing — fail-safe, worst case
unchanged, never always-green.

## `collectProofHints` (M11.1)

Flattens the charter's per-criterion proof hints (charter-level plus every
SubGoal's) into ONE criterion-text → runnable map, trimmed on both sides.
First hint wins on a duplicate criterion (charter-level outranks subgoal,
document order after that) — deterministic, never a merge surprise.

Blank OR trivially-passing (`isTrivialPass`) OR non-runnable-shaped
(`isRunnableShape` false — M11 finding 2b) run entries are dropped: a
degenerate hint must never mint a command assertion with an empty runnable
(`validateContract` would reject it), NOR an always-green one
(`validateContract` would NOT catch it — see `isTrivialPass`), NOR one
carrying PROSE / a JS expression that would reach `sh -c` verbatim ("process
exits with code 0…", `parse(…) === {…}` — the live `loom_mrirhfm4` bug). A
hint whose criterion matches nothing is simply inert — fail-safe, the
unmatched criteria keep today's routing.

Both consumers (`synthesizeContract` tightening 1, `tightenAuthoredContract`)
read through here, so the content check protects every hint-driven command
mint in one place — a non-runnable hint is inert everywhere, never
installed into an `expected`.

## `synthesizeContract` (M1, D0.2/D1.2, M10.5, M11.1 §3.1)

Forces a Verification Contract onto a loom that was created WITHOUT one (a
plain custom loom with only `acceptanceCriteria`, or nothing) — the M1
creation-time invariant that EVERY loom ends up with a contract. Each
`acceptanceCriteria` line becomes one `live-critic` assertion (the only kind
that maps prose to live judgment without a fabricated exit-code gate); with
zero criteria it falls back to a single assertion from the prompt/title.
Every assertion is scoped `subGoalId:"ALL"` so (a) the weave-of-one child
inherits the whole slice via `wireChildBundle`'s ALL filter, and (b)
`runIntegrationVerify`'s ALL slice is non-empty → full re-verify fires.
`synthesized:true` honestly labels the result so `validateContract` skips
only the hard-gate floor (D0.1). Never throws; always ≥1 assertion
(prompt/title always exist from `createLoom`, so this adds NO new mandatory
user input).

**M10.5 — `manifest` is OPTIONAL** (default `undefined` ⇒ existing callers
byte-identical, e.g. `m1-forced-contracts`). It is the flag-gated structural
hook (`proposerStructuralPlan` B). Flag-off (or no manifest) EVERY
criterion still maps to `type:"live-critic"` / `subGoalId:"ALL"` /
`blocker:true` / `synthesized:true`, so the m1/weave-planner/contract tests
stay byte-identical. Flag-on, this DETERMINISTIC no-LLM fallback stays
CONSERVATIVE by construction: it NEVER invents a `subjective` classification
from prose (a keyword scan risks false-positives that would DROP an
objective criterion — a moat violation). The one structural tightening it
makes is precise and deterministic: a criterion whose text EXACTLY names a
configured project gate becomes a `gate` assertion (an offline exit-code
check) instead of a live-critic — a live-critic→gate TIGHTENING
`contractLoosenings` never flags, and objective/fail-closed. Every other
criterion keeps live-critic. The rich per-criterion authoring (command/gate
+ the subjective marker) lives in the LLM charter proposer.

**M11.1 (docs/adaptive-verification.md §3.1) — the modality DERIVATION the
M10.5 header reserved.** When a manifest is present, two additional PRECISE
tightenings run, in order, after the exact-gate-name rule; everything they
cannot map STAYS live-critic (worst case = today):

1. HONOR a charter-authored per-criterion proofHint (`schemas.ProofHint`): a
   criterion whose exact text carries a hint becomes
   `{type:"command", expected: hint.run}` — how a CLI/DS criterion gets its
   concrete runnable (authored where the criteria live — by the proposer or
   a human, never invented here from prose; the module's own conservatism
   rule above).
2. DERIVE from the deliverable (`deriveDeliverableSignal` — the same PURE,
   never-throwing, bounded-filesystem signal the M11.0 pre-flight reads;
   flag-on this function trades strict purity for that bounded read): when
   the signal says "test-gate" (a real test script exists TODAY) the
   remaining criteria become `{type:"command", expected: signal.run}` (the
   lockfile-aware `bun|pnpm|yarn|npm run test`) — but ONLY under an explicit
   SANCTION, because "the suite proves it" must be a claim somebody actually
   made, never an inference from the repo alone:
   - (a) the criteria are the PROMPT FALLBACK (zero authored
     `acceptanceCriteria` — the `loom_mrigs3zo_vxgrsr` greenfield shape,
     where the one synth-0 assertion IS "the deliverable works" and the
     suite is exactly its proof), OR
   - (b) the charter carries gate-shaped proof intent
     (`charterHasGateIntent` — `PROOF_TEMPLATES.verifyMechanism==="gate"`),
     the same authored trust channel as a proofHint.

   WITHOUT a sanction, authored multi-criteria prose keeps live-critic: a
   pre-existing green suite must never rubber-stamp a criterion it says
   nothing about (credentials-bound work, taste — doc §4 "a mis-derived
   method can never rubber-stamp; the worst it can do is produce NO
   evidence", §3.2 park semantics). Those criteria tighten only via an
   exactly-matching proofHint, or land the fail-closed no-evidence demote.
   The web shape short-circuits to `plannable:false` inside the signal, so a
   dev-server app can never be blanket-tightened either way.
   deferred-gate/cli-harness/sandbox-eval carry NO runnable today, so they
   tighten ONLY via hints — never a fabricated command.

Both directions are live-critic → gate/command TIGHTENINGS (the direction
`contractLoosenings` never flags); the reverse (gate → live-critic) has no
code path here — the exact-gate-name rule stays FIRST, so a criterion that
is a named gate stays a named gate. A derived gate/command never carries
`subjective` (this deterministic path never authors the marker;
`validateContract` additionally rejects it on any non-live-critic type).
`synthesized: true` stays carried verbatim. The `manifest ? … : false` guard
mirrors the M10.5 routing line: a bare 1-arg caller runs no modality
tightening (worst case = today's blanket live-critic).

## `tightenAuthoredContract` (M11.1 §3.1)

The TIGHTENING-ONLY derivation over an AUTHORED contract — the choke-point
sibling of `synthesizeContract` for the case `synthesizeContract` never
reaches. Today `synthesizeContract` runs ONLY when `readContract` is null;
a human/agent-AUTHORED bundle contract (`readContract` non-null) bypasses
ALL derivation, so its golden-diff / live-critic assertions stay
agent-judged and a malformed command assertion (`expected` = a PROSE
description, not a runnable — the `loom_mrinlb18` "bun-test-suite-passes"
case) stays unrunnable. This closes that gap WITHOUT touching authored
intent it cannot improve: it only ever TIGHTENS toward a charter-authored
proofHint (the same authored trust channel `synthesizeContract` honors),
and only when the tightening still validates.

**Conservatism** (mirrors `synthesizeContract`'s header): the ONLY signal
consulted is `collectProofHints(loom.charter)` — a hint is a claim SOMEBODY
authored, never inferred from the repo or from prose, AND
(`collectProofHints`) never a trivially-passing runnable. An assertion is
matched to a hint by EXACT criterion text against its `id` (primary — the
live evidence had id `"bun-test-suite-passes"` == `hint.criterion`) OR
`description` (fallback), both trimmed.

**ONE direction only — CONVERT, never EDIT** (adaptive-verification review,
finding 1): an AGENT-JUDGED assertion (`isDeterministic=false` — a
live-critic or golden-diff, which carries NO runnable `expected` of its
own) that matches a hint becomes `{type:"command", expected: hint.run}`.
`observable`/`expectedFile` are cleared and any stray `subjective` marker
stripped (`validateContract` rejects `subjective` on a non-live-critic
type). This is the live-critic → command TIGHTENING the design doc blesses
(§3.1) and `contractLoosenings` never flags — it ADDS a real, validated
(non-trivial) runnable check where there was only agent judgment.

A DETERMINISTIC assertion with a RUNNABLE `expected` is NEVER touched here.
It already carries a human/proposer-authored runnable, and editing that
runnable is "editing the yardstick" — exactly what §M.2 exists to catch:
text CANNOT tell a stricter runnable from a looser one, so replacing e.g.
`bun test --coverage --min 90` with a charter hint's `bun test` would
silently WEAKEN a human-approved gate under a "tightening" label (the
original finding-1 breach). So: never a deterministic→live-critic downgrade,
never any edit of a RUNNABLE deterministic assertion, never touch a
hint-LESS agent-judged assertion — worst case unchanged.

**M11 finding 2c/3 — the ONE sanctioned exception** (the item-2c nuance the
invariant blesses): a DETERMINISTIC `command` whose `expected` is
NON-runnable-shaped (`isRunnableShape` false — the `loom_mrinlb18` "process
exits with code 0…" prose that reaches `sh -c` verbatim and can only ever
fail closed) is a BUG, not a yardstick. When such a broken command has a
SANCTIONED runnable — a matching charter proofHint OR the HUMAN-answered
`manifest.verifyCommand` (finding 3: the authoritative runnable the human
supplied at escalation, persisted to `telar.yaml`) — its `expected` is
REPAIRED to that runnable, recorded as a tightening (event-trailed,
co-signed `auto:tighten-authored` by the dispatcher). This is not a
weakening: the original was unrunnable garbage that always fails closed;
replacing it with a real check can only raise the floor from "never
verifiable" to "verifiable." A RUNNABLE authored `expected` stays forbidden
to replace (above); the repair is SCOPED to `command` (a `gate` `expected`
is a name, a `db` `expected` is legitimately SQL-shaped) and to the
NON-runnable case only. `contractLoosenings` sees the content change on a
still-blocking assertion — that is WHY the tightening is emitted and routed
through the dispatcher's sanctioned `auto:` co-sign, never a silent edit.

Every candidate is re-validated (`validateContract` over the whole contract
with the one assertion replaced); if it would produce an INVALID contract
the tightening for THAT assertion is DISCARDED and the original kept —
fail-safe, an invalid contract is never emitted. Flag-off (or no manifest)
is a strict no-op: the input contract is returned unchanged with an empty
tightenings list.

**IDEMPOTENT:** a re-dispatch reads the already-tightened contract from
disk; a converted assertion is now a DETERMINISTIC `command`, which this
function never touches → zero events, no rewrite. A tightening is recorded
ONLY when an assertion actually converts.

### The finding-6 repair source (field-inverted `observable`)

A THIRD sanctioned repair source lives INSIDE the contract: a command whose
runnable is field-inverted into `observable` (run #3 — the planner put
PROSE in `expected` and the actual RUNNABLE in `observable`, e.g.
`"bun test"`). `validateContract` now rejects that observable at author
time, but a LEGACY/started contract may already carry it. It repairs even
with no hint and no `verifyCommand`, so the cheap no-op guard
(`hasInvertibleObservable`) must also let that case through — otherwise, if
no assertion carries an adoptable inverted observable AND there are no
hints/`verifyCommand`, the loop would record nothing, and the function
short-circuits to the original contract reference (byte-identical).

Adopt a runnable `observable` as a sanctioned repair SOURCE — it is exactly
the command the author meant, just mis-placed — ahead of the human-answered
`verifyCommand`. Repair SOURCE only: `observable` is never read as a live
gate field (the gate layer still runs `expected`); this moves the
mis-placed runnable INTO `expected` where the gate layer will run it,
event-trailed like every other tightening. Clearing the stray `observable`
afterward is always correct — a command never legitimately carries one, and
`validateContract` (finding 6) now rejects a non-blank observable on a
command, so leaving it would make the re-validation DISCARD the repair.

The `isTrivialPass` guard applies here too, mirroring `collectProofHints`
and `hasInvertibleObservable`: an always-green observable (`"true"`, `":"`,
`"echo ok"`, `"exit 0"`) is runnable-SHAPED but not a genuine check;
adopting it as `expected` would rewrite a fail-closed prose gate into an
unconditional pass (the exact verdict-floor breach `isTrivialPass` exists
to prevent), then persist it under the `auto:tighten-authored` self-cosign
whose safety justification assumes only non-trivial runnables reach here.
Never adopt a trivial-pass observable.

## `wireChildBundle`

PURE w.r.t. the child object except for the two fields it stamps
(`contractRequired` / `acceptanceCriteria`) — the caller saves the child.
Copies every root bundle file into the child EXCEPT `contract.json` and
`objective.md`, which are set explicitly so a child never inherits the
root's whole contract or objective.

The filtered slice = root assertions whose `subGoalId` is this SubGoal's
id, OR `"ALL"`, OR unlabelled (cross-cutting). If that slice has a
falsifiable hard-gate (`validateContract` passes — needs ≥1 non-live-critic
assertion), the child gets its own `contract.json` and
`contractRequired:true` (panel path). If it doesn't, no `contract.json` is
written (`readContract` stays null) and the child falls back to the
SubGoal's `acceptanceCriteria` (legacy verifier path).

`synthesized` (M1, D1.4): whether the root contract these assertions came
from was synthesized. Threaded onto the child contract so an all-live-critic
synthesized slice passes `validateContract` (the floor is skipped for it)
and the weave-of-one child takes the panel path instead of the legacy
degrade.
