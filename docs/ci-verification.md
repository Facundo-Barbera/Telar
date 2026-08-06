# The verification gate

`.github/workflows/verify.yml` runs on every push to `main` and every pull
request. It is the gate that should have existed before `v0.1.0-beta.1` was cut:
until it landed, nothing in this repo ran a test, a typecheck or a lint
automatically. The two workflows beside it sign and publish a desktop app and
verify nothing on the way past.

This document holds the reasoning. The workflow file holds only what a reader
needs at the point of use.

## Why ubuntu, not macos-14

GitHub bills macOS runners at **10x** the per-minute rate of ubuntu. Every check
in this workflow — `tsc`, `bun test` over `packages/core` and `apps/web`,
ESLint, the desktop browser-manager unit test — is pure JS/TS with no native
toolchain, no Electron boot and no code signing. Running it on `macos-14` would
multiply the monthly bill by ten and buy nothing.

The desktop **smoke** and **e2e** gates genuinely do need macOS: a real Electron
binary plus a built Next standalone bundle. They stay where they already are, in
`build-desktop.sh` / `package-desktop.sh` on the tag-triggered and
manually-dispatched release workflows, which run rarely. They are already
fail-closed there — the packaged binary must print `SMOKE_OK` or the build exits
nonzero — so duplicating them on every push would pay 10x rates for coverage
that already exists.

## Why one job, not a matrix

Splitting core / web / desktop into parallel jobs is the reflex, and here it is
the more expensive reflex. Billing is the **sum of job minutes**, not
wall-clock, and **GitHub rounds every job up to a whole minute**. A three-way
split pays runner startup, checkout and `bun install` three times over — install
being the single most expensive step — and then rounds up three times instead of
once.

Measured per-step, that is `2 + 3 + 4 = 9` billable minutes against roughly 5
for the single job: an 80% surcharge to shorten a run nobody is blocking on.
Steps inside one job are free.

If the suite ever grows past the job timeout, split then — and split by install
cost, not by neatness.

## What it costs

Locally, with warm caches on Apple Silicon, the whole thing is about
**1:15–1:25**. That is *not* the CI number and quoting it would be dishonest: a
runner is always cold, `apps/web` sets `incremental: true` so its warm 2.0s
typecheck is 9.9s cold, and a standard runner has two slower cores.

Budget **~5 billable minutes per run** at 1x:

| Scenario | Cost |
|---|---|
| One PR with three follow-up pushes, plus its merge | ~25 min |
| Twenty PRs in a month | ~500 min (about a sixth of the Pro allowance) |
| One `macos-14` desktop build, for scale | ~63 min — a single nightly costs about twelve runs of this |

### No `paths-ignore` filter

Skipping docs-only pushes would save a few minutes a month. But once this check
is required in branch protection, a filtered-out run **never reports**, and a
required check that never reports blocks the pull request forever. Cheap is not
worth wedged.

### The `push: main` trigger is not redundant

Merging a green PR spends ~5 more billable minutes re-verifying a tree the PR
already verified — roughly 100 minutes a month at twenty merges, about 3% of the
allowance.

It is kept because it is the only thing that catches a **direct push to main**,
which a solo maintainer who declines "do not allow bypassing" in branch
protection can still do — and because a broken `main` is what a release gets cut
from. If the workflow ever becomes "every change goes through a PR, no
exceptions", deleting those two lines is a real and safe saving. Deleting them
while direct pushes still happen is not.

## Pinned versions and the cache

### `setup-bun` carries no version, and that is a pin

`oven-sh/setup-bun@v2` with no `bun-version:` input reads `packageManager` from
`package.json` first (then `engines.bun`, and only then falls back to `latest`),
so it resolves to the declared `bun@1.3.11` on every run. Spelling the version
out in the workflow as well would create a second place to update on a Bun bump,
and therefore a new way for the two to disagree. `package.json` stays the single
source of truth — which is also what the two release workflows get from the
identical bare invocation.

**Known drift, deliberately not fixed here:** local development is on bun 1.3.14
while `package.json` declares 1.3.11, so CI and the maintainer's machine are one
patch apart. Bumping `packageManager` would also change the Bun that signs and
packages the desktop release, which is not a change this workflow should smuggle
in. Owner's call.

### Why restore and save are separate steps

`actions/cache@v4` declares `post-if: success()`, so the combined action **skips
its save step whenever any earlier step failed** — and this job exists to fail.

