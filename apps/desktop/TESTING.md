# Desktop development and testing

Telar keeps UI iteration, desktop startup checks, and full Electron integration tests separate.

## Browser-host invariant

Telar's integrated browser follows the T3 Code-derived desktop architecture:
Electron owns browser tabs, `WebContentsView` instances, bounds, visibility,
accessibility snapshots, and CDP interaction. The web renderer is a presentation
and attachment layer that talks to that existing host through the preload bridge.
Do not add a second renderer-owned Playwright, Chromium, or CDP browser as a
fallback; that would split the tabs agents control from the tabs users can see.

## Live UI design

- Use `bun run dev` for normal renderer work and inspect the retained browser tab.
- Use `bun run dev:desktop` when the change depends on Electron, native browser views, IPC, or
  window behavior.
- The desktop runner keeps the Next development server alive. React changes use Fast Refresh;
  only changes to `main.js`, `preload.js`, or `browser-manager.js` restart Electron.
- The runner prints the retained renderer URL and Electron DevTools endpoint. Agent inspection
  should attach to that existing process instead of launching another desktop instance.

Desktop development uses the same `~/.telar-dev` state as `bun run dev`, so registered projects and
sessions remain available when switching between browser and Electron UI work. Set `TELAR_HOME` to
use an isolated directory, or `TELAR_DESKTOP_URL` to point Electron at an already-running Telar web
server. Automated desktop tests remain isolated in temporary state directories.

## Verification layers

| Command | Purpose | Starts Electron | Starts a server |
| --- | --- | --- | --- |
| `bun run test:desktop` | Fast browser-manager unit and contract tests | No | No |
| `bun run test:desktop:smoke` | Packaged-server and desktop dependency smoke check | Yes | Yes |
| `bun run test:desktop:e2e` | Shared-tab, CDP, cursor, and browser-control integration | Yes | Yes |
| `bun run test:desktop:profile-cookies` | Named browser profiles against REAL cookies: sharing, isolation, a live tab keeping its identity across a profile switch, migration of a pre-profile jar, and restart | Yes | Its own loopback fixture |
| `bun run test:desktop:webauthn` | Whether 1Password's WebAuthn interception installs, per profile. Needs `TELAR_1P_CRX` (a packaged extension) or `TELAR_1P_UNPACKED` (a verified unpacked one — the app's own install works, read-only). Reports; asserts only that two profiles do not share storage | Yes | Its own loopback fixture |

Use the smallest layer that proves the change. The E2E command is an explicit final integration
pass, not part of the edit-refresh loop.

## Local unsigned packaging

The working-tree packaging path is separate from the pristine origin build in
`scripts/build-desktop.sh`:

```bash
bun run desktop:package
bun run desktop:install -- --open
```

`desktop:package` builds the Next standalone server, bundles the runtime
dependencies that Electron needs, stamps the app as a local working-tree build,
creates `apps/desktop/release/mac-arm64/Telar.app`, and runs the packaged
`--smoke` check. `desktop:install` uses that verified artifact and atomically
copies it to `~/Applications/Telar.app`; add `--system` for
`/Applications/Telar.app`. The standalone `install:app` command smoke-tests an
existing artifact before copying it.

The result is unsigned and intended for local development/use only. macOS may
require Finder → Control-click → **Open** on the first launch. No signing,
notarization, publishing, or automatic update step is performed.

### A separate Telar Dev.app beside the installed Telar

```bash
bun run desktop:package:dev
open "apps/desktop/release/dev/mac-arm64/Telar Dev.app"
```

Same pipeline and smoke as `desktop:package`, but the artefact is a
**different app**: bundle id `com.telar.desktop.dev`, product name
`Telar Dev`, its own state in `~/Library/Application Support/Telar Dev`
(engine store under `engine/` inside it), updater off, `--publish never`,
never signed. It **ignores an inherited `TELAR_HOME` or `TELAR_DESKTOP_URL`**,
so launching it from a shell the installed Telar opened cannot point it at the
live store or the live server. The window title reads `Telar Dev <sha>`, with
`+dirty` when the working tree had uncommitted changes; `/api/about` reports
`channel: "dev"`. Open the built `.app` directly — `--dev` refuses `--install`
because the installer copies by the fixed name `Telar.app`.

**Quit Telar Dev before rebuilding it** — electron-builder replaces the bundle
in place, and macOS will not swap the binary out from under a running process.
The installed Telar (nightly or otherwise) is a different app and can stay
open throughout. The packaged smoke is bounded to 120 s (`TELAR_SMOKE_TIMEOUT`
overrides) and enforced with Bun, so no coreutils `timeout` is required.
