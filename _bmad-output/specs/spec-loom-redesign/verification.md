# Verification — Labs, Isolation, Evidence

Companion to `SPEC.md` (CAP-4, CAP-10 through CAP-13, CAP-16, CAP-18). The recipe's parameter grid is in `recipe-schema.md`; its machine-readable draft is `recipe.schema.yaml` in the verification brainstorm folder.

## The core inversion

Agents never spawn services — they **declare** them via a tool call. Telar's supervisor spawns, owns, probes, restarts on death, and tears down. Ownership by construction; orphans impossible by design.

- **One primitive, two lifetimes.** The same supervisor serves **sessions** (in-chat background processes) and **looms** (verification labs). Only owner and lifetime differ.
- **Leases persist ownership.** Generalize the existing runner-lease shape (`~/.telar/looms/<id>/.runner-lease`: `{pid, token, ts}`, heartbeated, stale-reclaim) into a per-owner service-lease registry. One token enumerates and tears down everything a run created, touching nothing else.
- **Idempotent ensure.** `ensure_service(name)` reuses a live lease rather than spawning a duplicate — this kills the duplicate-dev-server failure mode by design, not by convention.
- **The UI reads the registry**, so processes surface for both sessions and looms, not only the terminal that spawned them.

The agent-facing tool surface is modeled on Claude Code's typed event shape (start / progress / notification, stop-by-id), not raw PTY polling — that typed shape is what makes "agents declare" real.

## Two altitudes

| Altitude | Question | Shape | Cost |
|---|---|---|---|
| **Thread** | "Does the code hold?" | review-style: code review + checks/tests, serviceless, streaming, parallel | cheap, always runs |
| **Loom** | "Is this what you asked?" | full lab standup: playground, live Playwright, capability-walled agents, evidence out | expensive, gated |

- **HARD RULE:** only one loom verification per repo at a time (per-repo verification mutex).
- Thread-altitude rungs (review findings, tests, gates) stream live and **double as the progress heartbeat** — this is what makes stall detection free.
- Surface evidence events (loom verify, landing re-verify) also count under the mutex.

This two-altitude split is what unsticks the standing failure where threads never reached approval, and it is what closes the loop on full implementation testing.

## Borrow, don't hold

A lab does **not** live as long as the loom. Verification is event-based (landings, final ALL-verify), so heavy infra is leased **just-in-time per verify round** and released.

