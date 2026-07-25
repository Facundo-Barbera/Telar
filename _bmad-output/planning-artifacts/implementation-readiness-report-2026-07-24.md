---
stepsCompleted: ['step-01-document-discovery', 'step-02-prd-analysis', 'step-03-epic-coverage-validation', 'step-04-ux-alignment', 'step-05-epic-quality-review', 'step-06-final-assessment']
readinessStatus: 'NEEDS WORK'
findings:
  total: 38
  critical: 4
  high: 12
  medium: 11
  low: 11
coverage:
  frTotal: 49
  frCovered: 49
  frCoveragePct: 100
  storyTotal: 51
  tracksWithStories: '5 of 6 — Track B (session profiles) unstoried'
requirementsBaseline:
  functional: 49   # RF 6 · LR 24 · OW 13 · UW 6
  nonFunctional: 73  # cross-cutting 15 · LR 27 · OW 20 · UW 11
documentsIncluded:
  architecture:
    - _bmad-output/planning-artifacts/architecture/architecture-telar-2026-07-24/ARCHITECTURE-SPINE.md
    - _bmad-output/planning-artifacts/architecture/architecture-telar-2026-07-24/SOLUTION-DESIGN.md
    - _bmad-output/planning-artifacts/architecture/architecture-telar-2026-07-24/WORK-SPLIT.md
    - _bmad-output/planning-artifacts/architecture/architecture-telar-2026-07-24/reviews/review-adversarial-seams.md
    - _bmad-output/planning-artifacts/architecture/architecture-telar-2026-07-24/reviews/review-reality-check.md
    - _bmad-output/planning-artifacts/architecture/architecture-telar-2026-07-24/reviews/review-rubric.md
  requirements_prd_role:
    - _bmad-output/specs/spec-runtime-foundations/SPEC.md
    - _bmad-output/specs/spec-runtime-foundations/admission.md
    - _bmad-output/specs/spec-runtime-foundations/brownfield.md
    - _bmad-output/specs/spec-loom-redesign/SPEC.md
    - _bmad-output/specs/spec-loom-redesign/lifecycle.md
    - _bmad-output/specs/spec-loom-redesign/map-and-storage.md
    - _bmad-output/specs/spec-loom-redesign/recipe-schema.md
    - _bmad-output/specs/spec-loom-redesign/verification.md
    - _bmad-output/specs/spec-loom-redesign/brownfield.md
    - _bmad-output/specs/spec-organization-workspace/SPEC.md
    - _bmad-output/specs/spec-organization-workspace/item-model.md
    - _bmad-output/specs/spec-organization-workspace/brownfield.md
    - _bmad-output/specs/spec-ultra-workflows/SPEC.md
    - _bmad-output/specs/spec-ultra-workflows/brownfield.md
  epics_stories:
    - _bmad-output/specs/spec-runtime-foundations/stories.yaml
    - _bmad-output/specs/spec-loom-redesign/stories.yaml
    - _bmad-output/specs/spec-organization-workspace/stories.yaml
    - _bmad-output/specs/spec-ultra-workflows/stories.yaml
  ux:
    - _bmad-output/specs/spec-loom-redesign/ux-surfaces.md
    - _bmad-output/specs/spec-organization-workspace/ui-contract.md
    - _bmad-output/specs/spec-ultra-workflows/ui-contract.md
    - _bmad-output/brainstorming/brainstorm-loom-ux-ui-2026-07-23/conversation-component.md
  supporting_context:
    - _bmad-output/project-context.md
    - _bmad-output/brainstorming/*/brainstorm-intent.md
    - docs/**  # brownfield as-is documentation, 2026-07-17, baseline for brownfield claims
  projections_not_authoritative:
    - _bmad-output/planning-artifacts/architecture/architecture-telar-2026-07-24/ARCHITECTURE-DECK.html
---

# Implementation Readiness Assessment Report

**Date:** 2026-07-24
**Project:** telar

---

## Step 1: Document Discovery

### Planning Model in Use

This project does **not** use the classic PRD → Epics → Stories layout. It uses the **SPEC-kernel model**
(`bmad-spec`) with an architecture spine layered over it:

| Standard BMAD role | Actual artifact in this project |
| --- | --- |
| PRD | 4 SPEC kernels (`_bmad-output/specs/*/SPEC.md`) + companions |
| Architecture | `planning-artifacts/architecture/architecture-telar-2026-07-24/ARCHITECTURE-SPINE.md` (+ SOLUTION-DESIGN, WORK-SPLIT) |
| Epics & Stories | 4 × `stories.yaml`, one per SPEC |
| UX | SPEC companions: `ux-surfaces.md`, `ui-contract.md` |

Confirmed by user on 2026-07-24: the SPEC kernels are the requirements source of truth, and the
`stories.yaml` files are the epics/stories source of truth.

### Architecture Documents

**Whole documents** (`_bmad-output/planning-artifacts/architecture/architecture-telar-2026-07-24/`):

| File | Size | Modified |
| --- | --- | --- |
| `ARCHITECTURE-SPINE.md` | 32K | 2026-07-24 22:39 |
| `SOLUTION-DESIGN.md` | 16K | 2026-07-24 22:39 |
| `WORK-SPLIT.md` | 8K | 2026-07-24 22:39 |
| `reviews/review-adversarial-seams.md` | 8K | 2026-07-24 22:39 |
| `reviews/review-reality-check.md` | 4K | 2026-07-24 22:39 |
| `reviews/review-rubric.md` | 4K | 2026-07-24 22:39 |

**Projection (not authoritative):** `ARCHITECTURE-DECK.html` (28K) — a rendering of the spine.
Treated as drift-check material only; `ARCHITECTURE-SPINE.md` governs.

**Sharded documents:** none.

### Requirements Documents (PRD role — SPEC kernels)

| SPEC | Kernel | Companions |
| --- | --- | --- |
| `spec-runtime-foundations` | `SPEC.md` (12K, 22:39) | `admission.md` (12K), `brownfield.md` (8K), `reference/admission-impl/` (`admission.ts`, `admission.test.ts`, `core-changes.patch`) |
| `spec-loom-redesign` | `SPEC.md` (32K, 13:22) | `lifecycle.md` (8K), `map-and-storage.md` (12K), `recipe-schema.md` (8K), `verification.md` (16K), `ux-surfaces.md` (12K), `brownfield.md` (8K) |
| `spec-organization-workspace` | `SPEC.md` (20K, 14:05) | `item-model.md` (8K), `ui-contract.md` (8K), `brownfield.md` (8K) |
| `spec-ultra-workflows` | `SPEC.md` (8K, 11:23) | `ui-contract.md` (4K), `brownfield.md` (4K) |

**Sharded documents:** none. Each SPEC has exactly one kernel.

### Epics & Stories Documents

Stories are held as YAML per SPEC rather than as a `*epic*.md` document:

| File | Size | Modified |
| --- | --- | --- |
| `specs/spec-loom-redesign/stories.yaml` | 16K | 2026-07-24 22:39 |
| `specs/spec-organization-workspace/stories.yaml` | 12K | 2026-07-24 14:06 |
| `specs/spec-runtime-foundations/stories.yaml` | 8K | 2026-07-24 22:39 |
| `specs/spec-ultra-workflows/stories.yaml` | 4K | 2026-07-24 22:39 |

### UX Design Documents

UX is embedded as SPEC companions rather than a standalone `*ux*.md` document:

| File | Size | Modified |
| --- | --- | --- |
| `specs/spec-loom-redesign/ux-surfaces.md` | 12K | 2026-07-24 11:46 |
| `specs/spec-organization-workspace/ui-contract.md` | 8K | 2026-07-24 14:05 |
| `specs/spec-ultra-workflows/ui-contract.md` | 4K | 2026-07-24 11:23 |
| `brainstorming/brainstorm-loom-ux-ui-2026-07-23/conversation-component.md` | 8K | 2026-07-24 00:02 |

`spec-runtime-foundations` has no UX companion — expected, it is a non-UI runtime package.

### Supporting Context (evidence, not assessed artifacts)

- `_bmad-output/project-context.md` (12K) — loaded as a persistent fact for the whole run.
- 6 brainstorming sessions, each with a `brainstorm-intent.md` carrying intent → SPEC resolution annotations
  (`brainstorm-loom-system`, `brainstorm-loom-verification`, `brainstorm-loom-ux-ui`,
  `brainstorm-loom-artifact-storage`, `brainstorm-organization-workspace`, `brainstorm-ultra-workflows`).
  These are the upstream intent record and will be used for requirements-traceability back-checks.
- `{project_knowledge}` (`/docs`) — **exists**: a full brownfield as-is documentation set generated by
  `bmad-document-project` on 2026-07-17 (15 files, ~340K). Notably `architecture-core.md` (41K),
  `architecture-web.md` (37K), `api-contracts-web.md` (49K), `data-models-web.md` (27K),
  `component-inventory-web.md` (31K), `source-tree-analysis.md` (28K), `integration-architecture.md` (23K),
  `project-overview.md` (13K), `index.md`. `docs/decisions/` exists but is **empty** (no ADRs recorded).
  This set describes the codebase *as it is today* and is the baseline the SPEC `brownfield.md` companions
  must agree with — it will be used to sanity-check brownfield claims and "existing code" assumptions.
  ⚠️ It is dated 2026-07-17, one week older than the SPECs (2026-07-24), so it may lag recent code changes.

### Issues Identified

**Duplicates (CRITICAL):** ✅ None. No document exists in both whole and sharded form.

**Structural notes (non-blocking, but they shape the assessment):**

1. **No PRD document exists** — by design. Requirements tracing will run against the 4 SPEC kernels.
2. **SPECs live outside `planning_artifacts`** — they sit at `_bmad-output/specs/`, while config points
   `planning_artifacts` at `_bmad-output/planning-artifacts/`. A glob-only discovery pass would have missed
   all 4 SPECs and every story file. Flagged so later tooling runs do not silently under-scan.
3. **`spec-ultra-workflows` is materially thinner than its siblings** — 8K kernel, 4K stories, 4K brownfield,
   versus 12–32K kernels elsewhere. Candidate under-specification; to be verified in the epics/stories step.
4. **`ARCHITECTURE-DECK.html` is a projection of the spine** — checked for drift only, never treated as source.

### Status

✅ Document discovery complete. No unresolved duplicates. Proceeding to requirements analysis.

---

## Step 2: Requirements Analysis (PRD role — SPEC kernels)

All four SPEC kernels and **all 17 companion files** were read in full. In this project the requirement
unit is a **capability (`CAP-n`)** carrying an `intent` and a testable `success` clause; the NFR unit is a
**constraint**. Traceability IDs assigned below (`FR-<spec>-<n>` / `NFR-<spec>-<n>`) are this report's, for
coverage checking against `stories.yaml`.

Spec key: **RF** = runtime-foundations · **LR** = loom-redesign · **OW** = organization-workspace · **UW** = ultra-workflows.

### Functional Requirements

#### SPEC-runtime-foundations (6 FRs)

| ID | Capability | Requirement |
| --- | --- | --- |
| FR-RF-1 | `TELAR_HOME` honored everywhere | Every persisted store resolves its root the same way, so pointing `TELAR_HOME` at a throwaway directory genuinely isolates a dev run. **Success:** `apps/web/lib/store.ts` resolves via `process.env.TELAR_HOME ?? path.join(os.homedir(), ".telar")`, matching `manifest.ts`, `looms.ts`, `session-log.ts`, `permissions.ts`, `vcs.ts`. With `TELAR_HOME` set to an empty temp dir, `chats.json`, `usage.ndjson`, `plan-usage.json` are created there and real `~/.telar` is untouched — asserted by a test. No behavior change when unset. Governed by AD-18. |
| FR-RF-2 | One attributed spend ledger | A single append-only record of what every agent call cost, attributed to its owner; every spend readout derived from it. **Success:** `UsageEntry` carries owner-kind + owner-id alongside `account`, `model`, `sessionId`, `costUsd`; **no new ledger file**. Session per-turn usage, Ultra manifest `spend`, and loom charter budget-left are all projections over `usage.ndjson`. Readers tolerate pre-field records (AD-7) — un-attributed records still count and never throw. Cost language (USD/tokens) is a property of the projection. Governed by AD-18, AD-20. |
| FR-RF-3 | Typed event bus with required delivery class | One publish path for "something happened", where every event declares whether it may wake an agent or only render. **Success:** single in-process bus in `packages/core`; adapters subscribe (SSE tails, session-wake injector, dock aggregator). Every event carries a **required** delivery class — `agent-facing` may synthesize an assistant turn, `human-facing` renders only on arrival and never pushes. Type system demands the field. A module's published event names/payloads are a declared contract; cross-module subscription only to declared events. Governed by AD-14, AD-21. |
| FR-RF-4 | Admission control for `agent()` concurrency | One visible, configurable ceiling on concurrent model calls, divided into classes so verification is never stuck behind a build fan-out and no slot idles while work is queued. **Success:** per `admission.md` in full — ceiling from `TELAR_MAX_AGENTS` (default 4, tolerant parsing); classes `loom-build`/`loom-verify`/`ultra`/`other` with weight+floor entitlement `max(floor, ⌊ceiling × weight / totalWeight⌋)`; verification holds **precedence, not a held-open slot**; no barging; freed slot → entitled waiters in class-priority order, FIFO within class, then a work-conserving borrow pass; never exceeds ceiling under arrival/release race; interactive chat sessions out of band by design (no `interactive-session` class); long-lived processes take no slot; Ultra's run-local cap of 3 stays. Policy half is **pure**. `admissionSnapshot()` observability export. Reconfigure/reset **throw** while waiters queued. `fanoutClamp` gains optional `processCeiling` + `capByProcess` + `binding: "process"`, preserving byte-identical behavior at existing call sites. Governed by AD-17. |
| FR-RF-5 | One lease primitive, two lifetimes | Session-owned and loom-owned processes lease through the same primitive; exactly one implementation of stale-reclaim. **Success:** `runner/lease.ts`'s record (`{pid, token, ts}`, atomic temp+rename, heartbeat, stale-reclaim) generalized to serve both owners. `TELAR_HOME/sessions/<sessionId>/` exists, owned by the session module, holding session-scoped **runtime** state only — does not absorb `chats.json`. Loom leases die at land; session leases die at session close; record shape and reclaim semantics identical. Invariant holds on both paths: a stale lease can at worst produce a false-positive `failed`, never an auto-`done`. Governed by AD-16, AD-5. |
| FR-RF-6 | Load-bearing invariants are executable | The rules the project calls non-negotiable are re-checked by something other than memory. **Success:** assertions in `bun test`, running in the manual trio. At minimum: no MCP surface exposes an accept tool; `verifier.ts`/`verify-thread.ts`/`critic.ts`/`panel.ts` granted no write/edit tools; no module reads another module's `TELAR_HOME` subtree by path; client components import no `@telar/core` runtime; no module writes a shared runtime service's state directly. Each assertion fails loudly naming the invariant it defends. Governed by AD-19. |

**Acceptance detail (from `admission.md`)** — 11 explicit acceptance assertions for FR-RF-4 alone, plus a
preserved reference implementation at `reference/admission-impl/` (22 tests, verified 1317 pass / 0 fail
across 99 core test files, core + web typechecks clean). The document is authority; the implementation is reference.

#### SPEC-loom-redesign (24 FRs)

**Act 1 — Prepare**

| ID | Capability | Requirement |
| --- | --- | --- |
| FR-LR-1 | Loom birth and detach | Session hands over premise + optional context and nothing more; loom detaches to its own pages. Same handover from workspace batch weave and ripened packet. **Success:** premise is a list of N≥1 intents (gate renders one contract group per intent; Judge lights groups per intent; delivery card claim reads as N deliveries under one verdict); accept stays a single moment. Spinning off leaves exactly two things in chat — detach marker + one-line mono receipt (`premise + context · detached`) — no graph preview, no progress narration, no loom door in session. Below the simple-task boundary the agent works inline and no loom exists. Batch-weave and packet paths produce the identical receipt; a ripened packet stays behind as origin receipt. Tasks a loom picked up stay in the workspace list and stay editable — an edit posts to the loom's always-open steering channel, the entry marks it sent, the loom's copy of the brief stays frozen. Nothing locks. Entries leave only once the loom is both accepted and landed (per OW CAP-11). Batch weave seeds the **preparation graph** from the task set rather than an intake conversation. Both workspace paths take a typed handover, never a read of the workspace store. |
| FR-LR-2 | Decision graph | Preparation runs as a branching DAG of real sessions converging into the gate. **Success:** graph opens with an intake conversation *or* a batch task set seeding it directly (packets replace the opening conversation, not narrated into one). Every node in a completed graph is a session that actually ran or was explicitly skipped — never decorative. Nodes bloom, branches converge; a fresh map region skips its node; user can steer at any point. Node shape is agent-chosen, never hard-coded. |
| FR-LR-3 | Living map and lazy intake diff | Every project carries an adaptive self-model in fine-grained region files that intake diffs against. Regions declared by the loaded methodology (CAP-7), not the engine. **Success:** intake diffs at main/default-branch head — never a worktree copy — reporting per-region drift; no drift → no node. How drift is noticed is the intake session's judgment (may read repo, stand the lab up, or ask); the readiness gate makes that freedom safe. Regions rewritten in place, never appended. **A loom's pin does not move for its lifetime** — threads read the pinned map as stable background reference; loom decisions reach them via the gate-frozen contract and per-node context manifests, never by mutating the loom's map view. |
| FR-LR-4 | Verification-readiness node and recipe | Before any build spend, a node proves the lab can stand up and emits a reusable recipe stored as a map region. **Success:** boots declared services, probes readiness, and either produces a recipe every future loom on that project inherits, or **fails closed** with the reason — no lab, no experiment. Degraded modes (missing secret → synthetic data, feature off) declared in the recipe and surfaced before the gate. |
| FR-LR-5 | Readiness gate | Human rules on the prepared plan at one entrance moat, with in-place change instead of accept-or-restart. **Success:** gate offers Accept, Modify on the go, Deny → straight to development. Unprovables shown first; degraded-mode acknowledgement **gates** Accept. Modify wakes a dormant node and grows a new edge into flow compile as an audited recompile. Deny skips preparation. |
| FR-LR-6 | Approval-gated advance | An agent moves the graph forward only by proposing. **Success:** `advance_node`, `weave_batch` and the ack-gated Accept are one protocol; every advance renders as the same approval card (mono header, proposal, Approve/Hold); no node changes state without explicit human approval; no code path advances a node on the agent's own authority. |
| FR-LR-7 | Methodology as data | Seats, artifacts, and target map regions are declared data, not engine code. **Success:** each node names the seat that staffed it; adding a seat or artifact requires no graph-engine change. v1 ships exactly one built-in BMAD-derived methodology expressed through that mechanism rather than hardcoded. User overrides ride the existing `customize.toml` + `_bmad/custom/<name>.toml` pattern (scalars override, arrays append), not a new format. |

**Act 2 — Execute**

| ID | Capability | Requirement |
| --- | --- | --- |
| FR-LR-8 | Orchestrator ownership and the role wall | Orchestrator holds sole responsibility from created to delivered; conductors never touch code. **Success:** orchestrators and sub-orchestrators hold no write/edit tools and carry a distinct UI role ("holds no pen"); no human steering required between gate and delivery except escalations passing the dire razor. |
| FR-LR-9 | Flow compile | A thread's main agent authors its own execution plan — a DAG of parallel lanes with dependency edges and per-node context manifests — executed deterministically. **Success:** authored flow validates against a schema before any child spawns; execution is deterministic; every node's agent receives exactly its manifest (neither context-bombed nor starved). Parallelism is a planning output: interference analysis over shared files and surfaces shapes decomposition width. Re-planning is an explicit, bounded, audited recompile; low-confidence/simple tasks fall back to the pre-written step template. |
| FR-LR-10 | Branch and worktree isolation | Concurrent looms never collide. **Success:** every loom gets its own branch and worktree; the user's primary checkout is never touched; threads default to their own worktrees, a single serial thread may share the loom's. **Thread worktrees reap at land** so peak disk tracks threads running now; the loom worktree survives until accept and landing complete (boomerang and park resume from it). Thread worktrees get deps by **APFS copy-on-write clone** of the loom worktree's install, falling back to `prepare.install` where clonefile is unavailable — N checkouts must not cost N installs. A stacked loom declares the relationship explicitly, verifies against A+delta, lands after A. |
| FR-LR-11 | Declared services and supervisor-owned labs | Agents declare services; telar's supervisor spawns, owns, probes, restarts on death, tears down under a per-owner lease. **Success:** `ensure_service(name)` reuses a live lease instead of spawning a duplicate; one owner token enumerates and tears down everything that run created and nothing else; orphaned processes impossible by construction. Same primitive serves in-chat session processes and loom labs, differing only in owner and lifetime; the UI lists both from the registry. |
| FR-LR-12 | Borrowed heavy infra | A fleet shares expensive infrastructure by time and refcount. **Success:** each service declares scope `project \| loom \| ephemeral`; project-scope stacks shared under refcounted lease, released on last use; a fleet-wide semaphore (1–2 default) caps concurrent heavy stacks and queues the rest; labs leased just-in-time per verify round, not for the loom's lifetime. Data isolation is tenant-db (stamped from a migration-hash-keyed template) where the backend allows, mutex-plus-reset where it does not. |
| FR-LR-13 | Two-altitude verification | "Does the code hold?" runs constantly and cheaply per thread; "is this what you asked?" runs as a full lab experiment at loom altitude. **Success:** thread-altitude is serviceless, streaming, parallel, runs on every thread, and its rungs double as the progress heartbeat. Loom-altitude stands up the lab, runs live Playwright against a real checkout with capability-walled agents, emits evidence — gated so only one loom verification per repo runs at a time. |
| FR-LR-14 | Pause, park and resume | A loom survives interruption. **Success:** execution state durable enough that a parked loom resumes without re-running completed work, including under a different account or provider; the UI shows park state and why. Park reasons include user pause, credit exhaustion, credential wall. |
| FR-LR-15 | Progress liveness and dire-razor escalation | The human is told when a loom has genuinely stopped, and nothing else. **Success:** two liveness layers — supervisor watches process liveness (restart on death, crash-loop breaker); orchestrator watches progress liveness (heartbeat of evidence rungs, landings, verify rounds). Flatline for N minutes escalates as dire **even when every process is green**. Push fires only when the loom has no viable path to advance without the human; a failed test entering repair or a flaky boot being retried never pushes. Mid-run escalations ask the orchestrator first, reach the user only if mediation fails. |

**Act 3 — Judge**

| ID | Capability | Requirement |
| --- | --- | --- |
| FR-LR-16 | Evidence subsystem | One evidence system serves three consumers — proof on the accept card, proof-of-life for stall detection, forensics for disputes. **Success:** artifacts harness-captured and provenance-stamped in a ledger; synthesized narrative cites artifacts and any uncited claim renders as **unverified**; every verify attempt stays on the history with flaky boots/tests flagged; each run records its lab grade (dev or release) and its reality manifest (real or synthetic data, which services degraded). |
| FR-LR-17 | Delivery card | A human judges a finished loom in seconds at fleet scale, going deeper on taste then evidence when earned. **Success:** shelf row carries claim, proof strip, risk flags, release grade and the verdict in place — skimmable across 7+ looms. Opening a card leads with the live product on its frozen final-verify lane (filmstrip flipping to ledger screenshots), with the courtroom below the glass: reality manifest, cited narrative, contract with per-assert citations, evidence ledger, attempt history, advisory critic verdict. One `VerdictBar` per delivery, shared between shelf row and open card. |
| FR-LR-18 | Accept-then-land with a landing queue | Human judges branch evidence first; landing is mechanical afterward, serially, without stalling on human latency. **Success:** Accept queues the landing; the queue rebases each accepted branch onto moved main and re-verifies the same contract **at release grade** before merging, one at a time. Clean rebase + contract pass → lands silently; a landing whose repair modified code → delta note on the done card; a contract failure → re-opens repair, knocking only when repair is exhausted. |
| FR-LR-19 | Boomerang | Rejecting a delivery sends the loom back to finish, not to the bin. **Success:** Boomerang opens a composer; sending resumes the same loom with branch, worktree and recipe intact, so the second attempt is cheap. No rejected loom is destroyed by the rejection. |
| FR-LR-20 | Vision critic | An advisory seat judges a delivery against the map's objective and form regions — the "why". **Success:** the critic's verdict renders in the card's courtroom section and **never gates or bypasses Accept**. |
| FR-LR-21 | Map write-back | The map changes only through human-accepted proposals. **Success:** a loom pins the map's content hash at prep and emits proposal deltas to a ledger instead of writing shared docs mid-run; the drift ledger is declared on accept; deltas land one at a time; a moved head triggers a mandatory rebase-adapt pass re-applying the delta onto current content; a semantic contradiction surviving textual merge is shown side-by-side on the accept card for the human to rule on; large drift at land time triggers the bounded recompile instead of blind landing. Another loom's open, unlanded proposals are **reachable but never handed over** — a preparation agent may query the ledger; nothing is injected by default. A loom plans against accepted reality; it may look at what is coming, and never builds on it. |
| FR-LR-22 | MapStore and the artifact split | Two artifact classes with different physics get one storage interface. **Success:** loom-run artifacts (decision graph, flow DAGs, evidence, deltas) always live under `TELAR_HOME/projects/<id>/looms/<loom-id>/`; project knowledge lives in-repo by default as per-region markdown. Both go through one MapStore read/write interface with two backends; location is a per-project dial set once, defaulting in-repo for personal repos and home for work repos, reversible by a migration command. |

**Surfaces**

| ID | Capability | Requirement |
| --- | --- | --- |
| FR-LR-23 | Home / fleet triage | One screen shows what needs you, what is running, and where the map has drifted, across the whole fleet. **Success:** Needs-you sits top-left, splitting into a compressed delivery shelf (claim, proof tally, risk flag, Accept/Boomerang) and parked questions shown **verbatim**, where answering resumes the loom. Running rows carry an act chip (prepare/build/verify/repair/parked) and evidence age. Right column keeps recent sessions and adds a done-today receipt, hot projects carrying map drift, plus a **landing-queue strip** (queued count, what is landing, landed today) so an accepted-but-unlanded loom is never invisible. Grafts onto the existing dashboard's KPI hero, two-column deck and panel grammar rather than replacing it. |
| FR-LR-24 | Loom cockpit | A running loom is walkable. **Success:** persistent Prepare/Execute/Judge act tabs with park and kill in the header. Prepare renders the sealed preparation DAG as a frozen receipt. Execute pins the conductor over dense thread rows, **always rendered inside groups** — a single-lane flow renders exactly one group, and group identity comes from the compiled flow's declared lanes rather than a free-text label, so a group always denotes real interference structure. Drilling a thread shows the compiled flow, per-node context manifests, builder lanes, thread-altitude rungs, and per-agent transcripts streaming in a right drawer. Judge shows the contract lighting up as work completes. Header carries WINDOW (live merged-so-far URL, borrowed on demand at scale), LAB (service registry with scope, lease token, trust wall) and CHATS (steering always open, intake reopenable). |

#### SPEC-organization-workspace (13 FRs)

| ID | Capability | Requirement |
| --- | --- | --- |
| FR-OW-1 | Project-less master chat | One project-less conversation is the module's front door; asking where you stopped returns the sit-down overview. **Success:** with no project selected, a session runs and returns a briefing covering all four bands (what happened while away, where each project was left, what today holds, suggested first move), sourced from **durable on-disk state rather than conversation history**. The surface never initiates contact — it answers only when arrived at. |
| FR-OW-2 | Brain dump → receipt | User dumps everything from multiple projects in one unstructured go; the master parses, splits, routes, and confirms with a receipt naming what it could not place. **Success:** a dump of N fragments spanning ≥2 projects yields a receipt accounting for exactly N (`5 in → 4 filed, 1 question`), each filed line naming its destination, each unplaceable one asked about **verbatim** rather than guessed. Nothing is invented. |
| FR-OW-3 | Desk rail | Agent-created items land on a persistent right rail; the user edits them by talking about them, without them moving; dismissing drains to the queue. **Success:** referring to a desk item in conversation updates it **in place** (card stays put, marked just-updated); dismissing removes it from the desk and it is findable in the queue. **No path deletes an item.** |
| FR-OW-4 | Queue with dynamic lanes | Every item as a dense grouped list, grouped by coarse context lanes each holding an ordered stack; lanes are the user's to split, rename, retire; the master may propose a split when a cluster crowds a lane. **Success:** lanes render as user-defined data (never a fixed enum) with per-lane counts, coarse windows, and structural provenance on split lanes; a master-proposed split takes effect only after explicit human approval. Order is stack position — no clock, no schedule. Stack order and live conversational reprioritization both work and stay in agreement. |
| FR-OW-5 | Item spectrum with sub-tasks inside | An item ranges from a one-line todo to a rich packet holding files; work discovered mid-item becomes a sub-task **inside** that item; only the human may promote one out. **Success:** breaking an item into sub-tasks leaves the queue's item count unchanged and renders as `done/total` on the parent row. Richness is optional. A human-promoted sub-task becomes standalone carrying its parent as provenance; **no agent path exists to promote one.** |
| FR-OW-6 | Work packet ripening | A raw fragment matures over days into an execution-ready briefing. **Success:** a packet shows its original raw fragment and source alongside the fixed brief plus acceptance criteria; each timeline event carries actor and timestamp, and agent-generated ones awaiting a human look are marked as **proposals**. At execution time the packet *is* the briefing — nothing is re-authored for handoff. |
| FR-OW-7 | Deadlines as data, with a self-deadline witness | Deadlines are attributes of an item, not schedule entries, distinguishing external from self-imposed; self-deadlines remember how often they slid. **Success:** external and self deadlines are visually and structurally distinct, self ones carrying a slip count; a slid self-deadline surfaces in the next briefing offering keep / move / drop. **No alarm, no notification, no clock-driven trigger.** |
| FR-OW-8 | Expectation gap detection | Time-commitments spoken inside captures are mined as expectations; when an expected moment passes with nothing captured, the master says so. **Success:** a mined commitment whose moment has passed with no linked capture produces a gap line in the next briefing naming the commitment and when it was expected, with capture options (paste transcript / mark no-notes / dump now). Gap detection reads expectations only — **it never creates an item on its own**. |
| FR-OW-9 | Ephemeral per-project experts | Each project has an expert agent spawned per call and rehydrated from that project's on-disk digest. **Success:** an expert invoked cold produces project-correct interpretation of a fragment using **only the on-disk digest** and returns a session-or-loom triage verdict rendering on the item, with reasoning recorded on the packet timeline. The verdict is advisory: a human override is durable and a later expert pass does not re-flip it. **No expert process persists between calls.** |
| FR-OW-10 | Bed mode | Overnight, Telar performs organization work unattended within a fixed scope and reports a bounded digest. **Success:** a bed-mode run reports as actions-taken with **zero started and zero completed**; every artifact it produced is marked a proposal awaiting a human look. It creates no queue item, and its mirror sync is read-only. The digest is bounded by what the user can absorb. |
| FR-OW-11 | Loom and session handoff | When an item's turn comes, the user hands it to execution. **Success:** both handoffs emit the universal one-line detach receipt (`premise + context · detached`) in place; the packet remains as the loom's origin receipt. Batched rows **stay in the queue** marked as tracking the loom, leaving only when it lands **and** the human accepts — departure stays gated on the accept moat. "Start a session instead" is an equal-weight alternative on both. |
| FR-OW-12 | Tasks as a Telar-wide substrate | Any session anywhere in Telar can read its project's slice, create items, and modify them through a workspace tool surface, with provenance recording which surface did it. **Success:** asking a normal project session "what are the tasks here?" returns that project's slice rendered with the same chips as the queue; creating one files it into the right lane, stamps provenance to that session, places it on the desk, and carries it into the next briefing. Access is via the **in-process workspace MCP server** — no session needs write access to the store's directory. |
| FR-OW-13 | External sources as reference | A roster of **external** MCP servers scoped to the workspace lets the master read outside systems as reference material. **Success:** the master answers a question about an external tracker by reading it live and states plainly that results are **not tracked in Telar**; an external record becomes an item only on explicit human say-so. |

#### SPEC-ultra-workflows (6 FRs)

| ID | Capability | Requirement |
| --- | --- | --- |
| FR-UW-1 | Completion wake | When a detached Ultra run reaches a terminal state, telar wakes the session's main agent with the outcome. **Success:** with the session idle, a run finishing produces an **unprompted assistant turn** summarizing the result; mid-conversation, the next assistant turn already knows the outcome without calling `ultra_status`. `ultra_status` polling still works as fallback. |
| FR-UW-2 | Real session UI (U6) | User watches and controls Ultra runs from the real session surface — not the demo gallery. **Success:** launching a run in a real session renders anchor + rail exactly per `ui-contract.md`, updating live from `/api/ultra/[id]/events`; Stop lands the run `stopped` and Resume re-runs from the journal, both from the UI. Anchor is ONE compact fixed-height tool-style row (name, state pill, agents done/total, quiet spend readout, thin progress sliver), never growing or reflowing, with exactly one permitted collapse to a one-liner at terminal. Rail gains a Workflows section with run cards (name + state + spend + Stop), phase groups, per-agent rows (`label` · state · `model·effort` chip · masked-shimmer snippet · tokens/cost), a fixed-height scrolling narrator `log()` window, and a read-only Script tab with model pins visible. |
| FR-UW-3 | Authoring-reference skill file | The session's main agent has an authoring reference, shipped with the tool and injected for Claude sessions. **Success:** wired into Claude sessions (skill / system-prompt appendix), covering the injected surface API, the explicit-model rule, the quality patterns (adversarial-verify, loop-until-dry), and one worked example. The rail's Script tab links out to it. |
| FR-UW-4 | Composer Ultra chip | User arms Ultra for a single message via a composer chip annotating the message (`ultra: true`). **Success:** a chip-armed message may trigger `ultra` without the keyword; a message with neither chip nor explicit ask never does. The chip only arms — no ceiling editor, no submenu. |
| FR-UW-5 | Session-cost rollup | A run's live spend is attributed to its owning chat message and folds into the session's per-turn usage display, in the session's cost language. **Success:** during and after a run, the owning message's usage display includes the run's spend, matching the run manifest's `spend`. |
| FR-UW-6 | Dock run signal | From anywhere in the app, a session with live Ultra runs shows run status in its dock bubble. **Success:** with a run live and the user on another page, the session's dock bubble shows the run's name/state/spend updating live; tapping navigates back and focuses the run. One dock signal per session; concurrent live runs summarize. |

**FR total: 49** (RF 6 · LR 24 · OW 13 · UW 6)

### Non-Functional Requirements

NFRs in this project are expressed as **constraints** — mostly structural invariants and safety walls
rather than the classic performance/security/usability grid. They are load-bearing and testable.

#### Cross-cutting constitution (highest severity)

| ID | Constraint |
| --- | --- |
| NFR-X-1 | **The four structural walls never bend:** verifiers cannot write · conductors cannot code · agents cannot accept · nobody writes the map silently. Walls 1–3 exist in production; wall 4 is new with the redesign. |
| NFR-X-2 | **The human-accept moat is unchanged** — no agent-callable accept tool exists anywhere and none is ever added. `ready → done` is human-only, enforced twice (by construction in `packages/core`, re-enforced at the tool layer in `apps/web`). |
| NFR-X-3 | **Verifier capability wall:** `verifier.ts` / `verify-thread.ts` / `critic.ts` / `panel.ts` hold no write or edit tools; extended to loom-altitude lab agents, never relaxed. A passing verdict must be un-self-issuable. |
| NFR-X-4 | **Design law:** deterministic control flow in code, intelligence in the leaves. Scheduling/repair/escalation decisions stay pure functions over integers, sets and injected clocks; non-determinism pushed to injected seams and agent leaves. |
| NFR-X-5 | **Client-bundle rule:** `@telar/core` is server-only; client components import types only. Runtime core code lives in Route Handlers, Server Components, `instrumentation.ts`. |
| NFR-X-6 | **`TELAR_HOME` is the entire state root**; all engine state filesystem-backed with **atomic writes only** (`.tmp` → `renameSync`). One owner per subtree; shared runtime state written only through its owning core service. |
| NFR-X-7 | **Tone law:** no suggestion-text or doctrine captions anywhere in the UI. Surfaces show state and data only. |
| NFR-X-8 | **Single status vocabulary** (`components/looms/status.tsx`, `Tone = done \| attention \| danger \| active \| muted`); quiet-color law — hue on the icon only, badges stay neutral outlines. |
| NFR-X-9 | **Hand-rolled SSE**; native `EventSource` for GET tails. No `useChat`, no `EventSource` polyfill, no global client-state library. |
| NFR-X-10 | **bun-only**, `bun test` the only test tooling, **no CI** — `bun test` / `bun run lint` / `bunx tsc --noEmit` run manually. Note: `bun run lint` currently reports ~77k pre-existing problems in `apps/web`; not a clean baseline. |
| NFR-X-11 | **New conversational surfaces are born on the extracted `Conversation` shell.** The carve-out of `session-view.tsx` cuts at the render seam only; the shell owns no data fetching and no session semantics. |
| NFR-X-12 | **One fractal pattern everywhere:** declare → validate → execute deterministically → reconcile lazily. |
| NFR-X-13 | **Approval-gated advance is the universal protocol shape** — proposal → explicit human approval → effect, rendered as the shared `ApprovalCard`. |
| NFR-X-14 | **The detach receipt grammar is universal** — one mono line, identical from birth session, batch weave, or packet handoff. |
| NFR-X-15 | **No auth or multi-user model** — local single-user cockpit posture inherited. |

#### SPEC-loom-redesign constraints (27, the deltas beyond the cross-cutting set)

`NFR-LR-1` ONE design for looms at any size — no small/medium/large split; ceremony scales, walls never do ·
`NFR-LR-2` the decision graph always exists and is never rendered inside the originating session's UI ·
`NFR-LR-3` **no file locks anywhere on the map** — proposals are the only write path, serial landing the only commit path ·
`NFR-LR-4` only human-meaningful markdown lands in-repo, one file per map region; machine artifacts always stay in `TELAR_HOME` ·
`NFR-LR-5` a methodology declares the catalog, never the graph — drift alone decides which nodes run ·
`NFR-LR-6` methodologies never declare *how* anything is written, so wall #4 survives a user-modified methodology ·
`NFR-LR-7` the region set is per-project; changing methodology is a reconciliation-loom rebuild, never a schema migration ·
`NFR-LR-8` hand-edits to in-repo map files are allowed and treated as good; the lazy intake diff absorbs them as drift ·
`NFR-LR-9` **one loom verification per repo at a time** (per-repo verification mutex); surface evidence events count under it ·
`NFR-LR-10` **trust wall** — sessions may adopt a user-hand-started foreign stack, looms never may; evidence comes only from telar-owned labs ·
`NFR-LR-11` **data class `production` means refuse surface-verify, fail closed** (not hypothetical — a surveyed project's documented dev path pointed at live production Supabase) ·
`NFR-LR-12` carried files have lab-checkout lifetime — planted at `0600`, scrubbed at teardown, never copied into evidence/map/transcript; a worktree that held carry files and cannot be removed raises a **dire escalation naming the path** ·
`NFR-LR-13` evidence inherits its recipe's data class — `disposable` retains freely, `shared-dev` is flagged and never lands in-repo, `production` already refused; evidence is reaped with its loom ·
`NFR-LR-14` degradation is a **prep-time** concern, surfaced before the gate, never mid-run ·
`NFR-LR-15` children escalate to mediation, never straight to humans; pushes are awareness-only ·
`NFR-LR-16` **one window per loom, never per thread**; heavy infra is one stack at a time, never N; borrowed on demand for heavy projects ·
`NFR-LR-17` window concurrency per project is a function of the recipe's `isolation` parameter, not a fixed number; a request beyond what isolation permits **queues and names its holder**, never displacing a live window or running verify ·
`NFR-LR-18` **the lane owns the server** — project-owned e2e suites reuse it via `PORT` + `reuseExistingServer`, never a nested `webServer` ·
`NFR-LR-19` the recipe is a map region compiling to `servers.yaml` + prepare/carry/verify; the region is source of truth ·
`NFR-LR-20` v1 **serializes** fleet access to stock or colliding ports rather than rewriting committed port config ·
`NFR-LR-21` evidence must cite artifacts; uncited claims render as unverified; every verify attempt stays on history, flaky boots and tests flagged ·
`NFR-LR-22` landings verify at **dev grade**; the accept-gating ALL-verify and post-accept landing re-verify run at **release grade** ·
`NFR-LR-23` worktree-per-loom is mandatory, branch-per-loom is constitutional, worktree-per-thread optional-but-preferred; the user's primary checkout is sacred ·
`NFR-LR-24` cleanup failure is best-effort except where secrets were carried; `reapOrphanWorktrees` keyed on the `telar-wt-` prefix so it never touches the user's own checkouts ·
`NFR-LR-25` intake always diffs against the map at main/default-branch head, never a worktree copy ·
`NFR-LR-26` the ledger holds full history so region files are rewritten in place and stay lean — documentation adapts, never accumulates ·
`NFR-LR-27` the map is a **regenerable projection** — a reconciliation loom can rebuild it from repo + ledger.

**Map/DAG render rules** (design-language NFRs from `ux-surfaces.md`): grab-to-pan viewport (not a scroll
container) · scroll-wheel zoom anchored at cursor · rounded 90°-elbow SVG edges · node sub-text **never
truncates**, selected node expands downward only into the row gap and never overlaps a neighbor while others
dim to 65% · glide-to-node measures after a double `requestAnimationFrame` with eased cubic-bezier to kill
flicker · a "sealed" gate state (muted lock) renders the same map as a frozen receipt.

#### SPEC-organization-workspace constraints (20, deltas)

`NFR-OW-1` **pull, never push** — no surface notifies, pings, badges, or interrupts ·
`NFR-OW-2` **prepare, never commit** — agents may file, draft, ripen, propose and sync inbound; never start work, complete work, or write outward to a foreign system ·
`NFR-OW-3` **compress, never multiply (conservation of the queue)** — item count grows only when reality grows; agents fan out inside a packet, never at queue level ·
`NFR-OW-4` capture raw, understand later — capture is zero-ceremony; understanding is a deferred enrichment pass; ambiguity resolved in the next chat, never by a ping ·
`NFR-OW-5` **experts write, master reads** — experts produce durable on-disk digests; the master is a thin reader. State lives on disk, not in the conversation (this removes the context-window ceiling) ·
`NFR-OW-6` foreign structures stay foreign — native projects: Telar is source of truth; mirrored projects: Telar holds a view with pointers back ·
`NFR-OW-7` the master is a **full harness session** (CC/Codex CLI, not an SDK-native agent): project gate skipped, `cwd` = `TELAR_HOME/workspace/home` (dedicated empty subdir, never the store root, never `/Users/facundo`), `settingSources: []`, default guardrails, MCP injected programmatically ·
`NFR-OW-8` Codex reaches workspace tools via per-invocation config injection — `runCodexTurn` has no MCP plumbing today; closing that gap is in scope for a Codex-backed master ·
`NFR-OW-9` **sub-agent scope is inverted here** — the master has no project and each expert is scoped to its own; any plumbing assuming a sub-agent inherits the caller's project breaks the master ·
`NFR-OW-10` lanes are data, never an enum; lane structure changes are human-accepted ·
`NFR-OW-11` **no clocks and no scheduling** — order is stack position, deadlines are chips ·
`NFR-OW-12` provenance is a free-form label, not a channel type — no capture-channel enum to switch on ·
`NFR-OW-13` the store is `lanes.yaml` + `packets/<id>/` under `TELAR_HOME/workspace`; structure and content stay separate; all writes atomic ·
`NFR-OW-14` **cross-surface access goes through the in-process workspace MCP server**, never raw file tools — project sessions are sandbox-bound to their own root, so file access does not merely offend tidiness, it does not work ·
`NFR-OW-15` only the human promotes a sub-task out of its parent — agents have no promotion path, proposed or otherwise ·
`NFR-OW-16` master chat is born on the shared `Conversation` shell as an owner adapter ·
`NFR-OW-17` **one chip grammar** — deadline, verdict, project, provenance render identically on every surface ·
`NFR-OW-18` **dismiss drains, never deletes** — stated in the UI wherever the action exists ·
`NFR-OW-19` **no clock anywhere** — timestamps are labels; nothing counts down, nothing fires ·
`NFR-OW-20` **agent honesty on screen** — bed-mode runs report `0 started`, the queue reports `agents added 0`, proposals are visibly dashed.

#### SPEC-ultra-workflows constraints (11, deltas)

`NFR-UW-1` opt-in is a request, not a behavior flag — `ultra` is callable only on explicit user ask (keyword or chip), never inferred; no engine mode, no `TELAR_*` switch ·
`NFR-UW-2` the non-blocking contract is fixed — `ultra` validates synchronously and returns `{runId}` immediately; several runs may be live per session; completion is an event; the wake **supplements** `ultra_status` polling, never replaces it ·
`NFR-UW-3` the sandbox stays as-is — `node:vm` capability shaping with determinism bans (`Date.now`, `new Date()`, `Math.random` throw) is load-bearing for ordinal resume; it is **not** a security boundary and must not be reworked into one ·
`NFR-UW-4` child posture is fixed — subagents run non-interactive under `ULTRA_CHILD_TOOLS` (Read, Grep, Glob, Write, Edit, Bash) + `restrictTools`; an approval-needing action fails that `agent()` call (fail-closed); no per-agent permission knob ·
`NFR-UW-5` every `agent()` call names its `model` — static lint rejects a model-less script before `runId`; a runtime `MissingModel` ends the run `failed`, never coerced to `null` ·
`NFR-UW-6` schema-less `agent()` (returns final text) stays — reference parity with the CC harness ·
`NFR-UW-7` **no budgets anywhere** — no spend ceilings, meters, or budget UI; runaway brakes are the per-run cap (3), the engine gate (4), the 1000-agent backstop, human Stop, and `ultra_stop` ·
`NFR-UW-8` Claude-first — no Codex-specific Ultra work ·
`NFR-UW-9` Ultra never writes loom state and never `done`s a loom; run state lives in `~/.telar/ultra/` under `TELAR_HOME`, invisible to loom listing/reaping ·
`NFR-UW-10` terminal states are the as-built `done \| failed \| stopped` — the draft name `completed` is superseded ·
`NFR-UW-11` the real UI implements the frozen `ui-contract.md`; house rules apply (terse copy, `min-w-0` + `truncate` on variable-width flex children, density over height, no placebo, masked shimmer only).

**NFR total: 73** (cross-cutting 15 · LR 27 · OW 20 · UW 11), plus the 33 rules in `project-context.md`
that bind all four SPECs and the map/DAG render rules above.

### Additional Requirements, Constraints and Assumptions

**Architecture governance.** The spine defines **AD-1 … AD-21**. SPEC citations reference only
AD-5, AD-7, AD-14, AD-15, AD-16, AD-17, AD-18, AD-19, AD-20, AD-21 — and **all of those citations sit in
`SPEC-runtime-foundations` alone**. The other three SPECs cite no AD number at all.

**Declared out-of-scope work (deferred, must not be silently implemented):**
- RF: tuning admission ceiling/class weights against a real fleet; wiring `processCeiling` into `tick.ts` and `executor.ts` live clamps; tagging `executor.ts` `agent()` call sites with `loom-build`; adding CI; persisting bus events.
- LR: graduated-autonomy dial; remote accept; productized preview-deploy verify tier; tenant-DB optimization beyond template-stamp-per-migration-hash; port remapping; the organization-workspace module; methodology authoring UI and a second shipped methodology; a universal map-region taxonomy; a fleet-level map surface or landing-queue visualization; telar's own Ultra workflows; rebuilding the existing verifier/critic/panel stack, supervisor, or runner-lease machinery.
- OW: capture-channel integrations and taxonomy; board view; Telar-authored schedule or agenda; external calendar; notifications/alarms/badges/push of any kind; always-alive expert agents; any deletion path; agent-initiated sub-task promotion; agent write-back to a foreign tracker; agent-initiated execution; auth/multi-user; loom internals.
- UW: Codex-backed Ultra; reworking script isolation into a real security sandbox; budgets of any kind; nested runs; a cross-process supervisor or runs surviving server restart as `running`; deferred/queued wake delivery for unattended sessions; any loom-lifecycle integration; rebuilding U1–U5.

**Explicit success signals** (three of four SPECs):
- **LR:** one real loom end-to-end with the human touching it exactly three times — born with a receipt, gate accepted after acknowledging one degraded mode, orchestrator runs threads on the loom's branch while a borrowed lab produces cited evidence, delivery card read in under a minute and accepted, landing queue rebases/re-verifies/lands silently, knocked exactly once and only because it genuinely could not advance. **Recursive proof: the same run executed on telar itself under a sandboxed `TELAR_HOME`.**
- **OW:** the morning sit-down scenario end to end — briefing with all four bands, a five-fragment dump returning `4 filed, 1 question`, a three-day ripened packet handing brief + attachments to a loom that detaches, and **never once a notification**.
- **UW:** one real end-to-end Ultra workflow on a sandbox project through the actual session UI — ask, author, launch, anchor + rail track live, wake fires at terminal and the agent summarizes — with no `ultra_status` poll and no page refresh.
- **RF:** ⚠️ **none** — see gap RA-1 below.

**Declared assumptions carried into implementation:**
- LR-A1 the three acts **absorb** the existing production lifecycle rather than running beside it; the dead `preparing`-phase `runSetup` hook is the readiness node's slot.
- LR-A2 demo-gallery entries are design source of truth, **not production code**.
- LR-A3 `recipe.schema.yaml` is adopted as-is as the machine-readable draft.
- LR-A4 the vision critic (FR-LR-20) is in-contract because UX 3's final card renders it — **its promotion from July-18 "Could" is inferred from chronology, not a direct call.**
- LR-A5 three other July-18 "Could" items were likewise promoted by later sessions (fleet lanes + landing queue, streaming-evidence early-kill, adaptive ceremony templates).
- OW-A1 demo-gallery workspace mockups are the as-built rendering of the intended contract; fixture state is mockup-only.
- OW-A2 "hand-fed v1" means typing, pasting, or dropping into a Telar surface — no listeners, watchers, or webhooks.
- OW-A3 **the `Conversation` extraction lands before or alongside master chat.**
- OW-A4 bed mode's "0 started" reporting is a real invariant to assert against, not display copy.
- OW-A5 mining time-commitments is expert work during the enrichment pass, not a separate parser.
- UW-A1 the wake fires on every terminal state carrying `{state, result|error}` — the plan says "on terminal", the brainstorm only says "finishes".
- UW-A2 demo-gallery `session-ultra.tsx` is the as-built rendering of the frozen contract; its replay controls are mockup-only.
- UW-A3 "session-cost rollup" means folding into the owning message's per-turn usage display, not a new cost surface.

### Requirements-Analysis Findings

Extraction quality is **high**: every capability carries a testable `success` clause, constraints are stated
as invariants rather than preferences, non-goals are unusually explicit, and assumptions are labelled as
inferences where they are inferences (LR-A4 is a model of honest spec-writing). The following are the gaps.

| ID | Severity | Finding |
| --- | --- | --- |
| **RA-1** | ⚠️ **HIGH** | **`SPEC-runtime-foundations` has no Constraints, no Non-goals, no Success signal, and no Assumptions section** — it carries only Why, Capabilities, and Out of scope. The other three SPECs carry all five. Consequence: there is no stated definition of "the substrate is done", so Track A has no completion test of its own and inherits its finish line only from the features that consume it. Per-CAP success clauses are strong and partly compensate. |
| **RA-2** | ⚠️ **HIGH** | **`SPEC-ultra-workflows` does not declare its dependency on `SPEC-runtime-foundations`.** FR-UW-1 (completion wake) needs FR-RF-3 (typed event bus with `agent-facing` delivery class) — RF names UW CAP-1 explicitly as the thing its delivery class exists to keep consistent, but UW names neither RF nor the bus. FR-UW-5 (session-cost rollup) likewise needs FR-RF-2 (attributed ledger); RF states Ultra's `spend` is a projection over `usage.ndjson`, UW does not. RF (22:39) postdates UW (11:23), so UW is stale rather than wrong — but a reader of UW alone would build the wake against nothing. |
| **RA-3** | 🔶 MEDIUM | **NFR-UW-7 hardcodes the runaway brake as "the engine gate (4)"**, while FR-RF-4 makes that ceiling configurable via `TELAR_MAX_AGENTS` and admits Ultra under a weighted class. Not a contradiction — the default is 4 — but the constraint as written will read as false the moment anyone raises the ceiling. |
| **RA-4** | 🔶 MEDIUM | **Dangling cross-reference:** `spec-loom-redesign/lifecycle.md:75` says *"see the kernel's open questions"* for how a multi-task loom is demonstrated beyond the batch-weave path. **`SPEC.md` has no open-questions section.** The pointer resolves to nothing, and the underlying concern — that only one path exercises `loom ≠ one task` — is therefore recorded nowhere it can be actioned. |
| **RA-5** | 🔶 MEDIUM | **12 of 21 architecture decisions are never cited by any SPEC** (AD-1–AD-4, AD-6, AD-8–AD-13), and every AD citation that does exist lives in `SPEC-runtime-foundations`. The three feature SPECs are governed by the spine implicitly at best. Whether those 12 ADs are covered elsewhere is a Step-4 question, but the citation asymmetry is a traceability weakness now. |
| **RA-6** | 🔶 MEDIUM | **FR-UW-6 (dock run signal) is contractually open.** `ui-contract.md` §9 marks it *"polish tier; implementation shape is open"* inside a document whose own title declares it frozen. A capability with a stated success criterion but an undecided shape will not survive story-sizing intact. |
| **RA-7** | 🔵 LOW | **Scope asymmetry is extreme and unremarked.** LR carries 24 of 49 FRs and 27 of 73 constraints, with single capabilities (FR-LR-13, FR-LR-16, FR-LR-17) that each carry more contract than the whole of `SPEC-ultra-workflows`. This is legitimate — LR is the product and the others are substrate/side-quests — but it means LR's story decomposition is where nearly all delivery risk concentrates. |
| **RA-8** | 🔵 LOW | **`project-context.md` is simultaneously a binding companion to all four SPECs and, per FR-LR-7/`map-and-storage.md`, destined to be folded into the map's `conventions.md` region.** Once the map exists, the file has two homes and no stated precedence. Benign today; a real question at FR-LR-3 implementation time. |
| **RA-9** | 🔵 LOW | **`/docs` (the brownfield as-is set) is dated 2026-07-17, one week behind the SPECs**, and `docs/decisions/` is empty despite 21 architecture decisions now existing. The SPEC `brownfield.md` companions were re-verified 2026-07-24 and are the fresher source; `/docs` should not be treated as current during implementation. |

**No contradictions were found** between any two SPECs' stated contracts. RA-2 and RA-3 are staleness, not
conflict. The four structural walls, the accept moat, and the capability wall are stated consistently in all
four SPECs and in `project-context.md`.

**Traceability baseline established: 49 FRs · 73 NFRs.** Proceeding to epic/story coverage validation.

---

## Step 3: Epic & Story Coverage Validation

All four `stories.yaml` files read in full — **51 stories** total. Epic structure is not a separate
document: `WORK-SPLIT.md` **is** the epic layer, dividing the work into **Tracks A–F** with Track F further
split into sub-tracks F0–F5. Coverage was validated FR → story, and then FR → story → track.

### Coverage Matrix

#### SPEC-runtime-foundations — 6 FRs / 7 stories

| FR | Requirement | Story | Track unit | Status |
| --- | --- | --- | --- | --- |
| FR-RF-1 | `TELAR_HOME` honored everywhere | Story 1 | A1 | ✓ Covered |
| FR-RF-2 | One attributed spend ledger | Story 2 | A2 | ✓ Covered |
| FR-RF-3 | Typed event bus + delivery class | Story 4 | A3 | ✓ Covered |
| FR-RF-4 | Admission control | Story 3 | A4 | ✓ Covered |
| FR-RF-5 | One lease primitive, two lifetimes | Story 5 | A5 | ✓ Covered |
| FR-RF-6 | Executable invariant assertions | Story 6 | A6 | ✓ Covered |
| — | *(success signal)* | Story 7 Prove-run | — | ✓ Present |

**6/6 (100%).** Ordering constraint CAP-1→CAP-2 is enforced in story 1's `invoke_dev_with` *and* in
WORK-SPLIT's serialization list. Story 7 supplies the success signal the SPEC itself omits (see RA-1) —
the finish line exists, but it lives in the story file rather than the contract.

#### SPEC-ultra-workflows — 6 FRs / 7 stories

| FR | Requirement | Story | Track | Status |
| --- | --- | --- | --- | --- |
| FR-UW-1 | Completion wake | Story 1 | D | ⚠️ Covered, dependency undeclared |
| FR-UW-2 | Real session UI | Story 2 | D | ✓ Covered |
| FR-UW-3 | Authoring-reference skill file | Story 3 | D | ⚠️ Covered, mechanism unstoried |
| FR-UW-4 | Composer Ultra chip | Story 4 | D | ✓ Covered |
| FR-UW-5 | Session-cost rollup | Story 5 | D | ⚠️ Covered, dependency undeclared |
| FR-UW-6 | Dock run signal | Story 6 | D | ✓ Covered (shape open — RA-6) |
| — | *(success signal)* | Story 7 Prove-run | — | ✓ Present |

**6/6 (100%).**

#### SPEC-organization-workspace — 13 FRs / 13 stories

| FR | Requirement | Story | Track | Status |
| --- | --- | --- | --- | --- |
| FR-OW-1 | Project-less master chat | Stories 6 + 10 | E / **B** | ⚠️ Covered, see CV-1 |
| FR-OW-2 | Brain dump → receipt | Story 9 | E | ✓ Covered |
| FR-OW-3 | Desk rail | Story 7 | E | ✓ Covered |
| FR-OW-4 | Queue with dynamic lanes | Stories 1 + 3 | E | ✓ Covered |
| FR-OW-5 | Item spectrum with sub-tasks | Stories 1 + 3 | E | ✓ Covered |
| FR-OW-6 | Work packet ripening | Story 4 | E | ✓ Covered |
| FR-OW-7 | Deadlines + self-deadline witness | Story 10 | E | ✓ Covered |
| FR-OW-8 | Expectation gap detection | Stories 8 + 10 | E | ✓ Covered |
| FR-OW-9 | Ephemeral per-project experts | Story 8 | E | ✓ Covered |
| FR-OW-10 | Bed mode | Story 11 | E | ✓ Covered |
| FR-OW-11 | Loom and session handoff | Story 5 | E | ✓ Covered |
| FR-OW-12 | Tasks as Telar-wide substrate | Story 2 | E | ✓ Covered |
| FR-OW-13 | External sources as reference | Story 12 | E | ✓ Covered |
| — | Codex MCP injection (NFR-OW-8) | Story 13 | **B** | ⚠️ Marked "optional for v1" — see CV-4 |
| — | *(success signal)* | **NOT FOUND** | — | ❌ **MISSING** |

**13/13 (100%) — but no prove-run story.** See CV-3.

#### SPEC-loom-redesign — 24 FRs / 24 stories

| FR | Requirement | Story | Sub-track | Status |
| --- | --- | --- | --- | --- |
| FR-LR-1 | Loom birth and detach | Story 11 | F1 | ✓ Covered |
| FR-LR-2 | Decision graph | Story 8 | F1 | ✓ Covered |
| FR-LR-3 | Living map + lazy intake diff | Stories 2 + 9 | F0 / F1 | ✓ Covered (split, both halves present) |
| FR-LR-4 | Verification-readiness node + recipe | Story 4 | F2 | ✓ Covered |
| FR-LR-5 | Readiness gate | Story 10 | F1 | ✓ Covered |
| FR-LR-6 | Approval-gated advance | Story 8 | F1 | ✓ Covered |
| FR-LR-7 | Methodology as data | Story 2 | F0 | ✓ Covered |
| FR-LR-8 | Orchestrator ownership + role wall | Story 12 | F3 | ✓ Covered |
| FR-LR-9 | Flow compile | Story 13 | F3 | ✓ Covered |
| FR-LR-10 | Branch and worktree isolation | Story 6 | F3 | ✓ Covered |
| FR-LR-11 | Declared services + supervisor labs | Story 1 | F3 | ✓ Covered |
| FR-LR-12 | Borrowed heavy infra | Story 5 | F3 | ✓ Covered |
| FR-LR-13 | Two-altitude verification | Story 7 | F2 | ✓ Covered |
| FR-LR-14 | Pause, park and resume | Story 14 | F3 | ✓ Covered |
| FR-LR-15 | Progress liveness + dire razor | Story 15 | F3 | ✓ Covered |
| FR-LR-16 | Evidence subsystem | Story 16 | F2 | ✓ Covered |
| FR-LR-17 | Delivery card | Story 17 | F4 | ✓ Covered |
| FR-LR-18 | Accept-then-land + landing queue | Story 18 | F4 | ✓ Covered |
| FR-LR-19 | Boomerang | Story 19 | F4 | ✓ Covered |
| FR-LR-20 | Vision critic | Story 21 | F2 | ✓ Covered |
| FR-LR-21 | Map write-back | Story 20 | F0 | ✓ Covered |
| FR-LR-22 | MapStore + artifact split | Story 2 | F0 | ✓ Covered |
| FR-LR-23 | Home / fleet triage | Story 23 | F5 | ✓ Covered |
| FR-LR-24 | Loom cockpit | Story 22 | F5 | ✓ Covered |
| — | Conversation shell carve-out (NFR-X-11) | Story 3 | **C** | ✓ Covered |
| — | *(success signal)* | Story 24 Prove-run | — | ✓ Present |

**24/24 (100%).**

### Coverage Statistics

| Metric | Value |
| --- | --- |
| Total FRs in specs | **49** |
| FRs covered by a story | **49** |
| **FR coverage** | **100%** |
| Total stories | 51 (RF 7 · LR 24 · OW 13 · UW 7) |
| Stories with no FR in the specs | 0 — every story traces to a CAP, a named constraint, or a prove-run |
| Architecture tracks (WORK-SPLIT) | 6 (A–F), F split into F0–F5 |
| **Tracks with a story file** | **5 of 6** — Track B has none |
| Prove-run / success-signal stories | 3 of 4 specs (OW missing) |

**No orphan stories and no uncovered capability.** On the standard measure this is a 100% clean
traceability result. The failures are structural, not arithmetic — a story-per-capability count cannot see
them, which is why they survived to this point.

### Missing Coverage — Findings

| ID | Severity | Finding |
| --- | --- | --- |
| **CV-1** | 🛑 **CRITICAL** | **Track B — Session profiles has no stories, in any spec file.** The string `profile` appears in **zero** of the 51 stories; `Track B` appears exactly once in the whole planning corpus — inside WORK-SPLIT's own diagram. Yet Track B: (a) is one of the three day-one critical-path tracks, (b) **blocks Tracks E and F**, (c) owns `apps/web/app/api/chat/route.ts` and the profile resolver, and (d) implements **AD-9**, whose typed `SessionProfile` — `{cwd, guardrails, settingSources, mcpServers[], toolPolicy, requiredCapabilities, systemPromptAppendix}` — is the seam through which D, E and F extend the chat route *without editing it*. That seam is what makes the disjoint-write-set guarantee real. Un-storied, it does not get built; D, E and F then each branch inside the route, and the parallel track model silently collapses into three agents editing one file. |
| **CV-2** | 🛑 **CRITICAL** | **The one story that touches Track B's territory specifies the anti-pattern AD-9 exists to forbid.** OW story 6 is titled *"Project-less master session"* and reads *"**Lift the chat route's project gate** so a session can run with no project"* — an `if`. AD-9's rule is explicit: *"A new surface adds a profile; **it does not add an `if`**. OW's project-less master is a profile supplying `cwd: TELAR_HOME/workspace/home` and `settingSources: []`, **not a special case in the handler**."* The story's `invoke_dev_with` then enumerates exactly the profile's field values (`cwd`, `settingSources: []`, default guardrails, MCP injected programmatically) while still framing them as a gate-lift. A dev following this story as written builds the special case. **This also puts AD-10 at risk** — *"the moat sits outside the profile"*, whose stated rationale is that *"a moat enforced in three places has three chances to be forgotten."* Without the profile pipeline, there is no single place for the guardrail to sit outside of. |
| **CV-3** | ⚠️ **HIGH** | **`SPEC-organization-workspace` has no prove-run story.** RF (story 7), UW (story 7) and LR (story 24) each close with an end-to-end story gating on the SPEC's success signal. OW has a detailed, testable success signal — the morning sit-down scenario: four-band briefing, `5 in → 4 filed, 1 question`, a three-day packet handing off to a loom, and never a notification — and **nothing gates on it**. OW instead ends on story 13, itself marked *"Optional for v1."* The module with the most human-judgment-dependent success criteria is the only one with no end-to-end proof. |
| **CV-4** | ⚠️ **HIGH** | **Priority contradiction on Codex MCP injection.** OW story 13 marks it *"Optional for v1 — a Claude-backed master is unblocked without it."* WORK-SPLIT assigns it to **Track B**, a day-one critical-path track that blocks E and F. `SPEC-organization-workspace`'s constraint NFR-OW-8 states it is *"in scope for a Codex-backed master, **not incidental cleanup**."* Three documents, three priorities. The likely reconciliation is that the *injection* is optional while Track B's *profile resolver* is not — but that reading only works once CV-1 is fixed, because today story 13 is the only story Track B has. |
| **CV-5** | 🔶 MEDIUM | **UW's cross-spec dependencies are undeclared at story level** — RA-2 propagated into the work items. UW story 1 (completion wake) describes *"synthetic completion event → fresh summarizing assistant turn"* with **no `invoke_dev_with` at all** and no reference to FR-RF-3's event bus or its required delivery class — even though RF story 4's own guidance names UW CAP-1 as the reason the delivery class must be a required field. UW story 5 (session-cost rollup) likewise has no `invoke_dev_with` and never mentions FR-RF-2's attributed ledger, though RF story 2 explicitly says Ultra's manifest spend becomes a projection over `usage.ndjson`. The dependency is documented in exactly one direction. A dev starting from UW builds both against nothing. |
| **CV-6** | 🔶 MEDIUM | **FR-UW-3's delivery mechanism is unstoried.** The spine maps UW CAP-3 to *"shipped with the tool; injected via profile `systemPromptAppendix`"* (AD-9). UW story 3 says only *"injected for Claude sessions"*. The `systemPromptAppendix` field belongs to the `SessionProfile` of CV-1 — so this story depends on a component no story creates. |
| **CV-7** | 🔶 MEDIUM | **OW's checkpoint coverage collapses after story 3.** `done_checkpoint` appears on OW stories 1 and 3 only; stories **4–13 carry none** — ten consecutive stories including packet detail, loom handoff, master session, master chat, experts, brain dump, the briefing, and bed mode. Compare LR, which spreads six done-checkpoints across the arc (3, 7, 11, 15, 21, 24), and RF (3, 6, 7). Combined with CV-3, the entire back half of the workspace module ships with no verification gate of any kind. |
| **CV-8** | 🔶 MEDIUM | **The Judge-surface and cockpit stories carry no `spec_checkpoint`.** LR stories 17 (delivery card), 19 (boomerang), 22 (cockpit) and 23 (home/fleet triage) have neither `spec_checkpoint` nor `done_checkpoint`; story 19 has no `invoke_dev_with` either. Story 17 renders the accept surface — where evidence is judged and the human-accept moat is exercised — and story 19 guarantees that rejection does not destroy a loom. These are among the highest-consequence surfaces in the system and are the least gated stories in the file. |
| **CV-9** | 🔵 LOW | **Stale counts and stale scope language.** WORK-SPLIT is titled *"how **43** capabilities divide into buildable tracks"* — 43 = LR 24 + OW 13 + UW 6, the count **before** runtime-foundations' 6 were added; the true figure is 49, and the doc's own Track A section was updated for the new spec package while the title was not. Independently, `spec-loom-redesign/stories.yaml`'s header comment reads *"Epic numbering is assigned later, across all **three** specs being planned together"* — also written before RF existed. Same staleness signature as RA-2 and RA-3: the 22:39 runtime-foundations pass updated its own artifacts and the WORK-SPLIT track table, but not the counts and cross-references in sibling documents. |
| **CV-10** | 🔵 LOW | **Epic numbering does not exist anywhere.** Story ids are flat per spec (`1`…`24`), and LR's header defers numbering to a later pass that has not run. Tracks A–F/F0–F5 in WORK-SPLIT are the de-facto epics but are never bound to story ids, so there is no single identifier a sprint plan can schedule against. Four separate `stories.yaml` files each starting at id `1` also means "story 5" is ambiguous across four specs — and stories already cross-reference each other by bare number (LR story 11 ↔ "workspace story 5"; the qualifier saves it, but the convention is fragile). |

### What the coverage check found working well

Worth recording, because these are the parts that should not be disturbed by fixing the above:

- **Every one of the 49 capabilities has exactly one clearly-owned story.** No duplication, no orphans, no capability split ambiguously across two owners. FR-LR-3's deliberate split (storage half → story 2, intake half → story 9) is stated in both stories.
- **The LR ↔ OW handoff seam is specified symmetrically and correctly.** LR story 11: *"the steering-channel endpoint is this story's deliverable; the workspace queue renders the sent mark (workspace story 5) — no queue UI is built here."* OW story 5: *"the steering-channel endpoint an edit posts to belongs to the loom spec (its story 11)."* Two specs, two directions, no overlap and no gap. This is the standard the CV-5 dependencies should be held to.
- **The Conversation shell dependency is declared in three places and fails loudly.** LR story 3 (*"this story IS Track C, on the critical path from day one"*), UW story 2 (*"final wiring lands after Track C's session-view migration"*), OW story 7 (*"PREREQUISITE… if the shell is not there yet, **STOP and say so**; do not hand-rebuild another chat window"*). This is exactly the pattern Track B needs.
- **`invoke_dev_with` carries real constraint enforcement**, not restated titles — RF story 3 warns off re-deriving a rejected design, LR story 3 warns that the extraction's danger *is* the story, OW story 10 rules a mockup detail out of scope. 43 of 51 stories carry one.
- **Ordering hazards are stated where they bite:** RF story 1 before story 2 (dev spend into production state), F0 before the rest of F, A1→A2 and A3→D/E/F in WORK-SPLIT's serialization list.

**Coverage verdict: 49/49 FRs traced (100%), but 1 of 6 architecture tracks is unstoried and one spec has
no end-to-end proof.** Proceeding to UX alignment.

---

## Step 4: UX Alignment Assessment

### UX Document Status

**FOUND** — UX is not a standalone document; it is distributed as SPEC companions, all of them contractual.

| Document | Scope | Contract status |
| --- | --- | --- |
| `spec-loom-redesign/ux-surfaces.md` | Six surfaces (UX 0 birth · UX 1 home · UX 2 cockpit · UX 3 delivery · UX 4 gate room · UX 5 workspace) + shared design language | Contractual |
| `spec-organization-workspace/ui-contract.md` | Four surfaces (master chat · desk rail · queue · packet detail · in-session) + chip grammar + 6 cross-surface invariants | Frozen |
| `spec-ultra-workflows/ui-contract.md` | Nine numbered contract points for the session UI | Frozen |
| `conversation-component.md` | The `Conversation` shell teardown plan — three layers, migration order | Adopted companion of LR, OW **and** the architecture spine |

This is a **UI-heavy initiative**: 3 of 4 SPECs are user-facing, and 10 of LR's 24 capabilities are surfaces
or surface-bearing. All six surfaces were prototyped live in `apps/web/lib/demo-gallery/**` and are
consistently labelled *design source of truth, not production code*. Prototype fixture state (pre-checked
rows, one-shot toggles, hardcoded timestamps, Ultra's replay controls) is explicitly ruled non-contractual
in every case — a discipline worth noting, since it is the usual source of "the mockup said so" disputes.

### UX ↔ SPEC Alignment

**Strong.** Every UX surface traces to a capability, and every UI-bearing capability has a surface:

| UX surface | Capability | Story |
| --- | --- | --- |
| UX 0 Birth | LR CAP-1 | LR 11 |
| UX 1 Home | LR CAP-23 | LR 23 |
| UX 2 Cockpit | LR CAP-24 | LR 22 |
| UX 3 Delivery card | LR CAP-17 | LR 17 |
| UX 4 Gate room | LR CAP-5, CAP-6 | LR 10, LR 8 |
| UX 5 Workspace (4 surfaces) | OW CAP-1…6, CAP-11, CAP-12 | OW 3,4,5,7,9,10 |
| Ultra anchor + rail | UW CAP-2, CAP-4, CAP-6 | UW 2, 4, 6 |

No orphan surface, no unrendered capability. Two boundary cases are handled explicitly and correctly:
`ux-surfaces.md` documents UX 5 (workspace) while LR's non-goals exclude that module — stating *"only the
loom-birth seam is in scope for this spec; the surface is documented here because the seam lives inside
it"*; and OW's `ui-contract.md` records a deliberate **v1 deviation** from its own mockup (the gap card's
*"was on your calendar"* framing is out of scope with no external calendar in v1), which OW story 10 then
repeats verbatim as dev guidance. That is traceability working as designed.

### UX ↔ Architecture Alignment

**AD-12 (frozen `Conversation` shell) is the load-bearing join, and it holds.** The shell's four slots
(transcript via item-kind registry · composer · right rail · header) match `conversation-component.md`
layer 2 exactly, and AD-12's *"one slot, many rails — subagent rail, Desk, chat-history rail and evidence
rail are the same slot"* is a direct lift of the UX plan. The architecture also **strengthens** the UX
document rather than merely restating it: AD-12 adds a purity rule the UX plan did not state — *"a
registered kind's renderer is a pure function of `(item payload, shell-provided view state)` and reads
nothing from ambient context — so any transcript can render any kind."* That is what makes `TranscriptView`
able to render everything, and it is a genuine architectural contribution.

The remaining alignment issues are below.

### Alignment Issues

| ID | Severity | Finding |
| --- | --- | --- |
| **UX-1** | ⚠️ **HIGH** | **`GateGraph` — a shared, precisely-specified component with no architectural home and no owning story.** `ux-surfaces.md` specifies it as `GateGraph(nodes, edges, gateState)`, *"the gate room's kit, **generalized and reused** as the frozen Prepare receipt in the cockpit"*, and pins **six exacting render rules**: grab-to-pan viewport (explicitly *not* a scroll container) · scroll-wheel zoom anchored at the cursor · rounded 90°-elbow SVG edges · node sub-text that **never truncates**, with the selected node expanding downward only into the row gap, never overlapping a neighbour, while others dim to 65% · glide-to-node measuring after a **double `requestAnimationFrame`** with an eased cubic-bezier to kill flicker · a "sealed" state rendering the same map as a frozen receipt. **The spine never mentions it** — the capability map routes LR CAP-5 to *"looms module + `ApprovalCard` item kind"*, which does not include a graph renderer. **No story owns it:** LR story 10 builds the gate room and LR story 22 reuses the sealed DAG as a receipt; neither declares the shared component or names an owner. This is the most bespoke rendering work in the initiative (custom viewport, custom edge routing, custom layout-and-glide) and it is the one component nobody has been assigned. |
| **UX-2** | ⚠️ **HIGH** | **`ApprovalCard` is classified three different ways across three binding documents.** `conversation-component.md` (adopted companion) lists it as a **layer-1 primitive** alongside `Marker`. `ARCHITECTURE-SPINE.md:349` lists it as an **item kind** — *"looms module + `ApprovalCard` item kind"* — governed by **AD-13, which requires registered kinds to carry their owning module** (`ultra:run-anchor`, `loom:gate-card`, `workspace:receipt`). Both SPECs require it to be **one shared cross-module component**: LR — *"One component, one protocol shape, every approval-gated advance"*; OW constraint — *"rendered as the shared `ApprovalCard`"* for `weave_batch` and lane splits. These cannot all be true. As a namespaced item kind it must be either `loom:approval-card` or `workspace:approval-card` — and whichever module owns it, the other registers a foreign-namespaced kind, breaking AD-13 and AD-5's ownership rule; register one each and "one component, one protocol shape" is dead. **LR story 3 resolves it correctly by building it as a primitive** (*"add the Marker and ApprovalCard primitives"*) — primitives are not namespaced kinds — but nothing reconciles that against the spine, and the spine is the document a Track F or Track E builder consults. |
| **UX-3** | ⚠️ **HIGH** | **The spine assigns the Home dashboard to a chat-shell owner adapter.** `ARCHITECTURE-SPINE.md:354` maps *"LR CAP-23 fleet triage · CAP-24 cockpit"* to the **`LoomSessionView` owner adapter** under **AD-12/AD-13/AD-14**. But UX 1 is explicitly *"a **graft onto the existing production dashboard**, not a replacement: same KPI hero, two-column command deck, rails and panel grammar"* — it has no transcript and no composer, so AD-12's four slots do not describe it at all. LR story 23's own guidance sides with the UX doc, not the spine (*"A graft, not a replacement: same KPI hero, two-column deck, rails and panel grammar"*). **The architecture is the outlier here.** The same line bundles CAP-24 (cockpit), which is a tabbed page holding a component kit (`ActTab`, `Room`, `ConductorCard`, `ThreadGroup`, `ContractGroups`, `LabRoom`) and only *contains* conversations at the thread-drill drawer — so `LoomSessionView` is doing double duty as both "the cockpit" and "a Conversation adapter" without either being defined. |
| **UX-4** | 🔶 MEDIUM | **`admissionSnapshot()` is justified by a UI need that no UX document plans and no story renders.** `admission.md` makes the observability read *"part of the contract and exported from `@telar/core`, **so a surface can show *why* a fan-out is queued instead of the user guessing**"*, and AD-17 binds LR CAP-23 (fleet triage). But UX 1's Home contract contains no admission, queue-depth, or concurrency element — its parts are Needs-you (delivery shelf + parked questions), Running-now rows (act chip, evidence age), and the right column (recent sessions, done-today receipt, hot projects, landing-queue strip). LR CAP-23's success clause likewise never mentions it. So the contract mandates an export whose stated consumer does not exist in any surface spec or story. Either the surface element is missing from UX, or the justification is over-claimed. |
| **UX-5** | 🔶 MEDIUM | **~119KB of live production UI has no stated disposition.** LR's `brownfield.md` records *"`components/looms/god-view.tsx` (~70KB) and `godview.ts` (~49KB) are today's loom detail"*, replaced in effect by the CAP-24 cockpit. **Story 22 never mentions them.** Only story 17 states a replacement anywhere in the corpus (*"This replaces `acceptance-panel.tsx`"*). Whether god-view is deleted, kept in parallel behind a flag, or migrated is undecided — and it is the largest single piece of production UI the redesign displaces. |
| **UX-6** | 🔶 MEDIUM | **The demo-gallery → production migration is storied exactly once.** `conversation-component.md`'s migration order (consolidate primitives → carve the shell → prove in the gallery → new surfaces born on it) is faithfully carried into LR story 3, which is excellent. But stories 10, 17, 22 and 23 each cite a demo-gallery entry as *"design source of truth, not production code"* without stating the production-migration step, and the spine's "Deferred" section scopes sequencing detail to the shell story only. Combined with **CV-8** (those same four stories carry no `spec_checkpoint` and no `done_checkpoint`), the entire loom UI arc — gate room, delivery card, cockpit, home — is planned as "prototype exists, production is the old shape" with neither a migration mechanic nor a verification gate. |
| **UX-7** | 🔵 LOW | **`VerdictBar`'s second consumer does not know about it.** LR CAP-17 and `ux-surfaces.md` both specify *"one verdict per delivery, **shared between shelf row and open card**"* — and the shelf row lives on **Home** (CAP-23 → story 23), not on the delivery card. LR story 17 declares the sharing; **story 23 never mentions `VerdictBar`**. Same one-directional dependency pattern as CV-5 and UX-1. |
| **UX-8** | 🔵 LOW | **A no-layout-shift guarantee spans a boundary AD-12 splits.** UW's frozen contract requires the run anchor to be *"fixed-height while running — never grows or reflows"* with *"its sole permitted height change… a one-time collapse"*, plus a rail-internal *"fixed-height scrolling narrator `log()` window (no layout shift, **ever**)"*. AD-12 gives the shell ownership of *"scrolling, auto-follow and streaming affordances"* while the anchor is a kind renderer and the rail is a slot. Nothing contradicts, but the guarantee is asserted across three separately-owned pieces (shell scroll behaviour · `ultra:run-anchor` renderer · rail section) and is verified by none of them individually — the classic shape of a constraint that passes every unit check and fails in integration. |
| **UX-9** | 🔵 LOW | **The tone law has no architectural home.** *"No suggestion-text or doctrine captions anywhere in the UI — surfaces show state and data only"* is a constraint in **both** LR and OW, and `ux-surfaces.md` gives it teeth with a concrete prohibition (*never render "threads land serially, on green"*). The spine's Consistency Conventions table carries the status vocabulary and the quiet-colour law but **not** the tone law. It is a UI-wide rule enforced only by the two SPECs that happen to state it — a fourth surface author reading the spine would not encounter it. |

### Warnings

- ⚠️ **No UX exists for `SPEC-runtime-foundations`, and that is correct** — Track A is a non-UI core package with no user-facing surface. Not a gap. The one exception is UX-4 above, where a core export is justified by an unplanned surface.
- ⚠️ **Architecture does support every planned UX surface** — the shell contract, item-kind registry, namespacing rule, event bus with delivery classes, and the SSE/EventSource conventions all cover the UI's actual needs. The failures found are **assignment and ownership gaps, not capability gaps**: no surface is impossible to build, but three shared components (`GateGraph`, `ApprovalCard`, `VerdictBar`) lack a single unambiguous owner, and one surface (Home) is assigned to the wrong architectural category.
- ⚠️ **The UI arc concentrates the initiative's unverified risk.** UX-6 + CV-8 together mean the four highest-consequence loom surfaces — including the delivery card, where the human-accept moat is actually exercised — have no migration plan and no checkpoint. Everything else in this initiative is gated; the UI is not.

**UX verdict: alignment is strong on contract and weak on ownership.** Proceeding to epic quality review.

---

## Step 5: Epic Quality Review

Validated against `create-epics-and-stories` standards: user value, epic independence, forward dependencies,
story sizing, acceptance criteria, entity-creation timing, and brownfield integration.

**Structural note:** epics here are the six **tracks** in `WORK-SPLIT.md` (A–F, F split into F0–F5), and
acceptance criteria live in the SPEC `success:` clauses that stories reference by CAP number rather than in
the stories themselves. Both are deliberate model choices, assessed on their merits below rather than
scored against a format they never claimed to follow.

### 🔴 Critical Violations

#### EQ-1 — Duplicate ownership of the lease primitive: two stories, two specs, one deliverable

**Two stories instruct a developer to build the same thing**, and it is the one primitive whose duplication
the architecture explicitly exists to prevent.

> **RF story 5** — *"CAP-5: **generalize `runner/lease.ts`** to serve both loom-owned and session-owned services. **Create `TELAR_HOME/sessions/<sessionId>/`** owned by the session module for session-scoped runtime state."*
> `invoke_dev_with`: *"**Two implementations of stale-reclaim is the outcome this story exists to prevent.**"*

> **LR story 1** — *"CAP-11: agents declare services and never spawn them… Unbundles `run-server.ts`/`supervisor.ts` from the verify-only path and **generalizes `runner/lease.ts`**."*
> `invoke_dev_with`: *"**There is no per-chat-session directory under `TELAR_HOME` yet — close that gap here**, since sessions and looms share this primitive."*

Both generalize `runner/lease.ts`. Both create the session tree. **LR story 1 is the second implementation
that RF story 5 says it exists to prevent.**

- **AD-16's stated purpose:** *"Prevents: two stale-reclaim implementations drifting — **the path by which a false `done` gets issued**."* A false `done` is a breach of the human-accept moat (AD-1), the project's highest invariant.
- **WORK-SPLIT assigns it unambiguously to Track A:** unit **A5** — *"lease primitive generalized; `sessions/<id>/` tree created"* — and Track A's owned column includes `lease`. Track F owns `looms/` and loom core modules. LR story 1 is Track F work reaching into Track A's write set, which WORK-SPLIT's own rule forbids: *"Nobody gets write access to another track's owned column."*
- **Both files were last written in the same 22:39 pass**, so this is not staleness — it survived the pass that created `SPEC-runtime-foundations`.

**Remediation:** LR story 1 should **consume** the A5 primitive, not build it. Strike *"generalizes `runner/lease.ts`"* and the *"close that gap here"* sentence; replace with an explicit dependency on RF story 5, and scope LR story 1 to what is genuinely Track F's: unbundling `run-server.ts`/`supervisor.ts` from the verify-only path and building the agent-facing `ensure_service` tool surface.

#### EQ-2 — Three of six epics are technical milestones with no user value, and they hold the critical path

| Track | Delivers | User value alone |
| --- | --- | --- |
| **A — Runtime foundations** | *"core ports · no UI"*; WORK-SPLIT: *"No UI, no feature behaviour"* | ❌ none |
| **B — Session profiles** | the chat route + profile resolver | ❌ none |
| **C — Conversation shell** | *"components only"*; LR story 3: *"No new surfaces here"*, explicitly no behaviour change | ❌ none |
| D — Ultra finish | run/watch/wake workflows | ✓ |
| E — Workspace | briefing, queue, packets | ✓ |
| F — Loom redesign | the whole loom product | ✓ |

By the letter of the standard these are the textbook violations — *"Infrastructure Setup"*, *"API
Development"*, *"Create Models"*. **The justification is real and I do not recommend restructuring them:**
this is brownfield work with three concurrent consumers, and the architecture argues the case explicitly —
AD-12 *"Prevents: a three-way merge conflict on `session-view.tsx`"*, AD-14 *"Prevents: UW's 'unprompted
assistant turn' and OW's 'never initiates contact' being resolved differently by each builder."* Vertical
slicing here would rebuild the substrate three times, differently, which is the failure the whole spine
exists to stop.

**The residual risk is what must be named, and it is not named anywhere:**

- **Phase 1 of 4 delivers nothing a user can see.** Its gate — *"A3 + A5 merged; shell contract proven in demo gallery"* — is entirely internal. First user-visible delivery is **phase 2**.
- **RF's prove-run (story 7) is a technical gate**, not a demonstration: suite green, typechecks clean, `TELAR_HOME` isolation asserted. Correct for the track, but it means the initiative's first three tracks can all pass their gates with zero evidence that any *user-facing* thing works.
- **The mitigation is already designed but is undermined by CV-1.** WORK-SPLIT reasons: *"D (ultra) is deliberately in phase 2 and small — it is the cheapest way to prove the event bus, the shell contract, **the profile resolver** and the usage ledger all work together before F's 24 capabilities depend on them."* Ultra is the designated integration proof for four substrate pieces — **and one of those four, the profile resolver, has no story (CV-1).** The plan's own risk mitigation depends on a component nobody is assigned to build.

**Remediation:** keep the track structure; fix CV-1 so the phase-2 integration proof is real; and state in the phase table that phases 1 and 2 carry no user-facing delivery, so a stall there is understood as such.

### 🟠 Major Issues

#### EQ-3 — Two acceptance-blocking constants are undefined everywhere

Both are load-bearing decision rules that a story cannot be verified without, and neither has a value in any
of the 21 planning documents:

| Constant | Where it is invoked | Defined |
| --- | --- | --- |
| **Flatline `N` minutes** | LR CAP-15 success clause: *"A flatline for **N minutes** escalates as dire"* · `verification.md`: *"Flatline for **N minutes** is dire even when every process is green"* · LR story 15 | ❌ **never** — the literal letter `N` is the specification |
| **The simple-task boundary** | LR CAP-1 success · LR constraint *"ONE design at any size"* · `lifecycle.md` (*"the dial's floor"*) · `ux-surfaces.md` UX 0 · LR story 11 — **6 invocations** | ❌ **never** — no threshold, no heuristic, no "the agent judges" ruling |

The simple-task boundary is the most-invoked decision in the birth flow — it decides whether a loom exists
at all — and the spec says only what happens *below* it, never where it sits. Left undefined, every builder
and every agent picks their own, and the "ONE design at any size" constraint has no floor.

**Remediation:** give `N` a default (and a rationale for it) in `verification.md`; rule on the simple-task
boundary in LR CAP-1 — either a stated heuristic or an explicit "this is the birth agent's judgment, and
here is what it weighs." Either answer is fine; the absence is not.

#### EQ-4 — Extreme story-size variance; several stories are epics

| Story | Contains | Assessment |
| --- | --- | --- |
| **LR 2** | CAP-22 + CAP-7 + storage half of CAP-3 — a storage adapter with **two backends**, the proposal ledger, per-region markdown, **and** a methodology-as-data system with `customize.toml` override semantics | **3 capabilities. This is F0, an epic.** |
| **LR 1** | CAP-11 + unbundling `run-server.ts`/`supervisor.ts` + lease generalization (see EQ-1) + session tree + an agent-facing tool surface on a typed event shape | **Epic-sized** |
| **LR 7** | CAP-13 — both verification altitudes, the per-repo mutex, and heartbeat integration | Epic-sized |
| **LR 16** | CAP-16 — one subsystem serving three consumers, ledger + provenance + citation enforcement + attempt history + lab grades + reality manifest | Epic-sized |
| **LR 22** | CAP-24 — the entire cockpit: act tabs, conductor card, thread groups, thread drill, streaming transcript drawer, WINDOW/LAB/CHATS header trio | **The largest surface in the system, one story** |
| *versus* | | |
| LR 19 | CAP-19 boomerang | Right-sized |
| OW 13 | Codex MCP injection | Right-sized |

WORK-SPLIT correctly recognises the problem one level up — *"24 capabilities is too big for one epic"* — and
splits F into F0–F5. **That reasoning was never applied a level down.** LR story 2 alone carries as much
scope as the whole of `SPEC-ultra-workflows`.

#### EQ-5 — A capability split across two specs, where neither story proves it

FR-LR-1 requires: *"an edit posts to that loom's always-open steering channel **and** the entry marks that
it was sent."* That behaviour is split cleanly — and completely — in two:

- **LR story 11:** *"The steering-channel endpoint is this story's deliverable; the workspace queue renders the sent mark (workspace story 5) — no queue UI is built here."*
- **OW story 5:** *"Tracking-row edits are **rendering-only** in this story… the steering-channel endpoint an edit posts to belongs to the loom spec (its story 11)."*

The split is stated in both directions, which is exemplary. But **no story owns the integrated behaviour**:
OW 5 can complete with a mark that posts nowhere, LR 11 can complete with an endpoint nothing calls, both
tick their boxes, and the capability does not work. No prove-run covers it either — LR story 24's scenario
is the single-loom happy path, and OW has no prove-run at all (CV-3).

#### EQ-6 — Acceptance criteria exist by reference, and six stories have no referent

No story uses Given/When/Then. Acceptance lives in the SPEC `success:` clauses — a coherent choice, since
the SPEC declares itself *"the complete, preservation-validated contract for what to build, test, and
validate."* Where a story names a CAP, its ACs are precise and often excellent (`5 in → 4 filed, 1
question`; *"zero started and zero completed"*; *"a single-lane flow renders exactly one group"*).

The gaps:

- **Six stories reference no CAP** and therefore inherit no acceptance criteria: LR 3 (Conversation shell), OW 1 (item store), OW 13 (Codex MCP), and the three prove-runs. Most compensate by pointing at a companion doc; **RF story 7 does not — it cites *"The SPEC success signal"* for a SPEC that has none (RA-1)**, then states its criteria inline. Self-contained in practice, mis-attributed on paper.
- **Only one capability in 49 has an enumerated acceptance list** — FR-RF-4, via `admission.md`'s 11 assertions. That document is the quality bar the other 48 are measured against and mostly do not reach.
- **A cluster of success criteria are unfalsifiable:** *"skimmable across 7+ looms"*, *"a human judges in seconds"*, *"reads the delivery card in under a minute"*, *"the digest is bounded by what the user can absorb."* These are honest statements of design intent but cannot gate a story.

#### EQ-7 — Brownfield migration gap: nothing drains the legacy loom tree

**AD-5:** *"The legacy flat `~/.telar/looms/<id>/` tree is **read-only until drained**."* `map-and-storage.md`
repeats it: *"stays read-only for pre-redesign looms **until drained**."* The state-root diagram marks it
`# LEGACY — read-only until drained`.

**No story drains it.** The word does not appear in any of the 51 stories in this sense. So every
pre-redesign loom on disk becomes permanently unreachable state with no migration, no drain, and no
disposition — alongside the same problem for `god-view.tsx` (UX-5). For an initiative whose brownfield
analysis is otherwise this strong, the *exits* from the old world are the one thing not planned.

### 🟡 Minor Concerns

- **EQ-8 — OW story 1 creates the whole store upfront** (*"lanes, packets, and the shapes everything inherits… Schemas and CRUD only"*), which the standard flags as an anti-pattern. **Justified deviation:** `item-model.md`'s core design is *"one shape for all items… no migration when an item grows, and no second code path for rich items"*, and the store is two file types. It also carries both a `spec_checkpoint` and a `done_checkpoint`. Not a defect.
- **EQ-9 — Undeclared (but correctly ordered) backward dependencies.** No forward dependency was found anywhere — see below — but several real dependencies are declared in only one direction: LR 16 → 17 (the card renders the evidence subsystem), LR 17 → 23 (`VerdictBar`, UX-7), LR 10 → 22 (`GateGraph`, UX-1), OW 8 → 10 (commitment mining feeds gap detection — declared in 8, absent from 10), OW 7 → 9 (filed items land on the Desk).
- **EQ-10 — Story ids are not globally unique.** Four files each numbering from `1` means *"story 5"* is ambiguous across four specs, while stories already cross-reference by bare number. LR's header defers epic numbering to a pass that has not run, and says *"across all **three** specs"* — written before RF existed (CV-9, CV-10).

### Best-Practices Compliance Summary

| Check | Result |
| --- | --- |
| Epic delivers user value | ⚠️ **3 of 6 fail** (A, B, C) — deliberate and justified; risk unstated (EQ-2) |
| Epic can function independently | ✅ **Pass** — A/B/C disjoint and unblocked; D←(A,C); E←(A,B,C); F←(A,B,C); F0→F1,F2→F3→F4/F5. No cycles |
| **No forward dependencies** | ✅ **Pass** — every dependency found runs backward. Verified across all 51 stories |
| Stories appropriately sized | ❌ **Fail** — 5 epic-sized stories (EQ-4) |
| Entity creation when needed | ⚠️ One upfront store, justified (EQ-8) |
| Clear acceptance criteria | ⚠️ By reference; 6 stories without a referent, 1 broken referent, 2 undefined constants (EQ-3, EQ-6) |
| Traceability to FRs | ✅ **Pass** — 49/49, 100% (Step 3) |
| Brownfield integration points | ✅ **Strong** — four `brownfield.md` files, verified against the working tree, with file-level seeds |
| Brownfield migration/exit | ❌ **Fail** — legacy loom tree undrained (EQ-7); `god-view.tsx` undisposed (UX-5) |
| Single ownership per deliverable | ❌ **Fail** — lease primitive built twice (EQ-1) |

### What this story set does better than most

Stated because the remediation must not damage it:

- **`invoke_dev_with` is the strongest artefact in the corpus.** 43 of 51 stories carry one, and they encode *why*, not *what*: RF story 3 warns off re-deriving a design that was built and rejected, naming the test it would break; LR story 3 warns that the extraction's danger **is** the story; OW story 10 rules a mockup detail out of scope before a dev can build it. This is the difference between a task list and a briefing.
- **Zero forward dependencies across 51 stories in 4 files with no global numbering.** That is a genuinely hard property to hold and it holds.
- **Ordering hazards are stated where they bite, with consequences attached** — RF 1 before RF 2 (*"would write dev spend into production state"*), A1→A2 and A3→D/E/F in WORK-SPLIT's serialization list, F0 before the rest of F.
- **The LR 11 ↔ OW 5 split is declared in both directions.** EQ-5 faults it for having no integration owner, not for the split itself — the boundary work is exactly right and is the model the CV-5 and UX-1 gaps should be fixed to.

**Quality verdict: dependency structure is sound, sizing and acceptance are not, and one load-bearing
primitive has two owners.** Proceeding to final assessment.

---

## Summary and Recommendations

### Overall Readiness Status

# ⚠️ NEEDS WORK

**Not** *not ready*. That distinction is the headline. This is one of the more rigorous planning corpora I
have assessed — 49 capabilities at 100% story coverage, zero forward dependencies across 51 stories in four
independently-numbered files, four `brownfield.md` companions verified against the working tree at
file-and-line level, and assumptions labelled as inferences where they are inferences. Nothing here needs
re-deriving.

What it needs is a **focused editing pass, not a replan.** Every critical finding below is precisely
located, and the largest is a missing story file. The estimate is hours of work on the planning artifacts,
not a return to the spec phase.

**38 findings across 4 categories:** 4 critical · 12 high/major · 11 medium · 11 low/minor.

### The root cause behind a third of the findings

Five findings (RA-2, RA-3, CV-4, CV-9, and the survival of EQ-1) share one origin. The **2026-07-24 22:39
pass** that extracted `SPEC-runtime-foundations` out of the architecture updated its own package, `LR
stories.yaml`, `UW stories.yaml` and the architecture folder — but did **not** sweep the sibling documents
it invalidated. So:

- `SPEC-ultra-workflows/SPEC.md` (11:23) still describes a world with no runtime-foundations — hence undeclared dependencies (RA-2) and a stale "engine gate (4)" brake (RA-3).
- `spec-organization-workspace/stories.yaml` (14:06) was untouched, so its story 13 still reads *"optional for v1"* on work the new track model puts on the critical path (CV-4).
- Even inside the pass, `WORK-SPLIT.md`'s Track A section was rewritten while its title still reads *"how **43** capabilities divide"* (CV-9), and `LR stories.yaml` was edited without resolving the lease collision it now had with RF story 5 (EQ-1).

**Fixing the root cause is a single reconciliation sweep**, and it clears more findings than fixing the
symptoms one at a time.

### Critical Issues Requiring Immediate Action

#### 1. 🔴 Track B has no stories, and the one story near it specifies the anti-pattern *(CV-1, CV-2)*

The word `profile` appears in **zero of 51 stories**. `Track B` appears once in the entire corpus — inside
WORK-SPLIT's own diagram. Yet Track B is a day-one critical-path track that blocks E and F, owns the chat
route, and implements **AD-9**'s typed `SessionProfile` — the seam that lets D, E and F extend the route
*without editing it*. Unbuilt, three tracks branch inside one 103KB handler and the disjoint-write-set
guarantee collapses.

Worse, the one story in that territory contradicts AD-9 directly. OW story 6: *"**Lift the chat route's
project gate**."* AD-9: *"A new surface adds a profile; **it does not add an `if`**… not a special case in
the handler."* This also puts **AD-10** at risk — *"the moat sits outside the profile"*, whose stated
rationale is that *"a moat enforced in three places has three chances to be forgotten."*

**Compounding:** WORK-SPLIT's own risk mitigation names the profile resolver as one of four things phase-2
Ultra exists to prove. The mitigation depends on the component nobody was assigned.

#### 2. 🔴 The lease primitive is built twice, in two specs *(EQ-1)*

RF story 5 — *"generalize `runner/lease.ts`… create `TELAR_HOME/sessions/<sessionId>/`"*, closing with
*"**two implementations of stale-reclaim is the outcome this story exists to prevent.**"*
LR story 1 — *"generalizes `runner/lease.ts`… there is no per-chat-session directory under `TELAR_HOME` yet
— **close that gap here**."*

LR story 1 is the second implementation. **AD-16 exists to prevent exactly this**: *"two stale-reclaim
implementations drifting — the path by which a false `done` gets issued."* A false `done` is a breach of the
human-accept moat. WORK-SPLIT assigns this to Track A unit A5 and forbids cross-track writes.

#### 3. 🔴 Three of six epics deliver no user value, and hold the critical path *(EQ-2)*

Tracks A, B and C are technical milestones by the letter of the standard. **I do not recommend
restructuring them** — the architecture argues the case and vertical slicing would rebuild the substrate
three times. But the residual risk is nowhere stated: **phases 1 and 2 of 4 carry no user-facing delivery**,
and phase 1's gate is entirely internal.

#### 4. ⚠️ Two acceptance-blocking constants are undefined everywhere *(EQ-3)*

The flatline threshold is specified as the **literal letter `N`** in both `SPEC.md` and `verification.md`.
**The simple-task boundary** — invoked six times, and the rule that decides whether a loom exists at all —
is defined in no document. Both gate stories that cannot otherwise be verified.

### Recommended Next Steps

Ordered by leverage. Steps 1–4 are what stand between this corpus and green.

1. **Story Track B, and rewrite OW story 6 as a profile.** Create `specs/spec-runtime-foundations/` coverage (or a Track B story set) for the `SessionProfile` resolver: the typed shape from AD-9, the intersect-only `toolPolicy` and out-of-profile guardrail from AD-10, and `requiredCapabilities` fail-closed from AD-11. Then rewrite OW story 6 from *"lift the project gate"* to *"register the master profile"*. **Highest-value fix in the report** — it protects three ADs, restores the parallel track model, and makes the phase-2 integration proof real. *(CV-1, CV-2, CV-6, UX and EQ-2 knock-ons)*
2. **De-duplicate the lease.** Strike *"generalizes `runner/lease.ts`"* and the *"close that gap here"* sentence from LR story 1; add an explicit dependency on RF story 5; rescope LR story 1 to unbundling `run-server.ts`/`supervisor.ts` and building the `ensure_service` tool surface. *(EQ-1)*
3. **Run the reconciliation sweep the 22:39 pass skipped.** Add RF dependency declarations to UW stories 1 and 5 and to `SPEC-ultra-workflows`; fix the *"engine gate (4)"* brake to name the configurable ceiling; reconcile OW story 13's *"optional for v1"* against Track B; correct WORK-SPLIT's `43` → `49` and LR's *"three specs"* → four. *(RA-2, RA-3, CV-4, CV-5, CV-9)*
4. **Rule on the two undefined constants** — give `N` a default with rationale in `verification.md`; define the simple-task boundary in LR CAP-1, or state explicitly that it is the birth agent's judgment and name what it weighs. *(EQ-3)*
5. **Add an OW prove-run story** gating on the success signal the SPEC already states — the morning sit-down, `5 in → 4 filed, 1 question`, packet-to-loom handoff, zero notifications. It is the only spec without one and the only one whose back half (stories 4–13) carries no checkpoint at all. *(CV-3, CV-7)*
6. **Assign the three orphaned shared components an owner.** `GateGraph` (shared by LR 10 and LR 22, specified with six render rules, absent from the spine); `ApprovalCard` (classified as a primitive, an item kind, and a cross-module shared component in three binding documents — LR story 3's "primitive" reading is the correct one, so amend the spine); `VerdictBar` (declared in LR 17, unmentioned in LR 23). *(UX-1, UX-2, UX-7)*
7. **Give `SPEC-runtime-foundations` a Success signal, Constraints, Non-goals and Assumptions section** — it is the only SPEC missing all four, so Track A has no stated definition of done. RF story 7 already invents one; promote it into the contract and fix its dangling *"The SPEC success signal"* citation. *(RA-1, EQ-6)*
8. **Split the five epic-sized stories** — LR 2 (three capabilities), LR 1, LR 7, LR 16, LR 22. WORK-SPLIT already applied this reasoning one level up (*"24 capabilities is too big for one epic"*); apply it one level down. *(EQ-4)*
9. **Plan the exits from the old world.** Nothing drains the legacy `~/.telar/looms/<id>/` tree that AD-5 marks read-only-until-drained, and ~119KB of live `god-view.tsx` / `godview.ts` has no stated disposition. *(EQ-7, UX-5)*
10. **Close the smaller gaps:** reassign LR CAP-23 (Home) off the `LoomSessionView` chat adapter in the spine (UX-3); add an integration owner for the LR 11 ↔ OW 5 steering channel (EQ-5); add `spec_checkpoint`s to LR 17/19/22/23 (CV-8); either plan an `admissionSnapshot()` surface or drop its UI justification (UX-4); fix `lifecycle.md`'s dangling *"see the kernel's open questions"* (RA-4).

### Final Note

This assessment identified **38 issues across 4 categories** — requirements completeness, story coverage,
UX alignment, and epic quality. Four are critical.

The pattern worth carrying forward: **this corpus fails where it hands off, not where it thinks.** Every
finding above sits at a boundary — between two specs (EQ-1, CV-5, EQ-5), between architecture and stories
(CV-1, UX-1, UX-2), or between an editing pass and the documents it invalidated (the 22:39 sweep). The
thinking inside each document is consistently strong; `admission.md` in particular — a contract that
records a design that was **built, tested, and then rejected on evidence**, preserving the rejected
implementation as reference while naming itself the authority — is the best single planning artifact here
and the bar the rest should be held to.

The two places that already do handoffs correctly show the fix. The **LR 11 ↔ OW 5** steering-channel split
is declared in both directions, and the **`Conversation` shell prerequisite** is declared in three places
and fails loudly (*"if the shell is not there yet, **STOP and say so**"*). Apply that same discipline to
Track B and to the lease primitive and the critical findings close.

Address items 1–4 before implementation begins. Items 5–10 can proceed in parallel with phase 1, since none
of them blocks Tracks A or C. Alternatively you may proceed as-is with these findings as a known-risk
register — but items 1 and 2 will be discovered as *architectural damage* after code lands rather than as
schedule slip, which is the expensive way to find them.

---

**Assessment date:** 2026-07-24
**Assessor:** Product Manager review (requirements traceability & planning gap analysis)
**Documents assessed:** 4 SPEC kernels · 17 companions · 4 story files · 6 architecture documents · `project-context.md`
**Baseline established:** 49 functional requirements · 73 constraints · 51 stories · 6 tracks
**Method:** full read of every planning artifact; FR→story→track traceability; three-way SPEC↔UX↔architecture cross-validation; `create-epics-and-stories` best-practice enforcement
