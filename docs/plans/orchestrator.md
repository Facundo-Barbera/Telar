# The Orchestrator

> Status: **design captured from conversation, 2026-08-19. Not approved, nothing built.**
> Supersedes the loom model in `packages/core/src/looms.ts`, `weave.ts`, `tick.ts`
> and the loom paths of `executor.ts`.

**Vocabulary.** The **orchestrator** is the perpetual agent that decides what to
work on. A **loom** is one dispatched unit of work: it owns a worktree, runs a
Claude Code session against one task, passes the project's gates, and ends as an
open PR. The word "loom" is kept from v1 (§9); the model underneath it is not.

---

## 1. What this is for

**Wake up to work done: PRs open and waiting, and nothing silently dropped.**

That sentence is the whole specification. Everything below is in service of it,
and anything that doesn't serve it is out of scope.

### Why looms failed

Looms was orchestration machinery built without a workload to shape it. With no
real demand pulling on it, every decision got made on aesthetics — a twelve-state
lifecycle, charters, decomposition contracts, critic panels, mediation budgets —
and none of it was answerable to a project anyone was actually trying to ship.

The specific inversion worth naming, because it's the mistake most likely to
recur: **looms required projects to supply proof machinery on its terms.** A
project had to have testing set up the way looms wanted it, or the model didn't
apply. That is backwards. Projects already have their own machinery, built for
their own reasons, and it is better than anything a generic system would impose.

The new posture is the opposite:

> **Discover whatever the project already has. Never impose. Be religious about
> what exists.**

Concretely: this repo has `bun run ci` — a local check that runs before opening
a PR so failed CI doesn't burn Actions minutes. Nobody designed that for an
agent. The orchestrator's job is to *find* it and never, ever skip it — not to
demand you build a gate to its specification.

---

## 2. Shape

```
        ┌─────────────────────────────────────────┐
        │ sentinel     cheap, deterministic, no LLM│
        │              "did anything change?"      │
        └───────────────────┬─────────────────────┘
                            │ only on change
                            ▼
        ┌─────────────────────────────────────────┐
        │ orchestrator   an AGENT. fresh each tick.│
        │                dispatch-only, never edits│
        └───────────────────┬─────────────────────┘
                            │ dispatches
                            ▼
        ┌─────────────────────────────────────────┐
        │ loom           one unit of work.         │
        │                Claude Code, in a worktree│
        │                ends at "changes made"    │
        └───────────────────┬─────────────────────┘
                            │ harness takes over
                            ▼
              project's own gates → PR → you, in the morning
```

---

## 3. Decisions

### 3.1 The orchestrator is an agent, and it only dispatches

It is an **agent**, not a scheduler, because context genuinely varies: projects
declare work differently, some have no external work source at all, and reading
an ambiguous issue is judgment. A deterministic loop would need a code change per
project convention.

It **only dispatches**. It never edits code. Editing is the worker's job, in a
worktree. This keeps the orchestrator's context small and its blast radius
narrow.

### 3.2 It never accumulates context

A fresh orchestrator on every tick. Read the world, decide, dispatch, write down
the reasoning, exit.

This is the answer to the three problems that killed the single long-lived agent:
degraded choices from long context, auto-compaction near 1M, and cost ramping
with uptime. All three had one cause — treating the orchestrator as *someone who
remembers* rather than *a function of current state*. A human PM holds context
because re-reading the backlog every morning is expensive for them. For an agent
it isn't: `gh issue list --milestone "hito 1"` is a second and a few hundred
tokens. The only reason to hold context is to avoid re-derivation, and here
re-derivation is nearly free.

Consequence: **a tick's context is bounded by construction** — policy + current
world + a slice of the ledger. It doesn't grow with uptime, so cost per tick is
predictable and can be priced before the first overnight run.

### 3.3 Three kinds of state, kept apart

Mashing these into one transcript is what makes a long-lived agent degrade.

