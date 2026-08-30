# Environment Contract v1

*Normative spec for how Telar leases project environments. Rationale lives in
[`vision-2026-08.md`](vision-2026-08.md). The contract is deliberately dumb:
five verbs and a cost class. Telar never knows what Docker, Supabase, or any
other stack is — the project's scripts absorb all weirdness.*

## Where it lives

The contract file is **never committed to the project repo**. It lives in the
sidecar:

```
~/.telar/projects/<project-id>/env.yaml     # the contract mapping
~/.telar/projects/<project-id>/scripts/     # private glue, only if the repo lacks a verb
```

`<project-id>` is derived from the normalized git remote URL (fallback: the
absolute path of the primary checkout). A repo-committed `telar.yaml` MAY
carry the same `env:` block for solo projects where the owner chooses to
commit it; the sidecar always takes precedence.

## The contract

```yaml
# ~/.telar/projects/<id>/env.yaml
version: 1
env:
  cost: heavy            # none | light | heavy   (REQUIRED)
  up: bun run up         # REQUIRED unless cost: none. Idempotent.
  ready: curl -sf http://localhost:${TELAR_PORT_BASE}/health   # REQUIRED unless cost: none
  reset: bun run db:reset          # OPTIONAL
  down: bun run down               # REQUIRED unless cost: none
  verify: bun run test:e2e         # OPTIONAL: heavy-tier verification entry point

  tiers:                 # OPTIONAL: verification tiers (see below)
    unit: bun test                 # cost: none — always safe to parallelize
    integration: bun run test:int  # runs inside a leased *light* env
    live: bun run test:e2e         # runs inside a leased *heavy* env
```

### Verbs

All verbs are shell commands run with the leased worktree as CWD and the
injected variables below in the environment.

| Verb | Required | Semantics |
|---|---|---|
| `up` | unless `cost: none` | Bring the environment for this slot up. MUST be idempotent: a second `up` on a running slot is a no-op or a fast reconcile. MUST NOT touch other slots. |
| `ready` | unless `cost: none` | Exit 0 when the environment is usable. Telar polls it after `up` with a timeout; non-zero within the timeout fails the lease. |
| `reset` | no | Return the environment to a clean data state without a full down/up. If absent, Telar achieves reset via `down` + `up`. |
| `down` | unless `cost: none` | Tear the slot's environment down. MUST be safe to call on an already-down slot. MUST NOT destroy state owned by other slots. |
| `verify` | no | The heavy-tier verification command. If absent, the Verifier drives the environment directly (browser + read-only tools). |

### Cost classes → pool policy

| `cost` | Meaning | Policy |
|---|---|---|
| `none` | Library / pure code. Tests need no running services. | Unlimited parallelism. No leases exist. |
| `light` | One or few processes, no containers, small RAM. | Per-worktree environments; default pool cap 4. |
| `heavy` | Containers, databases, real RAM. | Leased pool. Default k = 1 (configurable per machine in `~/.telar/config.yaml`). |

### Injected variables

Telar injects these into every verb invocation:

| Variable | Meaning |
|---|---|
| `TELAR_SLOT` | Integer slot number, 0 = primary checkout. Stable for the life of the worktree. |
| `TELAR_PORT_BASE` | Base of a reserved port range for this slot (range size 20). All services MUST bind inside `[BASE, BASE+19]`. |
| `TELAR_WORKTREE` | Absolute path of the worktree being served. |
| `TELAR_PROJECT_ID` | The normalized project id. |
| `TELAR_LEASE_ID` | Opaque id of the current lease (present only during a lease). |

Projects that already have their own slot convention (e.g. orchestrator's
`bun run up` slot system) are mapped by the sidecar — the `up` command may
translate `TELAR_SLOT` into whatever the repo expects. Telar does not care.

## The lease

```
telar env lease   [--tier live|integration] [--worktree <path>]   → lease-id, env vars
telar env release <lease-id>                                      → releases; pool decides down vs keep-warm
telar env status                                                  → pool, holders, queue
```

Semantics:

- A lease is **held through verify and repair** and released on green (or
  abandonment). Repair without the environment is churn; the lease exists to
  prevent re-queuing between verify and fix.
- The queue is FIFO with one exception: a loom re-entering after a repair on
  the *same* lease keeps it; a loom that released and returns goes to the back.
- Leases have a TTL (default 45 min, renewable). An expired lease is reclaimed
  with `down`; the holder is notified, not silently killed mid-verify —
  reclaim happens between verb invocations.
- `release` MAY keep the environment warm (skip `down`) when the queue is
  empty; the pool owns that decision, not the project.
- Crash safety: pool state is on disk; on daemon start, any slot whose holder
  process is gone is reclaimed via `down` (which is required to be safe on an
  already-down slot).

## Conformance

An onboarding (by agent or hand) is accepted only after this sequence passes
against a real non-zero slot:

1. `up` → `ready` within timeout.
2. `up` again → still ready, no duplicate state (idempotence).
3. `reset` (if declared) → `ready` still passes.
4. `down` → a subsequent `ready` fails; `down` again exits 0.
5. Ports observed during 1–3 all fall inside the slot's range.

**The generality rule:** if onboarding a new project requires a change to this
contract or to Telar, the contract is wrong. Amend the contract deliberately
(bump to v2); never special-case a project inside Telar.

## v1.1 amendments (from the first real onboardings, 2026-08)

Reported by the onboarding agents per the gap rule; the first two are
implemented, the last two are open design questions for v2.

1. **Per-verb timeout overrides** (implemented): `env.timeouts: {up: 900, ...}`
   in seconds. Cold container stacks routinely exceed the 300s default, and a
   SIGKILL mid-`supabase start` leaves a half-built stack no verb owns.
2. **Tier runs are labelled and budgeted as tiers** (implemented): a tier run
   reports `tier:<name>` and gets the verify budget (600s default,
   `timeouts.verify` overrides) instead of silently inheriting mislabelled
   defaults.
3. **Conform's scratch slot is not a scratch worktree** (open): `conform` runs
   the verbs in the *invoking* worktree. For projects whose isolation unit is
   the worktree (ozom-gv's model), a "scratch slot" from the primary checkout
   would cycle the developer's live stack. Until conform provisions its own
   throwaway worktree, onboarding agents MUST run it from one (the ozom-gv
   onboarding did exactly this). v2 direction: conform provisions and removes
   a scratch worktree itself, and refuses the primary checkout.
4. **No way to declare "reset requires credentials"** (open): today the only
   honest move is omitting `reset`; the contract should let a project say why
   (`reset: {unavailable: "needs real vault keys"}`) so schedulers and agents
   can distinguish "no reset" from "reset is unsafe unattended".
