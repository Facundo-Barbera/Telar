# CI throughput: what is actually slow, measured

**2026-09-20.** Written because `Verify` became the constraint on everything —
ten-plus jobs queued behind each other and `main` went 27 commits without a
green. Every number here was measured on the night it was written; none is
carried over from an earlier estimate. Where a figure contradicts something
previously believed, it is called out.

**This document did not decide anything — it was written to put the numbers in
front of the owner.** Both decisions have since been made, the same night, and
each is recorded at the section that framed it. The measurements are left
exactly as they were taken: they are what the decisions were made on, and
rewriting them afterwards would destroy the only record of why.

---

## The one-line answer

**The job is not slow; the queue is.** The job is ~3m35s. Runs waited
**39, 49 and 27 minutes** in the queue tonight before starting. Every proposal
below is worth less than that ratio suggests, and the queue is what to fix.

---

## Where the 206 seconds goes

Measured on the Mac, serially, in workflow order. The machine was at load
average ~5.3 throughout — that is the honest condition, because it is the
condition CI actually runs in, but it inflates absolute figures ~7% against a
quiet box.

| suite | seconds | share |
| --- | ---: | ---: |
| `test:engine-client` | 0.4 | 0.2% |
| `test:env` | 7.8 | 4.5% |
| **`test:engine`** | **127.6** | **73.7%** |
| `test:web` | 22.9 | 13.2% |
| `test:desktop` | 13.8 | 8.0% |
| `test:workers` | 0.3 | 0.2% |
| **total** | **173.1** | |

**The tail is one suite, not six.** That single fact invalidates the obvious
fix — see below.

Inside `apps/engine`: 159 files, 2 527 tests. The top file is 25.5s
(`test/ds-kernel.test.ts`), the top ten are 65% of the suite. The suite runs at
**61% CPU** — it is wait-bound, not compute-bound, because it spawns real
subprocesses.

---

## What does not work, with the numbers

### Parallelising the six suites: 19%, not a fix

```
serial six    173.1s
parallel six  139.8s     → 19% off
```

The floor is `test:engine`, and under concurrency it got *slower* — 127.6s →
139.8s — because the other five steal cores. All six passed concurrently, so no
isolation breakage surfaced: every test server binds `port: 0` and 109 files use
`mkdtemp`. The one racy pattern is `freePort()` in
`apps/desktop/browser-control-server.test.js:20` — a bind-close-rebind TOCTOU
that survived tonight but is the one to watch.

### Parallelising the four typecheck packages: actively worse

```
serial four    9.9s
parallel four  15.0s     → 52% WORSE
```

`apps/web` alone is 14.9s of it. Four concurrent `tsc` processes contend and the
`&&` chain was never the constraint. **Do not do this.** It looks like the same
change as the test one and is not.

### Sharding `apps/engine` four ways: 47%, and it breaks a test

```
serial       122.0s
4-way shard   64.2s     → 47% off (predicted 29.6s; contention ate the rest)
```

One shard failed. `apps/engine/test/run-manager.test.ts` passes in **0.735s
alone** and **times out at 20s** under 4-way concurrency — a 27× slowdown. It is
not a port collision; it spawns a real child process and starves. Sharding is
therefore **not free**: it needs that test fixed or the timeout raised first.
This is the same class as the timeout-ceiling failures seen earlier in the week.

---

## The hosted lane, measured

The 2026-09-11 billing refusal that moved `Verify` onto the Mac has cleared.
Run `35487517440` ran four shapes on `ubuntu-latest` side by side.

| step | Mac (loaded) | hosted cold | hosted warm |
| --- | ---: | ---: | ---: |
| `bun install` | 1s | **6s** | 6s |
| typecheck | 9.9s | 37s | 25s |
| lint | ~16s | 34s | 25s |
| test (six, serial) | 173.1s | **71s** | 100s |

Four things fall out of this, three of them against prior assumptions:

1. **The cold-cache fear was unfounded.** `bun install` is 6 seconds cold.
   `actions/cache` changed it by zero and its post-step costs up to 6s, so
   caching is **net negative**. Do not add it. (This supersedes the reasoning in
   the deleted `docs/ci-verification.md` about restore/save as separate steps —
   that analysis was correct for a slow install and the install is not slow.)
2. **Hosted is 2.5–3.7× slower on CPU-bound work** (`tsc`, `eslint`) **and
   1.7–2.4× faster on the test suite.** Same 159 files, same 2 529 tests: 69s
   hosted against 127s on the Mac. The Mac loses because it is at load ~5 serving
   everything else while the hosted box is dedicated and the suite is wait-bound.
