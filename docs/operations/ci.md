# CI

`verify.yml` is the gate. It runs on every pull request and on every push to `main`. The other workflows publish or deploy, and are covered at the end.

## Verify

It runs on hosted runners: Linux for most jobs, `macos-latest` for the jobs that need macOS. Every job refuses pull requests from forks. A fork PR gets no checks at all. To run it, re-push the branch to this repository.

There is no `on: paths` filter. A workflow skipped that way never reports, and a required check that never reports blocks the PR. Path scoping is done inside jobs.

| Check name | What it runs |
| --- | --- |
| `Source invariants` | `bun run check:source` (with `COMMENT_RATCHET_BASE=origin/<base>`), then `actionlint` over `.github/workflows/*.yml` |
| `Typecheck engine-client, engine, and web` | `bun run typecheck` |
| `Lint apps/web` | `bun run lint` |
| `Test web`, `Test desktop`, `Test engine-client`, `Test workers`, `Test operations` | `bun run test:<suite>` (matrix, `fail-fast: false`) |
| `Test engine 1/3`, `2/3`, `3/3` | `bun scripts/engine-shard.mjs <shard> 3` |
| `Test desktop on macOS (the ditto swap helper)` | `bun run test:desktop` with a JUnit report; fails if the macOS-only blocks were skipped or made no assertions |
| `Test the Electron suite (real Electron, real pages)` | each `test:desktop:<name>` Electron test in `apps/desktop`, each required to exit 0 and print its success marker |
| `Does anything here reach the iOS build?` | diffs the change against its base and matches paths with `.github/workflows/ios-paths.sh` |
| `Archive iOS (only when something iOS changed)` | on macOS: an unsigned Release archive, a type-check budget report, and `TelarMobileTests` on a simulator (at least 562 must pass). Otherwise a no-op on Linux |
| `knip` | `bun run knip`: fails on any unused file, export, dependency or config hint |
| `oxlint` | `bun run lint:ox`: fails on any finding in engine, desktop and engine-client |
| `Verify passed` | the aggregate: fails unless every job above reports `success` |

Notes for operating it:

- The iOS path filter counts `apps/ios/**` and `.github/workflows/ios-paths.sh` as iOS changes; editing `verify.yml` alone does not archive. If the diff can't be computed, the job assumes iOS changed and archives. The iOS job always runs, so it always reports `success` or `failure`, never `skipped`.
- `Verify passed` runs with `always()` and treats `skipped` or `cancelled` as failure. Add every new job to its `needs` list. A job left out can fail without turning the gate red.
- Three Electron tests are not run in CI because they need the 1Password extension package: `extension`, `extension-boot` and `webauthn`. Run them locally with `bun run --cwd apps/desktop test:desktop:<name>`.
- Concurrency: a pull request's runs share its ref, and a new push cancels the older run. On `main`, each commit gets its own group and is never cancelled.

### Required checks

The workflow is built around one required check, `Verify passed`, so jobs can be added or renamed without touching repository settings. The aggregate covers 15 check runs: `Source invariants`, typecheck, lint, the five `Test <suite>` runs, the three engine shards, the macOS job, the Electron job, `Does anything here reach the iOS build?` and the iOS archive. Counting `Verify passed`, that is 16 runs. `Guards` makes 17 but never blocks.

GitHub doesn't currently enforce any of them. `main` has no branch protection, and its only ruleset blocks deletion and force-push. To check the current state:

```sh
gh api repos/NovarixHQ/Telar/rules/branches/main
gh api repos/NovarixHQ/Telar/branches/main/protection/required_status_checks --jq .contexts
```

To enforce the gate, add a ruleset rule requiring the status check `Verify passed`.

## Engine sharding

`scripts/engine-shard.mjs <index> <total>` runs one slice of the engine suite:

- It collects every `*.test.ts` under `apps/engine/test`, sorts the list, and deals files round-robin: the file at zero-based position `p` goes to shard `p % total + 1`. There are no weights and no hand-kept list, so a new file lands in a shard automatically.
- The shard count is set in the `test-engine` matrix (`shard: [1, 2, 3]`, `total: [3]`). The `engine-shards-cover-every-test-file` invariant in `check:source` reads both values and fails if the matrix and the script disagree. To change the count, edit both axes.
- It runs `bun test --timeout <TEST_CEILING_MS> <files>` in `apps/engine`, through the bounded runner, with an 8-minute budget per shard. `TEST_CEILING_MS` is 20000, from `scripts/test-ceiling.mjs`.
- It compares the file count bun reports (`Ran N tests across M files.`) with the number of paths it passed. A mismatch or a missing line fails the shard. An empty shard also fails.

