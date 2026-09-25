# Telar

Telar is a control surface for the coding agents already installed on your machine.
It does not replace them and it does not bundle them: a local engine owns your
projects, their sessions and a durable turn journal, and the cockpit is where you
drive them — from a browser, a desktop shell, or your phone.

*Telar* is Spanish for **loom**. The app icon is warp and weft: separate threads
resolving into one fabric.

## What it drives

Your own installs, with your own subscriptions. Set at least one up before use:

| Harness | Get it | Sign in |
| --- | --- | --- |
| Claude Code | [claude.com/product/claude-code](https://claude.com/product/claude-code) | `claude auth login` |
| Codex | [developers.openai.com/codex/cli](https://developers.openai.com/codex/cli) | `codex login` |
| OpenCode | [opencode.ai](https://opencode.ai) | `opencode auth login` |

The packaged app resolves **your** binaries — `CLAUDE_CODE_EXECUTABLE` / `CODEX_BIN`,
then `~/.local/bin`, the Homebrew prefixes, then `PATH` — and refuses a turn with an
actionable message when there is none. Settings → Providers reports the exact binary
and version that will answer you.

## What it adds

- **Sessions with their own checkout.** A session runs `local` (shares the project's
  tree) or `worktree` (its own git worktree and branch), so several agents can work
  the same repo without colliding.
- **A durable journal.** Every turn, tool call and result is recorded and survives a
  restart; a claimed turn requeues rather than vanishing.
- **A permission gate.** The engine decides what needs a person — landing work on
  another session, destroying something — and parks the call until you answer.
- **The Agent**, optional and off by default. A global coordinator that dispatches
  work to sessions, subscribes for their outcomes, and reports back. It is not a
  session: it has its own thread, its own memory document and its own key.
- **An integrated browser.** Sessions get their own tabs, driven by tools, so an
  agent can check its own work without taking over yours.
- **A notebook per project** — the notes kept beside the code so nobody is asked twice.
- **MCP doors.** `/v2/sessions/mcp` and `/v2/notes/mcp` let an outside agent drive
  Telar the same way a session does.

## Layout

| Path | What |
| --- | --- |
| `apps/web` | **The app.** Standalone Next.js cockpit over the engine. |
| `apps/engine` | The control plane — a local authenticated daemon owning projects, sessions and the journal. |
| `apps/desktop` | The Electron shell. Forks the engine, then the cockpit's standalone server; owns auto-update and the browser host. |
| `apps/ios` | The iPhone client. Polling, with Mac-initiated push. |
| `packages/engine-client` | Dependency-free engine protocol types + HTTP client. |

## Getting started

Requires [Bun](https://bun.sh).

```bash
bun install
bun run dev
```

`bun run dev` is the supported browser-only door. It uses the isolated
`TELAR_HOME=$HOME/.telar-dogfood` by default (or an absolute dedicated `TELAR_HOME`
you set), starts or attaches the engine, starts one worker unless the attached engine
already has a live one, then opens the cockpit at `http://127.0.0.1:3000/`. Set
`TELAR_WEB_PORT` for a different port — the launcher checks it before starting
anything and fails rather than silently falling back. It never uses `~/.telar` or
`~/.telar-dev`.

For the same cockpit inside the development Electron shell:

```bash
bun run dev:desktop
```

This starts the engine, worker and one web server exactly as `bun run dev` does, then
launches the desktop runner against the same URL — it does not start a second Next
server. Ctrl-C stops only the worker, web and desktop processes it launched; when it
attached to an already healthy engine, it deliberately leaves that engine running.

### Reaching the cockpit from another device

`TELAR_WEB_HOST` chooses the interface the cockpit binds. It defaults to `127.0.0.1`,
and that default is a security boundary rather than a convenience: **the cockpit has
no login**, its route handlers hold the engine token, and a session's default runtime
mode is `auto` — so whoever can open the port can run shell commands and write files
on the host.

Bind ONE private interface, not a wildcard:

```sh
TELAR_WEB_HOST=100.x.y.z bun run dev   # a Tailscale address
```

The launcher warns whenever the bind is not loopback, and refuses to start if the port
is taken on that interface. `0.0.0.0` is accepted and is almost always wrong — it
follows the machine onto whatever network it joins next. Binding one address is
exclusive: with a tailnet address bound, `localhost:3000` on the host stops working,
and you use the tailnet address there too.

### Local desktop install (unsigned)

Builds a macOS **arm64** `.app` from the current working tree, uncommitted changes
included. One command packages, smoke-tests, installs and launches:

```bash
bun run desktop:install -- --open       # to ~/Applications
bun run desktop:install -- --system --open   # to /Applications
```

`desktop:install` packages first — it is a full build, not a cheap step after
`desktop:package`, so running the two back to back builds everything twice. Reach for
the halves separately only when you want them apart:

```bash
bun run desktop:package                             # build + smoke only
bun run --cwd apps/desktop install:app -- --open    # install the packed app, no rebuild
```

Neither needs `sudo`. The packed app lands at `apps/desktop/release/mac-arm64/Telar.app`,
stamped with the commit it came from — the smoke log prints `BUILD Telar <sha>`, so you
can confirm you launched what you just built.

This is intentionally an unsigned, local-only flow; it does not publish, auto-update,
sign or notarize. On first launch macOS may block it: in Finder, Control-click
`Telar.app`, choose **Open**, then confirm **Open**.

#### When the build fails on a route that does not exist

A type error naming a route absent from the tree — say
`Cannot find module '../../app/api/proxy/adopt/route.js'` — means a stale `.next/` from
an older build is being type-checked alongside `.next-desktop/`, since
`apps/web/tsconfig.json` includes both. Clear it and package again:

```bash
rm -rf apps/web/.next
```

## Prior art

Telar owes its shape to [T3 Code](https://github.com/pingdotgg/t3code), which solved
the same problem in the open and solved parts of it better —
`docs/design/t3code-survey/` is a written survey of what to take from it, and
`EnvironmentId` is threaded through every contract from day one for T3's own reason:
retrofitting remote environments later means touching every event and every persisted
reference. Conductor, the Codex desktop app and Cursor Glass are the other reference
points.

## Docs

`docs/investigations/` holds dated studies — each one is what was true on the day it
was written, and is not edited afterwards. `docs/design/` holds surveys and design
notes. Legacy design docs, outdated and kept only for reference, are archived under
`.cleanup-archives/docs-legacy-2026-07-17/`.

## Status

Active development — solo project, moving fast. Interfaces change without notice.

## License

Proprietary — © 2026 Facundo Barbera. All rights reserved. See [`LICENSE`](LICENSE).
