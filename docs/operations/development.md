# Developing Telar

How to run the stack from a checkout, and the checks a change has to pass. For how the pieces fit, read [architecture.md](../internals/architecture.md) first.

## Prerequisites

- macOS on Apple Silicon. Desktop packaging builds arm64 only.
- Bun (the version is pinned in `packageManager` in the root `package.json`). Never npm.
- Node, for `bun run test:workers` (`node --test`).
- Claude Code installed and signed in. The engine uses your own CLI and refuses a turn without one. Codex and OpenCode are optional.
- Xcode, only for the iOS app.
- Tailscale, only to reach the cockpit from another device.

```sh
bun install
```

## Running the stack

```sh
bun run dev             # engine + cockpit in the browser
bun run dev:desktop     # the same, plus the Electron shell
```

`bun run dev` starts the engine (which runs an embedded worker), starts a separate worker only if none is registered, then serves the cockpit at `http://127.0.0.1:3000/`. If a healthy engine is already running for the same home, it attaches to it and leaves it running on exit. Ctrl-C stops only what this run started.

`bun run dev:desktop` starts one cockpit and points the dev Electron shell at it. Editing a top-level `.js` file in `apps/desktop` (except tests and `dev-runner.js`) restarts Electron; web changes use Fast Refresh. The runner prints the DevTools endpoint (port 9223 or the next free one).

### TELAR_HOME isolation

Each run uses one home. The engine store is `<TELAR_HOME>/engine`.

| Command | Engine home | Notes |
| --- | --- | --- |
| `bun run dev`, `bun run dev:desktop` | `$TELAR_HOME`, default `~/.telar-dogfood` | Must be absolute. `~/.telar` and `~/.telar-dev` are refused. |
| `bun run dev:on-dev-store` | `~/Library/Application Support/Telar Dev` | The store of the packaged Telar Dev app, with the desktop shell. |

- The dev Electron shell keeps its own browser profiles, tabs and `shell.log` in `~/Library/Application Support/Telar (dev)`, whatever `TELAR_HOME` is.
- With `dev:on-dev-store`, quit Telar Dev first. Otherwise the run attaches to Telar Dev's engine, and your engine changes don't run.
- Never point `TELAR_HOME` at the installed app's store. Tests and agents build fixtures in temp dirs ([security.md](../internals/security.md)).

A second, independent stack:

```sh
TELAR_HOME="$HOME/.telar-scratch" TELAR_WEB_PORT=3100 bun run dev
```

The launcher checks the web port before starting anything and fails if it is taken; it never moves to another port. To open the cockpit to another device, set `TELAR_WEB_HOST` to one private address (a tailnet IP). The launcher warns when the bind is not loopback, or when pairing is off while the cockpit is reachable. `TELAR_TAILSCALE_SERVE=1` also publishes it on the tailnet's `https://*.ts.net` name.

## Tests

Per workspace:

```sh
bun run --cwd apps/engine test
bun run --cwd apps/web test
bun run --cwd packages/engine-client test
bun run test:desktop        # Electron-free desktop unit tests
bun run test:workers        # push-relay and updates-proxy, under node
bun run test:operations     # scripts/*.test.*
```

