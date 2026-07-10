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
[`phase-2-runner-plan.md`](./phase-2-runner-plan.md)

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
- [ ] **Validate the repair leg live** — prove builder → verify → repair → pass on a real task

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
- [x] **Stage B — connect flow + UI** — connect/callback/status/disconnect routes + PKCE-state pending store, `mcp.ts` auto-inject + best-effort refresh-on-resolve, Connect/Reconnect/Disconnect UI. _(Live Supabase test pending — yours to run.)_
- [ ] **v2 — CIMD hosted client-doc** — stand up the client-metadata URL to flip the top tier on

## Phase C — Durable execution (out-of-process)

Today looms run inside the web dev-server process, so a code edit or reload can kill
in-flight work. Move execution out of process so runs survive.

- [ ] **Phase 2 — `telar-runner`** — out-of-process execution → see [`phase-2-runner-plan.md`](./phase-2-runner-plan.md)
- [ ] **Run initializer** — per-loom environment + dedicated app server (dynamic verify URL)
- [ ] **Keychain-backed MCP token storage** _(deferred)_

## Phase D — Scale the weave & the roster

Once one Thread is trustworthy, widen it.

- [ ] **Sub-thread build fan-out** — wire `splitBuild`/`decideBuildFanout` so a Thread can use N parallel builders (built in M7.3b, never wired)
- [ ] **P4 — dynamic weaver** — methodology-neutral extraction; the Verification Contract becomes the proof, not an enumerated strategy
- [ ] **Curated agent roster** — via the SDK `agents` option

## Phase E — Verification depth, live-proven

The moat is only real if it's demonstrated on live features.

- [ ] **M3 distillation** — green-run acceptance + spec-lint gate wiring (exploratory run → deterministic `.spec.ts`)
- [ ] **M4 monitoring** — cron trigger + prod guardrails + terminal-state alert hook
- [ ] **M6 design-QA** — prove design findings on an ugly-but-functional feature
- [ ] **M5 hardening & scale**

## Housekeeping

- [ ] Account `displayTier` plan labels (5x / 20x) + in-app login UI
- [ ] Clean up `[demo]` looms _(pending explicit OK — no `rm` without authorization)_

---

_Last frontier update: Phase A down to just a live repair-leg proof; Phase B.1
steering + P5 boot-recovery shipped, watcher design drafted. Next fork: build the
**v1 watcher** now (tab-open-only) or pull **Phase C** forward so watchers ship
tab-closed-capable._
