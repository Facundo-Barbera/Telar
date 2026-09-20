# Dispatch board

**This is the orchestrator's working file, not a convention file.** It is
deliberately *not* `AGENTS.md` or `CLAUDE.md`: nothing loads it automatically and
nothing should. A coordinator is pointed at it by the message that hires them,
reads it once, and carries the relevant parts into each worker's prompt in their
own words.

Why not the automatic route: a file that loads into every session is a tax on
every session, and it rots quietly because nobody is responsible for it. This one
has exactly one reader — a coordinator starting a batch — and one author, the
orchestrator who wrote the batch.

---

## 1. Rules that are not negotiable

These come from Facundo directly. A worker that breaks one has done damage that a
green test suite will not show, so they are listed before anything about how to
work.

**Do not touch the live store.** `~/Library/Application Support/Telar/engine/` is
the running cockpit's own data — his real sessions, his real history. Build a
fixture. Do not read it "just to check the shape", do not copy it, do not write to
it. If a task seems to require it, it does not: say so and stop.

**Do not restart Telar or any of its processes.** Not to make a change take
effect, not to clear a state, not as the last step of a fix. There is a button in
the app for exactly this and it is his to press. This includes quitting the app,
killing the engine, and anything that amounts to the same thing by another name.

**Do not start long-running processes.** No dev servers, no dev Electron shells,
no headless browsers, no simulators, no watchers. They survive the turn, they pile
up, and they have put his machine at load 27. Run a test suite, run a build, run a
script — all of which exit.

**Never print or log a key, token, or credential.** Not in output, not in a
comment, not in a test fixture, not in an error message you add. Reading a secret
into a variable is fine; putting it anywhere a human or a log could see it is not.

**Do not set up Tailscale or ask for network changes.** His words: we cannot force
a user to change their network for our app. A fix that requires it is not a fix.

**Do not touch the `lintel-nightly` runner.** It belongs to a different project and
its name differs from ours by four characters.

---

## 2. How work is done here

**Bun, never npm.** `bun install`, `bun run`, `bun test`. The lockfile is
`bun.lock` and it is modified only by the package manager.

**Conventional commits**, small and atomic, each a single logical change. Write
*why*, not *what* — the diff already says what.

```
Git author: facundo-barbera <facundo.barbera@gmail.com>
```

**Push branches and open PRs without asking.** That permission is standing. What
is *not* standing is merging — the orchestrator merges.

**Stacking is the default for related work.** If change B depends on change A, B's
branch is cut from A's, not from `main`. It does not reduce CI per PR — every PR
in a stack still runs — but the merge happens once. Do not parallelise work that
has a dependency just because parallel is available.

**CI runs on GitHub-hosted runners.** `Verify` is a matrix — `source`,
`typecheck`, `lint`, six test suites, one macOS leg — and aggregates into
`Verify passed`. It is roughly 96 s wall. Nothing runs on anyone's Mac.

---

## 3. Verification, and the failure that keeps happening

Every wrong claim tonight had the same shape: **something that was true once, and
was still being relied on after it stopped being true.**

- A PR that was green — on a base that has since moved.
- A commit pushed to a branch — whose PR had already merged, so it reached nobody.
- An issue that reads as unbuilt — whose feature shipped nine days ago.
- "Waiting on CI" standing in for "will pass".
- A grep that returned nothing — because `grep` here is a `ugrep` shim that hides
  `node_modules` and binaries. Use `/usr/bin/grep -a`.

The habit that catches all of them: **check the thing itself, not a report about
it.** `git show origin/main:path` rather than the PR's file list. The run's steps
rather than the job's colour. The current issue body rather than your memory of
it.

Four specific traps worth naming:

