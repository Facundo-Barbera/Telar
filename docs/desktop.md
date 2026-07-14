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

## Update flow (build from origin, never the working tree)

The everyday way to get a fresh app is to build it straight from GitHub, so
uncommitted local changes can never ship inside the `.app`:

```bash
# 1. land your change on main and push
git push origin main
# 2. build a pristine, stamped .app from origin/main
bash scripts/build-desktop.sh                 # --ref origin/main --out apps/desktop/release/from-origin
# (or a specific ref: bash scripts/build-desktop.sh --ref origin/main --out ~/Apps)
```

`build-desktop.sh` fetches origin, materializes a **pristine detached worktree**
of the ref in a temp dir (dirty working-tree files physically cannot leak in),
runs `bun install --frozen-lockfile` + `build-web.sh` against that snapshot,
stamps a `build-info.json` (`shortSha`, `ref`, `builtAt`) into the desktop
resources *before* packaging, runs `electron-builder --dir`, atomically swaps
the new `Telar.app` into `--out`, and finally boots the packaged binary with
`--smoke` — failing the whole build unless it reports `SMOKE_OK`. It refuses to
run for a ref that doesn't exist on origin and never touches the repo's own
checkout or `bun.lock`.

**Which build am I running?** The window title is `Telar <shortSha>` (plain
`Telar` for an unstamped dev-repo run). The same sha is printed in `--smoke`
output (`BUILD Telar <shortSha>`).

**Update check:** compare the sha in the title against `origin/main`
(`git rev-parse --short origin/main` after a fetch). If they differ, re-run
`build-desktop.sh` to get the latest.

## Run in dev

`TELAR_DESKTOP_URL=http://127.0.0.1:3001 bunx electron apps/desktop` points the
window at an already-running server and skips the child boot entirely.

`bun run dev` (web) defaults `TELAR_HOME` to `~/.telar-dev` so dev runs never
touch the real `~/.telar`; set `TELAR_HOME` explicitly to override. The packaged
app and `next start` keep `~/.telar`.

## Quarantine note (unsigned app)

macOS Gatekeeper blocks unsigned apps. After copying `Telar.app` somewhere,
clear the quarantine flag once:
`xattr -dr com.apple.quarantine /path/to/Telar.app`.

## Known gaps

- **Verifier / Playwright browsers**: `@playwright/mcp` itself now ships inside
  the `.app`. `build-web.sh` materializes a self-contained, symlink-dereferenced
  copy (cli.js + `playwright`/`playwright-core`, ~17 MB) that electron-builder
  copies to `<Resources>/playwright-mcp`; when packaged, `main.js` exports
  `TELAR_PLAYWRIGHT_MCP_BIN` (unless you already set it) so the core resolver
  points the Verifier's browser at the bundled cli. `--smoke` asserts that cli is
  present and prints `PLAYWRIGHT_MCP_BUNDLED_OK`. The one honest remaining
  requirement is the Playwright **browser binaries** themselves
  (`~/Library/Caches/ms-playwright`), which are a machine-level cache, not part
  of any npm package — install them once with `bunx playwright install chromium`.
  This belongs in the onboarding doctor as a checked precondition (present /
  absent), the same way it checks for git/gh/claude/bun.
- **Separate dev data**: the desktop app writes to `~/.telar`, while `bun run
  dev` servers default to `~/.telar-dev`. Point both at the same `TELAR_HOME` if
  you deliberately want them to share a loom.
- **No remembered window bounds, no icon, no menu** — viable tier, by design.
