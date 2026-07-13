# De-flag cut plan (APPROVED 2026-07-13)

> Approved by the owner with decisions D1-D7 below. Grounded in docs/PRINCIPLES.md.

TELAR DE-FLAG CUT PLAN — one engine, no dual paths (grounds: docs/PRINCIPLES.md §38-42 "one engine, git is the flag"; §65-69 forbids flags/TELAR_* behavior env/byte-identical-off dual paths; §70-72 no per-thread fail-closed-as-terminal; §73-74 no human ping while a correction is untried).

═══════════════════════════════════════════
MOAT — MUST NOT CHANGE (verify every phase leaves these fail-closed and intact)
═══════════════════════════════════════════
1. Top-gate coercion — orchestratorVerify/frozenLaneVerify over the consolidation branch/full contract demotes ready→needs-review fail-closed (weave.ts:443-450, dispatcher.ts:603-612, verify-thread.ts:147). Becomes UNCONDITIONAL, never removed.
2. No-target floor — runPanelVerification if(!target)→panelRequired skip→decide() demote (executor.ts:591-606) and frozenLaneVerify's noTarget marker withholding the stale-URL fallback (verify-thread.ts:239-252). Stays fail-closed.
3. Read-only judge wall — READ_ONLY_TOOLS/READ_ONLY_DISALLOWED_TOOLS + restrictTools + settingSources:[] (build-fanout.ts:130-131) at planner/splitBuild/free-fanout/critic. Evidence is never self-report.
4. Human accept — acceptLoom is the sole path to done, non-blank `by` required (looms.ts:456,464); terminalStateForCompletedLoom keeps roots at ready never done (executor.ts:246). No autonomous path may ever write done (§75).
5. Waste breakers — executeLoom unfixable-gate signature-plateau breaker (executor.ts:1914-1969) + repair-guard.ts convergence guards (maxRepairIterations/budget/byte-identical-signature). These stop WASTE, not fixable problems; their convergence math is a keep (only their PARK action is re-routed through mediation in Phase 6).
6. Completeness gate — validateDecision finish-loom illegal unless every required subgoal is done (tick.ts:98-103) + rollupWeave zero-required refusal (weave.ts:28-30).

═══════════════════════════════════════════
ROUND A — DE-FLAG (collapse to one engine). Four phases; A1+A3 parallel, A2 after A1, A4 last.
═══════════════════════════════════════════
The spine. 15 flag helpers live in 3 files (runner/flag.ts:7-119 [11], vcs.ts:44/52/63 [3], build-fanout.ts:70 [1]). Each is `manifest.<flag> || TELAR_*=1` with a documented byte-identical OFF path — the exact §65-69 pattern. Collapse the keeps to unconditional and delete the OFF branch; delete the dead/superseded features outright.

PHASE A1 — Collapse the 11 keep-on flags to the sole path (L).
Delete the OFF branch at every callsite for: setupAgent, threadWorkflow, threadPlanner, stepChecks, orchestratorVerify, laneEscalation, verifyLane, subjectiveRouting, adaptiveVerification (runner/flag.ts) + isolateWorktrees, autoRepair (vcs.ts). These are the inner-loop (thread-as-workflow, §26), the deterministic top gate + moat (§53), ask-once-persist escalation (§63), and the worktree/review-branch substrate. Sub-lanes (serialize on shared executor.ts/dispatcher.ts edits, but conceptually independent):
  - A1a worktree/repair substrate: isolateWorktrees, autoRepair (vcs.ts:44,52; dispatcher.ts:479,484,566,616,694; executor.ts:1478,1742). HIGH blast radius.
  - A1b thread inner loop: threadWorkflow (executor.ts:1558), threadPlanner (executor.ts:2261 → planner is the norm, template the degrade floor), stepChecks (executor.ts:2501,718), setupAgent (dispatcher.ts:461,675).
  - A1c top gate + moat: orchestratorVerify (dispatcher.ts:603,631; executor.ts:2032), verifyLane (dispatcher.ts:347), laneEscalation (dispatcher.ts:459; executor.ts:618).
  - A1d contract routing: subjectiveRouting (executor.ts:581,873,1196; scoping.ts:161; weave-contracts.ts:174), adaptiveVerification (weave-contracts.ts:179,284; dispatcher.ts:222,1211; executor.ts:1764; scoping.ts:169).
