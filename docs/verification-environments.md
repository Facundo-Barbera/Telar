# Verification & Environments — verify-threads, lanes, and a closed orchestration loop

**Status:** Draft for review · 2026-07-10
**Scope:** three seams that share one root cause — (A) auto-verification silently
does not run for looms with no live-app surface, (B) there is no reproducible,
self-healing environment for verification (or the builder) to run against, and
(C) verification is a terminal leaf gate instead of a feedback signal the
orchestrator loops on. Fixing the execution model (a *lane*) makes both the
verifier and the builder work; promoting verification to a *thread-kind* makes
the orchestrator loop close.
**Related:** `loom-model.md` §4 (Layer 2 Critic Panel / Layer 3 promotion) · §M.5
(critic information isolation) · `runtime-architecture.md` §A (background Run) ·
`run-server.ts` D13 (per-loom run initializer) · `verifier-agent.md` §3.

---

## 1. Goal & non-goals

**Goal.** Make "did the completed task achieve what the user expected?" a signal
the orchestrator can *obtain reliably* and *act on repeatedly* — for backend/DB
work as much as UI work — by (1) giving every loom a reproducible **environment
lane**, (2) modeling **verification as its own read-only, multi-agent
thread-kind** run against a frozen snapshot, and (3) feeding its verdict back
into the orchestrator's tick decision so an unfinished loom continues instead of
terminating.

**Non-goals / the moat holds.**
- **No auto-accept.** A green verify-thread lands a loom `ready`; `ready → done`
  stays a human click (`loom-model.md` §M.6, `watchers-design.md` §1). The loop
  spawns *work*, never *acceptance*.
- **The verifier still cannot edit.** Read-only, restrictTools, no
  Write/Edit/Bash/Agent (`verifier.ts:233-237`). A verify-thread is multi-agent
  but every agent in it is read-only. Trust comes from structural inability to
  make a failing thing pass.
- **Not a general CI system.** Deterministic gates (`gates.ts`) already run shell
  commands by exit code; this design routes work *to* them, it does not replace
  them.

---

## 2. What happens today (grounded)

Traced from a real run — `loom_mrf6ewd9_dyaju8` (ozom-gv PD backlog, 4
workstreams), `~/.telar/looms/<id>/events.ndjson`:

**Auto-verification never ran, and nothing said so.** Each child thread went
`dev → verifying → verdict(dev self-report) → panel report:null → needs-review`.
No `verifier`-role attempt, no `critic-cost`/`critic-verdict` events, empty
evidence dirs. The panel short-circuited at `executor.ts:284`:

```ts
if (!target) { emit({ type: "panel", n: attempt.n, report: null });
               return { verification: "skip", ... panelRequired: true }; }
```

`target = url ?? manifest.urls?.dev` (`executor.ts:373`); the ozom-gv manifest
has **no `urls.dev`, no `devCommand`, `gates: []`**. The fallback that spins its
own server needs `manifest.devCommand` (`executor.ts:382`), which is absent → the
panel had nothing to point a browser at, for four backend/migration/pgTAP
workstreams that have no browser surface anyway.

**The contract was mistyped.** `spec/contract.json` = **20 `live-critic` + 2
`value-equality`** assertions, but the `live-critic` observables are offline
checks (`grep ingest.ts`, `bun test ingest.test.ts`, `pgTAP select count(*) = 0`).
Browser lenses can't judge those; they belong to a gate/command layer.

**The orchestrator terminated on a transient failure.** `tick.ts:114` →
`escalate, reason: "${failedRequired.id} failed"` fired ~1 ms after W1's builder
hit `error_max_turns` — before W1's own retry brought it back to `needs-review`
(ok=true). The tick loop reasons over thread *state* (`failed`) with no notion of
*transient vs terminal* and **no verification signal at all**.

**Builders collided in a shared lane.** W1/W2 verdicts flag it directly: shared
working tree with "concurrent/other session" edits, migration band collision
`0055→0056` renumbered by hand, local Supabase "schema drift … prevented running
staging_rls.sql". Same root as the verifier problem: **no per-lane isolation.**