- A **cancelled** CI run is not a failed one, and is not a passed one either.
- `bun test <path>` from the root uses bun's **5-second** default. CI runs
  `bun run test:<suite>`, which carries `--timeout 20000` from the workspace's
  `package.json`. A 5007 ms failure is the clock, not the code.

  **That sentence was false for about three hours on 2026-09-20**, and this is
  the entry worth reading twice. #740 moved the ceiling from the script's flag to
  a bunfig `preload`, and **a preload's `setDefaultTimeout` does not reach every
  file** — reproduced on bun 1.3.11 with three identical 6 s files: `1 pass, 2
  fail`, both deaths at ~5000 ms. So 181 of the engine suite's 182 files were
  back on the 5 s default. #810 put the flag back on every script and the
  sentence is true again.

  What it cost: a coordinator copied the sentence **verbatim into three worker
  briefs** while it was false. This document's own §3 is about relying on
  something after it stops being true, and it happened *in* §3. A load-bearing
  factual claim here is a measurement with a date on it, not a fact. If one
  decides your diagnosis, re-run it.

- **A `pull_request` run does not test your branch.** It tests your branch merged
  with current `main`. So a test-count baseline a coordinator hands you is a
  measurement of a moment, and comparing a `pull_request` run against a `push
  main` run from a different head produces a wrong delta **that looks precise**.
  One PR on 2026-09-20 read as +42 against its own base and +16 against the main
  it was actually merged with; +16 was what it added. Compare like with like, and
  say which head each number came from.

**If your task's premise turns out to be false, say so and stop.** That is a
correct outcome, not a failure to deliver. One worker tonight was sent to build
something that already existed and refused with proof — that was the right call
and it saved a day. Of seven issues closed on 2026-09-20, **three had a wrong
premise** — not incomplete, wrong. Reproduce before you fix.

### Instruments lie too, including the ones you build to catch lying reports

This is the harder half. On the same night, three verification instruments
written specifically to check other people's claims were themselves broken:

- A `grep -E` with `\|` instead of `|` searched for a literal string and
  reported a PR body as missing four sections that were all present.
- A modifier-order checker matched on a fixed indent, missed two chains, and
  raised a false alarm against a worker whose refactor was correct.
- A CI probe filtered on `SessionView.swift` unanchored — and
  `NewSessionView.swift` contains it as a substring, so one view's cost was
  attributed to another.

Each time the artefact was sound and the tool was broken, and each time it was
caught by looking again rather than by the check passing. **A green check from
an instrument you just wrote is evidence about the instrument first.**

### Cheap habits that make a check non-vacuous

**Compare counts, not colours.** `main` had 3516 tests across 276 files; the PR
had 3533 across 277 — exactly the +17 and +1 it claimed to add. That proves the
new tests *ran*, where a green suite only proves nothing already there broke.

**A marker string must be unsatisfiable by anything but the thing it marks.**
`expect(error).toContain("Keychain")` was satisfied by the sentence "the
credential lives in the macOS Keychain" — a refusal for an entirely different
reason. Three tests in that file could not fail. If you add a grep-for-a-marker
guard, exercise **both** directions: it passes on a real run, and it fails when
the thing it guards did not happen.

The general form, which is wider than error messages: **any check keyed on a
string that both the success and the failure state emit is vacuous.** A substring
in an error message is the mild instance. **A test-name grep is the dangerous
one, because a skipped test prints its own name.**

That is not hypothetical and the example matters more than the rule. The `macos`
job's "prove the macOS-only block ran" check grepped `/tmp/desktop.log` for the
describe name `the swap helper, run for real against fake bundles`. A real log —
the ubuntu leg of run `35492116321` — contains:

```
(skip) the swap helper, run for real against fake bundles > success: candidate installed, …
```

So the string the guard required was present **exactly when the thing it guarded
against had happened**. It was vacuous from the day it was written, and it was
this repository's only example of the "prove it ran" idiom — which means it was
also the thing being copied. It was held up as the template to mirror, in
writing, twice, and mirroring it faithfully would have produced a second vacuous
guard reported as proven. It was caught only because the same instruction said a
guard whose string is satisfiable another way is not a guard, and that was applied
to the template rather than only to the new code. **Anyone sweeping for this
pattern will find that idiom in the history and reasonably read it as the good
one. It was not.**

Prefer a **count the failure state cannot produce** over a string that both
states emit: `skipped="0"` and `assertions>0` from `--reporter=junit`, or a test
total that moved by exactly what you added. Counts distinguish the states instead
of sharing a substring, and they do not drift as tests are added.

