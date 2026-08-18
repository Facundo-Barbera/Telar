# The Spool, defined

`SPEC-organization-workspace` described a place to keep work. This document
redefines the module as an **assistant** whose memory is that place, and states
exactly which of the spec's frozen decisions that costs.

Status: **draft, 2026-08-14.** It supersedes the spec's *intent* — the module's
purpose, laws, non-goals and success signal. The spec and `item-model.md` stay
canonical for the *memory model* — items, lanes, packets, ripening, provenance —
because that half is what the redefinition keeps. `docs/spool-port.md` remains
the record of where the code lives and what the architecture forced.

Read this first, then the spec.

## 1 · What it is

**A standing assistant you talk to about anything, whose distinguishing skill is
interpretation, and whose memory makes every dispatch land with context instead
of starting cold.**

You dump something half-formed — a fragment, a complaint, a photo of a
whiteboard, a paragraph spanning three unrelated concerns. It works out what you
meant, files it, and then keeps working on it while you are elsewhere. Overnight
it reads, analyses, drafts, and where it is allowed to, *starts*. You come back
and things have moved.

It is not scoped to code, and it is not scoped to one project. School, a client
engagement, and a repository are the same kind of subject to it. The difference
between them is only how far it is permitted to act.

The Spool — items, lanes, packets, ripening timelines — is not the product. It
is what the assistant remembers, and the reason a dispatch four weeks from now
still knows why the thing mattered.

## 2 · Why the old definition cannot stretch to this

The spec was designed to be **calm**, and it achieved that by being **inert**.
That was a deliberate, well-argued choice: every mechanism that could nag, act,
or accumulate on its own was removed by name. Twelve non-goals enforce it.

The new definition asks for a system that **acts**. Not louder — the calm is
still the point — but capable of having done something while you slept. Those
are different categories, and no amount of careful implementation reconciles
them, because three of the spec's constraints forbid the new behaviour outright:

| Frozen decision | What it forbids | What is now wanted |
| --- | --- | --- |
| "No agent-initiated execution. No agent starts work, completes work, or accepts a loom." | Any agent starting anything. Bed mode's asserted invariant is literally **0 started**. | Overnight agents that begin work, dispatch worktree sessions, and open PRs. |
| "No Telar-authored schedule or agenda." Plus: no clocks anywhere. | Any time structure Telar keeps of its own. | A 4-month plan with milestones and dependency chains that agents work against. |
| "No notifications, alarms, badges, or push of any kind." | Anything reaching you. | Knowing that a dispatched session is blocked, or that a PR has gone stale. |

The honest move is to bend those three, replace each with a limit stated as
sharply as the one it replaces, and leave the other nine alone.

## 3 · The three laws that bend

### 3.1 The moat moves from "start" to "land"

> **Old:** nothing runs unless a human starts it.
> **New: nothing LANDS unless a human accepts it.** An agent may begin work
> only inside a container it cannot ship from.

This is the redefinition's central claim, and it is not a weakening. A confirm
dialog asks you to approve a *promise*; a pull request asks you to approve a
*diff*. The second is a stronger gate, and it is the gate real engineering
practice already settled on.

A container that qualifies has three properties: work inside it is **reversible**
(discard costs nothing), **inspectable** (you review the artifact, not a summary
of it), and **inert until accepted** (nothing downstream observes it). A git
worktree behind a pull request has all three. So does a draft, a proposal, and a
packet.

Telar already builds the containers — `createSessionWorktree` and the GitHub
surfaces are shipped. What is new is the assistant being allowed to put work into
one without being asked first.

**The corollary, and it is the load-bearing half:** *anything with no such
container stays behind the old moat.* Sending an email, writing to a client's
database, pushing to a default branch, spending money, replying to a person — no
container, so the assistant prepares and stops. The test is not "how risky does
this feel"; it is "is there a place to put this where discarding it costs
nothing."

### 3.2 Clocks may drive agents; they may never reach you

> **Old:** no clocks anywhere.
> **New: no clock reaches the human.** Time may decide what an agent works on
> and when it wakes. It may never decide what a surface shows, what order a
> queue is in, or that you should be interrupted.

