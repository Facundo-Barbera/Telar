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