And when the honest mechanism looks worse than the elegant one, take the honest
one. A `(pass) …` grep was rejected here because bun prints per-test lines only
under GitHub Actions — zero locally across four environments — so its negative
case could not have been exercised at all. **Choosing a worse-looking check you
can falsify over a better-looking one you cannot is the whole of this section.**

**`du` and link counts cannot see APFS block sharing.** `du` reports the apparent
size of every clone, so it overstates a deduplicated tree; a link count reads `1`
whether cloning worked or not, because a clone is not a hardlink. On macOS `bun
install --backend` defaults to **`clonefile`**, so both of the natural ways to
prove a dedup fix worked would show nothing had changed. Measure with a **`df`
delta**.

This is the strongest instance of the pattern so far because it is the only one
where *both* obvious instruments fail in the same direction, and it is worth
being precise about how it happened: **#633 measured a link count carefully and
concluded deduplication was switched off.** The measurement was sound and the
mechanism was wrong — bun does not hardlink on this platform, so `links 1` is
what a *working* install looks like. Not sloppiness; the wrong quantity,
measured well.

**And "the filesystem supports it" is an inference, not an observation.** The
volume in that issue is formatted APFS, which is a reason to expect cloning and
not evidence of it. `cp -c` between two paths on that volume succeeding is the
evidence. Formatted-as-APFS and mounted-with-cloning-available are two claims,
and the cheap one to check is the second.

**An empty result from a tool you just wrote is a claim about the tool.** This is
the general form of the section above, and the sharper half, because silence
reads as an answer. The `grep -E` with `\|` returned nothing and that looked
exactly like "those four sections are missing".

The count habit above has its own instance of it, found while applying that
habit: the obvious way to read a job's test counts is

```
gh api repos/OWNER/REPO/actions/jobs/<job-id>/logs      # returns nothing usable
```

which refuses with *"the response contains terminal escape sequences"* and yields
one unusable line, so a grep over it comes back empty and looks like "CI does not
report counts". What works:

```
gh run view <run-id> --log --job <job-id>
```

then grep for `Ran N tests across M files`. Two PRs whose counts were sitting
right there would have been reported as unverifiable on the strength of that
empty result.

**The actionable rule, which stands on its own: prefer the job-level view.**
`gh run view --json jobs` over `gh pr checks`. That is already the standing habit
— the run's steps rather than the job's colour — and what follows is a reason for
it rather than a new rule.

**One unreplicated observation, recorded as one.** A worker reported that on
#778, `gh pr checks` showed `Test engine` and the Electron suite as `pending` for
several minutes after `gh run view --json jobs` already had all eleven real jobs
`completed/success`, with only the aggregate still queued. Reporting from `pr
checks` would have described a job as running that had passed four minutes
earlier. **Not reproduced.** The coordinator could not corroborate it: it never
had both views open at the same instant, and the lag is transient, so it cannot
be re-measured after the fact.

That paragraph is deliberately an observation and not a diagnosis, and the
distinction is the reason it is allowed here at all. **#706 was filed in this
same shape — "so a third observation has something to land against" — and it was
wrong, and it cost a worker a turn.** What made #706 harmful was not that it was
filed on thin evidence; it was that it stated its *diagnosis* as fact. So if you
reach for this entry as precedent: the precedent is naming what is unreplicated,
not filing a guess. An observation with its limits stated keeps this file's bar.
The same observation written as a mechanism lowers it.

**Before you treat a discrepancy as damage, check that both numbers measure the
same thing.** Characters are not bytes — a 44-byte gap between python's `len()`
and `wc -c`, on a file carrying multibyte quotes and dashes, read exactly like a
stale-base clobber of someone else's commit. A share of the qualifying rows is
not a share of the file — journal compaction reported as "11% instead of 57%"
was two figures that were **both true**, with different denominators. In each
case the artefacts themselves settled it (diff the live file against the intended
one), because from the number alone both stories are equally credible: reasoning
produces whichever one you went looking for.

### A report of what happens next is not evidence that anything is running