The original law conflated two things. What made a tracker stressful was never
that it knew the date — it was that the date *shouted*: overdue in red, badges,
"3 days late". None of that returns. Queue order is still stack position,
deadlines are still chips you chose to look at, and nothing has ever gone red.

But a four-month plan has a shape in time, and an assistant that cannot see that
shape cannot decide what is worth doing tonight. Milestones, dependency chains,
and "this has to be true before that can start" are inputs to the assistant's
own reasoning. They are not a schedule Telar shows you.

**The line, stated for the test suite:** a clock may be read by an agent deciding
what to do. A clock may not be read by a renderer deciding what to draw.

> **AMENDED, 2026-08-16 (the workbench pass — `docs/spool-loops.md` §8):**
> **the calendar belongs to the human.** The user said it plainly: "sometimes
> dates exist and that's not a problem — I want to keep my freedom but
> sometimes I do need to pin down tasks to specific dates." So the law's
> target narrows to what it was always aiming at: the system *editorializing*
> time. Dates the user stated are the user's own words, and drawing them
> spatially — on a week, on a month, on the day they name — is quoting, not
> shouting. A renderer may now read the clock for exactly one purpose: to know
> which day is today so it can draw the user's own dates in the right place
> and say, quietly, "you pinned this to Tuesday — it's still here." What
> remains banned, forever: countdowns, overdue-red, badges, reordering the
> user's attention because a clock ticked, and any date the user did not
> state. The system may **respect** the user's dates (night prepares
> Tuesday's work before Tuesday); it may never **wield** them.

### 3.3 It waits at the door rather than knocking

> **Old:** no notifications, alarms, badges, or push of any kind.
> **New: the system may hold things for you; it may never come and get you.**

Pull-never-push survives essentially intact, because the thing that would break
it — "your PR is 3 days old" — is not actually push. The system waits. When you
next sit down, it says so. Nothing buzzes.

What does change is that the assistant now has **state you did not create and
would not think to ask about**: a dispatched session that stalled, a PR nobody
reviewed, an overnight run that hit a wall at 3am. That has to be visible on
arrival without being announced before it.

**The unresolved carve-out** is the genuinely blocked agent — one parked on a
question, burning nothing, going nowhere. Waiting until you happen to sit down
may be the right answer. It may also be how you find a week later that nothing
ran. **Left open on purpose;** see §9.

## 4 · The laws that do not bend

These carried the spec and carry this document unchanged. Several matter *more*
now, because an assistant that acts has more ways to violate them.

- **Compress, never multiply.** Breaking a thing down does not grow the queue.
  An assistant that produces more items than it resolves is a worse assistant,
  not a busier one. This is the single easiest law to lose once agents can write.
- **No delete path.** Dismissing drains. Nothing here deletes.
- **Lanes are data, never an enum.** More true now that subjects include school
  and clients, not just repositories.
- **The raw fragment is never overwritten.** What you actually said stays beside
  what the assistant made of it, forever, so you can always check it did not
  drift from what you meant. With interpretation as the headline feature this
  becomes the primary audit surface.
- **Ephemeral experts, not resident ones.** Cost and context-rot; unchanged.
- **Provenance is honest.** Every artifact an agent produced is marked as such
  until a human has looked at it.
- **No agent RESOLVES anything in a foreign tracker.** Sharpened rather than
  kept: opening a pull request is now allowed, because a PR is a proposal and
  proposals are the container. Closing an issue, moving a card, editing someone
  else's ticket, or replying on a thread is not — those are accepts, and accepts
  are yours. Mirror sync still pulls.

## 5 · The non-goals, reconsidered

