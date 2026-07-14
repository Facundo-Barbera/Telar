# Looms that deliver: orchestrator-owned verification (design)

> **Status:** proposed direction (**M10**). No code yet — this is the alignment +
> execution-plan doc. **Builds ON M9** ("threads become workflows"): M9 upgraded the
> *doing* (a thread is now a step-graph of fan-out agents); M10 upgrades the *proving*
> (where the verification gate lives). M9 must land its flip (`docs/ROADMAP.md` M9.5)
> before M10.6, but M10.1–M10.5 are independent and can build dark alongside it.
> **Companion visual:** the *Telar verification-model* side-panel Artifact (the two-altitude
> diagram: threads advise ↑ orchestrator gates ↑ human signs). **Motivating evidence:**
> `docs/analysis-loom-run-2026-07-12.md` (the `telar-test-m9` retrospective) and
> `docs/cockpit-ux-findings.md` (Findings 1 & 3).

---

## 1. Where this comes from

The `telar-test-m9` run (a greenfield TypeScript arithmetic-expression engine) is the
canonical motivating failure. The system produced a **clean, fully-tested deliverable** —
tsc-clean, `54/54 bun test`, the `error-paths` command-gate green ×3 — and then **correctly
refused to call it done**, because two of the three threads carried a required assertion the
engine could not machine-verify in a library with no running app. Both `errors` and
`semantics` landed `needs-review "panel verification required but did not run"`; a human
waited 28 minutes and clicked `Accept (override)` to record `acceptedOverride:true`
(`docs/analysis-loom-run-2026-07-12.md` §1.2, §3.1).

The retrospective's own verdict: **correct, yet unsatisfying — same root.** The moat
fail-closed exactly as designed (it never laundered a self-reported `54/54` into "done"),
but *everything feeding the moat left it no verifiable path*: a planner that authored
panel-only modalities for machine-checkable criteria (§3.2–3.3), an environment with no
target and no autonomous way to stand one up (§3.1, §4), and a retry loop that burned six
attempts / $2.78 re-building against an un-buildable block (§3.4). The system "fails closed
but has **no autonomous mechanism to open the door it's failing closed against**"
(`analysis-loom-run-2026-07-12.md` §5).

M10 is that mechanism — and it is deliberately **not** "relax the moat." It is "put the moat
at the only altitude where it can be true, and give the orchestrator the duty (and the tools)
to make verification *achievable*."

---

## 2. Thesis & the shift

**Thesis.** A loom must drive to an **actual, verified result** — not a guided one. The whole
point of a loom is to prepare everything so the future is ready; a deliverable that is correct
but stranded one provisioning-step short of proof is a loom that did not finish its job. So the
**verification gate moves UP**: **threads advise, the orchestrator decides once on the whole,
the human signs once.**

**The shift, concretely:**

| | Today (as-built) | M10 |
|---|---|---|
| **Thread verdict** | **Blocking / authoritative.** A child runs the full `executeLoom` build loop → `runVerification` → the real Critic Panel, and `decide()` gates it exactly like a root (`executor.ts:243`, `:1582`). A required-`skip` / `fail` child lands `needs-review` (`executor.ts:1630`) and, via `rollupWeave`, forces the whole root to `needs-review` (`weave.ts:53-54`). | **Advisory.** A thread is **green unless it actually broke** (build/tests crashed, a real hard-gate genuinely failed). "Couldn't independently verify X" is a **green thread with a note**, never per-thread `needs-review`. The per-thread panel-gating + per-thread `needs-review` path is deleted. |
| **The authoritative gate** | Scattered: each thread self-gates; the root-level integration verify (`weave.ts:395-433`) exists but under isolation checks the **pre-work base** (`baseSha`/`manifest.root`), not the assembled whole (§F of the orchestrator map). | **One** authoritative verification, run **once on the composed whole**, answering two questions: (1) regression — did we break what the user already had? (2) completeness — did we fill every criterion of the full contract? Fail-closed. |
| **Human** | Pulled in per-thread, per-fragment, out of context (the 28-minute override on a fragment that was actually fine). | **Pre-steer + final accept.** Direction up front; the holistic/subjective sign-off + the `done` signature once, on the composed whole. |

The load-bearing point from `cockpit-ux-findings.md` Finding 3: the moat behavior was
**correct** — the defect was that a machine-checkable criterion (`comprehensive-tests` on a
*test file*, all 13 `value-equality` arithmetic checks) was routed to a browser panel it could
never satisfy, and there was no autonomous way to either fix the routing or stand up a lane.
M10 keeps the refusal and removes the strand.

---

## 3. The model — seven points, grounded in the code that changes

