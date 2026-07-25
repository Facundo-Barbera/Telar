# Loom Verification — Intent

> Source: brainstorming session 2026-07-18 → 2026-07-22 (`.memlog.md` in this folder is the canonical log; `schema-grid.md` holds the fleet-validated recipe grid; research-1 through research-6 are the empirical backing). Verification-side sibling of `../brainstorm-loom-system-2026-07-18/brainstorm-intent.md` — both feed `bmad-spec`, alongside a still-pending UI/UX session. Chosen and critical discoveries only; no session narrative.

## The core inversion

- Agents never spawn services — they **declare** them via a tool call. Telar's supervisor (the lane stack that already exists for the verify path but is unreachable from agent tools) spawns, owns, probes, restarts-on-death, and tears down. Ownership by construction; orphans impossible by design.
- **One primitive, two lifetimes**: the same supervisor serves **sessions** (in-chat background processes, CC-style) and **looms** (verification labs). Only the owner and lifetime differ.
- **Leases** persist ownership — generalize the existing runner-lease shape (`~/.telar/looms/<id>/.runner-lease`: pid/token/ts, heartbeated, stale-reclaim) into a per-owner service-lease registry. One token enumerates and tears down everything a run created, touching nothing else.
- **Idempotent ensure**: `ensure_service(name)` reuses a live lease instead of spawning a duplicate — kills the CC/Codex duplicate-dev-server failure mode (CC issue #9780) by design, not by convention.
- **The UI reads the registry**: processes surface for both sessions and looms, not just the terminal that spawned them.

## Two-altitude verification + the per-repo mutex

| Altitude | Question | Shape | Cost |
|---|---|---|---|
| Thread | "Does the code hold?" | bmad-review-style: code review + checks/tests, serviceless, streaming, parallel | cheap, always runs |
| Loom | "Is this what you asked?" | Full lab standup: playground, live Playwright, capability-walled agents, evidence out | expensive, gated |

- **HARD RULE**: only one loom verification per repo at a time (per-repo verification mutex) — heavy infra is never duplicated for concurrent verifies of the same repo.
- This unsticks the standing bmad failure (threads never reaching approval) and enables full implementation testing — the loop finally closes.
- Streaming/mid-run evidence = thread-level rungs (review findings, tests, gates: live, cheap, doubles as the progress heartbeat). Surface evidence = verification events (loom verify, landing re-verify) — both count under the mutex.

## Borrow-don't-hold heavy infra

- Per-service `scope`: **project | loom | ephemeral**. Heavy infra (Postgres/Supabase) shared at **project** scope under a refcounted lease; app server **loom**-scoped and warm; **ephemeral** for previews and frozen final verifies.
- Exposed hidden assumption: a lab does **not** live as long as the loom. Verification is event-based (landings, final ALL-verify), so heavy infra is leased **just-in-time per verify round** and released.
- Fleet-level **heavy-infra semaphore**: default 1-2 concurrent stacks, queue beyond — dissolves the RAM fear via time-sharing and doubles as the fix for fleet-wide stock-port collisions (4+ surveyed projects sit on Supabase's default 54321-9).
- Same-project looms **share** the project stack (refcount). Data isolation diverges by backend shape:
  - plain Postgres → **tenant-db**: each loom's branch migrations applied to its own tenant, stamped from a **template DB keyed by migration-hash** (cheap file-level copy; validated against a 698-migration project, resets ~1s).
  - Supabase-gateway mode (auth/PostgREST/storage all point at one DB) → **mutex + reset-on-acquire**, made cheap by the same template cache.
- Final ALL-verify recomposes as: cold app checkout + shared warm infra + fresh tenant data from template — evidence purity where it binds, without re-paying the infra boot.

## Worktree doctrine, branch-per-loom, landing queue

- Ground truth: one working directory = one checked-out branch. Concurrent same-project looms require separate materializations — there is no way around this.
- Doctrine:
  - User's primary checkout is **sacred** — sessions attach here, looms never touch it; sessions may adopt a user-hand-started stack.
  - Worktree-per-**loom** is **mandatory** — where the loom branch lives, the warm lane runs, landings update, carry files are planted.
  - Worktree-per-**thread** is **optional-but-preferred** (collision avoidance); a single serial thread may work directly in the loom's worktree.
- **Branch-per-loom is constitutional**: looms never share a branch.
- Two proof layers: each loom proves its own branch **concurrently** in its own borrowed lab; the fleet **landing queue** proves combinations **serially** — rebase onto moved main → re-verify same contract (under the mutex) → merge.
- **Stacked looms** (loom B based on loom A's branch) are an explicit declared relationship, never implicit: B verifies against A+delta; landing order constrains B-after-A.

## Accept-then-land; boomerang

- Ordering: human judges the branch evidence first (**accept**); landing (rebase + re-verify) is mechanical afterward. Alternative (land-then-accept) rejected — it stalls the queue on human latency.
- Judge the **product** the loom came out with, after its own verify/repair loop converges — final judgment on the ready product, "so I can see it in work."
- Post-accept landing: clean rebase + contract-pass lands silently; if landing repair must modify code, a delta note surfaces on the done card; contract-fail re-opens repair and knocks only when repair is exhausted.
- Rejection is a **boomerang, not a bin**: the user can send the loom back with feedback to finish what it started. The loom keeps its branch, worktree, and recipe — resumes cheap.

## The five promises

1. "I'll tell you what I can't prove — before you spend."
2. **"You can always look; I'll only knock when it's dire."** — ranked most critical: the worst failure is a **silent stall** (hours lost believing the project advances while nothing moved).
3. "Evidence ran on a clean real copy — never a mock, never leftovers, never production."
4. "I share the heavy stuff — a fleet won't melt your machine."
5. "When we're done, it's like I was never here."

- The scarce resource isn't spend, it's **wall-clock time under false confidence**. Silence must be a guarantee, not an absence of noise.
- **The dire razor**: dire := the loom has no viable path to advance without the human (stall, park, credential wall, crash-loop, credit exhaustion) → push. Everything else (a failed test entering repair, a flaky boot being retried) → window only.
- **Two liveness layers**: supervisor watches **process** liveness (restart-on-death, crash-loop breaker — exists today); orchestrator watches **progress** liveness — a heartbeat of advancement (evidence rungs, landings, verify rounds). Flatline for N minutes = dire even when every process is green.
- Pushes are **awareness-only**: telar is a local, no-auth desktop cockpit — there is currently no way to *solve* anything from the phone. The knock kills false confidence (you know it stopped and why; it resumes when you're back); acting on it stays at the desktop.

## Courtroom countermeasures (evidence trustworthiness)

Three verdicts, approved:

1. **Lab grades** — dev vs release. Landings verify at **dev grade** for speed; the accept-gating ALL-verify and the post-accept landing re-verify run at **release grade**.
2. **Evidence ledger** — harness-captured artifacts, provenance-stamped; the narrative must cite artifacts. Uncited claims are marked unverified.
3. **Attempt history + flaky flag** — every verify attempt is kept on the card's history, not just the last; flaky boots/tests get flagged rather than silently retried into invisibility.

Plus a schema-level decision from the same evidence-trust thread (predates the courtroom technique but belongs with it):

4. **Reality manifest** — degraded modes are declared in the recipe ("without secret X: data synthetic / features Y off" — the contract narrows explicitly instead of flows hanging) and **surfaced on the delivery card**: which mode the lab actually ran in (real vs synthetic data, which services degraded).

- Synthesis: evidence is one subsystem wearing three hats — proof for the card (accept), proof-of-life for the heartbeat (stall detection, promise 2), forensics for the courtroom (ledger + provenance). Design it once, it serves all three.

## Decision-tree resolutions

- **Cheap state-diff vs re-prove**: every loom start spends a few tokens diffing current project state against the last run's. Unchanged → trust the recipe. Drift → full re-prove by booting.
- **Degradation timing**: degradation is a **prep-time** concern. The readiness node surfaces it before the gate so the user decides with full knowledge before any spend — it should not surface mid-run.
- **Mid-run escalation (rare case)**: ask the **orchestrator first** (mediation), then the user only if unresolved. Preserves two standing invariants for free: children escalate to mediation, never straight to humans; the dire razor (human is knocked only when no other path remains).

## The recipe schema (16 parameters)

- Full grid, fleet-validated against 5 archetypes (ozom-gv, orchestrator, bixkuOS, happy-path, no-server): `schema-grid.md` in this folder — no column broke the schema. Canonical machine-readable form: `recipe.schema.yaml` (still to be authored downstream; `schema-grid.md` is its source draft).
- Parameter groups (see grid for full option sets): **prepare** (install, generate, migrate, seed, `carry`, requirements) · **services** (command, scope, readiness, portInject, update, teardown) · **data** (isolation, class, template stamp) · **verify** (strategy, entrypoints, evidence targets).
- Notable resolutions:
  - **`carry`** (the one genuinely novel field, absent from all prior art surveyed): gitignored-but-required files to propagate into worktree/lab checkouts (e.g. ozom-gv's `supabase/.env.keys`) — a lab-checkout property, not a loom property (applies to ephemeral previews too).
  - **Prepare is first-class**: install → generate → migrate → seed are run-once steps with their own requirement checks, validated by actual execution — not by reading docs (docs lied in multiple surveyed projects).
  - **Data classification**: disposable | shared-dev | production; **production = refuse surface-verify, fail closed** (a surveyed project's documented dev path pointed at live prod Supabase — a real, not hypothetical, danger).
  - **Recipe = map region** (per the loom-system redesign) that compiles to `servers.yaml` + prepare/carry/verify sections — the map region is source of truth, compiled files are what the lane consumes.
  - **Lane owns the server**: project-owned e2e suites (Playwright, etc.) reuse it via `PORT` + `reuseExistingServer` rather than launching their own nested webServer.

## Trust wall

- **Sessions** may adopt a user-hand-started foreign stack (convenience; attach as owner).
- **Looms never** — evidence must come only from telar-owned labs. Adoption is allowed for working, forbidden for proving.

## Implementation seeds (file refs, from research-3)

- **Unbundle the lane/supervisor stack** from the verify-only path: `run-server.ts` (`startProjectServer`, `startLane`, `killTree`, `findFreePort`) + `supervisor.ts` (process-liveness loop, crash-loop breaker) are currently reachable only from privileged verify/setup code — generalize for agent-tool use.
- **Generalize the runner lease pattern** (`runner/lease.ts`: `{pid, token, ts}`, heartbeat, stale-reclaim) into a per-owner service-lease registry; natural home `~/.telar/looms/<id>/services/<name>.json`. No per-chat-session directory exists yet under `TELAR_HOME` — close that gap alongside.
- **Wire the dead `weave.ts` `preparing`-phase `runSetup` hook** — currently flag-off in production (only the reactive repair-time `mediateThread` path runs `runSetupAgent`). This is the natural readiness/lab-standup slot in the loom lifecycle; `preparing` already exists as a state, currently a no-op pass-through.
- **Build the agent-facing `ensure_service` tool surface** modeled on Claude Code's typed event shape (start/progress/notification + stop-by-id), not Codex's raw PTY polling — this is what makes "agents declare" real.

## Priority projects (MVP recipe coverage)

1. **ozom-gv** — gold standard: `kickstart.ts` is already a verification recipe in shell form (idempotent, non-interactive-safe, preflights docker/supabase, seeds, three-layer `bun run verify`). Cheapest path to a first working recipe; also the reference case for `carry` and degraded-mode declaration.
2. **orchestrator** — polyglot stress test: 5 services / 3 languages, portless+sudo wrapper dependency to strip, a broken documented seed path, a wrong test gate (misses 130+ Python tests), no aggregate health signal. Proves the schema against real heterogeneity.
3. **telar itself** — dogfooding: looms build telar under a sandboxed `TELAR_HOME`. Recursive proof — the system verifies its own next version.

## Flagged futures (explicitly out of scope this round)

- **Companion website** (Vercel-hosted): relay-only remote *answering* of blocked questions — local telar stays sole executor. Explicitly **not** remote accept; the human-accept moat deserves its own design pass first.
- **Preview-deploy verify tier**: v1 ships the `ephemeral` scope for "preview this thread" lanes and frozen final verifies (decided this session); a deeper productization — e.g. shareable preview URLs or verifying against an actually-deployed preview rather than a local lane — was not designed this session and is flagged for later.
- **Tenant-DB optimization** beyond v1's template-stamp-per-migration-hash (e.g. incremental stamping, warm pooling) — not designed this session.
- **Port remapping**: v1 serializes access to fleet projects on stock/colliding ports (schema-grid cell B); rewriting/overriding committed port config per project is a later optimization.

## Open threads deliberately left

> **Reconciled 2026-07-24** against `_bmad-output/specs/spec-loom-redesign/`, which is now the contract.

- **UI/UX session** runs next (per the loom-system intent's queued order) — needs this verification model as input.
  - **Done** — ran 2026-07-23; outcomes are in the spec and in `../brainstorm-loom-ux-ui-2026-07-23/`.
- **Final map-region taxonomy** research — still pending, per the loom-system intent; affects where the recipe region ultimately sits in the living map.
  - **Moot as posed.** Regions are declared by the project's loaded methodology, not fixed by the engine, so there is no universal set to discover. v1 ships one built-in BMAD-derived methodology whose declared regions include `verification.md` — the recipe region. (SPEC CAP-7.)

## Decided after the session (spec derivation, 2026-07-24)

Three things this session left implicit or unstated, resolved during spec derivation and now binding:

- **Window concurrency per project is a function of `isolation`, not a constant.** This session scoped both of its mutex statements to *verifies* ("serialize verifies against shared stack"; "only one loom verification per repo") and never ruled on how many live *windows* a project may have. Derived: `mutex` (Supabase-gateway, reset-on-acquire) permits exactly one live window per project and forbids a window coexisting with a loom verification there, since the verify's acquire resets the DB under the viewer; `tenant-db` and `schema` permit one window per loom; a DB-less project keeps always-warm windows. Requests beyond the permitted count queue and name their holder, never displacing a live window or a running verify.
- **Worktree lifecycle and disk.** Worktrees share the git object database, so the real cost is `node_modules` — untracked, required per worktree for thread-altitude checks, and unmanaged anywhere in core today. Thread worktrees are therefore reaped **at land**, so peak disk tracks threads running now rather than threads ever run; the loom's own worktree survives until accept and landing complete, because boomerang and park both resume from it. Thread worktrees get dependencies by APFS copy-on-write clone of the loom worktree's install (telar is mac/arm64 only), falling back to `prepare.install`. A shared symlinked `node_modules` was rejected — postinstall scripts, native binaries and bun's hoisted store make shared mutable state across parallel threads a source of confusing cross-thread failures.
- **Carried secrets and evidence retention.** `carry` plants files at mode `0600` and scrubs them at teardown, never copying them into evidence, the map, or an agent transcript. Worktree removal stays best-effort as it is in code today, with one exception: a worktree that held carry files and cannot be removed raises a dire escalation naming the path. Evidence inherits its recipe's data class — `disposable` retains freely, `shared-dev` is flagged on the reality manifest and never lands in-repo, `production` is already refused — and is reaped with its loom.