| Non-goal | Now |
| --- | --- |
| No capture-channel integrations; v1 is hand-fed | **Flips, narrowly.** A tracker may POPULATE a plan — that is how ozom-gv's four months get in — but the plan is Telar's own record and no subject ever requires one. Read-only, one channel, no watchers or webhooks. Every other channel stays out. |
| No Telar-authored schedule or agenda | **Flips, internally.** Telar may keep a plan's shape to reason with. It still authors no agenda *at you*. |
| No agent-initiated execution | **Flips, bounded by §3.1.** Only into a container that cannot ship. |
| No notifications or push | **Holds**, with the arrival-state clarification in §3.3. |
| No external calendar in v1 | **Holds.** Still deferred, still rides CAP-13 when it lands. |
| No capture-channel taxonomy | **Holds.** Provenance stays free-form. |
| No board view | **Holds.** |
| No always-alive experts | **Holds.** |
| No deletion path | **Holds.** |
| No agent write-back to a foreign tracker | **Sharpened**, per §4 — propose yes, resolve never. |
| No auth or multi-user model | **Holds.** Local, single-user. |
| No loom-internals work | **Holds**, and looms are out of the app entirely today ([#93](https://github.com/Facundo-Barbera/Telar/issues/93)). |

Nine of twelve survive. That is the measure of whether this is a redefinition or
a different product: it is the former.

## 6 · What ozom-gv already proves

`ozom-ai/ozom-gv` is the test case, and it is more useful than an invented one
because it is a real four-month engagement already running: four milestones from
**Hito 1 · Agosto** (due 2026-08-29) to **Hito 4 · Nov–Dic** (due 2026-12-18),
29 open issues, 71 closed.

**It sets the quality bar, and the bar is already met by hand.** Every issue is
written *Problema → Resultado esperado → Contexto*, with dependencies named
inline — "Depende de #409 (identidad) y #411 (lectura en vivo)" — and the
milestone's chain spelled out: "identidad → presupuestos leídos → tools de
lectura en vivo → **tools de escritura**". That is precisely what a ripened
packet is supposed to look like. So the target for the interpreter is not
aspirational prose in a spec; it is 29 worked examples of the output, written by
the person the assistant is for.

**It already runs the accept moat.** The `needs-approval` label reads *"Do not
start implementation until explicit approval is recorded."* And #412 puts the
same rule one level deeper — its **vista previa → confirmación → bitácora**
contract "lives in the tool itself, not in a screen: any channel (agent, MCP,
and eventually the UI) passes through it." §3.1 is not a new idea being imposed
on this project. It is that project's own rule, restated.

**It shows what a plan's shape is.** Milestones with dates, ordered chains,
issues that cannot start until another is true, and a category prefix per issue
(`Datos ·`, `Plataforma ·`, `PD ·`, `Perf ·`, `Gobernanza ·`, `Limpieza ·`) that
is doing lane-shaped work already.

**Acceptance test for the whole redefinition:** the assistant reads this plan,
and on a night in August can say which of the eight open Hito 1 issues are
unblocked, pick one whose dependencies are closed, dispatch a worktree session
against it, and have a draft PR waiting — while never touching an issue carrying
`needs-approval`, and never closing anything.

## 7 · What has to be built that the spec never described

Numbered so they can be argued with separately.

**7.1 · The interpreter. — THE SEAM IS BUILT.** Now the headline feature. "Dump
loose input, get back something well-formed" is the thing the product is judged
on. The spec treated this as a background enrichment pass; it is the front door.

`apps/engine/src/agent.ts` is the structured one-shot call the engine did not
have — schema in, validated object or a named failure out, forced through an
`emit_result` tool so the model cannot answer in the wrong shape.
`apps/engine/src/spool/expert.ts` is the per-project expert on top of it, ported
from `packages/core/src/workspace/expert.ts` minus the verdict. 45 tests.

> **The wall, and why it needed its own function.** A structured call runs at
> `bypassPermissions` — not as a shortcut, but because there is nobody to ask:
> no session, no request queue, no human parked on `canUseTool`, so every
> approval would deadlock. The permission mode is therefore not the wall. The
> TOOL LIST is, in three layers that any one outside caller could widen —
> availability, approval, and an explicit deny that beats every allow rule. They
> are computed by one pure function so the suite can read the whole wall without
> a provider and without spending a cent.
>
> **`Agent` is on the deny list and that is load-bearing.** A sub-agent spawned
> from inside a structured call inherits THAT call's scope, which for a
> project-scoped expert would mean handing it a child scoped to nothing — the
> exact inversion the spec warns about.
>
> **Two things the runner does that the donor did not.** It distinguishes three
> failures rather than returning `null` — never answered, answered in the wrong
> shape, no Claude on this machine — because a caller has to tell a human which
> one happened. And it threads token and cost usage back out, because §7.5's
> overnight report has to be able to say what a night came to.
>
> **What it deliberately lacks:** admission control. The donor took a slot from
> a global limiter before spending money; the engine's concurrency lives in the
> worker pool, which this path does not touch. The overnight runner is the first
> thing that will need a ceiling and should bring one rather than inherit an
> unowned one.

**7.2 · Non-code subjects as first-class.** School is not a git repository. Today
a Spool item's `project` is a free-form label while a *session* needs a
registered project id, which is why the packet page has a "no registered project
matches" branch. A subject needs to be a real thing with a permitted-action
level, where "has a repo" is one property rather than the price of admission.

**7.3 · A plan with shape.** Milestones, dependency edges, and blocked-until.
Read from GitHub for ozom-gv; hand-built or interpreted for a subject with no
tracker. This is what the assistant reasons over when choosing tonight's work,
and per §3.2 it is not a surface.

**7.4 · Dispatch and follow.** Choose an item, cut a worktree, run a session
against it, open a draft PR, and remember the link so the result is findable
from the item that caused it. Worktrees and GitHub surfaces exist; the loop
around them does not. Note the bookkeeping gap: sessions are listed *by project*,
so a session the assistant spawned has no path back to the item unless the item
records it.

**7.5 · Overnight work with a real report.** Bed mode, redefined. Its old
invariant was `0 started`; the new one is that **everything it did is in a
container, and the morning report says what happened, what is waiting, and what
it refused to touch.** "Refused" is a first-class outcome, not an error.

**7.6 · Permission levels per subject.** The mechanism that makes §3.1
enforceable rather than advisory: what may this assistant do unattended *here*.
Read-only, may draft, may open PRs. Without it, "nothing lands" is a sentence in
a document.

## 8 · Success signal, rewritten

The spec's signal was a calm morning. This one keeps the calm and adds the
overnight.

> Facundo dumps a paragraph at 11pm spanning ozom-gv, a class deadline, and
> something a client said on a call. It comes back as a receipt for exactly
> three: two filed with the right subject, one asked about, nothing invented.
>
> Overnight, the assistant works the ozom-gv plan. It sees that #409 and #411 are
> closed and #412 is therefore unblocked, and that #414 carries `needs-approval`
> and is not to be touched. It cuts a worktree, runs a session against #412, and
> leaves a draft PR. It also reads two other issues, decides it does not
> understand one well enough to act, and writes down what it would need to know.
>
> He sits down the next morning, opens one project-less chat and asks where he
> stopped. In one screen: what ran, the PR waiting for review, the question it
> could not answer alone, where each subject stands, and the class deadline he
> mentioned last night sitting quietly in a lane. Nothing merged. Nothing was
> sent to anyone. No notification ever fired.
>
> He reads the diff, and it is a diff — not a summary of one.

## 9 · Open questions

Recorded rather than resolved, and each blocks something specific.

1. ~~**The blocked-agent carve-out (§3.3).**~~ **RESOLVED, 2026-08-16.** A
   blocked dispatch writes its question down and parks. The question is a
   first-class line in the morning report (§11.4) — "refused" and "asked" are
   outcomes, not errors — and nothing escalates, buzzes, or retries on its own.
   The week-later-nothing-ran fear is answered by the report being the first
   thing arrival shows, not by the system reaching out.
2. ~~**Where a plan lives when the subject has no tracker.**~~ **RESOLVED,
   2026-08-15.** A plan is a record of the SUBJECT's, never a Spool item and
   never a view of a foreign tracker. A tracker may populate it; none is ever
   required. The polarity matters: a subject with no tracker is the ORDINARY
   case, not a degraded one — ozom-gv is a subject that happens to have an
   importer, rather than school being a broken ozom-gv. This also removes the
   two-way sync these systems usually die of: an import is a one-way pass that
   PROPOSES entries, marked like every other agent artifact until a human has
   looked.
3. **Whether permission level is per subject or per action** (§7.6). Per subject
   is simpler and probably wrong at the edges — "may open PRs" and "may spend
   API budget overnight" are not the same grant.
4. **What the assistant does with a subject it has never been told about.** The
   receipt says "asked about" — but an assistant that asks about everything new
   is a form of nagging.

## 10 · What this costs in already-written code

Very little, which is the argument for making the change now rather than after
stage H.

**Survives unchanged:** the item store, ripening timelines, lanes, packets,
sub-tasks, expert digests, `applyExpertPass`, the protocol shapes, all fifteen
routes, both web surfaces, the per-project tool scoping on the driver, and the
project-less master session. All of it is memory, and memory is the half the
redefinition keeps.

**Changes:** bed mode's output contract (7.5) — but it was never built, so this
is a change to a plan. `SpoolItem.project` widens into a subject (7.2). The
`0 started` assertion is written in `docs/spool-port.md` and nowhere else yet.

**Newly urgent:** the expert runner (7.1) — it was a loose end and is now the
critical path — and the store-protection mechanism, which mattered when nothing
could act and matters considerably more now.

**Built since this document was written:** 7.1 end to end. The structured-agent
seam, the expert on top of it, `POST /v2/spool/items/:id/expert`, the web
adapter, "Ask the expert" on the packet page, and `spool_consult_expert` as the
toolkit's fifth verb. The interpreter is reachable from a click and from a
session.

> **It works, and the measurement is the point.** A live pass against `ozom-gv`
> with a real checkout turned "los presupuestos de sept no cuadran con lo que
> dice google, revisar antes del cierre" into a brief naming
> `packages/module-pd/src/core/reconciliation.ts`, the `crossed` /
> `por_conciliar` status values and their four reasons, the generated-edge-copy
> rule, and four checkable acceptance criteria. A second pass mined "quedé de
> mandarlo el viernes" as a commitment whose `when` is `"Friday"` — coarse, as
> the law requires. That is the ozom-gv quality bar, met from one line of
> shorthand.
>
> **DRIVING IT FOUND A DEFECT THE GATE COULD NOT.** `commitments.when` carried
> "never a date you computed" in its own field description, and the first live
> pass obeyed that field exactly — then wrote "Ana asked last Thursday
> (2026-08-13)" into `fixed`, which is free prose with no rule in front of it.
> The date was resolved from the model's own sense of today, written to the
> packet, and rendered on screen: a clock reaching the human, which is the one
> thing §3.2 forbids. **A per-field rule taught the model to move the date, not
> to drop it.**
>
> **The fix then over-corrected, and the second pass caught that too.** Banning
> dates outright also banned "the reference doc (2026-08-12) says the check was
> never run" — a date QUOTED from a file in the repo, which no clock produced
> and which is exactly the provenance the user wants. The rule now forbids
> RESOLVING and asserting today, and permits quoting with attribution. Both
> halves are asserted, so a later tightening cannot take the useful one with the
> harmful one.

**Stage G is unblocked by this document.** The master chat is the front door of
an assistant rather than a viewer for a queue, which settles the question that
was open: it is a chat with a Desk rail and dispatch cards, and the project
cockpit is where a *dispatched* session is watched. They are different surfaces
with a link between them, not one surface serving two masters.

> **Superseded in part by §13 (2026-08-16):** the chat remains the way you talk
> to it, but it is no longer the front door standing alone — the stance surface
> is, with the conversation beside it. The dispatched-session/cockpit split
> stands.

## 11 · How a night runs

Added **2026-08-16**, from the conversation that found the trigger paradox:
manual-only means nighttime never comes; a free-running agent is the runaway
the user rightly fears. The resolution is not a dial position. It is that night
work splits into two phases with opposite safety profiles, and discretion is
concentrated into one auditable seam.

### 11.1 · Two phases, two clearances

**Mapping is convergent.** It projects a finite external reality — the assigned
issues, their dependency edges, what closed since the last look, what a capture
implies about a subject — into the plan. It has a fixpoint: when the map matches
the world, there is nothing left to do. It is read-only toward the world and,
under compress-never-multiply, anything it adds to the store is a proposal
marked agent-authored. **Mapping therefore self-initiates freely.** Idle is
enough; `humanActive()` exists for exactly this. It cannot run away because
reality is finite.

**Working is divergent.** There are infinitely many things worth drafting, so
this is where runaway and waste live. Working runs only under a subject's
standing permit (§7.6), under ceilings (max jobs, max tokens, per-subject
allocation), into containers (§3.1). A subject with no permit gets mapped and
never worked.

**This supersedes the 2026-08-15 decision that the night's trigger stays
manual.** The "Work on this now" button survives as one way in, not the only
one.

### 11.2 · Three roles, one seam of discretion

The failure mode of one agent doing map → select → draft is that the selector
grades its own homework — it maps the world in a way that justifies the work it
wants to do. That is what task-selection overfit is. A swarm each choosing for
itself is worse: nobody's selection is accountable. So:

- **Mappers** update the graph from reality. No opinion about what is worth
  doing. Parallelism here is harmless precisely because they have no selection
  power.
- **The selector** is one small structured call whose only output is tonight's
  plan: a ranked handful of atomic jobs, each citing the map ("#412, because
  #409 and #411 closed and Hito 1 closes in two weeks"), plus what it
  deliberately skipped and why. This is the frozen queue `night.ts` already
  expects.
- **Workers** are one ephemeral agent per job — the spec's "ephemeral experts,
  not resident ones." A worker executes its job and stops. It cannot add jobs
  to the night.

Everything upstream of the selector is mechanical; everything downstream is
bounded. Discretion lives in one place you can read the next morning.

### 11.3 · The plan is recorded, never approved

An earlier draft of this section put an approval in front of the plan. That
quietly reintroduced the old moat — approving a *promise* instead of a *diff* —
and it is deleted on the argument §3.1 already made. The plan is frozen when the
night starts and shown in the morning next to what came of it: an audit trail,
not a consent screen. What replaces per-night consent is standing state the
human already authored: permits, ceilings, the container rule.

The cost is named so it stays chosen rather than discovered: **the worst night
is a wasted night** — wrong priorities, drafts discarded, a morning of "no, not
that." It can never be a damaging night, because damage requires landing and
landing still requires a human. Wasted nights are also the training signal: the
discards are what the next selector reads.

### 11.4 · What a night is measured by

Overuse and overfit stop being vibes once selection is a single recorded
decision:

- **Overuse is cost-per-accepted-artifact, not cost.** The runner already
  threads usage out so the report can say what a night came to. A night that
  spent heavily on drafts that were all discarded is overuse; the same spend on
  accepted work is not.
- **Overfit is read off the selection record:** the accept rate on its picks
  (calibration), the never-picked set (the gnarly work it avoids reveals its
  blind spot), and repeat concentration on one subject or category. The
  structural counter: a pick that cannot cite a map edge does not run.
- **The report is the contract:** what ran, what it cost, what is waiting in
  which container, every question it wrote down instead of asking, and every
  refusal. Refused is a first-class outcome.

## 12 · The provenance law

> **Every action a night takes must trace to something the human fed in** — a
> capture, an assigned issue, a mirror, a standing permit. The assistant's
> autonomy is *interpretive*, never *volitional*: it has no goals of its own,
> only the human's, elaborated later and further than the human took them.

"los presupuestos no cuadran" is enough provenance to map the reconciliation
flow, draft the fix, and prepare the summary for Ana — each a delayed response
to eleven words. A job with no citation does not run, and the citation is
visible on every artifact in the morning report. The queue's old footer —
"every one traces to something you fed in or a mirror" — is promoted from a
caption to an enforcement rule.

This is also why vagueness is the *primary* input, not a tolerated one. The
dump is the command. Being sloppy at 11pm is safe because the raw fragment sits
forever beside what the assistant made of it, so drift is checkable at any
depth, any time later. Nothing is approved in advance; it is corrected when
looked at, and the correction becomes memory the next selector reads.

## 13 · The surface, redefined

Recorded **2026-08-16**, after driving both built surfaces against the real
store and finding both illegible. The diagnosis, verbatim from the person the
product is for: "I have no idea what I'm looking at… just a bunch of data with
some fancy surfaces."

### 13.1 · Why both versions failed the same way

Every surface answered "what is in the store?" — subjects, threads,
known/unanswered counts, facts. Nobody arrives with that question. They arrive
with three: **what needs me, what is being handled, what happened while I was
gone.** A screen organized by the memory model's taxonomy is a database
presenting itself; a screen organized by those three questions is an assistant
presenting itself.

The shapes experiment failed for the same reason one level down: it bet the
problem was the *pieces* — make Capture look unlike Thread and Fact and the
screen will read. But a work surface is not parsed by object type; it is parsed
by **ownership and state** — whose hands is this in, and is it moving. Six
visually distinct nouns is still six nouns to memorize.

The one surface that already read well is the packet page, and the reason
generalizes: it leads with the human's own words plus one interpretation, no
invented vocabulary. It survives unchanged.

### 13.2 · One screen, four bands

`/spool` is one screen: the assistant's **stance**, beside the conversation.

- **Needs you** — decisions, unanswered questions, night-written questions,
  anything prepared that lacks a container and is waiting for a human act.
- **In its hands** — live work, tonight's plan or the last night's record, work
  sitting in containers awaiting review. The morning report lives here, drawn
  from `night.json` and the store with **no model call** — "what happened" is
  rendered, never asked about.
- **Waiting on others** — threads parked on a named person.
- **Settled** — the drained and the done, present but quiet.

Every line is titled by the human's own captured words wherever they exist.
The taxonomy — threads, ripening, facts, provenance chains — is detail *inside*
an item once opened, never the vocabulary of the front page. The exotic memory
model is the engine, not the dashboard.

Departure is a glance, not a gate: the stance shows what the coming night would
work on (per §11.3, recorded, not approved). Arrival is the same screen with
the report at the top of "In its hands." No clock reaches any of it (§3.2).

### 13.3 · What this retires

The v2 composed canvas (the model choosing the layout produced duplicated
blocks and stat-laden titles on its first real screen — freshness traded for
drift), the shapes scratch page (its question is answered: the pieces were
never the problem), and the queue as a destination (the bands absorb it; the
inventory view survives only as detail). The chat, the packet page, and the
store underneath survive whole.

### 13.4 · The room

Built **2026-08-16**, after two passes of driving §13.2 against the real
store. `/spool` is three columns: the stance, a tray, the conversation.

The tray is **summoned, never resident**. The panel it replaces was a tab
strip — Desk, Night, Memory, Queue, plus every packet you had opened — and a
tab strip says "these things are always here," which is the queue's posture
wearing new chrome. Detail is something you call for: a stance line opens its
packet in the middle column, the night line opens the record, a subject's
shield opens the grants, and dismissing it is two columns again. One face at
a time; a second summon replaces the first. The old packet route survives as
a deep link that lands in the room with the tray already open — one renderer
of a packet, not two.

**Scope is the room's aperture,** everything or one subject, and its truth is
the focus log — "You're on ozom-gv" was already a record, so the aperture
reads it rather than growing a view-only copy that could disagree with the
pickup. Entering scope opens a focus entry; widening ends it (`paused`, a
fact about attention, never a status on the work). Every band renders through
the scope, and what is folded compresses to one line whose calm is **checked,
not hoped**: a folded subject with something waiting on you is named, with
its count, before the line may say nothing blocks you.

The chat is aware of the room — every turn carries one bracketed line naming
the scope, the tray's face and the bands' counts, visibly, so "file this" and
"what's this about" resolve against what is on screen and the human can read
exactly what the model was told. And the chat's **steerable vocabulary is
closed: scope and tray, never layout.** It can be asked to narrow the room or
to open a face; it cannot be asked to rearrange the surface, because a layout
a model can restyle is the v2 canvas again — freshness traded for drift, once
was enough.
