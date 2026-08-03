# Desktop development and testing

Telar keeps UI iteration, desktop startup checks, and full Electron integration tests separate.

## Live UI design

- Use `bun run dev` for normal renderer work and inspect the retained browser tab.
- Use `bun run dev:desktop` when the change depends on Electron, native browser views, IPC, or
  window behavior.
- The desktop runner keeps the Next development server alive. React changes use Fast Refresh;
  only changes to `main.js`, `preload.js`, or `browser-manager.js` restart Electron.
- The runner prints the retained renderer URL and Electron DevTools endpoint. Agent inspection
  should attach to that existing process instead of launching another desktop instance.

The desktop development state defaults to the repository-local `.telar-desktop-dev` directory.
Set `TELAR_HOME` to use another isolated directory, or `TELAR_DESKTOP_URL` to point Electron at an
already-running Telar web server.

## Verification layers

| Command | Purpose | Starts Electron | Starts a server |
| --- | --- | --- | --- |
| `bun run test:desktop` | Fast browser-manager unit and contract tests | No | No |
| `bun run test:desktop:smoke` | Packaged-server and desktop dependency smoke check | Yes | Yes |
| `bun run test:desktop:e2e` | Shared-tab, CDP, cursor, and browser-control integration | Yes | Yes |

Use the smallest layer that proves the change. The E2E command is an explicit final integration
pass, not part of the edit-refresh loop.