| | What | Where it lives |
| --- | --- | --- |
| **World** | issues, milestone, PRs, CI, branches, worktrees | **Nowhere.** Re-read every tick. Authoritative externally; anything cached will be acted on while stale. |
| **Ledger** | "dispatched #47 at 14:02" · "CI failed twice on #31, stop" · "asked about #61, waiting" | Small, structured, append-only. Not a transcript. Recent slice feeds each tick. |
| **Project knowledge** | "`hito N` = milestone" · "gate is `bun run ci`" · "never touch `packages/legacy`" | **A file in the repo** (§5). Deliberately edited, diffable, reviewable. |

### 3.4 Agent decides, machinery enforces

This resolves the tension between wanting flexibility and wanting guarantees.
Prompting an agent to "always run the gate" is weak — agents skip things under
pressure, especially late in a long task.

So **the worker never runs the gate.** Its job ends at "changes are in the
worktree." The harness then runs the project's declared gates and decides whether
a PR opens. The worker cannot skip the gate because the worker was never holding
it.

- **Agent**: what needs doing · what a convention means · is this stuck · is the
  milestone finished
- **Machinery**: worktree lifecycle · running the declared gates · opening the PR
  · budgets · the ledger

Machinery was never the enemy. Looms just applied it to *what to do* instead of
*what always happens*.

### 3.4a Gates are not binary

Discovered in ozom-gv, and it invalidates the naive "run gate → green → open PR"
loop. `scripts/ci.ts` returns **three** outcomes:

| Exit | Meaning | What the orchestrator must do |
| --- | --- | --- |
| `0` | every gate ran and passed | safe to push |
| `1` | at least one gate failed | CI will be red — do not push |
| `2` | nothing failed, but a gate **skipped** | **unknown.** Not a green light. |

Exit 2 happens when Docker is down so the pgTAP suite can't run. The project's
own docs are explicit that this is not permission to proceed — and a system that
treats non-zero-means-fail *or* zero-means-go would get this wrong in both
directions.

So a gate result is `pass | fail | unknown`, never a boolean, and **`unknown` is
a policy decision the artifact must answer** — push and let remote CI adjudicate,
or hold. It cannot be inferred.

Generalized: the artifact records what each exit code *means*, because only the
project knows. Assuming POSIX convention is imposing, which is the thing this
design exists not to do.

### 3.5 Terminal state is an open PR that passes the project's own gates

Not merged — that stays your call in the morning. Not "verified against a
synthesized contract" — that was the over-reach.

The moat looms spent twelve states building already exists: it's PR review, and
GitHub implements it better than we will.

### 3.6 Idle must be free

The expensive thing is an orchestrator tick. Checking whether anything changed is
nearly free. So the agent does not go on the timer — a **sentinel** does.

Deterministic code, no LLM, runs often. Fingerprints the world: max `updated_at`
across milestone issues, `origin/main` sha, open PR check conclusions, inbox
mtime. Unchanged and nothing in flight → return, cost is one API call. Changed →
wake the agent.

**The failure mode this exists to prevent:** a loop that wakes, invokes an agent,
concludes "nothing to do," and reschedules — forever. That is the same cost trap
in a new costume, and it would make this a very expensive clock. *The sentinel
must be able to say "nothing changed" without invoking an agent.* If it can't,
the design leaks.

Three wake sources, deliberately distinguished:

| | Mechanism | Latency | Idle cost | Needs |
| --- | --- | --- | --- | --- |
| Heartbeat | timer | interval | one tick | nothing — always available |
| Poll-as-event | sentinel + diff | interval | one API call | credentials |
| Real event | blocking wait / webhook | instant | ~zero | infrastructure |

A cron that polls `gh` is the middle row, not the third. That's the right
default, but calling it a listener hides where the wins are.

**Free events already available**, both cheaper than polling:

- **Process exit.** A dispatched worker finishing is a local event with zero
  latency and zero cost. With work in flight you wait on a PID, not a timer.
- **`gh run watch` / `gh pr checks --watch`** block until CI settles.