The three symptoms are one cause per §1: no lane, wrong verification modality, and
verification stranded at the leaf.

---

## 3. The model — one orchestrator, two kinds of subtree

The mental graph, made concrete:

```
            orchestrator (the tick loop — the brain)
           /                                    \
        weave                              verification
   (build fan-out)                        (verify fan-out)
   build threads ───┐                     verify threads
   (mutating)       │  quiesce → freeze →  (read-only, multi-critic)
                    └──────── snapshot ────────► judged here
```

**Everything is a work unit in a recursive tree.** A unit either does atomic work
(one agent) or decomposes into sub-units (a sub-orchestration). A unit carries a
**kind** that fixes its tools, its lane, and its termination:

| | **build thread** | **verify thread** |
|---|---|---|
| tools | Write / Edit / Bash / MCP | read-only probes only |
| output | a commit | a verdict + evidence |
| lane | a worktree it mutates + its DB | worktree **frozen at a commit** + a DB clone |
| agents | multi, **partitioned** (§7) | multi-critic panel (`runPanel`) |
| terminates on | "I'm done" + own gates green | every assertion has a verdict |

**The weave is just the build subtree.** Verification is the *other* subtree, a
**peer** under the orchestrator — not a step inside a build thread, not a step
inside the weave. This answers "on the orchestrator or a separate block?":
**decision on the orchestrator** (a tick action, §6), **execution as a
thread** (a separate, isolated, multi-agent block). That is the existing
decision-vs-execution law — deterministic control flow stays in the caller
(`critic.ts:223-228`).

**Why a thread-kind and not a bolt-on.** The thread boundary *is* the §M.5
information-isolation boundary: a verify thread receives only `{ contract,
snapshot, url }`, never the build thread's transcript or verdict — so critics
can't be contaminated by construction, not by convention.

---

## 4. Environment lanes — `servers.yaml`, dynamic ports, self-heal

A **lane** is the unit of isolation: `{ worktree @ commit, database, running
services }`. Build threads get a mutable lane; verify threads get a frozen-code +
cloned-DB lane. Both are described by one per-project recipe.

### 4.1 `servers.yaml` (per project, in the repo — committable, secret-free)

Mirrors the `mcpServers` split (`runtime-architecture.md` §B.3): the repo declares
*how* to bring services up; no secrets live here.

```yaml
# telar knows how to stand this project up for a lane
services:
  db:
    command: "supabase start"
    portStrategy: fixed          # 54321/54322 are fixed BY the dependency — probe, don't reassign
    readyCheck: { kind: command, run: "supabase status" }
    reset: "supabase db reset"   # how to return the substrate to clean (self-heal + template seed)
  app:
    dependsOn: [db]
    command: "bun run dev"
    portStrategy: dynamic        # OS-assigned free port, injected
    portInject: { env: PORT }    # OR { arg: "--port {port}" } OR { file: ... } — no universal convention
    readyCheck: { kind: http, path: "/api/health", status: 200 }  # NOT "any response" (see 4.2)
    healthcheck: { kind: http, path: "/api/health", intervalMs: 5000 }  # ONGOING liveness → supervisor
    restartPolicy: { onCrash: true, maxRestarts: 3, backoffMs: 1000 }
    env:                         # self-referential config must receive the chosen port too (4.2)
      NEXT_PUBLIC_APP_URL: "http://localhost:{port}"
      DATABASE_URL: "{db.url}"
```