NOTE carried to Round B: stepChecks' current fail-closed thread-demote (schemas.ts:296, executor.ts:2501,2542-2591) conflicts with §72 — collapse the flag now, reconcile the fail-closed-demote to mediate-then-escalate in Phase B1.
Rewrite the always-on test files alongside (see testImpact).

PHASE A2 — Delete the dead + superseded features (M). Depends on A1.
  - runnerEnabled / outOfProcessRunner: DEAD — zero non-test callsites (verified: only its own def at flag.ts:7). Runner selection actually lives in resolveRunner precedence (runner/resolve.ts:21, TELAR_RUNNER_URL/BIN — untouched infra). Delete flag + key (schemas.ts:255) + TELAR_RUNNER + test.
  - envReview: SUPERSEDED — it inserts an EXTRA (4th) human gate beyond §13's three (executor.ts:602,909; dispatcher import :50). Its job (no target, no server recipe) is now the unconditional laneEscalation pre-flight + verifyLane lane stand-up. Delete flag + key (schemas.ts:278) + TELAR_ENV_REVIEW + the env-review state enum/state maps.
  - buildFanout: SUPERSEDED by M9 thread-workflow fan-out (§26 sanctioned fan-out is now unconditional). Delete flag + key (schemas.ts:268) + TELAR_BUILD_FANOUT + wiring at dispatcher.ts:566.
Delete 4 whole test files (see testImpact).

PHASE A3 — Convert liveDbClone env-gate to dependency injection (M). Parallel with A1.
vcs.ts:63 liveDbCloneArmed / TELAR_FROZEN_LANE_DB selects LiveDbCloner vs NullDbCloner (db-clone.ts:55,77) — a byte-identical-when-off dual path (§65). Resolution: engine always uses the real cloner when a real DB is present; tests inject a FakeDbCloner (the seam already exists — db-clone.ts, flag-off.test.ts:66). Delete the env gate; capability becomes DI. (This is a safety posture the owner must confirm — see openQuestions.)

PHASE A4 — Schema + env cleanup (S). Depends on A1+A2+A3 (nothing reads them anymore).
  - Remove the 14 boolean flag keys from ProjectManifest (schemas.ts:242-340). Migration-free: ProjectManifest is a plain z.object (schemas.ts:221, no .strict/.passthrough), so zod STRIPS unknown keys — a stale telar.yaml/projects.json still carrying removed keys parses cleanly, safeParse does NOT error (manifest.ts:59). The projects.json cache blob (raw JSON.parse, no re-validation, manifest.ts:35) keeps inert dead keys until the next registerProject/writeManifest rewrites it. No deprecation shim, no on-disk migration.
  - Remove the 15 TELAR_* behavior env reads (die 1:1 with their flags). SURVIVORS (facts/infra, not switches — do NOT touch): TELAR_HOME (looms.ts:17, manifest.ts:17), TELAR_PLAYWRIGHT_MCP_BIN (verifier.ts:168), TELAR_RUNNER_URL/TELAR_RUNNER_BIN (runner/resolve.ts:15-16, ensure.ts:17-18).

═══════════════════════════════════════════
ROUND B — DOCTRINE-GAP RESHAPE. B1 then B2; B3 optional after B1.
═══════════════════════════════════════════
Round A makes the capabilities unconditional; Round B makes the thread/orchestrator behavior match §20-32,§58-63. Depends on Round A landing (advisory threads and the top gate must be the sole path).

PHASE B1 — Thread inner-loop reshape: advisory verify-as-step (L). Depends on A1.
Under §70-72 a per-thread verify failure is the thread's cue to mediate-then-escalate, never terminal. Today decide()'s childAdvisory (executor.ts:274,292,2032) relaxes ONLY the evidence-unobtainable panelRequired skip; a genuine per-thread panel fail still lands needs-review (executor.ts:301,333) and contractRequired makes a missing contract a hard thread FAILURE (executor.ts:942-945). Work:
  - Generalize childAdvisory past the skip case so per-thread panel-fail / contract-miss become mediate-then-escalate, not a terminal demote.
  - Reconcile stepChecks fail-closed-demote (carried from A1) to the same mediate-then-escalate posture.
  - Move the legacy runVerification/verify() path (executor.ts:832-1006) to an inner ADVISORY step; the authoritative fail-closed verify is the top gate.