Between them, polling reduces to "did a human change something," which is
low-frequency and deserves a slow interval with backoff. Nothing changed in six
hours → stop checking every five minutes.

### 3.7 It authors its watch config; a supervisor executes it

The orchestrator decides what's worth watching and writes it into the project
artifact. **One supervisor process** reads that file and does the watching.

It does **not** write to the system crontab or register org webhooks. Those are
durable side effects living outside the repo that survive the agent and
accumulate invisibly — a stale cron pointed at a deleted worktree, found six
months later. One supervisor, one file, one thing to kill, all of it greppable.

### 3.8 Heartbeat always works; every event source is additive

Not every project uses git. A project with no remote, no issue tracker and no CI
must still function — it wakes on a timer and reads an inbox file. **Nothing in
the design may require an event source to be correct, only to be fast.** An empty
watch list yields a slower system, not a broken one.

### 3.9 Looms run in worktrees — using the project's own worktree machinery

One loom, one worktree. This is the piece of looms v1 that was solving a real
problem and survives intact.

But ozom-gv makes the stronger point: **it already has this, and it is better
than anything we would have built.** `scripts/lib/worktree.ts` allocates each
worktree a *slot* with its own Next port (3000/3001/3002…) and its own Supabase
stack (`ozom-gv-wt1`, `ozom-gv-wt2`), with a registry in `.git/gv-worktrees.json`.
`bun run up` is idempotent and attaches to an existing stack rather than starting
a second.

A generic worktree manager would have fought this. The orchestrator should call
`bun run up` and let the project allocate.

It also supplies a constraint no budget number would have: **concurrency is
capped by RAM, not by policy.** ~480 MB and 6 containers per worktree stack
against ~7.75 GB allocated to Docker ⇒ the main checkout plus roughly five
worktrees. The fan-out ceiling is physical, discovered by reading the project's
own docs, and belongs in the artifact.

### 3.10 The bottleneck is triage, not dispatch

The finding that most changes what this system is for. In ozom-gv, **4 of 37
open issues are dispatchable right now** — and *not* because the backlog is
poorly written. These issues are unusually good: SQL output, `file:line`
citations, production timestamps, reproduction tables.

The other 33 are blocked on one of three things, and nothing in the repo
distinguishes them:

| Category | Example | Why an agent can't take it |
| --- | --- | --- |
| Needs a human decision | #457 — "los puntos 2 y 3 son decisión de JMB" | judgment, not work |
| Needs live credentials | #486, #464 — real Google Ads quota, "una campaña desechable" | can't be closed from a worktree |
| Needs decomposition | #409 — the identity backbone, absorbs #352, 5 comments | too large for one loom |

There is no label for any of this. The classification has to be re-derived from
prose every single cycle — which is expensive, and worse, *silent*: a naive
orchestrator picks #464, burns a loom, and produces a PR that cannot be correct.

So the highest-value thing this system can do may not be dispatching the 4. It
may be **maintaining the classification of the 33** — reading new issues once,
labelling them dispatchable / needs-decision / needs-credentials / needs-split,
and surfacing that. That is a durable artifact, it compounds, and it makes the
next cycle cheap.

Two consequences:

- **Triage is a first-class output, not a side effect of dispatch.** A tick that
  dispatches nothing but correctly classifies six new issues was a good tick.
- It argues for the orchestrator being allowed to *propose* labels — carefully,
  since §4.4 says setup must not refactor your repo. Proposing a taxonomy and
  applying it after approval is different from inventing one unasked.

---

## 4. Setup is a conversation

You should be able to say *"listen for the issues in hito 1 and keep an eye on
them"* and have it work out the rest. Hand-authoring a config means every project
onboards at the speed of you reading a schema.

So there are two modes over one body of knowledge:

- **Setup** — interactive, one-time, can afford to be expensive. Explores,
  proposes, gets corrected, writes the artifact.
- **Run** — headless, cheap, per-tick. Reads the artifact. Never re-derives.

### 4.1 Look first; ask only what you can't determine