3. **The six suites as a hosted matrix finished in 85 seconds wall**, first job
   start to last job end, gated by engine at 84s.
4. **Variance is large** — cold typecheck 37s against warm 25s; test 71s against
   100s. Quote ranges, never points.

**The repository is public, so standard GitHub-hosted runners are free and
unlimited.** There is no billing dimension to weigh for standard runners.

### The concurrent-job ceiling is at least 40

"Hosted" is not automatically "unlimited slots" — GitHub caps concurrent jobs
per account, and a matrix multiplies jobs per merge. A six-way split with four
merges in flight is 24 concurrent jobs, which would be over some plans' limits.
So the cap decides whether a matrix **removes** the queueing or **relocates**
it, harder to see than before because it would spread across matrix legs rather
than sit in one visible line behind one Mac.

Measured, run `35488350415` — 40 jobs each holding a slot for 25 seconds:

```
35 jobs started 04:07:47Z
 4 jobs started 04:07:48Z
 1 job  started 04:07:49Z
```

**All 40 started within two seconds, with no second wave.** A cap below 40 would
have shown one: jobs beyond the limit would start ~25s later, as the first batch
released their slots.

**Read this as ≥40, not as 40.** The probe establishes a floor, not the ceiling —
it was widened until it cleared the number in question and then stopped. Any
future shape wanting more than 40 concurrent jobs needs a wider probe. The scope
is account-wide, so nightlies and releases running hosted draw on the same pool.

GitHub documents 20 concurrent jobs for the Free plan and we measured twice that,
so either this account is not on Free or public repositories differ. Which of the
two is **not** determined here: `gh api user` returns `plan: null` for the token
available, and an unverified reason is not worth writing down.

### "Nothing here needs a Mac" is not true

`verify.yml`'s header says so. Nine tests disagree, and eight of them are a
worse problem than a platform dependency:

- **8 failures, all `apps/engine/test/plugin-driver-seam.test.ts`** —
  `ProviderUnavailableError: No Claude Code installation found`. That is an
  **environment** dependency, not a platform one: the suite shells out to a real
  Claude Code CLI, and the Mac passes only because it is the owner's development
  machine and has one installed. The logs show it probing real binaries and
  reporting `drifted · 2.1.232 (Telar expects 2.1.270)`.
  **`Verify` is not hermetic.** It is worth fixing on its own merits, separately
  from anything here, and it is also part of why `test:engine` is slow on the Mac.
- **1 failure, `apps/desktop/dev-update.test.js`** — the swap-helper test runs a
  generated shell script that calls `ditto`. Genuinely macOS-only.
- Linux additionally skips 12 more tests than macOS (26 against 14).

---

## What a cheap pre-merge gate would have caught

The proposal on the table was a PR gate of typecheck + lint only, with the full
suite after merge. Checked against the last 100 `Verify` runs — 73 success,
19 cancelled, 3 failure:

| run | failing step | suite | failure |
| --- | --- | --- | --- |
| `35468834478` | test | engine | `export retains post-migration history and reopens in a JSON-only store` |
| `35475591827` | test | web | `cards must paint > a semantic tint on a reading surface goes through the floor` |
| `35480720690` | test | web | `Failed to register. Happy DOM has already been globally registered` |

**All three were test failures. None was a typecheck or lint failure.** A
typecheck-and-lint-only gate would have caught **none of them** and shipped all
three to `main`.

But the per-suite numbers say the gate does not have to be that thin. Two of the
three were in `test:web` (22.9s). The five suites that are not `engine` cost
**45.2s together**:

```
engine-client 0.4 + env 7.8 + web 22.9 + desktop 13.8 + workers 0.3 = 45.2s
```

**A gate of typecheck + lint + everything-except-engine would have caught 2 of
3** and still fits in about 70 seconds on the Mac. Only the engine failure needs
the 127.6s suite. That is a far better-shaped split than "tests are expensive,
move them all", and it falls out of the measurements rather than being designed.

---

## Prior art, recovered

