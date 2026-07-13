# The Loom Doctrine — Telar's operating principles

> Confirmed by the product owner 2026-07-13. This document is AUTHORITATIVE.
> Where any design doc, roadmap section, or existing code disagrees with it,
> THIS wins and the other is a defect to fix. Agents: read this before
> planning any change to how looms operate.

## The org chart

Tasks flow down. Escalation flows up — and only after the level below has
exhausted its own corrections.

- **Level 0 — The human (the client).** Touches the loom at most three times:
  charter approval where policy asks; the rare dead-end question; and the
  final accept — `ready → done` is ALWAYS a human click. Everything below
  this line is autonomous.
- **Level 1 — The orchestrator (the project owner).** Decomposes the
  objective, assigns tasks to threads, stands up whatever verification needs,
  and owns the ONE authoritative, deterministic verification of the composed
  whole (evidence — exit codes, gates, artifacts — never self-reports;
  fail-closed; green lands `ready`, never `done`). When a thread escalates,
  the orchestrator MEDIATES FIRST: re-plans, reassigns, repairs the lane,
  re-derives the verification method. It reviews corrections until there is
  genuinely no way out. Only then does it ping the human.
- **Level 2 — Threads (lead developers).** A thread is its OWN inner
  orchestration loop — an agent authors a workflow and executes it: plan its
  steps, fan out sub-agents (developers, QA) when the task warrants, a single
  agent when it doesn't. **Verification is a step inside that loop.** On a
  failing verify step the thread mediates internally — repair, retry,
  re-plan — and escalates to the orchestrator only when it cannot resolve it
  itself. A thread never escapes its inner loop: it reports upward either a
  verified result or an exhausted, specific escalation — never a raw failure.
- **Level 3 — Sub-agents.** Workers inside a thread's workflow. Their
  failures are the thread's to mediate.

## The standing principles

1. **There is one engine and it just IS.** No behavior flags, no defaults,
   no alternatives, no dual code paths, no opt-in machinery. An improvement
   applies to every registered project the moment it lands. Projects never
   fossilize on old behavior. Rollout safety lives in branches and sandbox
   projects — git is the flag.
2. **`.telar` / `telar.yaml` hold FACTS about the project, never switches on
   the engine.** Base branch, gates, verify/dev commands, servers, MCP,
   guardrails — declared by the human or learned once (ask-once-persist) and
   never re-asked. If a key describes how the ENGINE behaves rather than what
   the PROJECT is, it does not belong there.
3. **Autonomy is the point.** Nothing between the objective and `ready` waits
   on a human. Threads advise; verification failure triggers mediation, not a
   stop. Guards exist to stop WASTE (runaway spend, provably unfixable
   loops) — never to substitute a human for a fixable problem. Human
   intervention is the extreme case, by design.
4. **Deterministic proof at the end.** The loop closes with the
   orchestrator's machine-checked verification of the whole, fail-closed.
   Then the single human accept. That moat — and only that moat — stays.

## The escalation ladder

| Level | On failure |
|---|---|
| sub-agent | the THREAD mediates: retry, repair, re-plan its workflow |
| thread (exhausted) | the ORCHESTRATOR mediates: re-plan, reassign, repair the environment, re-derive verification |
| orchestrator (exhausted) | ping the human — with what was tried and a specific question; the answer persists as project data, never re-asked |

## What this forbids (for agents planning changes)

- Adding a behavior flag, a `TELAR_*` behavior env var, a "default off" path,
  or any byte-identical-when-off dual implementation. If a change is risky,
  prove it on a branch and a sandbox project, then land it for everyone.
- Per-thread fail-closed verification gates that demote a thread for
  "couldn't verify" — that is the thread's cue to mediate, then escalate to
  the orchestrator, never a terminal state on its own.
- Any escalation that reaches the human while the orchestrator still has an
  untried correction.
- Any autonomous path that writes `done`.
