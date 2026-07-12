# Retrospective — Loom Run `telar-test-m9`, "TypeScript arithmetic expression engine"

**Run date:** 2026-07-12 · **Root loom:** `loom_mri1c2i2_17m4z9` · **Project:** `telar-test-m9` (greenfield, no git repo) · **Flags:** Full-M9 (`threadWorkflow` / `threadPlanner` / `stepChecks`) · **Analyst source of truth:** each loom's `loom.json` + `events.ndjson` + `spec/contract.json` under `/Users/facundo/.telar/looms/…`; mechanism grounded in `/Users/facundo/Projects/personal/telar/packages/core/src/executor.ts`.

> **One-line finding.** The system produced a clean, fully-tested deliverable (tsc-clean, `54/54 bun test`) and then *correctly refused to call it done* — because two of the three threads carried a required assertion the engine could not machine-verify in a greenfield library with no running app. The outcome was **right** (the moat fail-closed rather than rubber-stamp) but **unsatisfying** (no autonomous "done"; the human had to override). Every root cause here is a planner/contract-quality or environment-provisioning gap, not a build defect.

---

## 1. What ran

### 1.1 Weave shape

The `weave-planner` scoping session (`sessionId 6b4a5807…`) emitted a **3-subgoal decomposition** and self-approved (`loom.json:97` `"approvedBy": "auto:weave-planner"`, `"singleThread": false`):

| subGoal | dependsOn | required | title |
|---|---|---|---|
| `scaffold` | `[]` | ✅ | Project scaffold + core engine implementation |
| `semantics` | `["scaffold"]` | ✅ | Precedence, associativity, unary-minus, variables & built-in semantics |
| `errors` | `["scaffold"]` | ✅ | Error paths and comprehensive test coverage |

Shape: **`scaffold → (semantics ∥ errors)`**. Budget (`loom.json:30-35`): `maxWallClockHours:6, maxParallelThreads:3, maxAgents:12, maxCriticAgents:3` — the run finished well inside all of them.

### 1.2 The three threads

| thread | loom id | attempts (ladder) | gates | panel | terminal | cost |
|---|---|---|---|---|---|---|
| scaffold | `loom_mri1gcl6_gpepo8` | 1 (dev/sonnet) | **5/5 green** (all `command`) | not required | **done** ✅ | $0.5900 |
| errors | `loom_mri1j53v_jzyv53` | 3 (dev→dev→careful) | `error-paths` **green ×3** | **never ran** (`report:null`) | **needs-review** ⚠️ | $1.2479 |
| semantics | `loom_mri1j53z_wcxfzn` | 6 (dev→dev→careful ×2 steps) | **zero gates** | **never ran** (`report:null`) | **needs-review** ⚠️ | $2.7770 |

### 1.3 Timeline (UTC)

- **16:58:29.871** — run starts; weave-planner scoping (`turns 2, $0.2052`).
- **~16:59:26** — root L11 `schedule ["scaffold"]`, agents 1 — *"scaffold first (unblocks 2 downstream)."*
- **17:01:37.048** — scaffold **done** (130.3 s). Root L15 `observe scaffold state:done unblocked:["semantics","errors"]`.
- **17:01:37** — root L16 `schedule ["errors","semantics"]`, agents 2, `fanout:{pieces:2,chosen:2}` — the only parallelism in the run.
- **17:06:21.637** — errors lands **needs-review** (284.6 s, 3 attempts).
- **17:08:46.423** — semantics lands **needs-review** (429.4 s, 6 attempts).
- **17:08:46** — root L23 `escalate — "no ready threads and none in flight (blocked)"` → L24 `state:"needs-review"`, L25 `weave-rollup {"state":"needs-review"}`. Root `loom.json:13` `error: "semantics: not done"`.
- **~17:37 (28.2 min later)** — user **accepts with override**: root L26 `{"type":"accepted","by":"you","override":true,"fromState":"needs-review"}`, L27 `{"type":"commit-skipped","reason":"not a git repository"}`. Final root `state:"done"`, `acceptedOverride:true`.