Reproduce one shard locally from the repo root:

```sh
bun scripts/engine-shard.mjs 2 3
```

Engine tests must live under `apps/engine/test/`. The shard script doesn't collect `*.test.ts` files anywhere else in `apps/engine`.

## The bounded engine runner

`scripts/test-engine-bounded.mjs` wraps a test command, kills the whole process group when the time budget runs out, and reports how the run ended:

| Exit | Outcome | Meaning |
| --- | --- | --- |
| 0 | `passed` | tally printed, 0 fail, nothing left running |
| 1 | `failed` | tally printed, some tests failed |
| 2 | `hung` | no tally, budget exceeded, group killed |
| 3 | `unknown` | exited without printing a tally (crash, preload or load failure) |
| 4 | `leaked` | all passed, but processes were still in the group afterwards |

- The default command is `bun run test` in the current directory. The default budget is 15 minutes, overridden by `TELAR_TEST_BUDGET_MS` or `--budget-ms`. Other flags: `--log-dir <dir>`, `--verdict-out <file>`, and `-- <command...>`.
- Each run writes a timestamped log to `$TMPDIR/telar-engine-tests/engine-<time>-<pid>.log`, and prints the log path at the start and at the end.
- For `hung` and `leaked`, the output lists the leftover processes as `[test-engine-bounded]   pid=… ppid=… pgid=… etime=… <command>` rows. Find the test that starts that command and stop it in the test's teardown.
- The shard script passes exit codes 2, 3 and 4 through unchanged.

Locally:

```sh
bun run test:engine                  # whole suite, bounded
bun run --cwd apps/engine test       # unbounded, same --timeout
```

## Reruns and flakes

```sh
gh pr checks <pr>                          # check states on a PR
gh run list --workflow verify.yml --branch <branch>
gh run view <run-id> --log-failed          # logs of failed steps only
gh run rerun <run-id> --failed             # rerun failed jobs (and their dependents)
gh run rerun <run-id> --job <job-id>       # rerun one job
```

- If you rerun only a failed job, also rerun `Verify passed`, or it keeps its red result. `--failed` does this for you, because the aggregate failed too.
- An engine shard that exits `hung` or `leaked` usually means a real leak, not a flake. Read the process rows before rerunning.
- Test timeouts come from `scripts/test-ceiling.mjs` (20 s). Use `TELAR_TEST_TIMEOUT_MS` to change it for a local run.

## Other workflows

- `deploy-push-relay.yml`: tests and deploys the push relay Worker. See [workers.md](workers.md).
- `nightly-desktop.yml`, `release-desktop.yml`, `publish-handoff.yml`: desktop builds and the bundle-id hand-off. See [release-desktop.md](release-desktop.md).
- `bump-computer-use-helper.yml`: runs Mondays at 06:17 UTC, or on dispatch. It runs `bun scripts/bump-computer-use-helper.mjs`, and if `trycua/cua` has a newer stable `cua-driver-rs-vX.Y.Z`, it rewrites `apps/desktop/src/main/computer-use-helper.json` and opens a PR from `chore/bump-cua-driver-<version>`. A PR opened with `GITHUB_TOKEN` doesn't trigger `verify.yml`. Push a commit to the branch, or close and reopen the PR, before merging. To check without changing anything, run `bun scripts/bump-computer-use-helper.mjs --check`.
- `ios-export-probe.yml`: runs `apps/ios/nightly.sh --export-only`, which archives and exports the iOS app with real signing and uploads nothing. Dispatch it by hand, or push to a `telar/*-probe-*` branch that touches the workflow, `apps/ios/nightly.sh` or `apps/ios/ExportOptions.plist`. Use it when the nightly's export step breaks.
- `nightly-ios.yml`: the TestFlight nightly, triggered by an `ios-nightly-*` tag or a dispatch. See [release-ios.md](release-ios.md).
