# Discuss-escalation — iteration 2 feedback (live testing, 2026-07-12)

Feedback from live-testing the conversational blocked-escalation on
`loom_mrinlb18_0s6x5h` (vindication). Items numbered as given; this list is
appended to as testing continues, then executed as one build round.

## 1. AI opens with an initial proposal (one-shot when possible)

When the human clicks **Discuss**, the FIRST turn is the AGENT's, not an empty
chat waiting for the human to speak: the agent has the full blocked context
(blockedReason, blockedQuestion, contract, deliverable-signal evidence), so it
should open by ANALYZING it and PROPOSING a concrete verification method
upfront — e.g. "This is a greenfield bun-test library; I propose
`verifyCommand: bun test`. Approve and I'll submit it."

- **One-shot path:** if the opening proposal is right, the human's entire
  interaction is approving the `answer_blocked` tool call — one click, done.
  The conversation only deepens when the human disagrees or is unsure.
- **Boundary preserved:** the agent turn fires only AFTER the human clicks
  Discuss (the no-auto-start rule from iteration 1 stands — no session, no
  tokens, no spoken turns before the click). The click IS the human
  initiation; the first VISIBLE content is the agent's proposal.
- **Moat unchanged:** the proposal still lands exclusively through the
  human-approved `answer_blocked` tool — an auto-fired first turn must not
  auto-fire the tool approval. The agent may CALL the tool in its first turn;
  execution still waits on the permission card.
- Implementation note: today's surface uses a render-only greeting
  (`PLANNER_GREETING` pattern, never sent/billed). This item replaces that
  with a REAL first agent turn auto-fired on chat open (post-click), so the
  proposal is genuine analysis, not static copy.

## 2. Non-runnable command/gate `expected` must never reach `sh -c` (live bug)

Observed on `loom_mriqnl72_o854v7` (vindication child): the authored command
assertion `bun-test-suite-passes` carried `expected: "process exits with code
0; test runner summary reports 0 failing tests…"` — prose. `runContractGates`
executed it verbatim (`process: command not found`, `test: too many
arguments`) and the child burned 3 repair attempts on a gate the builder can
NEVER fix (it's contract state, not project code) — even ending up reading
Telar's own source to debug "its" failure.
- `validateContract` (and the planning session's `propose_contract` tool) must
  reject/flag a command/gate `expected` that is not runnable-shaped.
- At execution, a non-runnable expected should fail closed TO ESCALATION
  (blocked, strategy-derived question), never enter the repair loop.

**Round-2 amplification (fresh run `loom_mrirhfm4_w0o4n2`, post-72e498c):** the
capture + tightening fixes WORKED (charter-proof-intent-captured, 13 hints,
contract-tightened events) but garbage flowed through unvalidated at every hop:
- (a) The PLANNER authored non-runnable `ProofHint.run` values — JS expressions
  (`parse('1.2.3') === {...}`) for API-behavior criteria. Needs BOTH schema/lint
  validation at emit (reject a run that is not an executable shell command) AND
  prompt guidance (a hint run must be a real command — wrap API assertions in a
  test file the run executes, e.g. `bun test test/contract-parse.test.ts`).
- (b) The tightening pass installed those hint runs into `expected` with NO
  runnable-shape validation — direction-1 tightening must refuse a non-runnable
  install (leave agent-judged; escalate if that empties the deterministic slice).
- (c) The no-overwrite rule (moat fix) blocked the SAFE repair: the one correct
  hint (`bun test` for test-suite-green) could not replace that assertion's
  prose `expected`. Nuance the rule: never replace a RUNNABLE authored expected
  (weakening risk), but a NON-runnable prose expected + a matching runnable hint
  is exactly the repair the moat wants — install it with an event trail.

## 3. The escalation answer must reach the gate layer

The human's `verifyCommand: bun test` made the lane viable and informs the TOP
gate strategy, but the CHILD thread still executed the broken authored
command. The human-answered verifyCommand is the authoritative runnable for
the test criterion — it should (with an event trail) sanction repairing or
overriding an unrunnable command assertion in the slice, instead of the child
gating on garbage while the correct answer sits in the manifest.

## 5. Cancel-path worktree removal loses committed, un-consolidated work

Observed after cancelling `loom_mrinlb18_0s6x5h` mid-build: the child
(`loom_mriqnl72_o854v7`) had COMMITTED attempt work in its isolated worktree
(`telar-wt-loom_mriqnl72_o854v7-1`, per its transcript), yet after the halt the
project repo has ONLY `refs/heads/main` — no recovery branch, no retained
worktree, and the child's `worktreeRetained`/`recoveryBranch` fields are null.
M8's promise ("a completed OR CANCELLED isolated loom leaves zero worktree dirs
behind, with the deliverable preserved as a BRANCH") is violated on the
cancel/abort path — likely the documented M8 crash-window (snapshot lives in
the executor finally; an abort mid-attempt may bypass it). Reproduce + close.

## 4. Unfixable-gate circuit breaker (repair-guard extension)

A gate that fails IDENTICALLY across attempts while the tree changes
substantially is not builder-fixable — the repair loop must detect this
(same assertion, same output signature, N consecutive attempts) and escalate/
park instead of spending. Related: proof-intent capture is creation-time only;
looms created before the plumbing fix (or whose planner emitted no hints) have
no repair route at re-dispatch — the breaker is their safety net.

## 6. Planner field inversion on authored command assertions (run #3)

Observed on `loom_mriuu8la_lrtwxx`: the planner authored command assertions
with the RUNNABLE in `observable` (`bun test`; a `node -e` dependency check; a
`grep -Eq` test-script check) and the EXPECTED OUTCOME as prose in `expected`
("exit code 0"). The gate layer executes `expected` and ignores `observable`
for command types — the real commands are unused. Fix: pin the field semantics
(reject `observable` on command/gate assertions at validation with a clear
message naming the right field, plus propose_contract prompt guidance), or
consciously adopt observable-as-runnable — pick ONE and enforce it everywhere.

## 7. isRunnableShape is too lenient — and a false-runnable becomes UN-repairable

"exit code 0" and "process exit code 0; summary output reports 0 fail" both
passed isRunnableShape (syntactically valid shell), so (a) validateContract let
them through and (b) the sanctioned prose-repair REFUSED to fix them — the
no-overwrite moat rule protects anything the predicate certifies as runnable.
The predicate's false-positives are therefore self-sealing. Tighten it (e.g.
first token must resolve via `command -v` allow-listing builtins that make
sense as gate entrypoints; reject bare `exit`/semicolon-chained prose), and
consider requiring the runnable to match a hint for planner-authored contracts.

## 8. A child's `blocked` park must propagate as a PAUSE, not a step failure

Run #3 (`loom_mriuu8la_lrtwxx` / child `loom_mrjgch8b_g9r7g4`): the new
circuit breaker correctly parked the CHILD `blocked` ("Unfixable gate after 2
attempts ... the red is contract/environment state") — but runThreadWorkflow
treated the non-green terminal as a step failure ("step \"implement\" failed:
terminated non-green (state \"blocked\")"), so child -> failed, rollup ->
root failed. The awaiting-human escalation was swallowed; the human never saw
the question. Fix: `blocked` must propagate through the step runner and weave
rollup as an awaiting-human PARK on the root (surface the child's
blockedQuestion; keep everything resumable), never coerce into `failed`.
Wins proven by the same run: the breaker fired as designed, and the child's
committed work was preserved on a recovery branch
(telar/loom_mriuu8la_lrtwxx-wip-loom_mrjgch8b_g9r7g4) — findings 4 and 5 work.
