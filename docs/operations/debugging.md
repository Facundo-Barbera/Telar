# Debugging Telar

Reproduce against a dev home, never the installed app's store. Every step here assumes `TELAR_HOME` names a dev home, such as the `bun run dev` default:

```sh
export TELAR_HOME="$HOME/.telar-dogfood"
```

How the processes fit together is in [architecture.md](../internals/architecture.md), and the engine's traps are in [engine.md](../internals/engine.md).

## Where output goes

| Process | Where |
| --- | --- |
| Engine, worker, cockpit under `bun run dev` | The terminal running it, lines tagged `[telar]`. |
| Embedded worker, packaged or dev | `<TELAR_HOME>/engine/diagnostics/worker.jsonl` (rotates to `.1`): connection, transport and outage events. |
| Worktree setup for a session | `<TELAR_HOME>/engine/sessions/<session id>/setup.log` |
| Desktop shell (main process) | `<userData>/shell.log`: startup failures, engine exits, `child-process-gone`, 401s and pairing redirects of the host window. |
| Desktop updater | `<userData>/update.log`. Telar Dev's "Update from Local Checkout" writes `<userData>/updates/update.log`. |
| Bundle-id hand-off helper | `<userData>/handoff/handoff.log` |
| Shell heap diagnostics | `<userData>/diagnostics/` |
| Leased dev environments (`scripts/env/up.sh`) | `~/.telar-dogfood-slot<N>/env-run.log` |
| Bounded engine test runs | `$TMPDIR/telar-engine-tests/engine-<time>-<pid>.log` |

`<userData>` is `~/Library/Application Support/Telar (dev)` for the dev shell and `~/Library/Application Support/Telar Dev` for the packaged Telar Dev app. A packaged app sends the engine's stdout and stderr nowhere, so use `shell.log` and `worker.jsonl` there.

## Is the engine up?

`<TELAR_HOME>/engine/engine.json` holds the engine's loopback port and its per-boot bearer token (mode 0600). Don't paste its contents anywhere.

```sh
D="$TELAR_HOME/engine/engine.json"
curl -s -H "authorization: Bearer $(jq -r .token "$D")" "http://127.0.0.1:$(jq -r .port "$D")/v2/health"
```

`worker.registered: false` means turns are accepted but nothing runs them.

`engine.lock` beside it records the owning pid. A lock whose pid is dead is broken automatically on the next start.

## Diagnose

Read-only questions about a store. The store is opened read-only, and the root must be explicit: `--root`, or `TELAR_HOME`.

```sh
bun run --cwd apps/engine diagnose stalled                 # runs silent longer than the engine's stall threshold
bun run --cwd apps/engine diagnose stalled --minutes 30
bun run --cwd apps/engine diagnose stalled --root /path/to/engine-root
```

The output is JSON: ids and times.

## Extra logging

| Setting | Effect |
| --- | --- |
| `TELAR_CLAUDE_RUNTIME_DEBUG=1` (engine env) | `[claude-runtime]` and `[claude-timing]` lines on stderr: runtime reuse, why a runtime was not reused, turns settled without a result frame, per-turn timings. |
| `TELAR_SHELL_HEAP_LOG=1` or `--telar-heap-log` (desktop) | A heap line in `shell.log` every minute, and one heap snapshot when the heap passes 1 GB. |
| `TELAR_EMBEDDED_WORKER=0` (engine env) | No embedded worker. `bun run dev` then starts the worker as its own process, so its output is separate. |

```sh
TELAR_CLAUDE_RUNTIME_DEBUG=1 bun run dev
```

The engine also prints how it resolved each provider CLI at start (`[telar] Claude Code CLI: …`). Check that line first when turns fail because the CLI is missing or its version doesn't match.

## Hung engine tests

At the repo root, `bun run test:engine` runs the suite under `scripts/test-engine-bounded.mjs`. It prints its log path before the run starts, kills the whole process group at the budget, and ends with one verdict:

