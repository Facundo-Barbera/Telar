# The loom model, v1 — detachment

Status: normative for the loom surface. Supersedes the v0 sketch that lived only
in code. The env contract (`docs/env-contract-v1.md`) is unchanged; this
document consumes it.

## What v0 got wrong

v0 proved the lifecycle (objective → threads → verify → human accept) but built
it as an *overlay*: the loom was a JSON file pointing at sessions it did not
own. Three failures followed directly:

1. **Surface confusion.** Loom threads appeared in the ordinary sessions list,
   indistinguishable from the human's own conversations.
2. **Unenforceable contracts.** A contract was prose. Nothing bound it to
   anything executable, and "verify" ran inside the agent's own dirty worktree
   — the worker graded its own exam at its own desk.
3. **Machinery naming.** Branches like `telar/session_998f0d8be315…` told a
   human nothing about the work.

## The model

**A loom is born from a conversation and then detaches.**

You start in a normal session — talking, planning, exploring. When the
conversation has produced enough shape, you *spin* it into a loom. From that
moment:

- The origin session and every thread session are **owned by the loom**. They
  leave the ordinary sessions surface entirely and are reachable only through
  the loom's room. Your sessions list is yours again.
- The weaver reads the origin conversation (not a re-typed objective) plus the
  project's environment contract, and proposes threads. A human approves before
  anything runs. The blank-objective form remains as the degenerate case: a
  loom with no origin.

### Contracts are tiers, not paragraphs

Every proposed thread carries two things:

- `contract` — the human-readable intent: what must be demonstrably true.
- `tier` — the executable binding: a verification tier from the project's env
  contract (`unit`, `db`, `e2e`, …). The weaver is told which tiers exist and
  must bind each thread to one. If no fitting tier exists, the proposal must
  say so explicitly instead of inventing prose-only verification.

### Verification runs at a clean desk

"Verify" checks out the thread's **branch** into a scratch worktree and runs
the thread's tier there, via `telar-env` (which handles leasing per the env
contract). Consequences, all deliberate:

- Uncommitted work does not exist. An agent that "finished" without committing
  has not finished.
- The agent cannot doctor the checkout that grades it.
- A thread agent may run its tier itself while working — good habit, zero
  authority. The loom records only the verification the loom ran.

The accept moat is unchanged: accept is UI-only and refuses until every thread
has a loom-run green.

### Names come from the work

- Loom threads: branch `loom/<loom-slug>/<thread-slug>`
  (e.g. `loom/hito1-agosto/presupuestos`), worktree directory
  `<loom-slug>--<thread-slug>-<suffix>`. Groupable in any git tool:
  `git branch --list 'loom/hito1-agosto/*'`.
- Ordinary worktree sessions: branch `telar/<title-slug>-<id6>` — readable,
  unique, still namespaced under an engine-owned prefix so the engine's
  forced branch reset can never clobber a human branch.
- Slugs are minted from the weaver's titles at approval time; the human pays
  nothing for good names.

## Ownership mechanics

The loom store records `originSessionId` and each thread's `sessionId`. The
sessions list route subtracts every loom-owned id before answering, so the
ordinary surface (sidebar, project pages) never sees them. The engine remains
ignorant of looms — ownership is a cockpit-level fact, which keeps the engine
honest as infrastructure and the loom free to evolve.

## Lifecycle (v1)

```
session (talking) ──spin──▶ proposal (weaver reads conversation + tiers)
                              │ human approves
                              ▼
                    loom { origin + threads } — detached, own home
                              │ threads work in loom/<slug>/<slug> worktrees
                              ▼
                    verify — clean checkout of each branch, thread's tier
                              │ all green → ready
                              ▼
                    human accepts (UI-only; no agent path exists)
```

## Open questions carried forward

- Merging: accept currently stamps sign-off but does not merge branches. The
  merge story (octopus vs sequential, conflict handling) is v2.
- The origin session stays frozen inside the loom; whether it can keep serving
  as a steering channel to the threads is open.
- Thread transcripts are viewed via the session cockpit reached from the room;
  a loom-native reader is deferred until the room's summary view proves
  insufficient.
