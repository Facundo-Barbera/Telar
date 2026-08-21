# Loom — the loop, closed

> Companion to [`loom-build.md`](./loom-build.md). Every other loom suite proves
> one layer. This proves the product: work discovered → triaged → dispatched into
> a worktree → gated → published, against a real git repository.

Two artefacts:

| | |
| --- | --- |
| `apps/engine/test/loom-e2e.test.ts` | The loop in CI. 13 tests, ~9s, no network. |
| `scripts/loom-demo.ts` | The same loop, printed for a human. `bun scripts/loom-demo.ts` |

## What they build

A throwaway project in a temp directory, with **no GitHub, no tracker and no
network** — which is the point of §1's four command slots and the only honest way
to show that nothing in the engine knows what GitHub is:

```
project/
  inbox/index.tsv     a1<TAB>2026-08-20T01:00:00Z<TAB>strip the prefix
  inbox/a1.md         the item, as prose
  gate.sh             exits with whatever a file outside the repo says
  .telar/loom.md      the Program
remote.git            a second local repository, bare, standing in for origin
engine/               engineRoot: looms, ledger, triage, worktrees
```

The Program's four slots and its gate, verbatim:

```
probe    cat inbox/index.tsv inbox/*.md | cksum
list     cat inbox/index.tsv
detail   cat inbox/$ITEM.md
publish  git push origin $BRANCH && echo "published http://localhost/branch/$BRANCH"
gate     bash ./gate.sh        0 pass · 1 fail · 2 unknown, on unknown: hold
```

`cksum` rather than `shasum`: POSIX, present on every CI image, one line of
stdout — which is the whole of `probe`'s contract.

## Real and faked

**Faked — two things, and only two.**

- `LoomAgent`: a scripted `TickDecision`. A real one costs money and would make
  the suite non-deterministic. What it decides is not under test; what the
  machinery does with its decision is.
- `LoomSessionPort`'s worker: a function that writes a file and commits it in the
  worktree, standing in for Claude doing the work. The harness only ever reads
  its exit status and its commits, which is the entire contract in §4.

**Real — everything else.** `createLoomRuntime`, `defaultLoomExec` spawning real
shells, `defaultGitRunner`, `createSessionWorktree` cutting real worktrees,
`git fetch` + `git rebase` onto the freshly fetched base, the never-touch diff
check, the gate, the `git push`, the store, the ledger, the triage cache. The
demo additionally runs the real daemon, its `/v2/looms/**` routes and the typed
`EngineClient` over HTTP.

`bun scripts/loom-demo.ts --real-agent` fakes nothing: the daemon's own
orchestrator decides and a real Telar session does the work in the worktree, with
an embedded worker started for it. It costs money and takes minutes. `--keep`
leaves the temp tree behind so you can open the worktree and read the ledger.

## What each scenario proves, and why it matters

1. **The happy loop.** Three items discovered, triaged, one dispatched into a
   real worktree, the worker commits, the gate exits 0, `publish` runs. The loom
   is `published`, `publishedUrl` is set, and the branch exists in the remote
   carrying the commit. *Without this nothing else is worth checking.*

2. **Idle is free.** Five sentinel passes over an untouched inbox invoke the
   agent **zero** times; changing one inbox file produces exactly one wake. *The
   property whose absence is invisible: a loop that wakes an agent to discover
   there is nothing to do looks perfectly correct and costs money forever.*

3. **Exit 2 holds — and the same exit 2 publishes when the policy says so.** One
   gate, one exit code, two outcomes, decided by the Program's `on unknown:`
   line. *A pass/fail model has no answer for "nothing failed, a gate skipped",
   and the right answer is a human's preference, not a convention.*

4. **Zero is not a green light either.** A Program declaring `0 fail` does not
   publish on exit 0. *The exit table is the only meaning an exit code has.*

5. **An undeclared exit code is `unknown`, never `fail`.** Exit 7 holds, and the
   reason says the Program does not declare it rather than that the gate failed.
   *`fail` would claim the project said no. It never said anything about 7.*

6. **Boundaries are enforced by the harness, not the worker.** A worker that
   commits `.env.local` alongside a legitimate change parks the loom terminally;
   nothing is published, and a second pass does not retry it. *The worker cannot
   skip what it never held, and a `.env` quietly rewritten at 3am is discovered
   by an outage rather than by a review.*

7. **A rebase conflict parks at rung 1 with the conflict text as the reason.**
   A human lands a conflicting commit on `main` after the worktree was cut; the
   gate phase rebases onto the freshly fetched base, conflicts, and the loom goes
   `stuck` with `CONFLICT … README.md` as its reason and a clean worktree behind
   it. *A gate result measured against a stale base describes a world the PR will
   not land in, and a conflicting branch genuinely needs a decision.*

8. **Nothing is merged and base is never pushed to.** Across a whole successful
   run `main`'s sha in the remote is unchanged, its commit count is unchanged, and
   the published branch is not an ancestor of it. *The failure mode of the
   alternative is silent and compounding.*

9. **Statelessness.** After a full tick the runtime is thrown away and a fresh one
   is built over the same engine root, with a session port that has never heard of
   the worker — a daemon restart. It reconciles from the loom file and the
   worktree's commits alone and reaches `published`. *That is the entire premise
   of a fresh agent per tick: nothing survives but files.*

10. **A killed worker is distinguishable from a running one.** A session still
    running leaves the loom `working` and the pass returns; a session that
    vanished with nothing committed goes `stuck` with "without committing" as its
    reason. *The two failure modes are calling it published and hanging forever.*

11. **Triage is cached and refreshed on `updatedAt`.** Two ticks over an unchanged
    inbox re-read `detail` zero times; bumping one item's `updatedAt` re-reads
    exactly one. Observed through the `detail` command's own append to a log file,
    not through a spy. *This is what makes "read the whole comment thread"
    affordable — once per item per change, not once every five minutes.*

Every assertion is on observable state: the loom record on disk, the ledger, the
triage file, the contents of the remote repository, or a file the Program's own
commands wrote. None is on an internal call count.

### And the seam the fake hid

Sections 1–11 above drive a `LoomSessionPort` written inside the test file, which
is cheap and is the right level for asserting the ladder, the gate table and the
sentinel. It is also exactly where the loop's central bug survived: the real port
cut a *second* checkout and handed the worker that one, so the loom's own branch
never received a commit and every finished worker read as one that did nothing.
Section 11 therefore runs the same loop through the **real** `createLoomSessionPort`
over a real `EngineStore`, claiming the turn through the same store API a worker
process uses. Only the text of the diff is scripted. Faking a port and faking a
worker are not the same concession, and this is the file that has to say so.

## Cleanup

One temp directory per test holds the project, the remote, the engine root and
every worktree the engine cut inside it, so a single `rm -rf` in `afterEach`
leaves nothing behind and no `git worktree prune` is owed. The demo does the same
unless `--keep`.