### 3.1 Thread verification = advisory help, not a gate
A thread is **green by default**. It emits a self-check + advisory comment (optionally an
advisory critic note) — **signal for the orchestrator, never a stop**. A thread turns **red
only when something actually broke**: build fails, tests crash, a real defect / hard-gate
genuinely fails. **"Couldn't independently verify X"** (panel/live-critic couldn't run) becomes
a **green thread with a note**, never per-thread `needs-review`.

- **What changes.** Today `terminalStateForCompletedLoom(child) === "done"` only when the
  child's `decide()` returns `done` (`executor.ts:230-232`, `:1594`); a required-`skip` with
  `panelRequired` lands `needs-review` (`executor.ts:265-268`, `:1630`). Under M10, a child's
  `panelRequired` skip (no live evidence obtainable at the thread altitude) resolves to
  **green-with-note**, not `needs-review`. This deletes the per-thread panel-gating consumption
  of `panelRequired` in the *child* branch of `decide()` — but only after 3.2's top gate exists
  (see the sequencing invariant in §8).
- **What does not change.** A genuinely broken thread (builder `verdict.ok === false`, or a
  configured deterministic gate red — `executor.ts:1547` `builderOk`, `:313-314`) still fails/
  retries exactly as today. "Red only on real breakage" is the child `decide()`'s existing
  fail path; M10 narrows *what counts as a stop* to real breakage, not "evidence unobtainable."

### 3.2 Orchestrator = the sole authoritative verification, once on the composed whole
The orchestrator owns the verification lane for the pass, runs **everything**, and is
**fail-closed** (independent read-only verifier + adversarial panel over the whole; never
rubber-stamps). It answers exactly two questions on the assembled deliverable:
**(1) regression** and **(2) completeness** against the full contract.

- **Where it hooks.** The existing root gate already lives at **`weave.ts:395-433`**, gated
  at `:396` (`if (r.state === "ready" && verifyProducer)`), immediately after
  `rollupWeave`/`setState`. The producer seam is already injected
  (`dispatcher.ts:354-401` — `runIntegrationVerify` flag-off, `runAutoRepair` flag-on), and
  the demote-vs-keep semantics are already correct: a red whole-verdict demotes
  `ready → needs-review` (`weave.ts:414-421`); `pass`/`skip` keep `ready`; a throw is caught
  fail-open (`:426-432`). **M10.1 adds no new state-machine plumbing** — it slots the true
  whole-verification in as `verifyProducer`.
- **The gap M10.1 closes.** Today the root verify forks its read-only worktree at
  **`loom.baseSha`** (`verify-thread.ts:108`) or checks **`manifest.root`**
  (`runIntegrationVerify`, `executor.ts:894`) — both the **pre-work base**. Under isolation the
  children's work lives only on `loom.consolidationBranch` (`telar/<rootId>`, assembled
  incrementally as each child folds — `executor.ts:1594-1628` → `consolidate.ts:24-40` →
  `vcs.ts:258-319`). A genuine "verify the composed whole once" gate must fork from the
  **consolidation branch** (fall back to `baseSha` when absent) — change the checkout ref at
  `verify-thread.ts:108` from `loom.baseSha!` to the consolidation branch; everything
  downstream (`verifyCwd` plumbing, gates, panel, demotion) is already in place.

### 3.3 The verification lane = general infra, proactively stood up
The lane is **all** the infra verification needs — dev server, DB + fixtures, external service,
credentials, MCP tools, sandbox — **general, not just "dev server."** The orchestrator
**proactively stands it up** (a *duty*, especially for live-testing / greenfield: once the app
is built, bring the dev server up so the live-critic can actually run) and **repairs it** if it
breaks mid-run.

- **What exists.** The lane runtime is already there: `startProjectServer` (devCommand path,
  `run-server.ts:142`; auto-spun at `executor.ts:742`), `startLane` (servers.yaml path,
  `run-server.ts:515`), `laneTarget` (`:228-232`), and `Lane`/`ServiceHandle` carry
  `restart`/`isAlive`/`logTail` — the repair seams (`run-server.ts:204-222`). The M7 divert
  already sets `needsEnv` when a live-critic slice has no target + no `devCommand` + a
  `driver:"none"` recipe + the flag (`executor.ts:475-489`).
- **What changes.** Today provisioning is **reactive and human-owned**: the panel hits
  `if (!target)` (`executor.ts:475`) and either diverts to `env-review` (a *propose-to-human*
  path, flag-gated) or fail-closes to a `panelRequired` skip. M10.3 makes the **orchestrator**
  proactively resolve/stand up the lane *for the final pass* (generalize the target resolution
  at `executor.ts:721`, `:742`, `:767-786` from "dev server" to the full lane), and repair it
  if a `ServiceHandle` dies mid-run.

### 3.4 Pre-flight lane-viability gate
Before spending on the build, **check the lane is achievable**. If it cannot be established up
front, **ask the human once**, set it up, persist — orchestration does not commence until
verifiability is secured.

- **Where.** The weave already pins `baseSha` + creates the consolidation branch *before any
  child spawns* (`dispatcher.ts:260-279`) and runs an optional `runSetup` in the `preparing`
  window (`weave.ts:143-153`). The pre-flight check slots in at that same
  before-children seam: resolve the declared lane (`resolveServersConfig`,
  `servers.ts:51-60`; `manifest.devCommand`, `schemas.ts:322`), and if it is unviable *and*
  cannot be auto-provisioned, escalate once (3.5) rather than spawning threads that will strand.

