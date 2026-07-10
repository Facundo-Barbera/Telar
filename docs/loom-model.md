# Telar — The Loom Model (Spec Bundles, Sessions & Adversarial Verification)

**Status:** in build (2026-07-09). P1 (Spec Bundle) and P2 (Critic Panel) shipped; P3 (session front door) in progress; P4 (the dynamic weaver + methodology extraction, §W) and P5 (steering) next. See §8 for phase status. The definition, entry, and proof layers of the loom, revised. Companion to `docs/loom-orchestrator.md` — that doc specifies the **engine** (the child-Loom ledger, the orchestrator control loop, budget/fan-out, the verified loop). This doc revises the **front door and the moat**: how a loom is *defined*, how it is *started*, and how "done" is *proven*. The engine is preserved; the definition/entry/verification layers are re-cut.

> Written in Telar's own vocabulary — **methodology-agnostic by design** (BMAD/epics/stories/sprints/TDD are ways to *produce* a bundle, never Telar types — see §W): **Telar** = the app; a **Loom** = a unit of work; a **Thread** (weave) = a child loom the weaver spawns; the **weaver** = the loom's orchestrator; the **Spec Bundle** + **Verification Contract** = the *what* and the *proof*.

---

## 1. Two premises

1. **Methodology produces artifacts; the Loom consumes artifacts.** BMAD, epics, sprint plans, TDD — these are *ways to generate a specification*, not types in a schema. A Loom is anchored to a **Spec Bundle** (a directory of files) and does not care how the bundle was authored. This dissolves the `ProofStrategy`/`shape` enum problem at the root: there is nothing to enumerate, because the plan lives in files, and the intelligence that produced them lives in the planning session.
2. **A human never starts a Loom alone.** A raw prompt must never become autonomous multi-agent spend in one click. A Loom can only begin from a Spec Bundle, and a bundle is the *output of a thought process* — a planning session (agent-assisted) or a deliberately authored spec. This is a UI/product rule, **not** an engine constraint (see §6): automation may still hand the engine a pre-built bundle.

The design law is unchanged and now has a sharper home: **deterministic control flow in code; intelligence in the leaves; and the moat is the one thing that is never free-form.**

---

## §M. The moat is code, not prose — the invariants (red-team hardening, 2026-07-09)

An adversarial red-team found a complete, code-plausible path from prompt to `done` in which *nothing executable ever falsified anything*: an AI drafts a prose-only contract (valid JSON is our only requirement), a human rubber-stamps a non-epic loom (frictionless by default policy), a self-sized panel of same-model lenses reads that same lenient prose and passes — and if it doesn't, a steering session just *loosens the contract* and reruns. That is self-certification with three layers of ceremony **on top**, not underneath. The claims below were backed by prose/UI-convention; the engine already built the pattern they must follow (`validateCharter`'s required-subgoal floor; `§8.2`'s co-sign). **Every one is now a code-enforced invariant — a pure function or a schema constraint. If it isn't checkable, it doesn't count.** This section governs §2–§6.