CRITICAL guard against fail-open: coverage relaxed at the thread MUST be re-proven at the top gate — the COVERAGE INVARIANT (executor.ts:2019-2031) generalizes with childAdvisory. Nothing here weakens the moat; it shifts fail-closed weight up, which is why the top gate must be unconditional (A1c) first.

PHASE B2 — The orchestrator-mediation rung (L). THE central gap. Depends on B1.
Today a thread escalation goes STRAIGHT to the human: rollupWeave lifts a blocked/failed required child to root (weave.ts:41-42,63-64), tick() emits escalate (tick.ts:186,209), runWeave just does `loom.error=…; break` (weave.ts:348-351) → root parks awaiting-human. §22-24,§62 require the orchestrator to MEDIATE FIRST (re-plan, reassign, repair the lane, re-derive verification) before any human ping. Install into the dead half-built seam (verified): Decision already has {action:"repair";threadId} with validateDecision support (tick.ts:32,127-132) but tick() never emits it and runWeave rejects it (weave.ts:356 "unexpected repair decision"). Work:
  - tick() emits repair/reassign while corrections remain, instead of escalate.
  - runWeave grows a repair/reassign handler (replaces the weave.ts:356 break), reusing runAutoRepair's bounded convergence machinery (verify-thread.ts:338, repair-guard.ts) with a PER-THREAD budget/guard snapshot distinct from the root ALL-verify loop; spawnChild child-reuse for reassignment (dispatcher.ts:502-534, autonomously — today only after answerBlocked); runRepairThread (executor.ts:1331) / re-planThreadWorkflow for re-derive.
  - Extend REPAIRABLE_STATES: blocked needs a reassign/re-derive path (today tick.ts:130 = needs-review/failed only).
  - Gate the human-first parks BEHIND this rung: weave.ts:63 (blocked propagation), tick.ts:205-214, executor.ts:1963 (breaker park), dispatcher.ts:463 (pre-flight park). Human reached only when corrections are genuinely exhausted (§73-74). The parks stay as the final valve — mediation must stay bounded so a genuine dead-end cannot become an infinite mediation loop.

PHASE B3 — Deeper thread capability (M/L, OPTIONAL — owner decides in/out of this cut). Depends on B1.
The maps flag two "missing" capabilities that are additive, not de-flag:
  - Thread re-plan: today step repair only re-runs the SAME step (executor.ts:2565); the thread cannot add/replace a DAG step. §30 "re-plan" has no implementation at thread altitude. Must stay bounded (budget/provenance gates, executor.ts:2631).
  - Inter-step dataflow: steps pass only a pass/fail scheduling signal, never output (thread-templates.ts:25-33). "Author a workflow and execute it" with dependent steps is not yet real. Must respect the read-only wall for non-writing steps.

═══════════════════════════════════════════
DOCS LANE — runs in PARALLEL with any round (docs block no code); best landed after Round A so docs describe reality.
═══════════════════════════════════════════
PHASE D — Docs reconciliation (M). Four targeted rewrites + one localized + a banner. No doc is deleted; each carries doctrine-correct design worth keeping — strip only the flag-discipline/prove-and-flip/opt-in scaffolding.
  - adaptive-verification.md: remove the named TELAR_ADAPTIVE_VERIFY=1 env var (:336-337 — the artifact §67 forbids BY NAME) and the flag-modeled-on-subjectiveRouting framing; strip flag-gated/default-off/flip-the-default (:292-293,:299-300,:370-383,:394-395). Keep "freedom in the method, never the verdict."
  - orchestrator-owned-verification.md: this is the doctrine's OWN source — keep the fail-closed-moves-up core (§3,§6) verbatim; strip only the process wrapper (:337-345 M9-discipline/orchestratorVerify default-off, M10.6 PROVE&FLIP :453-465,:480, and the "opt-in to revisit auto-done" :511 — ready→done human-only is a standing principle, not an opt-in).
  - thread-as-workflow.md: keep the thread-as-inner-loop design; strip flag-gated/default-off/byte-identical/flip (:82-84,:123-125,:167-171,:182).
  - ROADMAP.md: reframe the three "prove & flip the default" milestones (M9.5 :287-288, M10.6 :351-354, M11.3 :408-409) as "collapse the flag — the engine IS this now"; strip the flag-gated template (:232,:331-332,:389); keep shipped-flag history as fact; ADD a top-of-file PRINCIPLES banner (it bills itself single-source-of-truth at :15 and currently out-ranks the doctrine for readers).
  - loom-orchestrator.md: rewrite the two virtue lines "New power is opt-in." (:41) and "Additive & reversible first … byte-identical to today" (:42, echoed :111,:254,:272); keep the input-shaped fast-path MECHANISM (a legit fact-driven branch, not a flag). Leave guardrails.autoStartRuns (:220) — it's a spend guard (§51).
