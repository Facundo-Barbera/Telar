# The method contract, v0 — a paper test

Status: DRAFT, deliberately unimplemented. This document exists to answer one
question before any code does: **can one contract express both Telar's current
weaver behaviour and bmad without contortions?** The env contract got this
same paper test and the scheduler that followed built cleanly on it. If bmad
does not fit here, we want to learn it on this page.

## The claim under test

Telar is the **machine**: environments, isolation, verification, acceptance,
scheduling. A **method** — how an intention becomes finished work — is
content, supplied per project and per person, the way an env contract is.
Every dissatisfaction so far ("adapted per project", "warp with a bigger UI",
"what about bmad") traces to method-content baked into the machine.

## What the machine imposes regardless of method

These are invariants, not configuration. A method that fights them is not a
method Telar runs:

- **Detachment.** Work sessions are loom-owned and leave the ordinary surface.
- **Isolation.** Execution units get their own worktree and branch, named
  after the work (`loom/<loom>/<unit>`).
- **Clean-desk verification.** The gate to `ready` is a tier from the env
  contract, run against a fresh checkout of the branch. Uncommitted work does
  not exist. Method-supplied review agents (bmad's QA) are welcome and
  advisory — they never substitute for the tier.
- **The accept moat.** Acceptance is human and UI-only. No method, agent, or
  standing order can accept a loom or close an issue.
- **Leasing.** Anything that needs a live environment goes through the env
  scheduler like every other consumer.
- **Sidecar sovereignty — refined.** A method's *definition* (its pack:
  prompts, templates, phase graph) is machine-side (`~/.telar`), never
  committed to a shared repo. A method's *outputs* (PRDs, stories, specs) are
  ordinary work products: committable, reviewable, as much a deliverable as
  code. The line is definition vs. artifact.

## The contract shape

A method pack declares, in one document:

```yaml
method:
  name: weave            # or bmad, or anything
  version: 0

  # WHAT IT ACCEPTS as the seed of work. Intake adapters are machine-side
  # (conversation, bare objective, an issues query) — the method says which
  # it can start from, not how to fetch them.
  intake: [conversation, objective, issues]

  # THE PHASE GRAPH. Each phase is an agent run with declared tools, declared
  # artifacts, and a gate. Phases run in order; a phase's artifacts are the
  # next phase's input.
  phases:
    - id: plan
      run: <agent spec: prompt/pack reference, tool policy (read-only etc.)>
      produces:
        - kind: proposal          # machine-known kinds: proposal | document | units
          # documents get a path template; they land in the workspace and are
          # ordinary committable artifacts
      gate: human                 # human | none | standing-order
        # `human` pauses the loom in `waiting on you` until approved in the
        # room. `standing-order` consults the project's autonomy policy and
        # only escalates to a human when outside it.

    - id: execute
      shape: parallel             # parallel | sequential
      unit: thread                # what one execution unit is, per the plan
      workspace: per-unit         # per-unit | shared
        # `per-unit`: each unit gets its own worktree/branch (the default,
        # and the only safe choice for `parallel`).
        # `shared`: sequential units build on one branch — story-by-story
        # methods need this, and the machine forbids combining it with
        # `parallel`.
      brief: <how a unit's opening instruction is composed from artifacts>

  # EVERY UNIT BINDS TO A TIER. The method maps its own done-criteria to the
  # project's env-contract tiers. A unit whose criteria no tier can prove is
  # allowed but VISIBLY unproven ("no tier") — never silently trusted.
  verification:
    binding: required-or-flagged
    advisory: <optional method-supplied reviewer agents, e.g. bmad QA>

  # WHAT THE HUMAN RECEIVES. Fixed floor imposed by the machine: branch,
  # diff summary, verification evidence with commit hash, honest leftovers.
  # Methods may add artifacts (bmad: the updated story file), never remove.
  delivery:
    adds: [...]
```

Standing orders (the autonomy ratchet) live beside the method, per project:
`propose-only` → `auto-run gated phases whose tier cost is light` → `full
windows`. They parameterise gates; they never touch the accept moat.

## Expression A — `weave` (the current behaviour)

