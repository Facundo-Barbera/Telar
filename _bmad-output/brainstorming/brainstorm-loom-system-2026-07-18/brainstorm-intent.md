# Loom Redesign — Intent

> Source: brainstorming session 2026-07-18 (`.memlog.md` in this folder is the canonical log).
> Purpose: lean input for `bmad-spec` / `bmad-prd` / `bmad-architecture`. Inspiration anchors: Claude Code ultracode workflows, Codex Ultras, bmad-loop. Telar's own ultras are a separate workstream.

## Axiom & job

- **Axiom: get it done.** A loom carries intent all the way to proven-working delivery. (Flipping this axiom = the loom shouldn't exist.)
- Job statement: *"When I know what I want built, I hire a loom to carry it from intent to proven-working feature — judgment, not steering."*
- Success measure: **the human stays in the planner seat** — planning the next batch while fleets deliver; only judgment interrupts.
- The loom's true deliverable is **evidence**; code is the side effect.
- Boundary: simple/quick tasks never get looms (chat / ultra / by-hand instead). Ceremony is adaptive.
- A loom may carry **multiple tasks** (batch). Its unit is sized by its accept moment, not by intent count. Guard against agents assuming "loom = one task."

## Core redesign — the loom as a three-act system

### Act 1 — Prepare (new: preparation graph + living map)

- Problem definition comes from the **user**, before execution. Today a single agent drafts charter+spec and infers too much — the diagnosed root failure is **preparation**, not just design.
- **Living map**: an adaptive model of the project (candidate regions: objective, architecture, form/UX, surfaces, verification norms — taxonomy is open research). Documentation **adapts, never accumulates** (anti-rot; the bmad epic-sediment problem).
- **Preparation graph** (left-to-right DAG; see `preparation-graph.html`):
  - Opens with a "what are we doing" conversation (user + intake agent).
  - Intake **diffs intent against the map**; planning nodes spawn **only where drift exists**; fresh artifacts are skipped (progress preservation).
  - Grows in layers (parallel nodes, e.g. context gathering / PRD delta / UX-feel); shape is agent-chosen, never hard-coded; user can steer at any time.
  - Nodes are staffed by **specialist seats** (bmad-like agents), forming a growable registry; possibly exposed via MCP.
  - **Verification-readiness node**: proves the lab works before build (dev-server standup, probe). Emits a per-project **verification recipe** stored in the map. Fail-closed: *no lab, no experiment.*
- **Readiness gate** (entrance moat): user chooses **Accept / Modify (on the go) / Deny → straight to development**.

### Act 2 — Execute (orchestrator + threads)

- After the gate, the orchestrator takes **sole responsibility**: `created → proven → delivered`. Deterministic-guided, fully AI-driven.
- **Role wall: conductors never code.** Orchestrators and sub-orchestrators never touch code and get their own role in the UI.
- A thread = a **team behind a feature**. Its main agent **compiles its flow**: authors a DAG artifact (parallel lanes; dependency edges — "before this you need this"; per-node **context manifest** so no agent is context-bombed or starved), schema-validated, then executed deterministically. Re-planning is an explicit, bounded, audited recompile event. Current pre-written steps survive as the fallback template for simple / low-confidence tasks.
- **Parallelism is a planning output**: interference analysis (shared files/surfaces) shapes decomposition width. Fleet level: lanes + a **landing queue** (build isolated, land serially through rebase-and-reverify).
- **Pause/resume is required**: durable execution state; park on usage/credit exhaustion or user pause; resume later — potentially under a different account/provider (multi-account auth already exists).

### Act 3 — Judge (accept experience)

- Accept surface = an **inbox of delivery cards**: claim, proof (Playwright walkthroughs, screenshots), synthesized narrative of what happened and what was implemented, risk flags — skimmable at fleet scale (7+ concurrent looms is the norm).
- **Windows, not doorbells**: observability is always-on and pull-based (user *choice*); push escalation reserved for dire situations only (bmad-loop CRITICAL shape). Audit every current escalation point: *dire, or just uncomfortable?*
- Streaming evidence enables **early kill** mid-run at a fraction of cost.
- The **human-accept moat is unchanged** — the accept moment is where *vision* enters the system (verifiers check contracts; the human checks the why). Future: advisory **vision critic** judging deliveries against the map's objective/form regions; any autonomy dial is per loom class and never a silent bypass.

## Structural walls (the constitution)

1. Verifiers can't write.
2. Conductors can't code.
3. Agents can't accept.
4. **Nobody writes the map silently** — map updates only via: **(A)** drift ledger declared on accept + **(C)** lazy intake diff always on; **(B)** threshold-triggered reconciliation loom as escalation. Never automatic write-back.

## MoSCoW (locked)

| | Items |
|---|---|
| **Must** | Preparation graph MVP (conversation → drift-diff → gate) · Map v1 with minimal regions + lazy diff (C) · Verification-readiness node + recipe · Role-wall carving (conductors never code) · Escalation audit (dire vs uncomfortable) · **Pause/resume (durable execution state)** |
| **Should** | Flow compile (thread-authored DAG, deterministic run) · Delivery-card inbox redesign · Drift ledger (A) · Specialist-seat registry (fixed seats first) |
| **Could** | Vision critic seat · Fleet lanes + landing queue · Streaming-evidence early-kill UI · Adaptive ceremony templates |
| **Won't (this time)** | Graduated-autonomy dial · Verification-system deep design (own session) · UI/UX rebuild (own session) · Final map-region taxonomy (research first) |

## Open questions & queued work (in order)

> **Reconciled 2026-07-24** against `_bmad-output/specs/spec-loom-redesign/`, which is now the contract. All four queued items below are closed.

1. **Verification system** — brainstorm session (`next-session-verification.md`). Runs FIRST: its outcomes change the spec.
   - **Done** — ran 2026-07-18 → 07-22. Also spawned a fourth session on artifact storage (2026-07-24) that this plan did not anticipate.
2. **UI/UX rebuild** — brainstorm session (`next-session-ui-ux.md`). Runs SECOND: needs the loom spine + verification model as input.
   - **Done** — ran 2026-07-23; six surfaces prototyped in the demo gallery.
3. **Spec** — `bmad-spec` over this intent doc + both session outcomes. Deliberately deferred until both sessions complete.
   - **Done** — `_bmad-output/specs/spec-loom-redesign/`: 24 capabilities, six companions, zero open questions, plus a 24-story breakdown.
- *(anytime)* **Map-region taxonomy** — research pass over bmad and other methods: what should a living project model hold, and what does "stale" look like per region?
   - **Moot as posed, and the seat registry generalized with it.** Regions, seats and artifacts are **declared data, not engine code** — a project's loaded methodology declares them, so there is no universal taxonomy to discover. v1 ships one built-in BMAD-derived methodology; a methodology declares the *catalog*, while drift alone decides which nodes run, and it never declares *how* anything is written (wall #4 sits below the methodology layer). The second half of the question — what "stale" means per region — resolved as: drift detection is the intake session's judgment over intent, the map and the actual repo, not a per-region rule table; the readiness gate downstream is what makes that freedom safe. (SPEC CAP-3, CAP-7.)

## MoSCoW status (2026-07-24)

The locked MoSCoW is partly spent. Both "Won't this time" deferrals for the verification deep design and the UI/UX rebuild are **discharged** — those sessions ran, and their outcomes are in the contract. Four "Could" items were **promoted** by the later sessions: fleet lanes + landing queue (verification made serial landing constitutional), streaming-evidence early-kill (park/kill landed in the cockpit header), adaptive ceremony templates (superseded by "ONE design at any size" plus the ceremony dial), and the vision critic (UX 3's final delivery card renders its advisory verdict). Only the graduated-autonomy dial remains a genuine non-goal.
- Implementation note: one fractal pattern runs through all three acts — **declare → validate → execute deterministically → reconcile lazily.** Build it once, apply it everywhere.
