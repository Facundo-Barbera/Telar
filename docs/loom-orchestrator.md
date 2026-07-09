# Telar M7 — The Loom Orchestrator

**Status:** design locked (2026-07-09). Pre-build. Builds on the shipped verified loop (M2), distillation (M3), read-only verify kind (M4), and design-aware QA (M6). Companion visuals: the control-loop diagram and the Loom-detail god-view mockup.

> This spec is written in the **loom vocabulary** (see §2). Today's code says "run"; the rename (M7.0) aligns the code to this spec. Where a current file/type is named, it's the pre-rename name.

---

## 1. Goal & non-goals

**Goal.** Let one **orchestrator** own a unit of work end to end — decompose it, run many pieces at once (at two levels), keep itself oriented over a long horizon, and decide when to loop / escalate / stop — while staying *walk-away-trustworthy*. It takes over the coordinating role a human plays today; it never gains authority over *truth*.

**The invariant that survives every feature here (the moat).** Promotion to `done` requires a passing **independent** VerifierReport on executable evidence — never the builder's, the orchestrator's, a steering agent's, or a chat's say-so. This holds on *every* write surface (the orchestrator's decision tick **and** any human/agent directive).

**Non-goals.** Not a general multi-agent framework. Not a replacement for the verified loop — a single thread *is* today's `executeRun`. Not a distributed scheduler; `~/.telar` is single-machine for v1.

---

## 2. Vocabulary (the naming lock-in)

`telar` is Spanish for **loom**. The metaphor is the model.

| concept | name | today's code |
|---|---|---|
| the app / frame | **Telar** | Telar |
| one unit of work | a **Loom** | a `Run` |
| a parallel lane / subtask of a Loom | a **Thread** | (new; a child Loom) |
| the goal + proof spec for a Loom | the **Charter** | (new; extends `acceptanceCriteria`) |
| the agent that coordinates a Loom | the **orchestrator** (the *weaver*) | (new) |
| promote to done | the cloth comes off the loom | `state → done` |

A Loom is `leaf` (one thread — today's verified loop) or `epic` (a tree of Threads). An epic Loom **never builds** anything itself; it only spawns and folds up child Looms.

---

## 3. Design principles

1. **The Ledger is the truth, not any agent's context.** A Loom's state lives on disk (`loom.json` + `events.ndjson`), never in a transcript. This single decision answers all four axes: scope is an approvable ledger artifact, the orchestrator's context stays fresh because it's re-composed per tick from the ledger, and any agent or human can take over by loading it.
2. **Deterministic control flow in code; intelligence in the leaves.** The orchestrator's *scheduling* is pure/deterministic. Individual judgment calls inside a tick (scope-conformance, decomposition) route to cheap agent calls. "The orchestrator is a pure function" is precise for scheduling, and honestly qualified as **pure scheduler + agent-adjudicated gates** for the judgment parts.
3. **The moat is a code invariant, not a convention.** Independence of the Verifier is enforced by construction (tool restriction + a `validateDecision` invariant), on every write surface.
4. **Least privilege by omission.** Workers get only their tools; the orchestrator holds only the ledger; chats get a narrow, mostly-read toolset. New power is opt-in.
5. **Additive & reversible first.** The fast path (no charter) is byte-identical to today. Fan-out, scoping, and orchestration engage only when a Loom actually needs them.

---

## 4. The Ledger — child-Loom model (the foundational decision)

**A Thread is a first-class child Loom** — its own `~/.telar/looms/<id>/` (`loom.json` + `events.ndjson`), `parentLoomId` + `subGoalId` pointing at the epic. **Not** an embedded `LaneState[]` inside the parent file.

**Why (red-team #1).** Embedding lane state in one `loom.json` creates a two-writer race: a thread's own `executeRun` and the orchestrator's tick both atomically `tmp+rename`-rewrite the same file, with no merge semantics → silent lost updates. That's the *normal* condition once threads run in parallel, not an edge case. Child Looms keep Telar's existing **single-writer-per-file** guarantee intact and reuse every run primitive (`createRun`, `saveRun`, `appendEvent`, the executor loop, the UI) for free. "Lane" is the scheduling lens; "child Loom" is the persistence lens on the same thing.

```ts
// runs.ts (→ looms.ts) — additive fields on the existing Run/Loom
type Loom = Run & {
  parentLoomId?: string;   // set on a thread; points at the epic
  subGoalId?: string;      // which Charter.decomposition node this thread proves
  charter?: Charter;       // the approved scope (root Loom; threads inherit a slice)
  role?: "leaf" | "epic" | "thread";
};
```

---

## 5. Phase 0 — Scoping & the Charter

Scoping runs **before** plan/build: a read-only agent drafts a **Charter** the human can approve or revise.

```ts
const ProofStrategy = z.enum(["quickfix","bmad-story","verifier-criteria","custom"]);
const ScopeBoundary = z.object({
  allowedPaths: z.array(z.string()).default([]),   // globs; enforced against repair diffs
  forbiddenPaths: z.array(z.string()).default([]),
  notes: z.string().optional(),
});
const Budget = z.object({
  maxCostUsd: z.number().optional(),
  maxWallClockHours: z.number().optional(),
  maxParallelThreads: z.number().default(3),
  maxAgents: z.number().default(12),               // the concurrency pool (see §8)
});
const SubGoal = z.object({
  id: z.string(),                                   // "s1"
  title: z.string(),
  detail: z.string(),
  proofStrategy: ProofStrategy,
  acceptanceCriteria: z.array(z.string()).default([]),
  dependsOn: z.array(z.string()).default([]),
  required: z.boolean().default(true),
  status: z.enum(["pending","ready","active","done","blocked","failed"]).default("pending"),
});
const Charter = z.object({
  objective: z.string(),
  proofStrategy: ProofStrategy,
  scope: ScopeBoundary,
  budget: Budget,
  shape: z.enum(["leaf","epic"]),
  decomposition: z.array(SubGoal).default([]),      // epic only
  version: z.number().default(1),
  approvedBy: z.string().optional(),                // "you" | "auto:<policy>"
  scopingSessionId: z.string().optional(),          // the drafting session — resumable for takeover
  rationale: z.string().optional(),                 // structured decomposition reasoning (survives account/machine handoff)
});
```

- **`draftCharter()`** (new `scoping.ts`): an `agent()` pass, `schema: Charter`, `restrictTools: true` with `Read/Grep/Glob` only — scoping never mutates the repo (enforced exactly like the Verifier's read-only guarantee). Inputs: the raw prompt, `ProjectManifest`, the chosen ProofTemplate's guidance, and (for a BMAD adapter) the story/epic markdown.
- **ProofTemplates** (new `proof-templates.ts`): `quickfix` / `bmad-story` / `verifier-criteria` / `custom` become *selectable templates*, not hardcoded `RunKind` branches. `custom` is a loose escape hatch (`proofPlan` prose + `verifyMechanism: gate|verifier|human-signoff`) so a novel path never fights a rigid schema.
- **Epics.** `shape:"epic"` emits `decomposition[]`. `done` composes up the tree as "every `required` SubGoal done" **plus an independent epic-closing-proof thread** (§9).
- **Human approval.** Gated by `manifest.charterPolicy × shape` (default: `human-required-for-epics`, so quickfix stays frictionless). Approval stamps `approvedBy`.
- **Mid-flight revision.** A Charter is versioned; revisions arrive as `edit_charter` **Directives** (§10), never a second write path.

**Fast path (byte-identical to today).** If the caller supplies `acceptanceCriteria` directly (existing API/scripts/tests), scoping is **skipped** and behavior is exactly today's `executeRun` — same discipline as `classify()`'s "skip" path. No planning tax on a one-line quickfix.

---

## 6. The orchestrator control loop

The orchestrator owns `plan → schedule → observe → decide`, looping. It is **re-invoked per decision tick over a curated, bounded view of the ledger** — so its context is fresh by construction and never accumulates.

```ts
// the tick input — small, curated, re-composed every time from the ledger
type LedgerView = {
  charter: Charter;
  threads: { id: string; subGoalId: string; state: WorkUnitState;
             latestVerdict?: string; evidencePointers: string[] }[];  // summaries, not transcripts
  decisionLogTail: Decision[];   // last K ≈ 8 — consistency across ticks
  salientEvents: RunEvent[];     // capped ≈ 30
  budget: BudgetState;           // agents in flight, spend, wall-clock
  pendingDirectives: Directive[];
  playbook: string;              // the decision rules (system-prompt-level)
};
type Decision =
  | { action: "schedule"; subGoalId: string; agents: number }
  | { action: "fanout"; threadId: string; phase: "build"; agents: number }
  | { action: "repair"; threadId: string }
  | { action: "escalate"; threadId?: string; reason: string }
  | { action: "finish-loom" }
  | { action: "hold" };
```

- **Context freshness.** Threads report **compact summaries + evidence pointers** into the ledger, never full transcripts; the orchestrator drills into a report on demand (a tool call), it doesn't hold it. Workers own the deep ephemeral context; the orchestrator owns only the ledger.
- **Consistency across ticks (red-team #2).** A **decision log** (`decisionLogTail`) is part of every view, so tick 200 can't silently contradict tick 5 — prior commitments are always in-context, and `validateDecision` re-checks invariants against the ledger, not memory.
- **`validateDecision(decision, ledger)`** (pure): rejects any decision that violates an invariant — most importantly, `finish-loom` is illegal unless **every `required` SubGoal *and* the epic-closing-proof thread** is `done` with an independent verify.
- **Tick cadence:** event-driven (on a thread's terminal-state change) **plus** a periodic heartbeat (≈5–10 min) so long single-thread stretches still reassess budget/deadline. (Interval is a tuning knob.)

---

## 7. Two-level parallelism & the concurrency budget

Two axes of parallelism, **one shared pool** — this is ultracode applied one level down.

- **Outer:** the Loom weaves up to `budget.maxParallelThreads` threads at once.
- **Inner:** a thread's **Build** (or any decomposable phase) fans out to M agents when the work splits into independent pieces — the same fan-out the Workflow/ultracode engine already does with `parallel()`.

**Adaptive sizing — a number, not a vibe.** Fan-out is sized to the *discovered independent pieces*, clamped by the budget:

```
agents(phase) = clamp(independentPieces, 1, min(maxAgents − inFlight, ⌊budgetLeftUsd / estCostPerAgent⌋))
```

- A simple/atomic task → **1** (you can't parallelize past 1 real piece).
- A cleanly-splitting task → up to the cap. Never 20 for a simple task; never a single bottleneck for a big one.
- **One pool.** All threads + their sub-fan-outs draw from `maxAgents`; five threads each wanting 5 builders share 12, they don't spawn 25.

**Fan-out isn't free (self-limiting).** Parallel builders touching the same files need **git worktree isolation** (`isolation:"worktree"` in the engine) + a merge on green — real overhead — so the orchestrator only pays it when the split is worth it.

**Contended-pool priority (open decision #8).** When demand > pool, default **critical-path-first** (unblock the most dependents / shortest path to `finish-loom`). Alternatives: charter-order, cheapest-to-finish. Same class of knob as the flaky/retry budgets.

**The moat under fan-out.** Fan-out is on the **generation** side only. However many builders wove a thread, exactly **one independent** Verifier still gates it. More hands weaving; the same inspector.

---

## 8. The moat under orchestration & override

The moat must hold on **both** write surfaces (red-team #6):

1. **The tick path.** `validateDecision` forbids `finish-loom` without independent verify; the orchestrator has no tool to set `state`/`verdict` directly.
2. **The directive path.** A human/agent `override_decision` (§10) can *unblock*, *redirect*, or *reassign* — but **cannot author `done`**. Closing a thread as passed always requires a verify pass. Overriding to `done` requires either a fresh independent verify or a code-enforced human **co-sign** (not a lone agent).
3. **Distillation provenance.** `distillSpec()` checks `verifiedBy` provenance before emitting a regression spec — it refuses to freeze a spec from a `done` that wasn't independently verified, so an override can't leak a bogus regression into the suite (hard to retrofit; must be right from the first Loom).

---

## 9. God-view — pickup, handoff & steering

Because truth is in the ledger, **any** agent or human can load a Loom and take over. `needs-review` is a resumable **pause**, not a dead end.

**One write path for all mutation — Directives** (append to `events.ndjson`, optimistic concurrency):

```ts
const Directive = z.object({
  kind: z.enum(["steer","edit_charter","unblock","inject_thread","override_decision","reassign","resume","cancel"]),
  basedOnVersion: z.number(),         // optimistic concurrency vs the ledger/charter version
  by: z.string(),                     // "you" | "session:<id>" | "agent:<id>"
  payload: z.record(z.unknown()),
  at: z.number(),
});
```

- **Concurrency/ownership (red-team #3).** The orchestrator holds a **lease** (`orchestratorLeaseUntil`, a lockfile `O_CREAT|O_EXCL` under `runDir/.lease`). A directive with a stale `basedOnVersion` is rejected and re-read — so a human directive, an orchestrator tick, and a thread finishing can't clobber each other. Human directives are consumed at the **next thread boundary** (`agent()` has no live side-channel; steering is asynchronous — the same primitive as `telar_steer_run`).
- **Actions:** edit the charter (redefine goal / scope / decomposition), unblock a paused thread (supply the missing decision/credential/answer), inject a new thread, override a decision (bounded by §8), reassign a stalled thread to a fresh or specialized agent, resume, cancel.
- **Cold takeover (red-team #4).** A new agent picks up from the ledger alone — `charter` + `decomposition` states + evidence pointers + `decisionLogTail` + `rationale`. `scopingSessionId` gives a live pointer back into the drafting reasoning when a summary isn't enough.
- **Scope drift (red-team #5).** `scope.allowedPaths` + a deterministic **diff-vs-boundary** check on every repair — shipped *with* the repair loop, since "scope creep via ordinary repair" is a live failure mode.

---

## 10. The cockpit — session agents drive Looms

A chat becomes where a Charter is negotiated and a Loom is launched. Wired via `createSdkMcpServer` + `mcpServers` into `api/chat/route.ts` (the exact seam `engine.ts` uses for `emit_result` and the Verifier's Playwright server).

| tool | reads/writes | calls into |
|---|---|---|
| `telar_draft_charter({goal, kindHint?, notes?})` | read-only ideation | pure, in-process |
| `telar_start_run({kind,title,prompt,acceptanceCriteria?,target?,maxAttempts?})` | the single create | `dispatcher.startRun()` |
| `telar_list_runs({project?,state?,limit?})` | read, capped ~20 | `runs.listRuns()` |
| `telar_get_run({runId})` | read; bounded event tail | `runs.getRun()`+`readEvents()` |
| `telar_steer_run({runId,note})` | append a steer directive | `dispatcher.steerRun()` (next boundary) |
| `telar_cancel_run({runId,reason?})` | abort → `halted` | `dispatcher.cancelRun()` |

- **Moat by construction.** Every mutating tool's schema is a **strict subset** of `StartRunInput`/dispatcher signatures — there is *no field* that sets `state`, `attempts`, or `verdict`. A chat literally cannot author a `done` Loom.
- **`project`/`account` are bound server-side** to the session's own — never read from the model (same as `canUseTool` already strips a spawned subagent's `mode`/`isolation`).
- **Approval** reuses the composer's **Ask-me / Auto / Accept-edits** selector + `canUseTool` verbatim. Read tools join the pre-allowed set; the three mutating tools fall through to a permission card. A `preToolUseGuardrail` runs in *every* mode and hard-denies `start`/`cancel` unless a per-project `guardrails.autoStartRuns` opt-in (default **false**) is set — closing the "Auto waved a spend-bearing run through" gap. No "Always allow" affordance for start/steer/cancel.
- **Who gets the tools.** Sessions: yes. Run-worker agents (builders/Verifier): **none**, by omission — a builder recursively starting runs would escape its own gates. A subagent a session spawns is hard-denied these tools when `parent_tool_use_id` is non-null (prevents leakage to an unauthorized subagent). Epics spawn sub-Looms through the **orchestrator**, not through a worker's tool.
- **Handoff.** The chat launches, then ownership belongs to the Loom's orchestrator; the chat keeps a soft `loomId` reference and can observe/steer, but does not co-drive. `telar_steer_run` and the god-view "steer" button are **one primitive, two surfaces**.

---

## 11. State machine & recovery

```
queued → scoping → [charter-review] → preparing → running → verifying → done | needs-review | failed | halted | skipped
```
- `scoping`/`charter-review` are new; `preparing` is the already-defined-but-unused state (epic: create child Looms for `dependsOn`-free SubGoals; no-op for leaf).
- **Restart recovery (red-team, conservative).** On boot, reconcile: `queued`/`preparing` (zero attempts, no side effects) → **auto-resume**; `running`/`verifying` (an attempt was in flight, possible live side effects) → **`halted`, human/agent-resume required** — matching Telar's stated caution about re-running builders with side effects. This also fixes today's dispatcher orphan gap (the in-process `active` Map has no rehydration).

---

## 12. Integration map — files to create / touch

**Create:** `scoping.ts` (`draftCharter`), `proof-templates.ts`, `orchestrator/tick.ts` (`tick`, `validateDecision`), `orchestrator/rollup.ts` (pure epic roll-up, mirrors `decide()`), `orchestrator/budget.ts` (pool + fan-out sizing + priority), `orchestrator/directives.ts` (append + `basedOnVersion` + lease), `apps/web/.../telar-tools.ts` (the cockpit MCP server), the Loom-detail god-view + Looms list UI.

**Touch:** `schemas.ts` (Charter/SubGoal/ScopeBoundary/Budget/Directive), `runs.ts→looms.ts` (`parentLoomId`/`subGoalId`/`charter`/`role`; states), `executor.ts` (extract `runThread` = today's verified loop; branch epic Looms to the orchestrator; keep leaf fast-path byte-identical), `dispatcher.ts` (`startLoom`, `steerRun`, boot rehydration/lease), `engine.ts` (worktree isolation for fan-out — extend `parallel()`), `verifier.ts` (unchanged; reused per thread), `distill.ts` (verifiedBy provenance check), `gates.ts` (scope-boundary diff check hook), `api/runs→api/looms`, `api/chat/route.ts` (mount the cockpit server), `session-view.tsx` (steer UI + loom-detail), plus the whole `runs→looms` rename (M7.0).

---

## 13. Open decisions — the forks (with recommendations)

Ranked by "blocks building." **Bold = my recommendation.**

1. **Lane data model → child Looms** (separate `loom.json`/`events.ndjson`). *Forced by the two-writer race; the only model compatible with single-writer-per-file.*
2. **Charter mutation → one Directive path** (`basedOnVersion` optimistic concurrency) with `patchKind` classification layered on. *Not two competing write paths.*
3. **Restart recovery → conservative** (attempts-in-flight → `halted`; zero-attempt → auto-resume). *Given side-effect risk.*
4. **Epic closing-proof → a required must-thread in the DAG** (not a documented step), so `validateDecision`'s finish invariant can't be met without it.
5. **Moat under override → code-enforced**: override can't reach `done` without independent verify; `distillSpec` checks provenance; override-to-done needs a human co-sign. *Right from the first Loom.*
6. **Scope-creep guard → `allowedPaths` + diff check ship with the repair loop**, not later.
7. **Fast path preserved → charter/plan absent ⇒ today's `executeRun` byte-identical.** No quickfix planning tax.
8. **Fan-out priority when contended → critical-path-first.**
9. **`autoStartRuns` default false; scoping always drafts** (auto-approve trivial), only human-*review* is policy-gated.
10. **On-disk dir rename `~/.telar/runs → looms` → migrate with a symlink shim** (vs keep internal). And: **do the rename first** (M7.0), so M7 is born in the right vocabulary.

---

## 14. Phased build plan

Each phase is independently shippable and terminates on **executable evidence** — dogfooding the thesis.

### M7.0 — Rename `runs → looms`
Mechanical, test-guarded. **Acceptance:** full suite green; `/looms` + `/api/looms` work; on-disk migration/symlink verified; no dangling "run" in the loom vocabulary surfaces.

### M7.1 — The Ledger: child-Loom model
`parentLoomId`/`subGoalId`; an epic Loom spawns child Looms; each child = today's verified loop. **Acceptance:** an epic Loom with two *independent* child Looms runs both to `done` and folds up; each child writes only its own `loom.json` (no shared-file write — grep proves it).

### M7.2 — Charter & scoping
`draftCharter` (read-only), the state machine, `charter-review`, ProofTemplates. **Acceptance:** a vague prompt → a drafted Charter you approve → a decomposition; a prompt with `acceptanceCriteria` supplied **skips scoping byte-identically** to today.

### M7.3 — Orchestrator loop + fan-out + budget
`tick`/`rollup`/`validateDecision`, the concurrency pool, intra-thread Build fan-out with worktree isolation, critical-path priority. **Acceptance:** a decomposable thread fans to N (N = independent pieces, capped by `maxAgents`); a simple thread stays 1; agents in flight never exceed `maxAgents`; promotion still gated by an independent verify; a decision-log replay shows no tick-vs-tick contradiction.

### M7.4 — The cockpit
The MCP toolset in the chat route; approval + `autoStartRuns` guardrail. **Acceptance:** a chat drafts a Charter and starts a Loom; the chat provably *cannot* author `done` (schema has no such field); a session-spawned subagent is denied the tools.

### M7.5 — God-view & steering
The Directive path, suspend/resume, takeover, the Loom-detail UI. **Acceptance:** a `needs-review` Loom is resumed by a *fresh* agent from the ledger alone; a human directive is picked up at the next thread boundary; an `override_decision` provably cannot bypass the moat.

---

*Grounding anchors: `engine.ts:agent()/createSdkMcpServer/parallel()`, `executor.ts:executeRun/classify/decide/runVerification`, `verifier.ts:verify()`, `distill.ts:distillSpec`, `gates.ts:runGates`, `runs.ts:Run/RunKind/createRun/saveRun/appendEvent`, `dispatcher.ts:startRun/cancelRun/active`, `schemas.ts:VerifierReport/ProjectManifest`, `api/chat/route.ts`, `session-view.tsx`. Design synthesized from a 4-axis design pass + red-team (2026-07-09); the loom-vocabulary and two-level fan-out added with Facundo.*