### 3.5 Bounded learn-once human escalation
If the orchestrator cannot stand up the lane (pre-flight **or** mid-run), it asks the human
**once** via the cockpit — an **"Orchestrator requires help"** surface: an agent tells the user
directly *what is stuck* and *what it already tried*. The user helps/steers. Then the
orchestrator **writes it down** — persists to the manifest (`devCommand`, `mcpServers`,
`gates`) + a per-project runbook — so it **never asks again**.

- **The precedent to copy.** `env-review` is the exact shape: `approveEnv`
  (`dispatcher.ts:613-640`) requires a non-blank `by`, persists the accepted recipe to
  **`.telar/servers.yaml`** via `writeAcceptedServersConfig` (`servers.ts:66`; gitignored,
  project-scoped, reused forever), clears the draft, and re-dispatches verify — **and a green
  re-verify still lands `ready`, never `done`.**
- **The missing plumbing.** `blocked` is a **dead enum member** today: declared
  (`schemas.ts:199`) and accepted as an *input* by the resume verbs / `watch_loom`, but
  **nothing in `packages/core/src` ever sets `state:"blocked"`**, there is no
  `Loom.blockedReason`/`blockedQuestion` field, and `steerLoom` refuses `blocked`
  (`dispatcher.ts:911-913`). M10.4 finally makes `blocked` **reachable as output**: a
  transition that parks a lane-viability question (the analog of `proposeEnvOrNeedsReview`,
  `executor.ts:1149-1172`, but for lane gaps) + an **"Answer & resume"** verb whose answer is
  written into the manifest and/or `.telar/runbook.*` before `reDispatch`
  (`dispatcher.ts:865-896`).
- **The motivating hard case.** A real project on **turbo + a Python API + a Vite front +
  Docker (AWS lambdas)** — a lane no single `devCommand` describes. Ask once, learn the recipe,
  persist to `.telar/servers.yaml` + `.telar/runbook.*`, never ask again.

### 3.6 Objective vs subjective, at two altitudes
- **Objective / machine-verifiable** (builds, tests, "API returns X", error paths throw) →
  the **orchestrator's final gate** (autonomous, fail-closed). These are exactly the
  deterministic slice `partitionAssertions` routes to gates (`executor.ts:363-374`,
  `runContractGates` `:396`) plus the panel's falsifiable checks.
- **Subjective / human-judgment** ("premium feel", cohesive UX) → **never a per-thread gate,
  never faked into a machine check** → the human's **final accept**, on the composed whole.
  Influenced early via pre-steer; judged once at the end. Optionally an **advisory aesthetic
  critic** (an agent, non-blocking) can nudge threads, but it never gates.

### 3.7 Human = pre-steer + final accept
Direction up front (the charter/contract-scoping session); the holistic/subjective sign-off +
the `done` signature at the end. **Never per-thread, never judging a fragment out of context.**
`ready → done` stays a human-only action — there is intentionally no `accept_loom` MCP tool
(`loom-mcp.ts` — `start_loom` is deliberately not auto-run; `LOOM_AUTO_TOOLS` excludes accept),
and every orchestrator/steer path converges to `ready` and stops
(`weave.ts:36-39`, `verify-thread.ts:14-15`).

### The invariant (sacred)
**Fail-closed does not disappear — it MOVES UP.** Threads relax; the orchestrator's gate
**tightens**. A thread's green means *"I built it and didn't break anything,"* never *"the
whole is correct"* — that is proven once, at the top, the only altitude where it can be true.
**Lane-repair can only ADD verification capability, never remove or relax an assertion.** The
moat stays exactly as strict (see §6).

---

## 4. The verification lane (general infra) — setup, pre-flight, escalation, persistence

### 4.1 The abstraction
Today's "target" is a single URL (`target = url ?? manifest.urls?.dev`, `executor.ts:721`) with
two ad-hoc spin-ups: `devCommand` (`executor.ts:742`) and an accepted `servers.yaml` lane
(`executor.ts:767-786`). The **verification lane** generalizes this to the full set of infra a
final verification needs:

| Lane facet | Declared in | Stood up by | Repair seam |
|---|---|---|---|
| Dev server / preview | `manifest.devCommand`, `manifest.urls.dev` (`schemas.ts:309-322`) | `startProjectServer` (`run-server.ts:142`) | `ServiceHandle.restart`/`isAlive` (`run-server.ts:204-222`) |
| Multi-service lane (DB, API, front) | `servers.yaml` / `.telar/servers.yaml` (`ServersConfig`, `schemas.ts:765-770`) | `startLane` (`run-server.ts:515`), `laneTarget` (`:228`) | per-`ServiceHandle` restart + `healthcheck`/`readyCheck` (`schemas.ts:707-724`) |
| Deterministic gates | `manifest.gates` (`schemas.ts:300-302`) | `runGate` (`gates.ts:28`), `runContractGates` (`executor.ts:396`) | n/a (exit-code) |
| MCP tools | `manifest.mcpServers` (`schemas.ts:326`) | `resolveProjectMcpServers` (`mcp.ts:81`) | reconnect |
| Credentials / secrets | secret store (out of the committable manifest) | injected env | ask-once (§4.3) |