Docs already accurate (leave): PRINCIPLES.md, README.md, m11-discuss-iteration.md, verifier-agent.md, loom-model.md, verification-environments.md, runtime-architecture.md, watchers-design.md, mcp-oauth-design.md, phase-2-runner-plan.md (its TELAR_RUNNER_URL/BIN/HOME are allowed deployment facts), analysis-loom-run-2026-07-12.md, cockpit-ux-findings.md, view-gallery.md, design-pass.md.

═══════════════════════════════════════════
SEQUENCING SUMMARY
═══════════════════════════════════════════
Round A: A1 + A3 in parallel → A2 (after A1) → A4 (after A1+A2+A3). Docs lane (D) may start in parallel immediately.
Round B: B1 → B2. B3 optional after B1. Round B depends on Round A.
Land each phase proven on branch m11 + a sandbox project before it reaches live — after the collapse there is no flag to flip back; git is the only rollback (§41).

## Test impact

91 test files total under packages/core/test. Ledger: 4 DIE ENTIRELY, ~24 REWRITE as always-on, ~63 KEEP unchanged. DIE (whole-file deletions, all in Phase A2): m5-runner-flag.test.ts (only asserts runnerEnabled/setupAgent false-by-default+env-override — both dead/defaulted), m7-env-review.test.ts (feature removed), build-fanout.test.ts + build-fanout-wiring.test.ts (M6 fan-out superseded by M9). REWRITE (strip the TELAR_*=1/manifest-flag setup + the 'false by default' helper blocks + any flag-OFF byte-identity block; keep the flag-ON assertions as unconditional behavior — done in the matching A1 sub-lane): flag-off.test.ts (helper + byte-identity blocks die; DB-clone seam tests survive as DI tests, moved to A3), m9-thread-workflow.test.ts (drops ~40 TELAR_THREAD_WORKFLOW=1 setups, the 'planner needs workflow parent' byte-identity test at :862, and the false-by-default helper tests), the M10 gate suite (m10-orchestrator-verify, m10-verify-lane, m10-lane-escalation, m10-thread-advisory-coverage, m10-5-subjective-routing), the M11 adaptive/lane suite (13 files: m11-0-preflight-plan, m11-1-modality-derivation, m11-2-frozen-lane-strategy, m11-2-verification-strategy, m11-3-authored-tightening, m11-blocked-propagation, m11-dispatch-revive, m11-emit-charter-proof-intent, m11-field-semantics, m11-nonrunnable-tightening, m11-runnable-shape, m11-runnable-shape-tightening, m11-unfixable-breaker), the isolation/autoRepair set (worktree-lifecycle, m11-cancel-worktree-recovery, auto-repair, repair-guard), and three partials (decide.test.ts — orchestratorVerify setup; roster.test.ts — buildFanout ref drops with the feature; thread-templates.test.ts — thread-workflow tie). KEEP (~63): non-flag suites (gates, panel*, contract, vcs, lane, verifier-*, the non-flag m5 transport/lease/liveness tests, manifest, manifest-cache, etc.). Round B adds NEW tests for advisory verify-as-step (B1) and the mediation rung (B2 — assert tick() emits repair/reassign and human park is reached only after mediation exhausts); it does not delete Round-A test work. Risk in the ~24 rewrites: losing a genuine assertion while stripping flag scaffolding — each rewrite must preserve every flag-ON assertion verbatim.

## Risks (accepted)

