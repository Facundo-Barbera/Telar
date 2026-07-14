# Telar Desktop (viable tier)

A thin Electron shell that boots the standalone Next server as a child process
and points a window at it. No auto-update, no notarization, no tray, no custom
menus; ad-hoc/unsigned; default icon. It is "for me", not for distribution.

## Build

```bash
cd apps/desktop
bun run build:web   # NEXT_OUTPUT=standalone NEXT_DIST_DIR=.next-desktop next build, then copies static + public
bun run smoke       # boots server, curls /, prints SMOKE_OK, no window (electron . --smoke)
bun run pack        # electron-builder --dir (mac arm64, unsigned)
```

The `.app` lands in `apps/desktop/release/mac-arm64/Telar.app`.

## Run in dev

`TELAR_DESKTOP_URL=http://127.0.0.1:3001 bunx electron apps/desktop` points the
window at an already-running server and skips the child boot entirely.

## Quarantine note (unsigned app)

macOS Gatekeeper blocks unsigned apps. After copying `Telar.app` somewhere,
clear the quarantine flag once:
`xattr -dr com.apple.quarantine /path/to/Telar.app`.

## Known gaps

- **Verifier / @playwright/mcp**: it is a devDependency and is *not* traced into
  the standalone bundle, and it is not on the global PATH. In the fully packaged
  `.app` the Verifier's browser-driving will not resolve it. The login-shell env
  capture fixes git/gh/claude/bun (the make-or-break) but not this — set
  `TELAR_PLAYWRIGHT_MCP_BIN` in your shell profile (it gets picked up) or install
  playwright-mcp globally. Unpackaged/dev-repo runs resolve it fine.
- **Shared data**: sessions write to the same `~/.telar` as the dev servers
  (intended). Don't run the desktop app and a dev server against the same loom.
- **No remembered window bounds, no icon, no menu** — viable tier, by design.