### 4.2 Proactive setup + repair (a duty)
The orchestrator **stands the lane up for the final pass** rather than waiting for a
`if (!target)` miss. Placement: at the existing before-children seam
(`dispatcher.ts:260-279`, `weave.ts:143-153` `runSetup`) for pre-flight, and around the top
gate (`weave.ts:395-433`) for the final verification. The **read-only wall is preserved** — the
lane is stood up by the executor/setup-agent (Write+Bash under the setup wall,
`setup-agent.ts:52-64`), but the *verifier and panel that judge it* stay read-only
(`verifier.ts:18`, `:237` `restrictTools:true`; `critic.ts:156` reuses the same wall). Standing
up a lane never grants the *judge* the ability to mutate code.

**Mid-run repair.** `Lane`/`ServiceHandle` already expose `restart`/`isAlive`/`logTail`
(`run-server.ts:204-222`). If a service dies during the final verification, the orchestrator
restarts it (bounded — see §9 clamp) and re-drives, exactly as the M4 auto-repair loop already
re-drives `frozenLaneVerify` (`verify-thread.ts:188-238`). **Repair may only re-establish the
lane; it may never edit an assertion or downgrade a verdict** (§6).

### 4.3 Pre-flight gate + bounded ask-once-persist escalation
- **Pre-flight** (M10.4): before spawning children, resolve the declared lane. If it is
  achievable (a `devCommand`, a `servers.yaml` tier, or nothing needed for an all-deterministic
  contract), proceed. If not, and it cannot be auto-provisioned, **park `blocked`** with a
  concrete question rather than spawning threads that will strand.
- **The "Orchestrator requires help" surface** (M10.4): mirror `env-review` end-to-end —
  `proposedServers` slot (`looms.ts:132-139`), an `env-proposed`-style event, a cockpit panel,
  and an accept/steer/reject verb requiring a human `by`. Extend it to carry a *narrative*
  ("here is what's stuck + what I tried"), the analog the retrospective calls for
  (`analysis-loom-run-2026-07-12.md` §6.3 — "nothing in core ever sets `state:"blocked"`").
- **Learn-once persistence** (M10.4): on accept, write the recipe to the existing gitignored,
  human-accepted, reused-forever tier — `.telar/servers.yaml` (`writeAcceptedServersConfig`,
  `servers.ts:66`) — plus a **new `.telar/runbook.*`** (mirror `resolveServersConfig`/
  `writeAcceptedServersConfig`: a `resolveRunbook(root, acceptedRoot=root)` + `writeAcceptedRunbook`
  copying `servers.ts:51-68` line-for-line) capturing the *verification narrative* (which route
  to drive, seed/login/reset steps, known-flaky notes, the lenses that mattered) that
  `servers.yaml` does not. Learned `devCommand`/`gates`/`mcpServers` promote to the committable
  `telar.yaml` via the manifest writer (`manifest.ts:81-93`) — **note the current cockpit PATCH
  whitelist omits `devCommand`** (`apps/web/app/api/projects/[name]/route.ts`, per
  `analysis-loom-run-2026-07-12.md` §6), a gap M10.4 must close so a learned command can be
  saved through the UI.

**Net.** `telar.yaml` stays the committable declared config; `.telar/servers.yaml` (existing) +
`.telar/runbook.*` (new) become the two gitignored, human-accepted, learned-and-reused
lane artifacts; the per-loom bundle (`bundle.ts` — `spec/`, `steering.md`, `events.ndjson`)
stays the ephemeral scratch that *feeds* those promotions; and `blocked` + "Answer & resume"
become the escalation channel that fills the gaps. The moat holds: human `by` required, write
is post-accept only, and a promotion never itself promotes a loom to `done`.

---

## 5. Objective vs subjective — two altitudes

The routing already exists at the assertion level — `partitionAssertions` splits a contract
into **deterministic** (command/gate/runnable-db → exit-code gates, no LLM) vs **agentJudged**
(live-critic + value kinds + live-SQL → the panel), and `panelRequired ⇔ agentJudged.length > 0`
(`executor.ts:363-395`). M10 keeps that split but re-assigns **who** the audience is:

- **Objective, machine-verifiable → orchestrator's final gate (autonomous, fail-closed).**
  Builds, tests, "API returns X", error paths throw. These run once over the composed whole and
  can *keep or demote* `ready` (`weave.ts:414-421`) — never author `done`.
- **Subjective, human-judgment → the human's final accept, on the composed whole.** "Premium
  feel", cohesive UX. **Never a per-thread gate; never faked into a machine check.** Influenced
  early by pre-steer (the scoping session), judged once at the end. An **optional advisory
  aesthetic critic** (an agent, non-blocking, reusing the read-only critic wall
  `critic.ts:156`) can *nudge threads* with notes — but it is `class:advisory`, so
  `aggregatePanel`'s floor/clean logic never lets it gate (`panel.ts:70-115`; only
  `blocker && !ok` fails).