Worse than silence, because silence at least looks like silence. A worker ended a
turn with *"#740 is committed and its full verify is running; I'll start #748 the
moment the tree is free"* — and the turn was over. Three commits sat in its
worktree, nothing was pushed, no PR existed, and the second issue had never been
started. Nothing was lost and nothing had landed. The report read as progress
because it described the future in the present tense, which is what a working
agent's status update also does.

**Check the remote, not the narration.** `gh pr list` and `git ls-remote --heads
origin` answer this in one call each, and they answer it about the world rather
than about the report.

**Do not use a branch-name glob for it.** The first version of this entry
suggested `git branch -r --list 'origin/telar/*'`, which is this same failure one
level down: the worker above was on `fix/740-test-ceiling-preload` while its
session branch was `telar/740-748-…`, so that glob would have answered "nothing
pushed" for a branch that had been. Only `gh pr list` carried the original
conclusion. **A check that assumes a naming convention is a check on the
convention.**

For coordinators specifically: **a worker's turn ending is not a worker's work
finishing.** Confirm against pushed branches and open PRs before you relay a
result, and before you free the slot — a batch that counts an unpushed worktree
as delivered will report itself complete while the work sits on a disk nobody is
reading.

### A question you cannot see is not a question nobody asked

A question asked through the CLI's own question control resolves **inside the
turn**. It never becomes an engine request, so it never sets `activity ===
"blocked"`, never reaches the rail's **Needs you** band, and leaves no trace in
the journal — before or after. From a coordinator's seat, **"asked and answered"
and "never asked" are the same picture.**

On #723 a coordinator read a worker's finished turn as having explained the
decision instead of asking it, and sent it back to park the question as a real
request. The worker had asked; the owner had answered — which surface the
control lives on, and what it shows while holding — and the open PR already
implemented that answer. Only the worker's refusal stopped the owner being asked
a third time for a decision he had made once, while three other conversations
wanted the same attention. **"No request parked" is not evidence that nobody
asked**, and it is the coordinator's inference, not the worker's silence, that
was wrong.

Two halves, and the second is the one that gets skipped:

- **If a decision needs to be visible to anyone but you, park it as a request.**
  That is the only form an orchestrator can see, wait on, or resolve.
- **If you already have an answer, say so in your report, in words.** Nobody can
  see that you have it, so a report that treats it as shared context reads
  exactly like one from a worker who never asked.

---

## 4. Reporting

Report to the coordinator who hired you, not to the main session.

**Report when you are blocked or when you are finished. Not on a clock.**

This replaces the ~25-minute cadence that was in force on 2026-09-20, and the
reason is worth keeping because it is not about report quality. Those reports
were good — two of them corrected the orchestrator's own premises before either
cost a worker a day. But **every message to the main session wakes it, and
waking it interrupts the person in the cockpit.** He asked for that to stop. The
cadence, not the content, was the cost.

So: **blocked** means a decision that is not yours to take, or a rule you would
have to break to proceed. It does not mean a status update, a milestone, a good
finding, or a premise correction.

Findings, corrections and measurements go where they outlive a message — the
issue, the PR body, this file. A struck-and-corrected comment on the issue is
worth more than a message to a coordinator, because the next person to read that
issue is not in this conversation.

When you finish, send exactly one message saying so.

Lead with what is true now. Name what you could not verify as unverified rather
than smoothing it into the narrative. If you changed the plan, say what you
changed and why — a coordinator that learns about a departure from the diff has
been given a worse report than a short one.

**Pass this rule downward.** A coordinator that stops reporting upward while its
workers keep reporting on a clock has not removed the interruption, it has moved
it one level down and made it arrive as a burst.

---

## 5. The board

Waves are capped. **No more than 2 workers running concurrently per coordinator**,
and no more than 3 coordinators at once. Unbounded fan-out is what put the machine
at load 27.

### The cap is on the machine, not on a coordinator

**One worker at a time per coordinator, and never more than four workers running
across the whole machine at once.**

The earlier rule — two workers per coordinator — was written when there was one
coordinator, and it survived into a night with four. Two each is eight. On
2026-09-20 that put the machine at **load 26.8**, with eight `bun` processes at
~75% CPU apiece, each one a worker running its suite. That is the number the
owner has named explicitly as the thing that must not happen again, and it was
reached while every coordinator was individually obeying its cap.