1. **The Verification Contract is falsifiable by construction.** Each entry declares an *assertion type* — `golden-diff` | `value-equality` | `schema-match` | `contains` | `live-critic` — with a concrete expected value or bundle-file pointer; a `live-critic` entry must still name the observable it checks. Prose-only entries are **rejected at validation** (the analog of `validateCharter`). "Structured" means *falsifiable*, not "valid JSON." → closes the unfalsifiable-prose contract.
2. **Loosening a contract under a failing verdict needs a human co-sign.** A spec-revision Directive that removes/weakens an assertion for a subgoal with an existing failing/blocker critic verdict takes the *same* code-enforced human co-sign `§8.2` mandates for override→done; the god-view diff-flags "loosening" edits in the audit trail. → closes steer-to-pass (editing the yardstick *is* `set_verdict` in disguise).
3. **At least one adversarial-class lens is always a blocker.** `decide()`'s panel aggregation hardcodes a non-configurable floor: ≥1 lens of class `adversarial`/`reproduction` is always blocker — enforced in code like `validateCharter`'s required-subgoal floor, never left to manifest/session policy. An empty blocker set is illegal. → closes the vacuous panel.
4. **Panel size is a pure function of measurable post-build signals.** `panelSize()` (analog of `budget.ts:fanoutSize`) is fed by signals *outside planner control* — diff size, files-touched vs `allowedPaths`/`protectedPaths`, whether protected paths were touched, prior failing critics — never an AI-self-declared label. → closes the planner shrinking its own panel.
5. **Each critic sees only the bundle + the running app** — never the builder's `Verdict`/summary or another lens's in-flight verdict (decorrelation by information isolation), and ≥1 blocker lens should run on a *different provider* (`ProviderId` already models claude/codex); a same-model-only panel is documented reduced-trust. → closes correlated LLM-judge failure.
6. **A Loom can only start from human-approved provenance.** The manifest carries `plannedBy: {sessionId, humanApprovedAt}`, settable only by a UI action (never the session agent), and `dispatcher.startLoom` rejects a bundle without it — making "no human starts a Loom alone" a checkable invariant and closing the automation carve-out. A non-agentic **quick-bundle** form (templates a minimal *falsifiable* contract, no `agent()` call) keeps trivial fixes cheap without bypassing provenance.
7. **`blocked` is a distinct state.** Add `blocked` to `WorkUnitState` (or a `pauseReason` discriminant), separate from `needs-review`, with a default block-timeout → escalation, so a missing-credential pause is not indistinguishable from a real failure.
8. **Steering is built, not cited.** `runEpic` today reads `epic.charter` **once** at entry (`epic.ts:88`) and closes over it — so "snapshot per tick + reconcile at a boundary" is currently fiction. It becomes real only when `runEpic` re-reads the bundle/version each tick, `LedgerView` gains `pendingDirectives`, and a directives reader exists. **This must be built before any P3/P4 UI.**

**Two more the red-team surfaced:** (a) **panel cost is real spend** — it must flow into `AttemptRecord`/`spentUsd` (today `verify()` passes no `onEvent`, so it's invisible) and draw from a *reserved* `budget.maxCriticAgents` sub-pool, retry-aware (a retry re-runs only the blocker lens(es) + a fresh reproduction check). (b) **distilled specs, honestly** — `distill.ts`'s `verifiedBy`-provenance check (still a TODO, engine `§8.3`) must ship, distilled files auto-join `protectedPaths`, and `distillSpec` needs a panel→single-report reduction. And a doc-doc contradiction to fix: engine `§12` says "verifier.ts unchanged" — under this model **it changes** (→ the panel).

---

## §A. `done` is accepted, not automatic — the owner closes the loom

A verified loop that *auto-promotes* to `done` still hands the last word to the machine. It belongs to the owner. Verification proves the *evidence*; acceptance is the *decision*. This is the moat's sharpest form — the "CI-green ≠ merged" model.

- **A Loom never marks itself finished.** When the autonomous loop completes — every required thread done, hard gates green, the panel's blocker lenses cleared, evidence assembled — it lands in **`ready`** (a new `WorkUnitState`: *verified, awaiting acceptance*). It does **not** become `done`. `decide()` / `rollupEpic` / the orchestrator's `finish-loom` are retargeted to emit `ready`, never `done`.
- **Only the owner closes the loom.** `done` is reachable **solely** through `accept_loom(id, by)` — the human, or a session agent acting as the human's authenticated delegate (§M.6's pattern: an owner-authenticated action, never callable by an autonomous loop agent). The builder / orchestrator / critic can reach `ready`; **none can reach `done`.**
- **`done` now requires *both*** — independent verification passed (evidence) **and** owner acceptance (decision). Accepting a Loom whose verification is *red* is a distinct, audited **override** = the same §M.2 human co-sign, never the default accept button. A clean accept is an accept of *green*.
- **Steer even after `ready`.** From `ready` the owner may **accept** (→ `done`), **steer** (add a subgoal / refine the Spec → the Loom leaves `ready` and continues, re-verifies), or **reject** (back to work with feedback). "All tasks pass" is a *milestone*, not an *ending*.
- **Autonomy intact, deepened.** Walk-away-trustworthy becomes stronger: the loop does all the work and verifies it while you're gone, then *waits for your sign-off*, having shipped nothing as `done` without you.