This is also the fix `cockpit-ux-findings.md` Finding 3 asks for at the *planning* altitude:
prefer executable (`command`/`gate`) assertions where a check is independently verifiable, and
reserve `live-critic` for criteria that genuinely need a live surface. M10.5 pairs the routing
fix (contract proposer prefers executable checks) with the audience fix (subjective → human).

---

## 6. The invariant — fail-closed MOVES up, it does not vanish

The single most important property to preserve. M10 **relaxes threads and tightens the top** —
the net strictness is *unchanged or greater*. Enumerated moat invariants that stay exactly as
strict:

1. **Read-only judge wall.** The verifier and every critic load only `VERIFIER_TOOLS`
   (`verifier.ts:18`) under `restrictTools:true` + a `Write/Edit/MultiEdit/Bash/NotebookEdit/
   Agent` disallow list (`verifier.ts:237-241`, `critic.ts:156`). Standing up or repairing a
   lane happens in the *executor/setup* wall, never the judge's. **Lane-repair adds capability
   to observe; it never grants capability to mutate.**
2. **No self-downgrade.** A critic's `class`/`blocker` are stamped from the sized `LensSpec`,
   never the agent's self-report (`critic.ts:195`). The panel floor closes the vacuous-panel
   attack (`panel.ts:83`); a never-reported blocker lens fails (`panel.ts:104`).
3. **Evidence ⇒ promotion; no evidence ⇒ no promotion — at the top.** The `panelRequired` moat
   moves from the *thread* `decide()` to the *orchestrator* gate. Today a required-skip cannot
   promote (`executor.ts:265-268`, `:295-298`); under M10 that same rule governs the **whole**:
   the top gate is fail-closed and cannot reach `pass` without independently-obtained evidence.
   `contractRequired` still hard-fails a bundle loom whose contract went missing
   (`executor.ts:800-803`).
4. **The gate only keeps or demotes — never authors `done`.** The whole-verification may keep
   `ready` or demote to `needs-review` (`weave.ts:414-424`); a throw is fail-open and never
   demotes a correctly-woven loom (`:426-432`). Promotion to `done` / landing the branch stays
   the human `acceptLoom` click.