`bun run test` runs all of them. At the root, `bun run test:engine` goes through the bounded runner (see [debugging.md](debugging.md#hung-engine-tests)). CI splits the engine suite into shards; to run a shard locally: `bun scripts/engine-shard.mjs 1 3`.

One file, from inside its workspace, so that workspace's `bunfig.toml` preloads apply:

```sh
cd apps/engine && bun test test/some.test.ts
cd apps/web && bun test path/to/some.test.tsx
```

`apps/desktop` has no `bunfig.toml`, so pass the ceiling yourself, or run the file from the repo root:

```sh
cd apps/desktop && bun test --timeout 20000 ./some.test.js
bun test apps/desktop/some.test.js
```

The per-test ceiling is 20 s. `TELAR_TEST_TIMEOUT_MS=<ms>` overrides it where you can't pass `--timeout`.

Electron tests run real Electron and are not part of `bun run test`:

```sh
bun run --cwd apps/desktop test:desktop:browser    # one of the test:desktop:* scripts there
bun run test:desktop:e2e
bun run --cwd apps/desktop build:app && bun run test:desktop:smoke
```

The smoke boots the bundled engine and the standalone cockpit, so it needs `build:app` first. Use the smallest layer that proves the change; `test:desktop:e2e` is a final integration pass. The `extension`, `extension-boot` and `webauthn` tests need the 1Password extension: set `TELAR_1P_CRX` to a packaged one or `TELAR_1P_UNPACKED` to an unpacked one.

## Checks

Before a PR, run the tests you touched plus:

```sh
bun run check:source
bun run typecheck       # engine-client, engine, web
bun run lint            # eslint, apps/web
```

`bun run verify` runs these three and the full test suite.

Report-only in CI, but worth running on what you touched:

```sh
bun run lint:ox         # oxlint: engine, desktop, engine-client; warns on files over 800 lines and functions over 150
bun run knip            # unused files, exports and dependencies; fails CI on any finding
```

### check:source

`scripts/source-invariants.mjs` checks the source text without running any app. Each failure names the check and says what to change. It includes the comment and size ratchets.

### Comment ratchet

It fails when:

- a workspace's comment-line count is higher than at the merge base with `origin/main`;
- a change adds a run of more than 6 consecutive comment lines. AGENTS.md allows 3.

It needs the merge base, so fetch first (`git fetch origin main`). To compare against another branch, set `COMMENT_RATCHET_BASE=origin/<branch>`.

There is no baseline file to update: the merge base is the baseline.

### Size ratchet

Against the same merge base, for TS/JS files (Swift: file size only), it fails when:

- a new file is over 800 lines, or an existing file grows past `max(800, its size at the merge base)`;
- a function over 150 lines is new (more than half its lines added) or grew. Untouched long functions pass.

Moves are followed down to 30% similarity, so moving a file keeps its history.

## Local desktop install (unsigned)

Builds an unsigned arm64 app from the working tree, uncommitted changes included. It never signs, notarizes, publishes or updates.

```sh
bun run desktop:package                    # build + smoke -> apps/desktop/release/mac-arm64/Telar.app
bun run desktop:install -- --open          # build + smoke + install to ~/Applications/Telar.app
bun run desktop:install -- --system        # ... to /Applications/Telar.app
```

`desktop:install` packages first, so don't run `desktop:package` before it. To install an already packed app without rebuilding (it smokes the app first):

```sh
bun run --cwd apps/desktop install:app -- --open
```

`Telar.app` from `desktop:install` replaces the installed app and opens the same store. To try a build without touching that store, build the separate Telar Dev app instead. It has its own bundle id and the home `~/Library/Application Support/Telar Dev`, and it ignores an inherited `TELAR_HOME` and `TELAR_DESKTOP_URL`:

```sh
bun run desktop:package:dev                            # -> apps/desktop/release/dev/mac-arm64/Telar Dev.app
bash scripts/package-desktop.sh --dev --install --open # -> ~/Applications/Telar Dev.app
```

- Quit Telar Dev before rebuilding it.
- The packaged smoke runs with a temp home, is bounded to 120 s (`TELAR_SMOKE_TIMEOUT=<seconds>`) and must print `SMOKE_OK` and `ENGINE_WORKER_OK`. It also prints `BUILD <title>` with the commit it was built from.
- On first launch macOS may block the unsigned app: Control-click it in Finder, choose Open, then confirm.
- Builds from `origin/main` and signed releases are in [release-desktop.md](release-desktop.md).

### Type errors about a route that doesn't exist

`apps/web/tsconfig.json` type-checks `.next/` and `.next-desktop/` alongside the source. A leftover `.next/` from an older build makes packaging or `bun run typecheck` fail with an error such as `Cannot find module '../../app/api/…/route.js'`. Stop the dev server, clear it, and build again:

```sh
rm -rf apps/web/.next
```

A packaging build rewrites `apps/web/next-env.d.ts` to point at `.next-desktop`. Don't commit that change: `git checkout apps/web/next-env.d.ts`.

## iOS, locally

The app talks only to the cockpit's `/api/**`. To use it against a dev stack, bind the cockpit to your tailnet address and pair from the phone (Settings ▸ Remote access):

```sh
TELAR_WEB_HOST=<tailnet IP> bun run dev
```

Build without signing:

```sh
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
xcodebuild -project apps/ios/TelarMobile.xcodeproj -scheme TelarMobile \
  -destination 'generic/platform=iOS' \
  -derivedDataPath apps/ios/DerivedData CODE_SIGNING_ALLOWED=NO build
```

Install "Telar Dev" on a phone connected by cable, and run the unit suite on it. Set `TELAR_IPHONE_UDID` to your device. Always pass the `.dev` bundle id, or the test host replaces the TestFlight app:

```sh
TELAR_IPHONE_UDID=<udid> apps/ios/phone.sh

xcodebuild -project apps/ios/TelarMobile.xcodeproj -scheme TelarMobile \
  -destination "platform=iOS,id=$TELAR_IPHONE_UDID" \
  -derivedDataPath apps/ios/DerivedData \
  -allowProvisioningUpdates DEVELOPMENT_TEAM=MM74W7WGAM \
  TELAR_APP_BUNDLE_ID=io.github.novarix.telar.dev test
```

`apps/ios/scripts/preview-server.py` serves a fixture for `-mobilePreviewURL http://127.0.0.1:8743`. Both the server and the app accept loopback only, so the fixture works in a simulator and not on a phone.

Snapshot lists decode through `Skippable`, which silently drops a row that fails to decode, so a mistyped field hides every row that carries it. Test each new decoded field against JSON copied from a real engine journal, not hand-written.

Bundle ids, signing and TestFlight are in [release-ios.md](release-ios.md).