*(Fork D12 — the delegate: may a session agent auto-accept a **green** Loom on the owner's behalf (it is the owner's tool), or must every accept carry a human touch? Proposal: agent may accept green only under an explicit per-project policy, **off by default**; accepting red always needs the human.)*

---

## §W. The weave is dynamic, and Telar has no methodology (2026-07-09)

Two linked corrections, one principle: **Telar freezes nothing that intelligence should decide at runtime.**

**1. The weave is dynamic — threads appear on the go, weaver-guided.** A Loom's sub-work is **not** a predefined `decomposition` list authored at planning time and exhausted by a scheduler (the M7 `Charter.decomposition` model — retired). The **weaver** plans continuously: each tick it reads the Spec Bundle (objective, contract, context files), the live ledger (threads spawned so far + their results), the budget, and any pending steering directives, and decides the next action — including **spawning a new Thread whose brief it authors on the spot**. The weave grows as it runs; threads materialize dynamically; the weaver adapts to what it discovers and to steering.

This changes the *path*, never the *destination*. The moat was never in the decomposition — it is the fixed, human-authored **Verification Contract** + the independent **Critic Panel** + the deterministic **promotion gate** (§4, §A). The weaver has full freedom in *how* it weaves; nothing it does reaches `ready` without the panel passing the contract. It *proposes* completion; the gates + panel *decide*. A rogue or sloppy weaver still cannot self-certify — so orchestration freedom costs the moat nothing.

The design law holds — **deterministic control flow in code; intelligence in the leaves**: the weaver's "what to spawn next" becomes an intelligent leaf (an `agent()` call), while the guards stay deterministic code invariants — `validateDecision` (each spawn's brief non-empty and inside `allowedPaths`/`protectedPaths`), budget hard-caps (cost / agents / wall-clock), `maxIterations`, and contract-gated termination. This also fixes the red-team's static-snapshot bug at its root (`runEpic` read the charter **once** at entry, §M.8) — re-planning per tick *is* the machinery that makes steering (§6) natural.

**2. Telar has no methodology in its types.** BMAD/epics/stories/sprints/TDD are *ways to produce a Spec Bundle*, not Telar concepts. The methodology-flavored identifiers that leaked into the core are extracted — and mostly **dissolve** rather than get renamed, because a Loom should not *declare* a shape it can derive:

| Methodology-flavored (out) | Telar (in) |
|---|---|
| `Loom.role: "epic" \| "leaf"` | derived: a **root** loom (no parent, the thing you own) vs a **thread** (`parentLoomId`); weaving is dynamic, not a type |
| `Charter.shape: "epic" \| "leaf"` | gone |
| `LoomKind: "quickfix" \| "story"` | gone — a Loom is anchored to a **bundle** |
| `ProofStrategy: "bmad-story" \| …` | gone — the **Verification Contract** is the proof |
| `kind: "verify"` | **kept** — a genuine read-only execution *mode*, not a methodology |
| `epic.ts` · `runEpic` · `rollupEpic` · `EpicGodView` | `weave.ts` · `weave()` · `rollup()` · the weave view |
| "orchestrator" | **weaver** |

Telar's whole vocabulary is then just: **Loom** (a unit of work), **Thread / weave** (a child loom the weaver spawns), **weaver** (decides the weave), **Spec Bundle** + **Verification Contract** (the *what* and the *proof*). Nothing methodology-specific survives in the types.

---

## §V. The loom is one surface — the orchestrator on top of its operators (2026-07-09, revised)

Locked with the owner against the **integrated god-view mockup** (the reference we build from). Supersedes the first §V draft — a linear "steps × agents" stepper — which was wrong: it flattened the orchestrator-on-top-of-operators hierarchy and made a fundamentally cyclic loop look linear.