5. **Consolidation writes only to `telar/<rootId>`.** The composed whole is assembled on the
   review branch, never `baseBranch` (`vcs.ts`, `consolidate.ts:48-73` — "no merge, no checkout
   of baseBranch, no state change").
6. **`ready` is the ceiling for every autonomous path.** Steer/reject/resume/auto-repair all
   converge to `ready` and stop (`weave.ts:36-39`, `verify-thread.ts:14-15`,
   `dispatcher.ts:865-896`). Orchestrator-owned verification means driving a stranded whole *up
   to `ready`* autonomously — **not** promoting to `done`.

**What relaxes (and only this):** a thread's `panelRequired` skip stops being a per-thread stop
and becomes a green-with-note *advisory* to the top gate. The assertion it represents is **not
dropped** — it is re-proven once, at the top, over the composed whole, where a lane can actually
be stood up. The moat's coverage is the same; its *altitude* is higher.

---

## 7. Generality — the model is not overfit to greenfield

| Scenario | How the model serves it |
|---|---|
| **Greenfield library** (the `telar-test-m9` run) | Threads go green (built + didn't break anything). The orchestrator runs the **suite once** over the whole → all-deterministic-green ⇒ autonomous **`ready`** → human `done`. Fixes the exact e2e pain: `54/54` no longer strands on a per-thread panel that can't run. |
| **Greenfield web app** | Orchestrator **stands the dev server up once** for the final pass (proactive `startProjectServer`, `run-server.ts:142`) so the live-critic actually runs over the assembled UI — instead of each thread individually failing to find a target. |
| **Big multi-service monorepo** (turbo + Python API + Vite + Docker/lambdas) | **Hard lane** → the **pre-flight ask-once-persist** path: orchestrator can't stand it up, asks the human once via "Orchestrator requires help", persists the recipe to `.telar/servers.yaml` + `.telar/runbook.*`, never asks again. |
| **Pure refactor** | **Regression IS the whole job.** The top gate's question (1) — "did we break anything the user already had?" — runs the existing suite over the composed whole; completeness (2) is "behavior preserved." No per-thread ceremony. |
| **CLI** | All-deterministic contract (commands/gates) → `agentJudged.length === 0` ⇒ the panel is skipped, green gates alone promote (`executor.ts:472-474`) — the top gate is a pure suite run, autonomous done. |
| **Backend + DB** | Lane = DB + fixtures (`servers.yaml` service with `reset`/`readyCheck`, `schemas.ts:733-757`); orchestrator stands up an ephemeral DB (the `frozenLaneVerify` ephemeral-clone pattern, `verify-thread.ts:112`) for the final pass; live-SQL assertions judged once over the whole. |
| **Subjective quality** ("premium feel") | Objective slice auto-verifies at the top; **taste → the human final accept** on the composed whole, optionally nudged early by an advisory aesthetic critic. Never a per-thread gate, never a faked machine check. |

---

## 8. Execution plan (M10.1–M10.6)

Every phase is **fail-closed, independently green-gated, committed as its own unit.** Each
shipped behind a milestone flag (`orchestratorVerify` + per-phase sub-flags) SINCE COLLAPSED to
the sole engine path by the de-flag cut (`docs/deflag-cut-plan.md`); the flag names below are
retained as shipped history.

> **CRITICAL SEQUENCING — never lose fail-closed.** Build the **TOP gate BEFORE demoting
> threads.** Demoting thread verification (M10.2) before the orchestrator gate exists (M10.1)
> would fail-**open** — a window where nothing proves the whole. So **M10.1 strictly precedes
> M10.2**, and M10.2 is "safe only because M10.1 exists." M10.3–M10.5 build outward from the top
> gate; M10.6 is the live fail-closed proof.

### M10.0 (adjacent quick fixes — already captured)
Two correctness/UX fixes from `docs/cockpit-ux-findings.md`, landable independently:
- **Finding 1** — cockpit conflates "working" with "needs you": `running`/`queued`-only threads
  read calm/informational; reserve amber "flagged / resolve / approve" for `needs-review`/
  `blocked` (apps/web weave-acceptance rail + Decisions timeline).
- **Finding 3** — planner prefers `live-critic` where a `command`/`gate` is independently
  verifiable: teach the contract proposer to prefer executable checks (directly enables M10 —
  executable checks at the top). *(Finding 3's routing change is also folded into M10.5.)*

### M10.1 — Orchestrator final-verification GATE
- **Goal.** After weave rollup, run **one authoritative verification over the composed whole**
  (full contract + regression), fail-closed, at root scope. **ADD the top gate; threads
  unchanged.** Strengthens fail-closed.
- **Seams.** Hook at `weave.ts:395-433` (`:396` condition; demote `:414-421`); producer wiring
  `dispatcher.ts:354-401`; **change the fork ref** `verify-thread.ts:108` from `loom.baseSha!`
  to `loom.consolidationBranch` (fall back to `baseSha`); reuse `runIntegrationVerify`
  (`executor.ts:894`) / `runPanelVerification` (`:437`) / `runContractGates` (`:396`).
- **Ships.** A whole-verification producer that forks its read-only worktree from the
  consolidation branch and verifies the **full** contract (not just the ALL slice) over the
  assembled deliverable; the existing demote-vs-keep semantics unchanged.
- **Tests.** A red whole-verdict demotes `ready → needs-review`; `pass`/`skip` keep `ready`; a
  throw is fail-open; the fork targets `consolidationBranch` when present and `baseSha` when not;
  flag-off byte-identical (producer is the current `runIntegrationVerify`).
- **Done when.** Green-gate clean; the composed whole is verified once at the top; no thread
  behavior changed; the gate can only keep/demote (never `done`).
- **Flag.** `orchestratorVerify` (top-gate leg).

### M10.2 — Thread verification → ADVISORY
- **Goal.** Threads go **green-unless-broken** (red only on real breakage: builder `verdict.ok
  === false` or a configured deterministic gate red). A `panelRequired` skip becomes
  **green-with-note**, not `needs-review`. The orchestrator gate (M10.1) is now the **sole**
  authority. **Safe only because M10.1 exists.**
- **Seams.** Child branch of `decide()` (`executor.ts:243`, the `panelRequired` skip →
  `needs-review` at `:265-268`/`:295-298`); child terminal mapping
  `terminalStateForCompletedLoom` (`executor.ts:230`) + `executeLoom` consumption (`:1582`,
  `:1594`, `:1630`); `rollupWeave`'s `notDoneRequired` branch (`weave.ts:53-54`) and the tick
  moat (`tick.ts:98-103`) — now a note-carrying green child satisfies "done".
- **Ships.** Under the flag, a child whose only failure was "evidence unobtainable" resolves to
  a green terminal carrying an advisory note (surfaced via `emitVerifySummary`,
  `executor.ts:662`), so `rollupWeave` rolls the root up to `ready` and M10.1's gate proves the
  whole. Real breakage still fails/retries unchanged.
- **Tests.** A required-skip child lands green-with-note (not `needs-review`) with the flag on;
  a genuinely-broken child still fails; the root reaches `ready` and M10.1 gates it; flag-off
  byte-identical (skip still `needs-review`).
- **Done when.** Green-gate clean; no per-thread panel-gating remains under the flag; the moat's
  fail-closed is provably intact **at the top** (M10.1 tests still hold).
- **Flag.** `orchestratorVerify` (thread-advisory leg — gated so it cannot be on without M10.1).

### M10.3 — The VERIFICATION LANE (generalize + proactive setup + repair)
- **Goal.** Generalize the infra the orchestrator provisions for the final pass (dev server / DB
  / service / MCP / credentials); **proactive setup + repair.** Builds on M7 env-review.
- **Seams.** Target resolution `executor.ts:721`, `:742` (devCommand), `:767-786` (accepted-lane
  round-trip); lane runtime `run-server.ts:142`/`:515`/`:228`; repair seams
  `run-server.ts:204-222`; setup wall `setup-agent.ts:52-64`, `:109-170`; before-children /
  `runSetup` seam `dispatcher.ts:260-279`, `weave.ts:143-153`.
- **Ships.** An orchestrator duty that stands up the *general* lane for the M10.1 pass (not just
  a URL) and restarts a dead `ServiceHandle` mid-verify (bounded). Judge wall untouched.
- **Tests.** Orchestrator stands a dev server up for a live-critic whole when none was declared;
  a killed service is restarted and the verify re-driven; the lane is torn down in `finally`;
  read-only wall unchanged.
- **Done when.** Green-gate clean; the greenfield-web-app scenario (no declared target) reaches
  a live verification autonomously; repair only re-establishes the lane, never edits an
  assertion.
- **Flag.** `verifyLane`.

### M10.4 — PRE-FLIGHT lane-viability + bounded ASK-ONCE-PERSIST
- **Goal.** Before spending on the build, check the lane is achievable; if not auto-provisionable,
  ask the human **once** via an "Orchestrator requires help" cockpit surface; persist to the
  manifest + a per-project runbook so it never asks again.
- **Seams.** Make `blocked` reachable-as-output — add `Loom.blockedReason`/`blockedQuestion`
  (`looms.ts:59-152`), a park transition (analog of `proposeEnvOrNeedsReview`,
  `executor.ts:1149-1172`) at the pre-flight seam (`dispatcher.ts:260-279`); extend `steerLoom`'s
  allow-list to include `blocked` (or add `answerLoom`) — today it refuses it
  (`dispatcher.ts:911-913`); new `.telar/runbook.*` via `resolveRunbook`/`writeAcceptedRunbook`
  mirroring `servers.ts:51-68`; promote learned `devCommand`/`gates`/`mcpServers` via
  `manifest.ts:81-93` and **close the cockpit PATCH whitelist gap** for `devCommand`
  (`apps/web/app/api/projects/[name]/route.ts`); mirror `approveEnv` (`dispatcher.ts:613-640`)
  for the accept-and-persist tail.
- **Ships.** A reachable `blocked` state with a narrative question surface; an "Answer & resume"
  verb that writes the answer to `.telar/runbook.*` / manifest / secret store before
  `reDispatch`; pre-flight that parks rather than spawning threads that will strand.
- **Tests.** An unviable-lane pre-flight parks `blocked` with a concrete question (never spawns);
  "Answer & resume" persists and re-dispatches to `ready`; the persisted lane is reused on the
  next loom without re-asking; `by` required; a persisted `devCommand` survives a UI PATCH.
- **Done when.** Green-gate clean; the monorepo scenario asks once, persists, never asks again;
  `blocked` is finally reachable-as-output; no autonomous path reaches `done`.
- **Flag.** `laneEscalation`.

### M10.5 — OBJECTIVE/SUBJECTIVE routing
- **Goal.** Route subjective criteria to the **human final accept** (never a machine gate);
  keep objective criteria at the autonomous top gate; add an **optional advisory aesthetic
  critic**.
- **Seams.** `partitionAssertions`/`isDeterministic` (`executor.ts:363-395`); the contract
  proposer (prefer executable checks — `cockpit-ux-findings.md` Finding 3); panel sizing / class
  (`panel.ts:29`, `:70-115`) for an `advisory` aesthetic lens; the read-only critic wall
  (`critic.ts:156`).
- **Ships.** The proposer prefers `command`/`gate` where independently verifiable; a
  subjective-only criterion is carried to the human accept panel (not the machine gate); an
  optional non-blocking aesthetic critic emits notes.
- **Tests.** A machine-checkable criterion routes to a gate (not the panel); a subjective
  criterion never gates and surfaces at human accept; the aesthetic critic can never flip a
  verdict (its `class:advisory` is stamped, `critic.ts:195`).
- **Done when.** Green-gate clean; `-2 ^ 2 === -4`-style checks route to gates; "premium feel"
  never blocks; the aesthetic critic is provably non-gating.
- **Flag.** `subjectiveRouting`.

### M10.6 — PROVE, then COLLAPSE
- **Goal.** Live-validate on real scenarios and confirm fail-closed holds **at the
  orchestrator**. **Interactive — needs a real run, not a build workflow.**
- **Scenarios.** (a) the greenfield lib that punted (`telar-test-m9`) → now autonomous `ready` →
  human `done`; (b) a web app needing a dev-server lane (M10.3 stands it up); (c) a pure
  refactor (regression IS the job). Confirm the top gate can still demote a genuinely-broken
  whole (inject a regression → `needs-review`).
- **Done when.** Fail-closed demonstrably holds at the orchestrator on a real red whole; the
  three scenarios reach `ready` autonomously where they deserve it. There is no default to
  flip — the top gate + lane + routing IS the engine now; the four flags
  (`orchestratorVerify`/`verifyLane`/`laneEscalation`/`subjectiveRouting`) were collapsed to the
  sole path by the de-flag cut (`docs/deflag-cut-plan.md`).
- **Relationship to M9.5.** M9.5 (`docs/ROADMAP.md`) landed the thread-workflow runner as the
  sole path first, so the prove-run exercises the full M9+M10 stack; M10.6 is the analogous
  proof one altitude up (verification, not execution).

### Process (every phase — the invariants the pass must hold)
- **Orchestrate only.** Build each phase via one Workflow (ground → design → implement →
  adversarially verify → integrate); then review, run the green-gate independently, delegate any
  fixes, and commit. **Never hand-edit source.**
- **Green-gate before every commit:** `NODE_OPTIONS= bun test packages/core` (0 fail);
  `NODE_OPTIONS= bunx tsc -p packages/core/tsconfig.json --noEmit` (0 `error TS`);
  `NODE_OPTIONS= bunx tsc -p apps/web/tsconfig.json --noEmit` (0 `error TS`).
- **Moat invariants (never weaken — see §6):** read-only judge wall; no self-downgrade;
  evidence ⇒ promotion at the top; the gate only keeps/demotes (never `done`); consolidation
  writes only to `telar/<rootId>`; `ready` is the autonomous ceiling; **lane-repair only ADDS
  observe-capability, never mutates or relaxes an assertion.**
- **Sequencing (sacred):** the **top gate (M10.1) ships before thread demotion (M10.2)** — never
  a window where nothing proves the whole.
- **Ordering invariant:** the thread-advisory leg (M10.2) cannot exist without the top gate
  (M10.1) beneath it — the fail-closed weight only ever shifts UP onto a gate that is already there.
- **Build hygiene:** atomic edits (a live `bun dev` on :3000; never a duplicate-definition
  window); `NODE_OPTIONS=` prefix on all bun/bunx/tsc; never touch `.env`/secrets/lockfiles;
  removal via git only (no `rm`); commit messages with backticks via `git commit -F`; author
  `facundo-barbera`; the standard co-author + session trailers.
- **Cadence:** commit each phase as its own logical unit (core / web / docs), advance the
  roadmap, keep the build never-broken longer than ~30 min.

---

## 9. Open questions & risks

- **Auto-provisioning safety.** Standing up a lane means running project code (a dev server, a
  DB, `docker`), not just reading it. Mitigation: the *judge* wall stays read-only
  (`verifier.ts:237`, `critic.ts:156`); provisioning runs in the executor/setup wall
  (`setup-agent.ts:52-64`) with `guardrails.protectedPaths`/`disallowedTools`
  (`schemas.ts:303-308`) enforced; lanes tear down in `finally` (the existing
  `executor.ts:742`/`:767-786` pattern). **Open:** sandboxing untrusted `devCommand`/`docker`
  for a project the orchestrator did not author.
- **Cost / loops of lane setup — clamp.** The `telar-test-m9` run burned six attempts / $2.78
  re-building against an un-buildable block (`analysis-loom-run-2026-07-12.md` §3.4). Lane
  setup + repair must be **bounded**: reuse the tick `fanoutClamp` + cost budget
  (`loom.json` `maxWallClockHours`/`maxAgents`), a max-restart count on `ServiceHandle`, and a
  non-retriable classification so a lane that *cannot* come up escalates (`blocked`) once
  instead of looping. **Open:** the exact retry/backoff policy for a flapping service.
- **Where autonomy stops.** The ceiling stays `ready` (§6, invariant 6). The orchestrator drives
  a stranded whole *up to* `ready` — it never promotes to `done`, never lands the branch, never
  self-accepts an env proposal (`approveEnv` requires a human `by`, `dispatcher.ts:621`). This is
  **settled, not open:** `ready → done` is a human click, ALWAYS — a standing principle
  (`docs/PRINCIPLES.md` §75 / Level 0, "no autonomous path writes `done`"), not a default awaiting
  reconsideration. Even a fully machine-verifiable whole stops at `ready`; the human accept is the
  point, by design.
- **`blocked` reachability is new surface.** Making `blocked` reachable-as-output (M10.4) touches
  the resume/steer verbs (`dispatcher.ts:865-927`) and the cockpit. Risk: a park that never gets
  answered strands a loom silently. Mitigation: the cockpit "Orchestrator requires help" surface
  + `watch_loom` triggers already fire on `blocked` (`loom-mcp.ts:299-331`); **open:** a
  block-timeout → escalate policy (the still-OPEN D10 in `docs/loom-model.md`).
- **Relationship to the M9.5 flip.** M9.5 (`threadWorkflow` default-on) and M10.2 (thread verify
  → advisory) both change thread semantics; they must not race. Sequence M9.5 first, then M10 on
  top, so the prove-run (M10.6) exercises one coherent stack rather than two half-flipped ones.
- **Consolidation-branch verify vs finalize ordering.** M10.1 verifies at the in-`runWeave` hook
  (`weave.ts:396`) against `consolidationBranch`, *before* `finalizeConsolidation`
  (`dispatcher.ts:427-448`, which only counts/drops empty branches). This is the lower-friction
  placement and reuses the demote path; **open:** whether the gate should instead move
  post-finalize (against the empty-dropped branch) — a no-op distinction when commits exist, but
  worth confirming on a zero-fold epic.