Drivers are pluggable: `none` (static url, today's path — unchanged), `host-process`
(spawn commands, §4.4), later `docker` / `compose` / `remote`. Start with
`host-process`; it is 10× cheaper than a container per lane and enough for a
single-developer machine.

### 4.2 Dynamic ports — the real problem is self-reference, not binding

`run-server.ts` already binds a free port (`findFreePort`) and injects `PORT`
(`startProjectServer:126`). Two things it does **not** yet handle, both of which
bit the real run:

- **Not everything is dynamic.** Only the *app's* listen port is OS-assigned.
  Dependency ports (Supabase 54321/54322) are fixed by the dependency — declared
  `fixed` and **probed**, never reassigned.
- **Self-referential config.** Bind port 51234 and the server is up, but its
  redirect URIs / `SITE_URL` / `NEXT_PUBLIC_APP_URL` / CORS still point elsewhere.
  "Dynamic-port support" *means* "flow the chosen port into every place the app
  refers to itself" — via `portInject` + templated `env`, per project, because the
  injection method has no universal convention.
- **Real readiness.** `defaultPoll` treats *any* HTTP response as "up"
  (`run-server.ts:52-58`); a Next dev server answers before it compiles the route,
  so verification can start against a server that 500s the first request. Replace
  it with the declared `readyCheck`.

### 4.3 The setup agent — pre-loom, interactive, self-healing

Mirror the weave-planner (an agent that runs *before* the loom): a **setup agent**
brings the environment up, diagnoses failures, and **asks the human** — "Docker
engine isn't running and this project needs it, can you start it?", "54322 is
already bound", "missing `supabase/.env.keys`". Its whole value is converting the
silent verify-time skip of §2 into a loud, actionable **setup-time** prompt.

- **Authoring helper.** When `servers.yaml` is missing, the agent inspects
  `package.json` / `supabase/config.toml` / compose files, proposes a
  `servers.yaml`, and the human approves it — charter-review style
  (`loom-model.md` §5).
- **Fast path.** Run *full* setup only when the recipe is missing or changed;
  otherwise just run the `readyCheck` probe and escalate to full setup only on
  failure. This is what makes "tools ready before dev, once for the whole loom"
  affordable — no re-diagnosing Docker every loom.
- **Home in the lifecycle.** There is already a `preparing` state
  (`schemas.ts` `WorkUnitState`; the parent sat in it before scheduling children).
  Provision → migrate → seed → **health-check** *is* the readiness gate: a broken
  substrate fails the loom at setup, not 30 minutes later at verify.

### 4.4 Self-heal — a supervisor owns the process, not the agent

Decouple process lifecycle from any single attempt (the `runtime-architecture.md`
§A.2 "compute ≠ request" principle, applied to services):

- **Supervisor** runs the `healthcheck` continuously, auto-restarts within
  `restartPolicy`, and **circuit-breaks** on a crash-loop → escalate with the
  captured log tail (a crash-loop almost always means an *edit* broke it;
  restarting is futile).
- **Distinguish mid-edit breakage from a dead process.** A compile error while a
  builder is editing is *expected* — dev servers show an overlay and recover on
  next save. The supervisor tolerates transient unhealth *during active editing*
  and only alarms after a quiescence window (no edits for *X*s **and** still down).
  It must not fight the builder. It restarts on *process death* (config syntax
  error, OOM, lost port), not on *code errors the framework already survives*.

---

## 5. The two collision questions

**Q: the server breaks while an agent is editing.** Covered by §4.4 — tolerated
as mid-edit; restarted only on true process death; escalated only on a crash-loop.
The builder's *own* self-checks (`bun test`, typecheck) stay **inside** the build
thread, sequential and self-owned (edit → run → fix). Those never collide — same
lineage checking its own work — and are *not* "verification" in the trust sense.

**Q: verification collides with development.** Solved by **isolation, not
locking.** A verify thread runs against a worktree **frozen at a commit** + its
own DB clone + its own server. The builder writes commit *X+1* while the verifier
judges commit *X* — they share no mutable state, so the collision is structurally
impossible, not merely coordinated away.

- **DB isolation, cheaply.** One Postgres per loom (the shared local Supabase, or
  a bare Postgres for SQL-only projects); each lane gets a throwaway DB **cloned
  from a template** (`CREATE DATABASE lane_n TEMPLATE loom_base` — near-instant) or
  a rolled-back transaction (W1's builder already used the txn trick). Collapses
  "5 × `supabase start`" into "1 × start + N × createdb".
- **The honest Supabase wrinkle.** Template-clone-per-lane works when code talks to
  Postgres directly (`DATABASE_URL`). The Supabase API layer (PostgREST/GoTrue/Kong)
  is bound to the one `postgres` DB, so per-lane *API* isolation needs a full stack
  per lane. Therefore: **pgTAP / direct-SQL assertions** (the bulk) isolate freely
  and run in parallel; the **rare UI-through-Supabase mutating assertion**
  serializes on the single stack with a `reset` between runs. `maxCriticAgents`
  (default 3) already bounds the blast radius.

**Rejected alternative — a shared running instance for the whole loom.** Re-buys
the state-collision problem across parallel workstreams and across build-vs-verify,
and makes the reproduction lens ("drive it cold") impossible. Share the *immutable
substrate* (template), never the *mutable instance*.

---

## 6. Verification as a thread — multi-step, multi-agent, and when it runs

### 6.1 The verify-thread pipeline

Not one critic — a pipeline (the "multi-step, multi-agent" shape generalized):

1. **Deterministic facts** — the *engine* runs gates (tests, pgTAP, typecheck) in
   the lane. Binary, unfakeable, no LLM. Most of §2's mistyped `live-critic`
   assertions land here.
2. **Evidence gathering** — read-only probes: Playwright *only when there is UI*,
   read-only SQL (the Supabase `?read_only=true` MCP is already wired for ozom-gv),
   HTTP.
3. **Critic panel** — multi-agent judgment over the gathered evidence
   (`runPanel`, the existing lenses), grounded only in the bundle + snapshot.
4. **Synthesis** — aggregate into one verdict against the contract assertions.

`runPanel` (`critic.ts:229`) is already ~80% of steps 2–4. This design **promotes
it from a leaf function call to a scheduled construct with its own lane** — the
single move that makes the orchestrator *know* whether verification ran (vs §2's
silent `report:null`).

**Assertion types drive the modality (planner's job, not run-time guess):** add
`command` / `gate` (→ step 1) and `db` (→ step 2 SQL) alongside `live-critic`
(→ step 2 browser). The engine routes deterministic assertions to gates *before*
spending an agent turn. This is also the fix for the `decide()` gap where
`panelRequired` is dropped in the `!gatesConfigured` branch (`executor.ts:209-214`).

### 6.2 When — interleave, never concurrent, not only-at-the-end

```
schedule build wave → quiesce to a commit boundary → freeze snapshot
   → spawn verify thread(s) on the snapshot → read verdict
   → decide: accept / repair / fanout more / escalate → repeat
```

Build and verify alternate at the orchestrator's cadence; a verify thread only
ever judges a *frozen* commit while builders (if any) work on the *next* one.
Scope uses the contract's existing `subGoalId` partition (`W1-109 … + ALL`):
**per-SubGoal verify threads at checkpoints + a final `ALL` integration verify
thread.** The contract was already built for this.

**Rejected framing — "just verify once at the very end."** Fine as the MVP (§8),
because today there is effectively *zero* real verification, so end-of-loom is
strictly better and simplest. But end-only discovers a broken whole after all
building is done — the late-rework the closed loop exists to avoid.

---

## 7. The orchestrator loop — verification as input + action

The loop already exists. `tick.ts:18-27` decides over:

```ts
schedule · repair · fanout · escalate · finish-loom · hold
```

`repair` and `fanout` are already the "spawn more work" actuators. Two changes
close the loop:

1. **Add `verify` as an action** and **the verdict as an input.** Today the
   decision reasons only over thread *state*; give it the last verify-thread's
   verdict. `finish-loom` (`tick.ts:109`) must require a green `ALL` verdict, not
   just child `done` (which came from self-report in §2).
2. **Distinguish transient from terminal.** `tick.ts:114` escalates on
   `state === "failed"` with no idea the child is mid-retry. Escalate only on
   *terminal* failure (own retries exhausted); a transient failure is "sensor says
   not-ready, keep sampling." This deletes the §2 premature-fail class outright.

**Convergence guards (build these in from the start — a spawn-until-done loop is
the classic runaway):**
- **Budget ceiling** (`charter.budget`, already present) + a hard max-iterations.
- **Progress detection** — diff verify results between iterations; if two passes
  surface the *same* unmet criterion unchanged, escalate instead of spinning.
- **Regression detection** — act on the *delta* of failing assertions, not the
  remaining set, to catch oscillation (fix A breaks B, fix B breaks A).
- **Human circuit-breaker** at boundaries (budget thresholds, N-iterations-no-
  progress) — extend the existing charter/acceptance gates.

---

## 8. Multi-agent build threads — one rule before you go there

Making threads multi-agent is right, and `fanout(threadId, pieces, agents)`
(`tick.ts:27`) is the primitive. The trap: **multi-agent *mutating* recreates the
collision one level down** — two agents editing the same files is the same
disaster as two builders on one DB (which §2 shows already happened). Pick the
coordination discipline before threads go multi-agent:

- **Disjoint partitions** — each agent owns non-overlapping files (the weave
  already partitions SubGoals this way; do it one level deeper), **or**
- **Sequential steps, single writer per step** — multi-agent across steps, one
  mutator within a step.

Multi-agent *verify* threads are safe by construction (read-only, no writers), so
that half is free. Only the mutating half needs the rule.

---

## 9. Phasing & what to build first

Environment substrate first (it unblocks both builder and verifier); then promote
verification; then close the loop. Each phase is independently shippable.

**Phase E — the lane (environment)**
- [ ] `servers.yaml` schema + loader (`schemas.ts`), driver `host-process`;
      `none` = today's static-url path, unchanged.
- [ ] Grow `run-server.ts` into a lane: `portStrategy` (fixed-probe vs
      dynamic-inject), `portInject`, templated `env`, real `readyCheck` replacing
      `defaultPoll`; per-lane `DATABASE_URL` to a template-cloned DB.
- [ ] Supervisor: continuous `healthcheck`, `restartPolicy`, crash-loop breaker,
      mid-edit tolerance window.
- [ ] Setup agent (pre-loom, in `preparing`): bring env up, diagnose, ask the
      human; authoring helper for a missing `servers.yaml`; fast-path probe.

**Phase V — verification as a thread**
- [ ] Assertion types `command`/`gate`/`db` + planner routing; deterministic
      assertions → `gates.ts`, off the browser.
- [ ] Promote `runPanel` to a scheduled `verify` thread-kind with its own frozen
      lane; multi-step pipeline (gates → evidence → panel → synthesis).
- [ ] Fix the `decide()` `panelRequired` drop (`executor.ts:209-214`).
- [ ] **MVP:** one `ALL` verify thread at end-of-orchestration (biggest gap today).

**Phase L — close the loop**
- [ ] `verify` action + verdict input in `tick.ts`; `finish-loom` requires a green
      `ALL` verdict.
- [ ] Transient-vs-terminal in the escalate path (`tick.ts:114`).
- [ ] Checkpoint verify threads per `subGoalId` (interleaved, §6.2).
- [ ] Convergence guards (§7) + human circuit-breaker.

**Moat check (every phase):** verification only ever produces a *verdict* and
*more work*. `ready → done` stays a human click; there is no `accept_loom`.

---

## 10. Open decisions to confirm before code

- **Lane granularity:** one DB clone per verify thread vs per SubGoal vs one
  frozen lane per checkpoint reused across that checkpoint's critics. *(Lean:
  per-checkpoint lane, critics share the frozen read-only clone.)*
- **Worktree cost:** always worktree-per-lane vs only when a build and verify
  would otherwise overlap. *(Lean: worktree only when concurrency demands it;
  read-only verify on a clean tree can checkout-detach a commit.)*
- **Setup agent reach:** may it run `docker`/`supabase` commands autonomously, or
  only ask? *(Lean: auto-run declared `readyCheck`/`reset`; ask before anything not
  in `servers.yaml`.)*
- **`portStrategy` default** when a project doesn't declare one — `dynamic+env:PORT`
  vs require explicit declaration. *(Lean: require it in `servers.yaml`; no silent
  hardcoded localhost — the long-standing objection.)*
