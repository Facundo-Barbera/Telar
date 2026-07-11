# Telar — Roadmap & Path to Success

> **Thesis:** Generation is solved; **verification is the moat.** A loom never
> auto-accepts its own work — a human accepts, always. Everything below is in
> service of making that trustworthy, observable, and drivable from where you work.

This file is the **living work tracker** (it replaces the ephemeral todo list).
Edit it freely: check boxes as things land, add items under the right phase, move
the **▶ You are here** marker as the frontier advances. Keep entries one line;
link to a design doc when one exists.

**Definition of success:** you can hand Telar a real multi-issue objective, watch
it fan out into Threads, *see why* each one passed or stalled, steer/accept/reject
it from your session, and trust that nothing reaches `done` without your sign-off —
all while it keeps running if you reload or walk away.

**Design docs:** [`loom-model.md`](./loom-model.md) ·
[`loom-orchestrator.md`](./loom-orchestrator.md) ·
[`runtime-architecture.md`](./runtime-architecture.md) ·
[`verifier-agent.md`](./verifier-agent.md) ·
[`watchers-design.md`](./watchers-design.md) ·
[`mcp-oauth-design.md`](./mcp-oauth-design.md) ·
[`phase-2-runner-plan.md`](./phase-2-runner-plan.md) ·
[`verification-environments.md`](./verification-environments.md)

---

## Phase A — A single loom you can trust end-to-end &nbsp;`▶ You are here`

Make one woven loom fully usable: it plans, fans out, verifies, and every terminal
state is recoverable and legible.