| Verdict | Exit | Meaning |
| --- | --- | --- |
| `passed` | 0 | Tally printed, no failures, nothing left running. |
| `failed` | 1 | Tally printed with failures. |
| `hung` | 2 | No tally before the budget (15 min). The last line printed and the processes still holding the run are listed. |
| `unknown` | 3 | Exited without a tally: a load failure, crash or kill. Not a pass. |
| `leaked` | 4 | Everything passed, but a test left a process in the group. The listed rows name it; stop it in that test's teardown. |

```sh
TELAR_TEST_BUDGET_MS=300000 bun run test:engine
cd apps/engine && bun ../../scripts/test-engine-bounded.mjs --budget-ms 300000 -- bun test test/some.test.ts
```

A test that dies at 5 s instead of 20 s ran without the ceiling. That happens from a directory without a `bunfig.toml` (such as `apps/desktop`). Pass `--timeout 20000` or set `TELAR_TEST_TIMEOUT_MS`.

## Common failures

| Symptom | Cause and fix |
| --- | --- |
| `web port 3000 is unavailable on 127.0.0.1` | Another server holds the port. The launcher never falls back to another port. Stop it, or set `TELAR_WEB_PORT`. |
| `TELAR_HOME for Telar must be an absolute dedicated directory.` / `Refusing to use legacy TELAR_HOME` | `TELAR_HOME` is relative, or is `~/.telar` or `~/.telar-dev`. Use an absolute, dedicated directory. |
| `[telar] attached to existing engine` and your engine change has no effect | A running engine owns that home, and dev did not start or restart it. Stop the other run (or quit the app using that home), or use a different `TELAR_HOME`. |
| `Telar engine: engine state root is already locked (pid N)`, exit 3 | A live engine owns the home. In the desktop app this shows as "Telar is already running". Quit that process. |
| `engine state root is already being recovered` | A stale-lock recovery was interrupted and left `engine.lock.break` in `<TELAR_HOME>/engine`. With no engine running on that home, delete that file. |
| `Timed out waiting for engine` | The engine didn't answer health within 15 s. Read the engine's own error above it in the terminal. |
| `worker exited before registration` / `refusing to start the cockpit` | The worker died on start. Its error is above this line. The cockpit doesn't start without a worker. |
| Cockpit calls answer `engine_unavailable` | No engine is serving that home. `engine.json` from a crashed engine stays behind and is rewritten on the next start. Restart `bun run dev`. |
| `Set an absolute TELAR_HOME before opening the cockpit.` | The Next server was started without `TELAR_HOME`, for example with `cd apps/web && bun run dev`. Start it through `bun run dev`. |
| Launcher warns the cockpit is reachable with pairing off | `TELAR_WEB_HOST` is not loopback, or Tailscale Serve is on, and "Require pairing" is off. Turn it on in Settings ▸ Remote access. |
| Phone or browser locked out of pairing | Delete `<TELAR_HOME>/remote/remote.json` for the dev home and pair again. |
| Type error naming a route that doesn't exist | A stale `apps/web/.next`. See [development.md](development.md#type-errors-about-a-route-that-doesnt-exist). |
| `engine bundle not found … Run \`bun run build:app\` first` | An unpackaged shell was asked to boot the engine itself, as in `test:desktop:smoke`. Run `bun run --cwd apps/desktop build:app`. |
| `bad option: --smoke` running a packaged app | `ELECTRON_RUN_AS_NODE` was inherited from a shell that Telar opened. Run it with `env -u ELECTRON_RUN_AS_NODE`. |
| Packaged smoke fails with `ENGINE_WORKER_OK missing` | The packaged engine came up without a registered worker. Run the app binary with `--smoke` to see the engine's output. |
| "Telar's engine stopped" / "Telar could not start" dialog | The dialog names `shell.log`. The engine's exit code and the stack are there. |
| `check:source`: `cannot find the merge base with origin/main` | Run `git fetch origin main`, or set `COMMENT_RATCHET_BASE`. |