"hito 1" is underspecified, and the gap between that sentence and what it needs
is where this design lives. Most of the gap it can **go find**: milestones are an
API call, the base branch is `git symbolic-ref refs/remotes/origin/HEAD`, `bun
run ci` is in `package.json`, the label convention is visible in the issue list.

It should return with a draft that's ~80% right and ask only about what is
genuinely unknowable — *"you have `listo` and `en progreso`; I read `listo` as
ready-to-work, correct?"*

An agent that asks for what it could have looked up is wasting your time and
telling you it won't be resourceful at 3am either.

### 4.2 The dry run is the trust surface

Before it runs autonomously once, it prints what it *would* do now. Real output
against ozom-gv on 2026-08-19 (see `ozom-gv-setup.md`):

```
Hito 1 · Agosto → 9 open · 13 closed · due in 10 days
  dispatch  #491  KB · embeddings model id has an `openai/` prefix OpenAI rejects
  dispatch  #432  Idioma · voseo rioplatense in 15 enumerated i18n keys
  skip      #464  body: "requiere autorización explícita y una campaña desechable"
  skip      #409  5 comments, absorbs #352, needs decomposition first
  never     #302  needs-approval
gate: bun run ci  (0 push · 1 hold · 2 = ?)   base: main   draft PR, never merge
⚠  6 newest issues (#486–#491, 4 urgente) have NO milestone. Ignoring them?
```

You read that and know instantly whether it understood your project. It costs
almost nothing and happens before a line of code is written.

That last line is the point. The dry run's job is not to look competent — it is
to **surface the thing you didn't think to say.** "Listen for hito 1" was a
complete-sounding instruction that would have skipped the entire week's real
work; only a dry run against live data catches that, and it catches it in
seconds, for free, before anything is dispatched.

This is what looms never had. One of these would have told you more about whether
the design worked than any amount of design document.

### 4.3 Correction is the loop, and the file is what makes it possible

Setup is not one conversation: draft → dry run → *"no, `listo` means triaged"* →
edits the artifact → dry run again. That path stays open forever — the morning
report is correctable the same way, and the fix is permanent.

This only works because its understanding lives in **a file**. In a context
window, correcting it means re-prompting forever and you can never see what it
currently believes. As a file, your correction is a diff, it's reviewable, and
`git blame` shows when it drifted.

### 4.4 Setup boundaries

- **Record assumptions, don't silently guess.** What it couldn't determine goes
  in an explicit "assumed" section, and the morning report can say "I assumed X."
  A wrong assumption you can see is survivable; an invisible one isn't.
- **Not a wizard.** No fixed question order, no schema-filling. A conversation
  that happens to emit something structured. Designing a form means it went
  wrong.
- **Human-readable artifact.** Markdown with commands quoted verbatim, not YAML.
  You will read this at 2am working out why it did something stupid.
