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

Two specific traps worth naming:

- A **cancelled** CI run is not a failed one, and is not a passed one either.
- `bun test <path>` from the root uses bun's **5-second** default. CI runs
  `bun run test:<suite>`, which carries `--timeout 20000` from the workspace's
  `package.json`. A 5007 ms failure is the clock, not the code.

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

### Two cheap habits that make a check non-vacuous

**Compare counts, not colours.** `main` had 3516 tests across 276 files; the PR
had 3533 across 277 — exactly the +17 and +1 it claimed to add. That proves the
new tests *ran*, where a green suite only proves nothing already there broke.

**A marker string must be unsatisfiable by anything but the thing it marks.**
`expect(error).toContain("Keychain")` was satisfied by the sentence "the
credential lives in the macOS Keychain" — a refusal for an entirely different
reason. Three tests in that file could not fail. If you add a grep-for-a-marker
guard, exercise **both** directions: it passes on a real run, and it fails when
the thing it guards did not happen.

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

---

## 4. Reporting

Report to the coordinator who hired you, not to the main session.

Lead with what is true now. Name what you could not verify as unverified rather
than smoothing it into the narrative. If you changed the plan, say what you
changed and why — a coordinator that learns about a departure from the diff has
been given a worse report than a short one.

---

## 5. The board

Waves are capped. **No more than 2 workers running concurrently per coordinator**,
and no more than 3 coordinators at once. Unbounded fan-out is what put the machine
at load 27.

| Wave | Coordinator | Issues |
|---|---|---|
| 1 | iOS release path | #757, #758 |
| 1 | Engine defects | #520, #521, #594, #710, #743 |
| 1 | Tests and tooling | #622, #633, #732, #740, #748 |
| 2 | — | #488, #547, #577, #620, #632, #639, #658, #686, #697, #711 |
| 3 | — | #516, #543 (one worker each, these are large) |

**Needs Facundo, do not start:** #49, #198, #199, #471, #490, #541, #542, #563,
#586, #587, #637, #646, #665, #670, #694, #705, #723, #741.