**Totals:** machine wall-clock **616.6 s ≈ 10.3 min**; **$4.8201** grand total (planner $0.2052 + threads $4.6149). Ledger reconciles exactly: root `events.ndjson:16` `spentUsd 0.5900402` (post-scaffold) → L20 `1.8379198` (post-errors) → L23 `4.614932` (post-semantics). The 28.2-min accept latency is human deliberation, not machine time.

---

## 2. What WORKED

### 2.1 Decomposition quality — the planner reasoned about *provability*, not just tasks

The planner's rationale (`loom.json:99`, echoed `events.ndjson:10`) is a genuine dependency argument, not a boilerplate split:

> "`scaffold` is the foundational build-out … and must exist before anything else can be verified, since semantics and errors assertions both invoke `calc(...)` from src/index.ts and inspect the test/ suite that scaffold's own criteria require to exist… `semantics` and `errors` are each independently provable once scaffold exists… neither depends on the other, so they can proceed in parallel once scaffold is done."

It also correctly declined to file-partition a cohesive module (`loom.json:28`): *"the engine is a single cohesive module set (tokenizer -> parser -> evaluator -> index) that cannot be meaningfully split across independent file ownership without duplicating the whole implementation."* That is the right call for a tokenizer→parser→evaluator pipeline — and it did it cheaply (`$0.2052`, 2 turns).

### 2.2 Weave-level parallelism actually fired

This run **did** parallelize — at the weave level. Root L16 scheduled `errors ∥ semantics` with `agents:2`, `fanout:{pieces:2,chosen:2}`, and both ran concurrently (errors 17:01:37→17:06:21, semantics 17:01:37→17:08:46, overlapping). The scheduler respected the `scaffold` barrier, then opened both downstream threads the instant it observed `scaffold:done` and `unblocked:["semantics","errors"]` (L15). The orchestration kernel behaved exactly as designed.

### 2.3 The scaffold thread is the "happy path" proof

scaffold is the clean end-to-end case and shows the intended promotion. Its contract is **5 assertions, all `type:"command"`, all `blocker:true`** (`build-install`, `build-tsc`, `test-suite`, `files-exist`, `no-runtime-deps`). All five gates ran green in one attempt — `test-suite` exit 0 with *" 13 pass … 0 fail … Ran 13 tests across 1 file"*. Because every assertion is deterministic, the agent-judged slice was empty → `panelRequired:false` → `verify-summary {"verification":"skip","source":"gates","panelRequired":false,"blockerFindings":0}` (`events.ndjson:68`) → **`state:"done"`** with **no panel event at all**. One agent, one attempt, $0.59. This is the shape both other threads *should* have been able to reach.

### 2.4 The load-bearing win: the moat FAIL-CLOSED correctly

This is the most important thing that worked, and it's easy to mistake for a failure.

Both errors and semantics builders self-reported success on every attempt — every verdict was `ok:true, blocker:null`, converging on the same `54/54` suite. Under a naive system, a green builder self-report plus green deterministic gates would promote to done. **Telar refused**, because a *required* assertion could not be independently verified.

The refusal is structural, not a heuristic:
- `decide()` (`executor.ts:265-268`, `:295-298`): a `verification:"skip"` **can never** promote when `panelRequired` is set — it retries to `maxAttempts`, then lands `{action:"needs-review", error:"panel verification required but did not run"}`.
- `contractRequired` closes the "delete the yardstick" hole (`executor.ts:800-803`).
- The panel itself is a hard read-only wall (`critic.ts:176-179` `restrictTools:true`), and `class`/`blocker` are re-stamped from the sized spec, never trusted from the agent (`critic.ts:195`) — *"a critic can't downgrade its own severity."*

The system even **diagnosed its own state correctly in-band**: semantics' opus attempt-3 careful agent wrote (`semantics/loom.json:114`):