- No instant rollback. Collapsing the flags deletes every byte-identical-off path, so once a phase lands there is no flag to flip back — the ONLY rollback is git (revert the branch) plus a sandbox project (§41 'git is the flag'). Every registered project changes behavior the moment a phase lands. Each phase must be proven on branch m11 + a sandbox before reaching live.
- Stale manifest keys in already-registered projects. After A4 removes the 14 keys, existing telar.yaml files and the projects.json cache blob still carry them. Safe by construction (plain z.object strips unknown keys, safeParse does not error, manifest.ts:59) but the cache keeps inert dead keys until the next writeManifest rewrites them — no migration runs, so verify no code path ever reads a now-absent key at runtime.
- In-flight looms during deploy. A loom mid-run when a collapse lands can straddle old/new paths (e.g. a thread that began under the flag-off executeLoom attempt loop while the new code makes runThreadWorkflow the sole body; recursion guard opts.viaWorkflow semantics, executor.ts:107-111, must survive). Drain or accept a discontinuity for running looms.
- Unconditional top gate = universal cost. orchestratorVerify + verifyLane always-on means EVERY woven root now pays a frozen-lane verify and stands a supervised lane up; must handle the no-ALL-contract null (weave.ts:432) gracefully. planThreadWorkflow's LLM planner now runs on every thread — an extra read-only LLM call per thread (degrade-to-template at executor.ts:2274 is the safety net).
- Fail-open risk in the advisory reshape (B1). Relaxing per-thread demotions to advisory shifts all fail-closed weight to the top gate — if the COVERAGE INVARIANT (executor.ts:2019-2031) is not generalized in lockstep, coverage relaxed at a thread could go unre-proven at the top gate and let a broken deliverable reach ready. The moat only holds if the top gate is unconditional (A1c) and re-proves everything a thread relaxed.
- Runaway mediation (B2). The orchestrator-mediation rung is the highest-value, highest-risk change. Without the repair-guard convergence discipline (per-thread budget snapshot distinct from the root ALL-verify loop) it can loop repairing/reassigning forever; without a genuine-dead-end exit it can strand a loom that should reach the human. The human parks must remain the final valve, just gated behind exhausted mediation.
- liveDbClone DI posture (A3). Making the engine always use the real cloner when a real DB is present removes the env safety catch that today refuses to construct LiveDbCloner unless armed (db-clone.ts:55). Owner must confirm real-Postgres cloning is acceptable in every environment where a real DB is present, since the guard is gone.


## APPROVED DECISIONS (owner, 2026-07-13)

- D1 outOfProcessRunner: DELETE the dead flag/key/env/test; keep the transport infra (TELAR_RUNNER_URL/BIN). Out-of-process dispatch is a possible future milestone, not this cut.
- D2 envReview: DELETE the gate outright; the propose-servers capability survives via the escalation answer (answerBlocked servers field, ask-once-persist). Remove web surfaces of the env-review state too.
- D3 setupAgent (REVISED with owner): survives as the orchestrator ENVIRONMENT-COMPREHENSION duty. Detection is EAGER (at scoping, while already reading the project, map what verification will need: dev server, env vars, DBs). Asking is HEURISTIC and agent-judged with deterministic rails: human-only requirements (secrets/credentials = certain dead-ends) MAY be offered for up-front answering at charter time; maybe-resolvable (ports, stubs, ephemeral resources) are NEVER asked up-front - mediate at need, escalate only when exhausted; greenfield unknowns proceed-and-defer. The early ask is an OFFER never a gate: proceed is always a valid answer, the build starts regardless, missing env blocks only the verify step. Never ask unclassified, never ask twice; answers persist as project facts, secrets only in the gitignored tier. Implement the mediation-side in B2; the eager-detection side lands with B2 as well (scoping hook).
- D4 isolateWorktrees: unconditional ON; keep the fact-driven non-git graceful degrade.
- D5 liveDbClone: DI + project FACT - the engine clones only when the project declares a template DB in its yaml; no behavior env, never implicit.
- D6 deploy discipline: Rounds A and B1 deploy to the live instance TOGETHER (the flags-collapsed-but-per-thread-gates-alive intermediate exists only on the branch). Check for in-flight looms before any deploy; drain first.
- D7 B3 (thread re-plan + inter-step dataflow): OUT of this cut - follow-on milestone.