- [x] Weave-planner — bundle looms decompose into parallel Threads (no more single-agent collapse)
- [x] Owner actions on Threads — accept / steer / reject / resume, moat-protected root
- [x] Failure legibility — failing gate/critic/verdict surfaced; woven cost aggregated
- [x] Turn cap is liftable — `maxTurns` override in `~/.telar/policy.json` (default rails stay)
- [x] `reDispatch` never strands a loom in `queued` — setup failures land in `failed` with the reason
- [x] Report is concise + markdown-rendered + roomier transcript
- [x] **Guard project config (#44)** — self-healing manifest cache: a wiped `telar.yaml` restores from the registry's last-good copy instead of bricking the project (malformed still errors)
- [x] **Boot / crash recovery (P5)** — `reconcileStuckLooms()` runs on server boot and marks in-flight-but-runnerless looms `failed`/resumable (no more hand-unsticking)
- [ ] **Validate the repair leg live** — prove builder → verify → repair → pass on a real task _(gated on Phase C's lane + Phase E's verification/loop: for a no-UI loom verification silently never runs, builders collide in a shared lane, and the tick loop escalates on the first transient failure — [`verification-environments.md`](./verification-environments.md) §2, §4/§5, §7)_

## Phase B — Drive looms from where you work

The session that plans a loom should also be able to steer it, and watch it in the
background — the session as cockpit. _(Decisions locked: steer/reject/resume/cancel
are agent-drivable on any loom on request; **accept stays a human click**. Watchers
are a true background process — you keep chatting; it reacts when state changes.)_

- [x] **Session → loom control tools** — `steer_loom` / `reject_loom` / `resume_loom` / `cancel_loom` MCP tools, auto-run, default to the linked loom (moat: no `accept_loom`)
- [x] **Watchers (v1 client-driven)** — a session watches a loom, reacts to state changes, surfaces a card + injects a follow-up turn without blocking the chat. **Designed → [`watchers-design.md`](./watchers-design.md)**; v2 (tab-closed) rides Phase C
- [ ] **`.telar/` per-project config dir** — gitignored home for `telar.yaml` & friends; easier to track, harder to clobber

## Phase F — Telar-owned MCP auth (current priority)

MCP servers (Supabase, GitHub…) bind their OAuth login to the account that logged
in — so switching execution account breaks the MCP. Telar owns the login as the
OAuth client, storing the token in its account-decoupled project store. **Designed →
[`mcp-oauth-design.md`](./mcp-oauth-design.md)** (CIMD → DCR → manual client ladder;
strictly more capable than Claude Code's DCR-only).

- [x] **Stage A — core OAuth engine** — PRM/AS discovery, client-identity ladder, PKCE, token exchange + refresh, record store; SSRF/state/audience/redirect guards; mocked-fetch tests
- [x] **Stage B — connect flow + UI** — connect/callback/status/disconnect routes + PKCE-state pending store, `mcp.ts` auto-inject + best-effort refresh-on-resolve, Connect/Reconnect/Disconnect UI. _(Live Supabase: both ozom-gv servers connect green.)_
- [x] **Loom agents use the project MCP servers** — verifier + critic now get the same read-only servers as the builder (URL-enforced `?read_only=true`); the project's Manifest rail surfaces each server's live health + an inline Connect shortcut
- [ ] **v2 — CIMD hosted client-doc** — stand up the client-metadata URL to flip the top tier on

## Phase C — Durable execution & the environment lane

Today looms run inside the web dev-server process, so a code edit or reload can kill
in-flight work — and there's no reproducible substrate to build or verify against.
Move execution out of process, and give every loom a self-healing **environment
lane** (`{ worktree @ commit, database, running services }`) — the substrate that
unblocks both the builder and the verifier.

- [ ] **Phase 2 — `telar-runner`** — out-of-process execution → see [`phase-2-runner-plan.md`](./phase-2-runner-plan.md)
- [x] **Environment lane — `servers.yaml`** — per-project service recipe (schema + loader), `host-process` driver; `none` = today's static-url path, unchanged (`bd2c6de`, §4)
- [x] **Grow `run-server.ts` into a lane** — `startLane`: `portStrategy` (fixed-probe vs dynamic-inject), `portInject`, templated `env`, real `readyCheck` replacing `defaultPoll` (`53663fe`, §4.2). _Per-lane `DATABASE_URL` template-clone rides the frozen lane (Phase E)._
- [x] **Service supervisor** — continuous `healthcheck` + `restartPolicy`, crash-loop breaker, mid-edit tolerance window so it won't fight the builder (`2a020a0`, §4.4)
- [ ] **Setup agent** (pre-loom, in the `preparing` state) — bring the env up, diagnose, ask the human; author a missing `servers.yaml`; fast-path `readyCheck` probe (§4.3)
- [ ] **Keychain-backed MCP token storage** _(deferred)_

## Phase E — Verification: real, looped, live-proven

_(Sequenced ahead of Phase D — a Thread isn't trustworthy to widen until
verification actually runs and loops.)_ Today auto-verification silently doesn't run
for no-UI looms and sits at the leaf as a terminal gate
([`verification-environments.md`](./verification-environments.md) §2). Make it a real
signal: promote it to a scheduled **read-only thread-kind** run against a frozen
snapshot, feed its verdict back into the tick loop so an unfinished loom continues,
then prove depth on live features.

- [x] **Assertion routing** — `command`/`gate`/`db` assertion kinds + deterministic routing to `gates.ts`, off the browser, so a backend loom verifies with no target (`ff83eb3`, §6.1)
- [x] **Fix `decide()` `panelRequired` drop** — a required-but-skipped panel now retries / needs-review instead of a silent pass (`ff83eb3`, §6.1)
- [x] **MVP — one `ALL` verify thread at end-of-orchestration** — the integration-verify producer runs one ALL-scope verify after a woven loom's children finish (`b33631a`, §6.2)
- [x] **Verdict gates the terminal state** — a red `ALL` verdict demotes a woven loom `ready → needs-review` (broken whole can't clean-accept); green → `ready` (`06761af`, §7)
- [x] **Transient-vs-terminal escalate** — tick escalates only on *terminal* failure (retries exhausted), tolerating a thread mid-retry — unblocks Phase A's repair-leg proof (`ccdd9f8`, §7)
- [ ] **Verify thread-kind (frozen lane)** — promote the integration verify to a scheduled **read-only** thread on a frozen lane (worktree @ commit + template-cloned DB) + gates → evidence → panel → synthesis (§3, §6). _Needs a live Postgres — validate live._
- [ ] **Auto-repair loop + convergence guards** — verify → repair → re-verify, bounded by budget + max-iterations + progress/regression detection + a human circuit-breaker (§7). _Runaway-prone — validate live._
- [ ] **Checkpoint verify threads** per `subGoalId` — interleaved per-SubGoal verifies + a final `ALL` integration verify (§6.2)
- [ ] **M3 distillation** — green-run acceptance + spec-lint gate wiring (exploratory run → deterministic `.spec.ts`)
- [ ] **M4 monitoring** — cron trigger + prod guardrails + terminal-state alert hook
- [ ] **M6 design-QA** — prove design findings on an ugly-but-functional feature
- [ ] **M5 hardening & scale**

_Moat (every item above): a green verify-thread only lands a loom `ready` and spawns
more **work**, never acceptance — `ready → done` stays a human click, the verifier
stays read-only, and there is no `accept_loom`._

## Phase D — Scale the weave & the roster

Once one Thread is trustworthy — verification actually runs and loops (Phase E) —
widen it.

- [ ] **Sub-thread build fan-out** — wire `splitBuild`/`decideBuildFanout` so a Thread can use N parallel builders (built in M7.3b, never wired)
- [ ] **Disjoint-partition rule** — each agent owns non-overlapping files, or sequential steps with one writer per step, so multi-agent *mutating* threads don't recreate the shared-lane collision ([`verification-environments.md`](./verification-environments.md) §8)
- [ ] **P4 — dynamic weaver** — methodology-neutral extraction; the Verification Contract becomes the proof, not an enumerated strategy
- [ ] **Curated agent roster** — via the SDK `agents` option

## Housekeeping

- [ ] Account `displayTier` plan labels (5x / 20x) + in-app login UI
- [ ] Clean up `[demo]` looms _(pending explicit OK — no `rm` without authorization)_
- [ ] Orphaned untracked `apps/web/components/looms/loom-view.tsx` — references non-existent `deriveSteps`/`StepAgent`/`WeaveStep`, breaks `apps/web` tsc; nothing imports it (delete or finish)

---

_Last frontier update: a full autonomous build run shipped the hermetically-verifiable
core of the **verification-environments** design. **Phase C lane substrate** is done —
`servers.yaml` schema+loader (`bd2c6de`), `run-server` → `startLane` with real
`readyCheck` (`53663fe`), and the service supervisor (`2a020a0`). **Phase E** now has
deterministic **assertion routing** so a backend loom actually verifies with no browser
+ the `decide()` `panelRequired` fix (`ff83eb3`), the **transient-vs-terminal** escalate
fix (`ccdd9f8`), the end-of-orchestration **integration-verify producer** (`b33631a`),
and the **verdict gating the terminal state** — a red `ALL` verdict now demotes a woven
loom to `needs-review` so a broken whole can't clean-accept (`06761af`). Plus the
override-from-`queued` + no-sweep-landing fix (`fd58885`). Every unit was two-verifier
checked; the moat held throughout (green → `ready`, never `done`).
What remains is **live-validation-dependent**, deliberately not built blind: the
**frozen-lane** verify thread (real Postgres template-clone, §5 Supabase wrinkle) and
the **auto-repair loop + convergence guards** (runaway-prone). Next: **prove the repair
leg live** on a real project (Phase A) — it's now unblocked, and the live run resolves
the §10 lane-granularity open decisions that the frozen lane needs. Prior: Phase F Stage
A+B (MCP reaches every loom agent read-only); Phase B.1 steering + v1 watchers + P5
boot-recovery._