- **Setup does not refactor your repo.** It may *propose* ("no local gate — want
  one?"). Its output is one artifact, not a pile of changes you didn't ask for.

---

## 5. The artifact

One file per project, in the repo. Written by setup, edited by both of you, read
by every tick. Sketch — the real shape falls out of §8:

- **Work source** — where tasks come from, as a literal command. `gh issue list
  --milestone "hito 1" --label listo`. For a project with no tracker: a path to
  an inbox file.
- **Ready / skip / never** — which items are actionable, and the conventions that
  say so.
- **Gates** — the project's own checks, verbatim: `bun run ci`. Run by the
  harness, never by the worker. **With the meaning of each exit code**, because
  they are not binary (§3.4a).
- **Done** — what terminal means here. Default: PR open and green.
- **Boundaries** — paths never to touch, branches never to push.
- **Watch** — what the sentinel fingerprints, and at what interval.
- **Assumed** — what it guessed and wants confirmed.

---

## 6. Open questions

Real gaps, not rhetorical ones. None should be settled by me.

1. **Worktree divergence.** Six PRs overnight from six worktrees all forked off
   Monday's `main` is six conflicts Tuesday. Rebase before opening, or refuse to
   run two workers whose declared paths overlap? The path-overlap check is cheap
   and is the useful residue of looms' write-partition idea.
2. **Done-detection across ticks.** The orchestrator dies each tick, so tick N+1
   re-derives in-flight state: process alive, worktree commits, PR exists. That
   fits "world state is external" — but a worker must leave legible traces, and a
   **killed** worker has to be distinguishable from a **running** one. Get this
   wrong and you either double-dispatch or wait forever on a corpse.
3. **When does it stop trying?** `bun run ci` fails three times on one issue —
   that's a park with a written reason, not a fourth attempt. Looms' mediation
   budget was a fine idea buried in bad machinery.
4. **Overnight risk posture.** "Opens PRs I review" vs. "merges its own green
   work" are different systems. Start with the first: the failure mode of the
   second is silent and compounding.
5. **Does the ledger belong in the repo or in `~/.telar`?** In-repo is
   inspectable and travels with the project; out-of-repo avoids commit noise on
   every tick.
6. **Reading an issue is not reading its body.** ozom-gv's rule is that **the
   most recent comment wins** — #431's fourth comment literally retracts the
   second and third; #432's body was rewritten mid-issue. So "read the issue"
   means reconstructing current intent from a whole thread, which costs real
   context per candidate and is exactly the judgment a scheduler couldn't do.
   Open: does the orchestrator read every candidate's full thread each tick, or
   cache a distilled "current ask" in the ledger and re-read only on new
   activity? The second is much cheaper and is what the sentinel's `updated_at`
   fingerprint is already positioned to detect.

### Questions only you can answer (ozom-gv)

Recon could not resolve these by looking; they are policy, not facts.

- **What is the work queue?** `milestone:"Hito 1 · Agosto"`, or `label:urgente`
  regardless of milestone, or the union? The milestone lapse (§4.2) makes this
  the first question, not a detail.
- **On `bun run ci` exit 2** — push and let remote CI's pgTAP job adjudicate, or
  hold? And how many concurrent worktree stacks may it occupy, given the ~5 the
  RAM allows?
- **Draft or ready-for-review?** Convention says never merge your own PR, but
  `main` has **no branch protection at all** — nothing technically enforces it.
  Worth deciding before an agent has push access.
- **How is a `needs-approval` approval recorded?** The label description says
  "until explicit approval is recorded" but nothing in the repo shows what
  recording looks like. The orchestrator needs a signal to watch for.

---

## 7. Explicitly not doing

- No `WorkSource` abstraction over GitHub/Linear/Jira. The work source is a
  command in the artifact; the agent runs `gh`. A project-supplied policy, not a
  type hierarchy.
- No contract synthesis, critic panels, charters, decomposition, or rollup.
- No verification model. The project's gates are the verification.
- No acceptance state machine. The PR is the acceptance surface.
- No requirement that a project have tests, CI, git, or an issue tracker.

---

## 8. Next step

Write the **ozom-gv setup transcript**: what you say, what it goes and finds,
what it asks back, and the dry run it prints. The artifact format falls out of
that almost for free.

ozom-gv is the right test precisely because its conventions are *specific* —
hitos, Spanish-language issues, its own label vocabulary. If the design only
works once those are generalized away, it has repeated looms' mistake.

---

## 9. Naming

**"Loom" is kept.** It stays the product's word for a unit of work — the thing
that gets dispatched, runs in a worktree, and ends as a PR waiting for you.

What it does *not* keep is v1's baggage. A Loom is no longer a twelve-state
record that decomposes, weaves, synthesizes contracts and accepts itself. It is
one dispatched unit of work with one terminal state (§3.5). The word survives;
the model underneath it does not.

The surrounding vocabulary stays plain on purpose — orchestrator, worker, tick,
gate, sentinel, ledger. The old weaving terms (`weave`, `thread`, `warp`,
`spool`) are not revived: each is either taken elsewhere in this repo or welded
to the model being discarded, and inventing replacements for them was a mistake
this design does not need to repeat.