A per-coordinator limit does not bound the machine. It is the same failure this
document's §3 is about — something true in one place, relied on somewhere its
premise no longer holds — committed in a rule rather than in a report.

**A coordinator running the suite itself is not a way around this.** It is the
same load wearing a different name.

Before starting a worker, look at what is already running across all
coordinators, not just your own.

---

**Waves are retired.** On 2026-09-20 the owner stopped them:

> *"te pedí hace un rato que fuéramos de lo más viejo a lo más nuevo y no has
> podido cerrar issues de hace más de 2 semanas. Necesito que paremos todo lo que
> está en cola y lo vayamos solucionando uno por uno, no importa el tiempo que
> tome."*

He had asked for oldest-first, one at a time, and got parallel waves of whatever
was tractable instead. **Oldest first, one issue at a time, however long it
takes.** The batch coordinators below exist only for small fixes that are
genuinely independent of each other and of the main line; they are not a wave.

### The night of 2026-09-20

**Closed:** #49, #199, #471, #488, #516, #771, #779, #790, #791, #792.
**Merged:** #793–#795, #796, #797, #799, #801, #802, #804, #805, #809, #810, #811.
**Filed by the work itself:** #789, #790, #792, #803, #807.

The open count did not fall. Ten closed, five opened. That is the shape of a
night spent on real causes rather than on the list.

**Still in flight:** #198 W2 (the xterm.js surface, unblocked by #794's PTY) and
#490 W3 (the snooze wake edge on #586's feed).

### What the night taught, beyond the diffs

**A premise died in almost every errand, and each death was cheaper than the
build it prevented.** #198's first milestone had shipped ten days earlier and the
brief would have rebuilt it. #490's transcript paging had shipped six days
earlier, claimed missing because neither file holding it matched the grep. #792's
stated cause was backwards — the ordering is the other way, verified by running
it. #811 was sent to measure three tools that #805 had already measured, and
confirmed the numbers to the byte rather than taking either report's word.

**Three instruments were vacuous, and one of them was built to prevent exactly
its own failure.** `perf-marks.test.ts`: six tests, all passing with the clock
frozen at 0. `test-ceiling.test.ts`: could not see that a preload's ceiling stops
at the first file, because every case it ran spawned a child with exactly one
file — the only arrangement in which the preload holds. And a byte-budget table
that would have accepted a `sessions_grep` answer of 241 bytes matching nothing,
reading as an unusually good result.

**The load was orphans, not concurrency.** At load 26.8, five `bun test`
processes had been alive 28 to 56 minutes against a three-minute suite, four of
them from one worktree. Killing them took the machine to 14.8 in a minute. The
obvious reading — too many workers — was *also* true and separately corrected,
but acting on it alone would have throttled real work while the leak continued.
Filed as #807.

### Needs Facundo

- **#541** — Agent v2. Held at his word on 2026-09-20: *"mejor dejamos este issue
  solo hasta mañana."* It is the third definition of the Agent's shape and the
  issue itself says it must be the last for a while. Parts A and D were the
  recommended cut; he has not taken it.
- **#760** — which tests earn their place. The analysis is done; what to delete
  is a judgement about risk appetite, not a measurement.
- **#791's remaining half** — making agents produce attribution markers
  *routinely*. What shipped works on any comment that carries a marker and needs
  no decision. Coverage needs either a `github_comment` tool on the session wall,
  which reverses the read-only posture `github_status` was built under and adds a
  write verb to every session, or a line in the session briefing, which is cheap
  and reversible and strictly a claim. The worker shipped neither on purpose,
  because both change every session's wall or prompt.

  Keep the scope straight either way: the marker claims *"this body claims
  session X"*, never *"session X wrote this"* — a model shelling out `gh` can
  type any marker, including one copied off another session's public comment. The
  panel draws it as a link to go and check, never a badge, and nothing
  authorises on it.

Anything else that reaches "this needs him" goes here rather than into a
message.