**The frame is the original god-view**, in the established design language: a compact Charter strip, the orchestrator on top, the operators (threads) below, a right rail (decision log + steer), the moat line at the foot. One surface per loom; a single-agent loom is a **weave of one** — the same frame with one operator.

**1. The orchestrator sits ON TOP of the operators.** A conductor band above the weave shows the loop it owns — `plan → schedule → observe → decide ↻` — with the live **tick** (its latest decision) and the concurrency governor (agents in flight / budget). This is ultracode one level down, made watchable; the operators are explicitly "what it is weaving."

**2. The loop is non-linear, and the steps are the orchestrator's to choose.** There is **no loom-level progress bar** and **no hard-coded step spine.** Each **operator (thread)** runs its **own** sequence of steps, and *the orchestrator decides what they are* for the work at hand — not a fixed `build → gate → verify → decide` enum. The one thing it cannot skip or author away is **verification** (deterministic gates + the critic panel): that is the moat, applied to every step's output, not a step the orchestrator invents. Each operator keeps its **own repair loop** (verify ✗ → back, bounded). Threads run at their own pace (pipeline, not lock-step); dependents unblock as prerequisites pass; a blocked thread parks while the rest weave on. The UI renders **whatever steps actually ran**, derived per-operator (never a fixed rail); the **decision log** is the narrative, not a stepper. *(Full orchestrator-authored steps arrive with the dynamic weaver, §W / Phase C; the model + UI stop hard-coding the spine now.)*

**3. Every agent has its own view — and its own transcript.** Click an operator → its agent view: pipeline · current action · fanned-out sub-agents · files · the critic panel. Each carries **Overview / Transcript** tabs; the transcript picker spans the **operator, each fanned-out sub-agent, and each critic**, showing that agent's raw session (assistant reasoning · tool calls · results; for critics, the Playwright drive + verdict). The header states the moat plainly — builders have Write/Edit/Bash; critics are read-only on a different account.

**4. Verify is the kicker, and it lives inside the thread.** Deterministic gates are table stakes. The edge is the **critic panel driving the real product with Playwright** to judge intent and gaps — *"what did the user want, and what are they missing?"* (§4 Layer 2). Each lens shows verdict, summary, findings, evidence, and the URL it drove; a failing blocker sends the thread back to repair. Nothing reaches `done` without surviving it; no agent self-certifies (the moat line anchors the view).

**5. The spec never invades the workspace.** The Charter strip is compact (objective + a few chips + Revise); the full Spec Bundle — objective, the falsifiable contract, context files (a BMAD story, a mockup, golden data) — opens in a **drawer**, over the view, never colonizing it.

**6. The loom is execution; planning is upstream.** The human's time goes into the **Loom Session** — a prompt (or BMAD epics, or a feature brief) becomes a full Spec Bundle + contract. Then the loom executes mostly autonomously. Two human gates bracket it: **Launch** (`start_loom`, its own moment) and **Accept** (§A — lands/commits the work). Everything between is autonomous and independently verified.

**Design.** Keep the established god-view visual language (the reference mockup) — reuse the app's real components; do not introduce a divergent look.

**Build order.** Phase A — the god-view frame + the agent view (with transcripts) + the spec drawer, foregrounding the Playwright critic panel, rendered against today's data. Phase B — the two gates (Launch surface; Accept-commits + wire Steer/Reject, #35). Phase C — the dynamic weaver: the orchestrator staffs operators at runtime (#32). Phase D — per-loom run initializer (#33) + out-of-process execution (#36), underneath.

---

## 2. The Spec Bundle — a Loom weaves from a directory, not a prompt

A Loom is anchored to a **Spec Bundle**: a working directory of artifacts the loom and its agents read.