> "the recurring 'panel verification required but did not run' is a harness orchestration issue outside the source/test tree, not something fixable by code changes."

That is exactly why six retries produced **no code change** and the loop terminated at `needs-review` rather than fabricating a pass. The moat did its one job: it did not launder an unverified claim into "done." (This matches **cockpit-ux-findings Finding 3**'s assessment: *"correct moat behavior, not an engine bug."*)

---

## 3. What DIDN'T

### 3.1 Two clean deliverables punted to `needs-review` for lack of a verifiable target

Both errors and semantics landed `needs-review` with the identical thread `error` (`errors/loom.json:98`, `semantics/loom.json:123`):

> `"panel verification required but did not run"`

Every attempt emitted `{"type":"panel","report":null}` paired with `verify-summary {"verification":"skip","source":"gates","panelRequired":true,"blockerFindings":0}`. The panel never spawned a single critic (`maxCriticAgents:3` was never drawn on; grep for `critic-start|critic-verdict|panel-sized` = 0 in every thread). The reason is environmental: a greenfield **library** has no `urls.dev` and no `manifest.devCommand`, so both the dev-server auto-spin (`executor.ts:742`) and the lane/env-review spin (`executor.ts:767`) were skipped, and `runPanelVerification` hit `if (!target)` (`executor.ts:475-489`) → `report:null`, `verification:"skip"`, `panelRequired:true`.

### 3.2 The planner authored `live-critic` where a `command`/`gate` would be independently verifiable

This is the **errors**-thread defect and the one directly actionable planner-quality finding. Its contract had two blockers:
- `error-paths` — `type:"command"` — **ran green on all 3 attempts** (`{"name":"error-paths","ok":true,"exitCode":0}`); all six throw-paths verified independently. ✅
- `comprehensive-tests` — **`type:"live-critic"`**, `observable`: *"Inspecting test/*.test.ts, there are assertions covering: operator precedence… each built-in… and every error path."*

"Comprehensive test coverage" is inspecting a **test file**, not a live surface — it is exactly the kind of criterion a `command`/`gate` assertion (`bun test` green, optionally a coverage threshold) verifies deterministically. Instead it was authored as `live-critic`, which by routing (`isDeterministic` default `false`, `executor.ts:371-372`) always feeds the browser-grounded panel and thus **requires a live URL by construction**. In a library there is none, so the assertion is *unverifiable by construction*. This is **cockpit-ux-findings Finding 3** verbatim: the fix is to teach the contract proposer to prefer executable assertions and reserve `live-critic` for criteria that genuinely need a live surface.

### 3.3 The subtler case: `semantics` had NO live-critic and still blocked — a precision correction

The run's original framing ("each contract had a live-critic blocker") is **only true for errors**. **semantics has zero live-critic and zero command assertions** — its contract is **13 assertions, all `type:"value-equality"`, all blocker** (e.g. `eq-pow-right-assoc` `2 ^ 3 ^ 2`→`512`, `eq-unary-pow` `-2 ^ 2`→`-4`, `eq-builtin-pow`→`1024`).

`value-equality` is *also* agent-judged (routes to the panel; `executor.ts:371-372` `default: return false`), never a gate. So `agentJudged.length = 13` → `panelRequired:true`, and there are **zero deterministic gates** (`gatesConfigured=false`). semantics therefore blocked on the missing target for the *same structural reason* as errors, despite having neither a live-critic nor a runnable command. This is the more damning version of the finding: even a contract of pure arithmetic value-checks — the single most machine-checkable thing imaginable — was routed to a browser panel it could never satisfy. The check `-2 ^ 2 === -4` never needed a browser; it needed to be a `command`/`gate`.

### 3.4 Single-agent threads — no intra-thread fan-out

Every thread ran one reused builder session (scaffold `05d91a10…`, errors `2dce0811…`, semantics `f442955a…`), all attempts reattaching the same `sessionId`, on the sequential ladder `dev(sonnet) → dev(sonnet) → careful(opus)`. Zero sub-threads, zero parallel builders. As **cockpit-ux-findings Finding 4** notes, this is *not a capability gap* — disjoint-writer fan-out is proven elsewhere, and this run *did* parallelize at the weave level. What didn't happen is the **per-thread planner autonomously authoring a fan-out**. For this cohesive-module engine that was arguably the correct choice anyway; the open item is confirming the per-thread planner *chooses* to fan out when a subgoal decomposes into disjoint files.

Two efficiency notes fall out of the single-agent ladder:
- semantics burned **six attempts / $2.7770** — the most expensive thread — producing *no code change* after the first, because the block was environmental and no amount of re-building could clear it (attempts 4-6 verdicts: *"no changes were needed,"* *"no defects found,"* and the correct harness diagnosis). Retrying a builder against an un-buildable blocker is pure waste; the loop should have recognized the skip-with-`panelRequired` as non-retriable and short-circuited.
- **Shared-scope side effect:** because `allowedPaths` stayed open, both threads owned the same `test/calc.test.ts`. The semantics builder observed the errors builder's concurrent rewrite — `semantics/loom.json:24` *"a concurrent sibling task was also editing this file for error-path coverage; merged cleanly"* — and both converged on `54/54`. It merged cleanly here, but two threads racing on one file is a latent hazard the open-scope decision papered over.

### 3.5 Cockpit copy conflated "working" with "needs you"

Even before the two threads landed `needs-review`, the UI mislabeled the *healthy* in-flight state. Per **cockpit-ux-findings Finding 1** (HIGH): an actively-building weave (threads `running`/`queued`) rendered as blocked-on-the-human — amber right-rail *"can't be accepted yet — N Threads still weaving… **flagged**… **resolve**"* and a Decisions line *"holding — waiting on in-flight threads."* The operator's own reaction: *"it stuck as soon as the first thread came in… actually it's not stuck, it's working, but says it isn't."* The same "flagged / resolve / holding / waiting" language and amber styling is used both for threads that merely need to *finish* and for threads that genuinely need a human — so when the run *did* legitimately need the human (the two `needs-review` threads), the signal was already worn out. And per **Finding 2** (MEDIUM), the scoping screen showed a static *"Waiting for the planner to start…"* placeholder while the planner was actively producing the 3-subgoal decomposition — no live planner transcript.

---

## 4. Root-cause chain — why a clean, tested deliverable ended in `needs-review`

Trace, source-grounded, from contract authoring to terminal state:

1. **Authoring.** The planner wrote required assertions in **agent-judged modalities** — `live-critic` (errors' `comprehensive-tests`) and `value-equality` (all 13 of semantics). Both are non-deterministic by `isDeterministic()` (`executor.ts:363-374`; `default: return false` sends value-equality *and* live-critic to the agent-judged slice).
2. **Routing.** `partitionAssertions` puts those in `agentJudged`; `panelRequired = agentJudged.length > 0` (`executor.ts:466, :732`). errors → `panelRequired:true` (1 live-critic). semantics → `panelRequired:true` (13 value-equality), with `gatesConfigured:false`.
3. **Target resolution fails.** `target = url ?? manifest.urls?.dev` (`executor.ts:721`). Greenfield library ⇒ no `urls.dev`. The two fallbacks don't fire: `devCommand` spin needs `manifest.devCommand` (unset, `executor.ts:742`); the lane spin needs `envReviewEnabled` + an accepted `servers.yaml` (`driver:"none"`, `executor.ts:767`). Both skipped.
4. **Panel can't obtain evidence.** `runPanelVerification` hits `if (!target)` (`executor.ts:475-489`) → emits `{type:"panel", report:null}`, returns `{verification:"skip", panelRequired:true}`. (Fail-closed: even a *thrown* panel returns the same, `executor.ts:560-563`.)
5. **Decide refuses to promote.** With gates green + `verdict.ok:true` + `verification:"skip"` + `panelRequired:true`, `decide()` retries to `maxAttempts` then returns `needs-review "panel verification required but did not run"` (`executor.ts:265-268 / :295-298`). It **cannot** reach `done` — *"a 'skip' can never satisfy promotion, no matter how green the deterministic gates are."*
6. **Rollup.** Root `rollupWeave` sees a required child not `done` → root `needs-review` (`weave.ts:53-54`); `tick` escalates *"blocked"* (`tick.ts:235/243`). Root `error: "semantics: not done"`.

Note the env-review escape hatch was **structurally unreachable** here: `needsEnv` is set only when `envReviewEnabled && !devCommand && driver==="none"` (`executor.ts:485-488`). With the flag off, the divert is never taken — a no-target live-critic/value-equality loom just lands the fail-closed `needs-review`. So the deliverable was perfect and the machine still — correctly, per its own rules — could not sign off on it.

**The causal knot:** an *authoring* mistake (wrong assertion modality) collided with an *environment* fact (greenfield library, no server) and the *fail-closed* verification spine turned the collision into `needs-review`. Remove any one of the three and the run auto-promotes: fix the modality (semantics/errors become gates), OR provide a target (dev server), OR (weaker) turn on env-review so a human is at least offered a lane to accept.

---

## 5. Verdict — correct, yet unsatisfying. Reconciling the two.

Both are true at once, and the tension is the whole point of the run.

**Correct.** The system's job at verification is to promote *only* on independently-obtained evidence. It had none for the one criterion per thread it couldn't machine-check, so it fail-closed to `needs-review` and offered an audited human `Accept (override)` (`acceptance-panel.tsx:98-100` — *"an override — your call, not a passing gate"*). It never fabricated a pass, never trusted the builder's self-reported `54/54` on an unverifiable criterion, never let a green deterministic gate mask a missing panel. Given its inputs, `needs-review` was the *right* terminal state. The proof: a naive system would have shipped "done" on a self-report; Telar surfaced precisely the one thing a human needed to look at.

**Unsatisfying.** The deliverable was *actually* correct — tsc-clean, `54/54`, error-paths gate green — and yet the autonomous run ended with no autonomous "done." A human waited 28.2 minutes and then clicked override to record `acceptedOverride:true`. From the operator's chair, the machine built the right thing, verified most of it, and then handed back a chore. And it cost extra to get there: semantics spent **$2.78 across six attempts** re-running a builder that could not possibly clear an environmental block — the system knew (its own opus agent said so) that no code change would help, yet the ladder kept retrying.

**Reconciliation.** The failure is not in the moat — the moat is exactly right and must not be weakened. The failure is that *everything feeding the moat left it no verifiable path*: a planner that chose panel-only modalities for machine-checkable criteria (§3.2–3.3), an environment with no target and (flag-off) no autonomous way to stand one up (§3.1, §4), and a retry loop that couldn't tell a non-retriable skip from a flaky one (§3.4). The correct outcome and the unsatisfying outcome have the *same* root: the system fails closed but has **no autonomous mechanism to open the door it's failing closed against.** It can only wait for a human to either provision a lane (env-review, and only with the flag on) or override.

---

## 6. How this motivates orchestrator-owned verification

This run is a clean, cheap ($4.82, 10 min) demonstration of the exact gap the "orchestrator repairs the verification lane / steers verification to delivery" direction targets. The evidence maps one-to-one onto grounded absences in the engine:

1. **No autonomous target provisioning.** The whole `needs-review` here is a *missing target*, not a missing deliverable. Today the only ways to get one are human-owned: env-review's propose-then-`approveEnv` (`dispatcher.ts:621` **requires a non-blank `by`** — the orchestrator physically cannot self-provision) or a hand-set `devCommand`/`urls.dev`. And env-review is **flag-gated** and was **off** this run, so even the propose-to-human path never fired. An orchestrator that could author/accept a `servers.yaml` (or recognize "library, no server needed — degrade this live-critic to a gate") would have let both threads reach `ready`.

2. **No per-thread re-verify and no weaver-issued `repair`.** `tick()` never emits `{action:"repair"}` (`tick.ts:38-40`); `weave.ts:341-343` treats it as *"unexpected."* The only re-verify is a whole-loom `reDispatch` (human steer/reject/resume) or the flag-gated **root-terminal** auto-repair (`verify-thread.ts:188`) — which fires only when the rollup is already `ready`, and here it never was. There is no "re-run *this thread's* verification against a now-provisioned lane." So the six wasted semantics attempts had no smarter target to retry against.

3. **No engine producer for `blocked`.** The cockpit fully renders a `blocked` "park a question / Answer & resume" flow (`acceptance-panel.tsx:110-128, :314-315`), and steer/reject/resume honor it — but **nothing in `packages/core/src` ever sets `state:"blocked"`.** So a thread that hits an unverifiable-by-construction assertion cannot pause and *ask* ("this is a library — should `comprehensive-tests` be a `bun test` gate?"); it can only fail closed to `needs-review`. This run wanted exactly that question asked, and the mechanism to ask it doesn't exist.

4. **The ceiling is `ready` by design — and that's the invariant to respect, not break.** Every orchestrator/steer path converges to `ready` and stops (`weave.ts:36-39`, `verify-thread.ts:14-15`, `loom-mcp.ts:41-43`); `ready → done` is a human-only click (there is intentionally no `accept_loom` tool). So "orchestrator-owned verification" does **not** mean the orchestrator gets to promote to done — it means the orchestrator should be able to drive a stranded thread *up to `ready`* autonomously (provision a lane, or degrade an unverifiable modality, or park a `blocked` question), leaving the final `ready → done` override where it belongs: with a human. This run is the canonical motivating case — a deliverable that *deserved* `ready` and got stuck one provisioning-step short, with no autonomous way to take that step.

**Persistence corollary (so it never asks twice).** When the orchestrator *does* learn how to stand this project up, the write-it-down homes already exist: the runnable lane → `.telar/servers.yaml` via `writeAcceptedServersConfig` (`servers.ts:66`; gitignored, *"reused forever… never asks again"*), the one-liner → `manifest.devCommand` — though note `devCommand` is **not** in the cockpit PATCH whitelist (`route.ts:77-90`), so a learned dev command can't yet be saved through the UI. Closing that whitelist gap and giving the orchestrator a propose-and-persist seam is the concrete next step this run points at.

---

### Appendix — evidence index

- Decomposition & rationale: `loom_mri1c2i2_17m4z9/loom.json:36-95, :97, :99`; `events.ndjson:7, :10, :11, :15, :16, :23-27`.
- scaffold (done): `loom_mri1gcl6_gpepo8/loom.json:13-79`; `events.ndjson:68-69`.
- errors (needs-review): `loom_mri1j53v_jzyv53/spec/contract.json`; `loom.json:13-96, :98`; `events.ndjson:45,74,96,98`.
- semantics (needs-review): `loom_mri1j53z_wcxfzn/spec/contract.json`; `loom.json:13-121, :114, :123`; `events.ndjson:59,83,105,122,142,157,159`.
- Verification spine: `executor.ts:363-374` (isDeterministic), `:466/:732` (panelRequired), `:475-489` (no-target), `:265-268/:295-298` (decide skip+panelRequired), `:560-563` (fail-closed throw), `:800-803` (contractRequired).
- Moat / read-only wall: `critic.ts:176-179, :195`; `panel.ts:83-90`.
- Orchestration & gaps: `tick.ts:38-40, :235-243`; `weave.ts:36-39, :53-54, :341-343`; `dispatcher.ts:621`; `verify-thread.ts:14-15, :188`; `acceptance-panel.tsx:98-100, :110-128, :314-315`.
- Persistence: `servers.ts:66`; `schemas.ts:322` (`devCommand`); `apps/web/app/api/projects/[name]/route.ts:77-90` (whitelist gap).
- Companion UX/planner findings: `docs/cockpit-ux-findings.md` Findings 1–4.