The bad path is concrete: a dependency-bump PR changes `bun.lock`, misses the
cache, does a full cold install, then `bun run test` goes red, nothing is saved,
and every subsequent push on that PR pays the full cold install again. The exact
PR where installs are most expensive would be the one that never gets a cache.

`save-always: true` is **not** the fix — the action's own deprecation message
says it does not work as intended and is being removed. Hence restore/save as
separate steps with `if: always()`.

**No `restore-keys`.** A prefix fallback guarantees a partial hit on every
lockfile change: restore an old cache, download the delta, then re-upload a
strictly larger archive. Bun's global cache is never pruned, so that ratchets
upward forever. An exact-key-only cache makes a miss a clean cold install
instead.

### The cache is the one unmeasured assumption

The archive is ~1.2–1.6GB, restoring it costs ~25–50s, and a cold `bun install`
of ~1200 packages on a runner's network is ~30–60s. The ranges overlap almost
entirely, so the cache may be buying ten seconds, nothing, or less than nothing.

Both numbers are printed in the log of every run.

> **Decision rule for whoever reads run #1:** if *Restore Bun's global install
> cache* costs as much as or more than *Install dependencies* did on the
> preceding no-cache run, delete both cache steps outright. That saves the
> restore, the save, and all the storage.

## The two ceilings

Neither lint nor the core test-tree typecheck is clean today. Both are pinned as
ceilings rather than gated clean, on the same argument: failing on pre-existing
findings would red-X every PR from day one and the gate would be switched off
within a week, while `continue-on-error` would make the check decorative and let
the backlog grow behind a green tick.

So: every finding is printed, **new ones fail the build, existing ones do not**,
and clearing them lowers the number in the script.

- **`scripts/lint-ceiling.mjs`** — `apps/web` carries 158 known problems (130
  errors, 28 warnings). Paying them down is not this workflow's job.
- **`scripts/typecheck-ceiling.mjs`** — `packages/core/tsconfig.json` excludes
  `test`, so until this branch **nothing typechecked core's 116 test files at
  all**. `bun test` strips types rather than checking them, and a deliberate
  `const x: number = "nope"` planted in that tree was checked green. `apps/web`
  had no such hole, which made the coverage silently asymmetric. Turning core's
  test tree on surfaces 264 pre-existing errors.

**Both scripts also assert how many files were looked at.** A ceiling counts
findings, not coverage — so an over-broad ignore glob makes findings fall to
zero, which a ceiling alone would report as an improvement and exit green on.
That is not hypothetical: the commit adding this workflow also adds a new ignore
glob to `apps/web/eslint.config.mjs`. ESLint currently walks 468 files, and that
floor is enforced.

## What this gate does not check

**`next build` is deliberately absent.** Naming it here because a reader who
sees a check called "Verify" will reasonably assume the app still builds, and it
does not check that.

`next build` appears exactly once in this repo — `apps/desktop/build-web.sh`, on
the tag-triggered macOS release path. So server/client boundary violations,
misplaced `"use client"`, and route-type failures — none of which `tsc` or
ESLint see — are currently caught at 10x rates in the middle of a release. That
is genuinely the wrong place to catch them.

It is still left out, for two reasons:

1. **Cost.** A cold Turbopack production build of this app is minutes, not
   seconds. For scale, the entire macOS desktop build is 376s, of which 214s is
   signing and notarization. Adding it to every PR push plausibly doubles a
   ~5-minute job — roughly 240 extra billable minutes a month at twenty PRs,
   against maybe one failed release a month costing ~20. On minutes alone that
   trade loses badly.
2. **It could not be verified before shipping the workflow.** The maintainer's
   machine has no `node` on `PATH`, so `bunx next build` runs Next under Bun
   there (the bin's shebang is `#!/usr/bin/env node`) and dies immediately with
   `TypeError: generate is not a function` out of
   `next/dist/build/generate-build-id` — reproduced on both bun 1.3.11 and
   1.3.14, with and without the desktop's standalone flags. GitHub runners ship
   Node, so this very likely does not happen in CI, but "very likely" is not a
   thing to put in a required check sight unseen.

If you want it, the cheap shape is main-only rather than every-PR. It still
catches breakage before any tag is cut, at a fifth of the cost:

```yaml
- name: Build apps/web (catches build-only breakage off the 10x path)
  if: github.event_name == 'push'
  run: bun run --cwd apps/web build
```

Verify a build works on a runner first, then add it, then raise
`timeout-minutes` to match.

## Branch protection

Not enabled by this workflow — it is a repository setting and the owner's call.
Once `verify` has gone green on `main` at least once, require it in branch
protection so the gate is real rather than advisory.