- **Location.** Telar-owned and temporal by default: `~/.telar/looms/<id>/spec/`. It is *not* the repo. Individual artifacts may **graduate** to the repo when that is the intent (the M3 distilled regression spec already does this) — but the planning corpus stays in Telar-land.
- **Any format.** Markdown epics, a golden output file, fixture data, a design mockup (image), an OpenAPI contract, a `.feature` scenario, a human-authored test, a CSV of expected rows. Different expectations need different formats; the bundle imposes none.
- **One required, *falsifiable* artifact — the Verification Contract** (`spec/contract.json` or equivalent). Not merely valid JSON: **each entry declares a falsifiable assertion** (§M.1 — `golden-diff`/`value-equality`/`schema-match`/`contains`/`live-critic` + a concrete expected value or file pointer), rejected at validation otherwise. Everything else in the bundle is free-form context. The contract is the moat's physical home (§4); a Loom cannot reach `done` without it, and cannot reach `done` on prose alone.
- **Versioned & snapshotted.** The bundle carries a version/hash. A running Loom binds to a *snapshot*; the orchestrator reads a snapshot per tick. Edits are deliberate version bumps (steering, §6), never silent mutation — so "what the loom is building against, and when it changed" is always auditable.
- **Renderable.** The god-view serves and renders the bundle (reusing the evidence-serving path, `/api/looms/[id]/evidence` → `/spec`). The user sees *what* we're building (the spec), *how we'll know* (the contract), the *weave* (threads), and the *proof* (evidence) in one place.

**The naming metaphor (open):** in tapestry a **cartoon** is the master drawing the weaver works from behind the warp. The Spec Bundle is the loom's cartoon. We may adopt "Cartoon" as the product term; this doc uses "Spec Bundle / the Spec" to stay unambiguous. (Decision D0.)

### The Charter, revised
The `Charter` stops being a JSON blob and becomes the **bundle manifest**: an index over the spec directory + the Verification Contract. There is **no predefined `decomposition`** — the weave is planned *at runtime* by the weaver (§W), so "epic-ness" is not a type at all; a Loom is a **root** (the thing you own) or a **thread** (`parentLoomId`), and whether a root weaves threads is decided as it runs. Retired: `ProofStrategy`, `shape`, `role: epic|leaf`, and `LoomKind`'s methodology values (`quickfix`/`story`) — a Loom is simply "anchored to a bundle." `verify` stays a genuine read-only execution **mode**.

---

## 3. You author expectations, not tests

The weakest assumption in the prior design was leaning on AI-generated tests as proof. Two problems: a test written by/near the builder is *implementation-anchored* (it asserts what the code does, so it passes tautologically), and you cannot write a test against code that does not exist yet.

**The reframe:** you were never meant to test the code — you author the **expectation**. While the thing does not exist, you *can* write down what a correct result looks like: a golden output, "clicking Export downloads a PDF with these fields," a mockup, a sample response, a real human-written test. These are authored from *intent*, up front, and do not rot the way generated tests do. That is what "use whatever files" unlocks: **bundle files are verification anchors, not just planning context.** The critic checks *reality against the human-anchored expectation* instead of the code checking itself.

Consequence: **AI-distilled tests (M3) demote to regression tripwires** — frozen *after* an independent pass to catch future drift. A distilled test can *detect regression*; it can never *earn* `done`.

---

## 4. Verification, made better — three layers

The moat — *promotion to `done` requires independent proof on executable evidence* — is preserved and strengthened into a stack. Proof stays deterministic **where it counts**; judgment lives in intelligent leaves; the verdict is deterministic code.

**Layer 1 — Hard gates (deterministic machine truth).** Compile, *existing* tests, build, lint, contract-conformance against a bundle file. Ungameable, cheap, run **first**. If they fail, spend nothing on Layer 2.

**Layer 2 — The Critic Panel (intent judgment).** Independent agents (different account, read-only, no write tools) that **drive the running product live** — Playwright is not a way to run e2e, it is a way to *simulate the actual user experience live* — grounded in the Spec Bundle, and prompted not to check boxes but to be adversarial critics: **"what did the user actually want here, and where would this disappoint them?"** That question is a different job from the builder's, and it is the right one. Not one verifier — a **panel** with distinct lenses, because diversity catches what redundancy cannot:
- **Intent / acceptance** — does it satisfy the contract *and* the spirit behind it?
- **Adversarial / edge** — what breaks it; the nasty inputs; the unhandled path.
- **Live experience (UX/design)** — driven as a real user; is the actual experience right (evolves M6).
- **Reproduction** — does the claimed behavior actually reproduce when driven cold?
- **Domain lenses** — security, performance, data-integrity, when the work calls for it.