- **Per-service scope:** `project` (heavy shared infra — Postgres/Supabase — under a refcounted lease) · `loom` (the app server, warm) · `ephemeral` (preview lanes and frozen final verifies).
- **One server per line of development.** The loom's warm lane is the single window; there are no per-thread servers. "Want thread progress? Open the loom's URL." A per-thread preview lane was floated and not adopted — the DB constraint is real: a Supabase CLI stack is too heavy to run per loom, so it is one heavy stack at a time, never N.
- **Window on demand.** For heavy projects, opening the window *is* the pull that borrows the stack: the lane stands while you look and releases after. Infra-free projects keep always-warm windows.
- **Window concurrency per project is a function of `isolation`, not a constant.** `mutex` (Supabase-gateway, reset-on-acquire) permits one live window per project and forbids a window coexisting with a loom verification there, since the verify's acquire resets the DB under the viewer. `tenant-db` and `schema` permit one window per loom. `none` — the majority of the surveyed fleet — keeps always-warm windows per loom. Requests beyond the permitted count queue and name their holder; they never displace a live window or a running verify. Derived from the isolation parameter rather than recorded in the session: the memlog scopes both its mutex statements to *verifies* and never rules on windows.
- **Fleet heavy-infra semaphore:** 1–2 concurrent stacks by default, queue beyond. Dissolves the RAM fear via time-sharing and doubles as the fix for fleet-wide stock-port collisions (4+ surveyed projects sit on Supabase's default 54321-9).
- **Same-project looms share the project stack** by refcount.

### Data isolation diverges by backend shape

- **Plain Postgres → tenant-db.** Each loom's branch migrations applied to its own tenant, stamped from a **template DB keyed by migration-hash** (cheap file-level copy; validated against a 698-migration project, resets in ~1s).
- **Supabase-gateway mode** (auth / PostgREST / storage all pointed at one DB) → **mutex + reset-on-acquire**, made cheap by the same template cache.

The final ALL-verify recomposes as: cold app checkout + shared warm infra + fresh tenant data from template — evidence purity where it binds, without re-paying the infra boot.

## Worktree doctrine

One working directory holds one checked-out branch. Concurrent same-project looms therefore require separate materializations; there is no way around this.

- The user's primary checkout is **sacred** — sessions attach here, looms never touch it. Sessions may adopt a user-hand-started stack.
- **Worktree-per-loom is mandatory** — where the loom branch lives, the warm lane runs, landings update, and carry files are planted.
- **Worktree-per-thread is optional-but-preferred** for collision avoidance; a single serial thread may work directly in the loom's worktree.
- **Branch-per-loom is constitutional.** Looms never share a branch.
- **Stacked looms** (B based on A's branch) are an explicit declared relationship, never implicit: B verifies against A+delta, and landing order constrains B-after-A.

### Worktree lifecycle and disk

Worktrees share the git object database, so their cost is the working tree — and in practice `node_modules`, which is untracked and must exist per worktree for thread-altitude checks and tests to run at all.

- **Thread worktrees reap at land**, the moment their work folds into the loom branch. Peak disk therefore tracks threads running now, not threads the loom has ever run. The trade accepted: a landed thread's exact working state is gone and is re-derived from the branch.
- **The loom worktree survives until accept and landing complete.** It cannot be reaped at delivery — boomerang keeps "its branch, worktree, and recipe" so a rejected loom resumes cheap, and a parked loom may resume days later under a different account.
- **Dependencies come by APFS copy-on-write clone** of the loom worktree's install (near-zero disk until a file is modified, each worktree still independently mutable), falling back to a full `prepare.install` where clonefile is unavailable. Symlinking one shared `node_modules` was rejected: postinstall scripts, native binaries and bun's hoisted store make shared mutable state across parallel threads a source of confusing cross-thread failures.
- **Cleanup failure is best-effort except where secrets were carried.** The existing calls (`build-fanout.ts`, `verify-thread.ts`, `executor.ts`) swallow removal failures, and `reapOrphanWorktrees` from `dispatcher.ts` is the crash safety net, keyed on the `telar-wt-` prefix so it never touches the user's main checkout or their own worktrees. Inherit all of it — but a worktree that held carry files and resists removal escalates as dire, naming the path.

### Trust wall

Sessions may adopt a foreign, user-hand-started stack. **Looms never may.** Evidence must come only from telar-owned labs. Adoption is allowed for working, forbidden for proving.

## Two proof layers

1. Each loom proves its own branch **concurrently**, in its own borrowed lab.
2. The fleet **landing queue** proves combinations **serially**: rebase onto moved main → re-verify the same contract (under the mutex) → merge.

### Accept-then-land

The human judges branch evidence first; landing is mechanical afterward. Land-then-accept was rejected: it stalls the queue on human latency. The human judges the **product** the loom came out with, after its own verify/repair loop converged.

Post-accept landing outcomes:

- clean rebase + contract pass → lands **silently**;
- landing repair had to modify code → a **delta note** surfaces on the done card;
- contract failure → **re-opens repair**, and knocks only when repair is exhausted.

Rejection is a **boomerang, not a bin**: the loom keeps its branch, worktree and recipe, and resumes cheap.

## The five promises

1. "I'll tell you what I can't prove — before you spend."
2. **"You can always look; I'll only knock when it's dire."** — ranked most critical.
3. "Evidence ran on a clean real copy — never a mock, never leftovers, never production."
4. "I share the heavy stuff — a fleet won't melt your machine."
5. "When we're done, it's like I was never here."

The scarce resource is not spend, it is **wall-clock time under false confidence**. The worst failure is a **silent stall** — hours lost believing the project advances while nothing moved. Silence must be a guarantee, not an absence of noise.

### The dire razor

**Dire := the loom has no viable path to advance without the human** — stall, park, credential wall, crash-loop, credit exhaustion → push. Everything else (a failed test entering repair, a flaky boot being retried) → window only.

Two liveness layers make this decidable:

- the **supervisor** watches *process* liveness (restart on death, crash-loop breaker) — exists in production today;
- the **orchestrator** watches *progress* liveness — a heartbeat of advancement (evidence rungs, landings, verify rounds). Flatline for N minutes is dire **even when every process is green**.

Pushes are **awareness-only**. Telar is a local, no-auth desktop cockpit; nothing can be solved from a phone. The knock kills false confidence — you know it stopped and why, and it resumes when you are back. Acting stays at the desktop.

Mid-run escalation asks the **orchestrator first** (mediation), the user only if unresolved. This preserves two standing invariants for free: children escalate to mediation, never straight to humans; and the human is knocked only when no other path remains.

## Courtroom countermeasures

Four decisions make evidence trustworthy:

1. **Lab grades — dev vs release.** Landings verify at dev grade for speed; the accept-gating ALL-verify and the post-accept landing re-verify run at release grade.
2. **Evidence ledger.** Harness-captured artifacts, provenance-stamped. The narrative **must cite artifacts**; uncited claims are marked unverified.
3. **Attempt history + flaky flag.** Every verify attempt is kept on the card's history, not just the last; flaky boots and tests get flagged rather than silently retried into invisibility.
4. **Reality manifest.** Degraded modes are declared in the recipe ("without secret X: data synthetic, features Y off" — the contract narrows explicitly instead of flows hanging) and surfaced on the delivery card: which mode the lab actually ran in.

Evidence is **one subsystem wearing three hats** — proof for the card (accept), proof-of-life for the heartbeat (stall detection), forensics for the courtroom (ledger + provenance). Design it once; it serves all three.

## Decision-tree resolutions

- **Cheap state-diff vs re-prove.** Every loom start spends a few tokens diffing current project state against the last run's. Unchanged → trust the recipe. Drift → full re-prove by booting.
- **Degradation timing.** Degradation is a **prep-time** concern. The readiness node surfaces it before the gate so the user decides with full knowledge before any spend. It never surfaces mid-run.

## Implementation seeds

Verified file references from the session's codebase research; see `brownfield.md` for the fuller as-built picture.

- **Unbundle the lane/supervisor stack** from the verify-only path: `run-server.ts` (`startProjectServer`, `startLane`, `killTree`, `findFreePort`) + `supervisor.ts` (process-liveness loop, crash-loop breaker) are currently reachable only from privileged verify/setup code — generalize for agent-tool use.
- **Generalize the runner-lease pattern** (`runner/lease.ts`) into a per-owner service-lease registry; natural home `TELAR_HOME/projects/<id>/looms/<loom-id>/services/<name>.json`, under the canonical per-loom root (the legacy flat `~/.telar/looms/<id>/` tree is read-only for pre-redesign looms — see `map-and-storage.md`). No per-chat-session directory exists yet under `TELAR_HOME` — close that gap alongside.
- **Wire the dead `weave.ts` `preparing`-phase `runSetup` hook** — flag-off in production today (only the reactive repair-time `mediateThread` path runs `runSetupAgent`). This is the natural readiness/lab-standup slot; `preparing` already exists as a state and is currently a no-op pass-through.
- **Build the agent-facing `ensure_service` tool surface** on the typed event shape described above.

## Priority projects for MVP recipe coverage

1. **ozom-gv** — gold standard: its `kickstart.ts` is already a verification recipe in shell form (idempotent, non-interactive-safe, preflights docker/supabase, seeds, three-layer `bun run verify`). Cheapest path to a first working recipe; also the reference case for `carry` and degraded-mode declaration.
2. **orchestrator** — polyglot stress test: 5 services / 3 languages, a portless+sudo wrapper dependency to strip, a broken documented seed path, a wrong test gate (misses 130+ Python tests), no aggregate health signal. Proves the schema against real heterogeneity.
3. **telar itself** — dogfooding: looms build telar under a sandboxed `TELAR_HOME`. Recursive proof.