`verify.yml:4` points at `docs/ci-verification.md`, **which does not exist** —
it was deleted in `bf10f4bd` ("docs: clear out the generated doc set for a fresh
start"), taking the rationale with it and leaving the pointer dangling.

Recovered from git, it already contains the main-only job pattern:

```yaml
- name: Build apps/web (catches build-only breakage off the 10x path)
  if: github.event_name == 'push'
  run: bun run --cwd apps/web build
```

It also records two things that still hold: the `paths-ignore` trap
(*"a filtered-out run never reports, and a required check that never reports
blocks the pull request forever — cheap is not worth wedged"*), and that the
`push: main` trigger exists to catch **direct pushes to main**, which is a real
case for a solo maintainer and is not covered by any PR check.

One correction to it: the filtering trap is real but the conclusion stops one
step short. A workflow skipped by `on: paths` stays **Pending forever**; a job
skipped by a job-level `if:` reports **Success**. Job-level conditions are the
safe form of the same saving.

---

## Decision 1 — where `Verify` runs. **DECIDED: hosted.**

> **Decided 2026-09-20.** Facundo: *"Si lo que dices de los minutos es cierto,
> entonces no hay debate. Hay que quitar el runner del Mac mini y usar el de
> GitHub."* — and further, that the runner be removed from the machine
> entirely. Shipped in #754 (`Verify`) and #756 (the other five workflows).
> `Verify` now runs in **96 seconds wall** against 206s plus up to 53 minutes of
> queue. The iOS device tests are the one casualty and were parked knowingly
> (#755). The analysis below is what that decision was made on.

**Staying on the Mac** costs nothing in money and everything in throughput: one
runner, one job at a time, a 3m35s job, and the queue waits measured above. Six
workflows — CI, releases and nightlies — share that one machine, which is a
single point of failure.

**Moving to hosted** is free (public repo), runs the six suites in 85 seconds
wall instead of 206 serial, and frees the Mac for the work that genuinely needs
macOS: the nightly build, the iOS device tests, signing. The concurrent-job
ceiling measured above (≥40) is wide enough that a six-way matrix removes the
queueing rather than relocating it. It costs the 9 tests above, of which 8 are a
hermeticity bug worth fixing regardless and 1 is truly Mac-only and would need
`runs-on: macos-*` or a skip. **A hosted move is a nine-test fix first, not a
label change.**

**More runner instances on the Mac** — explicitly not actioned, nothing
installed. What it would take, for the record: the runner at
`/Users/facundo/actions-runners/telar-nightly` is a per-directory install with a
LaunchAgent, so a second instance is a second directory, a second registration
token and a second `svc.sh install`. Disk is a few hundred MB each plus a
checkout per concurrent job. The real cost is contention, and it is measurable
rather than theoretical: **4-way sharding on this 8-core / 4-performance-core
box already produced a 27× slowdown in one test and blew a 20-second timeout.**
Two concurrent `Verify` jobs would put two 61%-CPU wait-bound suites on the same
four performance cores. Expect more of exactly that failure, not a clean 2×.
Hosted runners give the same throughput multiplier with no contention and no
machine of his involved.

## Decision 2 — what is verified before a merge. **DECIDED: no split.**

> **Decided 2026-09-20.** Everything stays pre-merge. The two-tier split was
> asked for because the full suite was in the way; hosted removed the thing it
> was in the way of, so the trade stopped being worth making. The evidence
> against splitting is in the section above this one: all three `Verify`
> failures in the last hundred runs were TEST failures, so the cheap gate that
> was proposed would have caught none of them.

Note first: **the `main` ruleset has only `deletion` and `non_fast_forward`
rules, and no branch-protection object. There are no required status checks.**
`Verify` is already advisory in fact, so a split cannot lose a guarantee that
exists today — and nobody should assume a red check is currently stopping
anything.

If the full suite runs hosted in 85 seconds wall, **the pre-merge gate can be
cheap and the full suite can still be pre-merge**, which is a different and
better trade than the one originally described. That option only exists in the
hosted world, which is why Decision 1 comes first.

If the split happens anyway, the shape the numbers support is typecheck + lint +
the five non-engine suites pre-merge (~70s), engine post-merge — not
typecheck-and-lint-only, which tonight's history shows catches nothing.

---

## Already done, and not a decision

**A red `main` is silent today.** No workflow in this repository has any failure
notification at all — no `if: failure()`, no issue, no message, in any of the
six. `.github/workflows/main-red.yml` fixed that by opening an issue on a red
`main`. It was removed on 2026-09-25 along with `publish-red.yml`: a red run is
fixed when it happens, and GitHub's own failure notifications are the signal.

It is the prerequisite for any post-merge tier — "verified after the fact" is
worth nothing if nobody finds out — and it is useful immediately regardless of
which way either decision goes.