**Layer 3 — Deterministic promotion rule.** `decide()` stays a pure function over structured verdicts, but promotes to **`ready`**, never straight to `done` (§A): reach `ready` **iff** every hard gate is green **and** the panel aggregation passes (every *blocker-lens* critic clears; no blocker-severity finding). The critics are the intelligent leaves; the verdict is code; the *acceptance* is the owner's. This is how "proof is deterministic" and "the critic is an AI" are both true — determinism lives in the gates and the aggregation, never in one model's reliability. Existing flaky-handling carries over.

**Adaptive cost.** A panel is expensive. It sizes to risk like the build fan-out: gates-first, a trivial change gets a light panel, a risky/large change gets the full council, all from the shared budget. The moat's *rigor* is constant; its *cost* scales to the risk.

**Panel composition = the definition of "done."** Which lenses are *blocker* (must clear) vs *advisory* (surfaced, non-blocking) is exactly what Telar considers a proven result. (Decision D3.)

We already run this pattern: every workflow this session used an adversarial verify panel that caught the moat-bypass, the worktree leak, the read-only hook-leak. This productizes the technique that has been protecting us.

---

## 5. Sessions are the Loom's interactive half

The Loom is autonomous execution. The **session** is the interactive complement — and it appears in three roles, which are the *same primitive*: **a session attached to a Loom, with a role, over the shared Spec Bundle.**

- **Planner** — a working session grows loom tools; mid-conversation you say "make this real," the agent finalizes the bundle, starts the Loom, and walks you to the god-view.
- **Loom Session** — a dedicated session in the **Looms tab**, purpose-built to prepare one Loom; auto-navigates to the god-view on start.
- **Steerer** — a session spun up *inside* a running Loom to unblock / redirect (§6).

The messy interactive work happens in the session (the kitchen); its **output is the clean Spec Bundle** (the dish); the Loom runs that snapshot (the diner). There is a **commit moment**: the session finalizes/version-bumps the bundle, and *that* is what the Loom weaves.

**Data model (the load-bearing new piece).** A `Session` gains an optional `loomId` + `role: "planner" | "steerer"`. The Spec Bundle is the shared surface. Everything else (planning tools, the loom-session view, in-loom steering, the credentials pause) is an expression of this link. (Decision D5 — spec this next.)

**Tools a session agent gets** (moat-safe, cf. `docs/loom-orchestrator.md` §10 — schemas structurally cannot author `done`): draft/refine the bundle, propose the Verification Contract, `start_loom(bundle)`, `list/get_loom`, `steer_loom(directive)`. No tool sets `state`/`verdict`.

---

## 6. Steering, blockers & the "no solo start" rule

**Steer by editing the Spec.** Modify a bundle file → version bump → the change becomes a **Directive** (`spec-revised → vN, reconcile`) consumed at a **thread boundary**, never mid-thread (reuses the M7.5 lease + optimistic-concurrency machinery). Policy for in-flight threads on a spec change: **finish-then-reconcile** past the point of no return, **interrupt** for not-yet-started. (Decision D4.)

**Blockers pause; they never hard-fail.** Missing credentials, an ambiguous requirement, a human-only decision → the Loom drops to a *blocked / needs-human* state, surfaces the exact blocker, and waits (the resumable pause, `needs-review` as a pause not a dead end). The bundle makes this precise two ways:
- It **declares prerequisites** ("requires: `STRIPE_TEST_KEY`, a staging URL"), checked **at start**, so the Loom pauses early with a clear ask instead of dying three threads deep.
- When blocked, you open a **steering session**, hand over the missing piece (a credential into the secret store; an answer that bumps the spec), and resume. The moat is untouched — a blocked Loom never reaches `done`.