```yaml
method:
  name: weave
  version: 0
  intake: [conversation, objective]
  phases:
    - id: plan
      run: { prompt: weaver, tools: read-only }
      produces: [{ kind: proposal }]      # v2: also { kind: document, path: docs/looms/<slug>.md }
      gate: human
    - id: execute
      shape: parallel
      unit: thread
      workspace: per-unit
      brief: unit.brief + contract + tier + loom rules
  verification: { binding: required-or-flagged }
  delivery: { adds: [] }
```

Fits without residue. The current implementation is this document, hardcoded.

## Expression B — `bmad`

bmad's shape: analyst brief → PRD (PM) → architecture (architect) → stories
(scrum master shards the docs) → dev implements story by story → QA reviews.
Document-first, sequential, human checkpoints between documents.

```yaml
method:
  name: bmad
  version: 0
  intake: [conversation, objective, issues]
  phases:
    - id: brief
      run: { pack: bmad/analyst }
      produces: [{ kind: document, path: docs/brief.md }]
      gate: human
    - id: prd
      run: { pack: bmad/pm, input: docs/brief.md }
      produces: [{ kind: document, path: docs/prd.md }]
      gate: human
    - id: architecture
      run: { pack: bmad/architect, input: docs/prd.md }
      produces: [{ kind: document, path: docs/architecture.md }]
      gate: human
    - id: stories
      run: { pack: bmad/sm, input: [docs/prd.md, docs/architecture.md] }
      produces: [{ kind: units }]         # one unit per story, ordered
      gate: human                          # approve the shard, like a proposal
    - id: execute
      shape: sequential
      unit: story
      workspace: shared                    # stories build on one branch
      brief: story file + acceptance criteria + loom rules
  verification:
    binding: required-or-flagged           # story AC mapped to tiers where possible
    advisory: [{ pack: bmad/qa, runs: per-unit }]
  delivery:
    adds: [updated story file with QA notes]
```

## What drafting this surfaced (the point of the exercise)

1. **Gates must be first-class and plural.** The loom today has exactly one
   pre-gate (approve the proposal). bmad needs a gate after *every document*.
   This forces the loom lifecycle to grow a real `waiting on you` state that
   scheduling must respect — a gated loom parks without burning a lease, and
   the room (plus a push) is where you clear it. This is also exactly the
   mechanism standing orders need, so the cost buys two features.

2. **Sequential + shared workspace is a genuine second execution shape,**
   not a parameter tweak. Parallel/per-unit and sequential/shared are the two
   legal combinations; the machine forbids the other two. The engine already
   cuts per-session worktrees; `shared` means the loom owns ONE worktree that
   successive story sessions inherit — new engine capability, discovered on
   paper instead of mid-build.

3. **The sidecar rule needed refining, not relaxing.** bmad *wants* its
   documents committed. Resolution that preserves the principle: definitions
   sidecar-only, artifacts committable. Telar-the-tool still never leaks into
   a shared repo; the team just sees ordinary docs and code arriving on a
   branch they can review.

4. **Prose acceptance criteria don't break verification.** Story AC that no
   tier proves lands in the existing "no tier" honesty channel, with bmad's
   QA as advisory colour. The clean-desk gate stays machine-owned. No
   contortion needed — the flag design from v1 absorbs it.

5. **Intake is orthogonal to method.** "Handle the filtered issues" is an
   intake adapter (gh query → seed context) that can feed weave OR bmad.
   It was tempting to make "issues mode" a method; the draft shows it is not
   one.

6. **The spec-document gap closes itself.** Once `produces: {kind: document}`
   exists, weave's own proposal becomes a committable spec doc for free —
   the v2 "spec as the loom's body" falls out of the contract rather than
   being a separate feature.

## Verdict

bmad fits. The contortions are two real machine gaps (plural gates, shared
sequential workspace), not shape mismatches — and both are things the trust
scenario ("handle my issues while I sleep") needs anyway. The contract is
worth building against.

Build order implied, when cooking resumes: gates + `waiting on you` in the
loom lifecycle → document artifacts → method packs (weave first, expressed as
data) → shared-workspace execution → bmad pack → intake adapters → standing
orders.