**"No solo start" = a UI rule with an automation carve-out.** The human path always goes through a session that produces a bundle (this is why the "Start loom" button was already removed). But the engine (`startLoom(bundle)`) still accepts a bundle from *any* caller — scripts, CI, another agent — or we lose automation and our own tests. Same door, different keys.

---

## 7. Preserved vs re-cut

| Layer | Verdict |
|---|---|
| Child-Loom ledger (`loom.json`/`events.ndjson`, single-writer) | **Keep** — a sub-unit is a child loom whatever the methodology |
| Orchestrator loop *as a static decomposition scheduler* | **Re-cut → the dynamic weaver** (§W) — plans the weave at runtime, spawns threads on the go; budget + fan-out kept |
| Verified loop + the moat | **Keep, strengthen** — into the three-layer stack (§4) |
| God-view shell | **Keep, extend** — now renders the Spec Bundle |
| Evidence-serving path | **Keep, reuse** — serve `/spec` the same way |
| `Charter` JSON blob | **Re-cut** → bundle manifest + Verification Contract |
| `ProofStrategy` / `shape` / `role: epic\|leaf` / `LoomKind: story\|quickfix` | **Dissolve** (§W) → methodology lives in files; root/thread derived from `parentLoomId`; weaving is dynamic. `verify` mode kept. |
| `draftCharter` (the sole scoping step) | **Demote** → one tool a planning session may call |
| new-loom / create-loom dialog | **Delete, gone** (§W, P3) → a Loom begins only from a Loom Session; no one-click prompt→loom |
| Single `Verifier` | **Multiply** → the Critic Panel |

---

## 8. Build phases (each shippable, each terminates on executable evidence)

- **P1 — Spec Bundle substrate. ✅ Shipped.** Bundle storage/versioning/snapshot; the falsifiable Verification Contract schema (§M.1); provenance (§M.6); the `ready`/`blocked` states (§A/§M.7); bundle rendering in the god-view.
- **P2 — Verification → the Critic Panel. ✅ Shipped.** The Verifier reframed from checker to adversarial *critic*, grounded in the bundle; a panel with the pure §M.3/§M.4 invariants (`panelSize`/`aggregatePanel`); information isolation (§M.5); reserved critic budget (D11); `decide()` promotes to `ready` only on gates + panel.
- **P3 — Session↔Loom front door. 🔄 In progress.** The session *is* the `Chat`; it gains `loomId`/`role` (§5). `startLoomFromBundle` — the provenance-gated commit — shipped; the moat-safe loom toolset + `start_loom` (permission-gated = the human-approval provenance stamp) + the handoff in flight. **Correction (locked):** the create-loom menu is **deleted**; a Loom begins only from a **Loom Session** that lives in the Looms tab and auto-navigates to the god-view on start.
- **P4 — The dynamic weaver + vocabulary extraction (§W). ⏭ Next.** Re-cut `epic.ts` → `weave.ts` into a dynamic, weaver-guided loop (threads spawned on the go, plan-per-tick, contract-gated termination; deterministic guards: `validateDecision` scope, budget hard-caps, `maxIterations`). Dissolve the methodology enums (`shape`/`ProofStrategy`/`role: epic\|leaf`/`LoomKind: story\|quickfix`) across core + web + tests; rename orchestrator → weaver, `EpicGodView` → the weave view. Test-guarded like `runs → looms`.
- **P5 — Steering, blockers & recovery. ⏭.** Spec-revision directives consumed at a thread boundary (most machinery lands in P4's per-tick re-planning); the `blocked`/needs-human pause + prerequisites declared and checked-at-start; in-loom steering sessions; boot-recovery for orphaned looms (§11 of the engine doc).

---

## 9. Open decisions (the forks)

Red-team-hardened (§M) items are now code-invariants; what remains is genuine forks.

- **D1 — Contract schema. LOCKED (§M.1):** falsifiable typed assertions, rejected-at-validation if prose-only. *Remaining:* the exact assertion-type set.
- **D3 — Panel floor. LOCKED (§M.3):** ≥1 adversarial/reproduction lens always blocks, in code. *Remaining:* the full lens list + which others block.
- **D2 — Anchors over generated tests.** Confirmed; provenance enforcement (§M "distilled specs, honestly") is the code delta.
- **D4 — Steer-under-execution.** Finish-then-reconcile vs interrupt for in-flight threads — but first requires the real directive-consumption path (§M.8).
- **D5 — Session↔Loom data model.** The biggest new surface; spec next.
- **D6 — Bundle lifecycle / GC.** Retention, size/TTL caps (bundles can hold arbitrary binaries; `listLooms` already does an unbounded scan), repo-graduation timing.
- **D0 — Naming.** "Cartoon" vs "Spec Bundle."

**New forks the red-team forced (need your call):**
- **D8 — Critic independence.** Require ≥1 blocker lens on a *different provider* (needs Codex/another account wired) for real decorrelation, or accept **v1 same-model "reduced-trust"** panels and document the limit?
- **D9 — The quick-bundle lane.** A non-agentic UI form that templates a minimal *falsifiable* contract for trivial fixes (no planning session, still provenance-stamped) — build it, or make *everything* go through a session?
- **D10 — Blocked-state policy.** Default block-timeout + escalation (notify? auto-halt? wait forever?) for a Loom paused on a missing prerequisite.
- **D11 — Critic budget.** A reserved `maxCriticAgents` sub-pool vs the shared `maxAgents` pool (the red-team showed the panel can starve or be starved by build fan-out).
- **D12 — The delegate (§A).** May a session agent auto-accept a *green* Loom on the owner's behalf under an explicit per-project policy (off by default), or must every `accept_loom` carry a human touch? Accepting *red* always needs the human co-sign regardless.
- **D13 — The run initializer (per-loom environment). Raised 2026-07-09; deferred.** The Critic Panel drives "the running product" (§4) — but *which* instance? A shared, hardcoded `urls.dev` collides across concurrent looms and can't reflect a loom's own isolated build. Direction: when a loom starts, a **run initializer** provisions its environment — including a **dedicated app server** (per-loom port, ideally against the loom's worktree) — so the verify target is *dynamic per-loom*, not a hardcoded manifest URL. Blocks live web-app dogfooding; the minimal unblock is "spin a dev server on a free port at loom start, tear down at end." **Do not** hardcode `urls.dev` as a workaround.

**Resolved (2026-07-09, locked in code where shipped):** D8 → v1 same-model + information-isolation + a provider seam (Codex cross-provider deferred). D9 → the quick-bundle lane is built (`quickBundle`). D11 → reserved `maxCriticAgents` sub-pool. D12 → a delegate may accept a *green* Loom only under an explicit per-project policy, **off by default**; a *red* accept always needs the human. D5 → the session *is* the `Chat` record; it gains `loomId` + `role` (§5). Two decisions locked this round (§W): **the weave is dynamic** (threads planned at runtime, not a predefined decomposition) and **Telar carries no methodology in its types** (epic/story/`shape`/`ProofStrategy` dissolved). Still open: **D10** (blocked-state policy — leaning timeout→escalate, P5) and **D0** (Cartoon vs Spec Bundle naming).

**Sequencing the red-team insists on:** lock D1 + the D3 floor *in code* before UI; build a minimal real directive-consumption path into `runEpic`/`tick` *before* P3 session UI; treat "co-sign to loosen a contract under a failing verdict" as a **P1 schema requirement**, not later polish.

---

*Grounding anchors (current code): `schemas.ts` (Charter/SubGoal/Budget — to re-cut), `scoping.ts:draftCharter` (→ session tool), `verifier.ts:verify` (→ critic panel), `executor.ts:classify/decide/runVerification` (→ three-layer promotion), `distill.ts` (→ regression-guard only), `looms.ts` (ledger — keep), `epic.ts`/`tick.ts`/`budget.ts` (orchestrator — keep), `apps/web/.../charter-panel.tsx` + the god-view (→ render the bundle). Synthesized from the 2026-07-09 design conversation with Facundo.*
