#!/usr/bin/env bash
# Build and smoke-test an unsigned Telar.app from the current working tree.
# This is intentionally different from build-desktop.sh: local iteration may
# include uncommitted changes, while the origin pipeline remains pristine.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DESKTOP_DIR="$REPO_ROOT/apps/desktop"
WEB_DIR="$REPO_ROOT/apps/web"
STANDALONE="$WEB_DIR/.next-desktop/standalone"
INSTALL=0
DEV=0
INSTALL_ARGS=()

usage() {
  cat <<'HELP'
Usage: package-desktop.sh [--dev] [--install [install options...]]

Build the current working tree into an unsigned macOS arm64 Telar.app,
smoke-test the packaged server and bundled binaries, and leave the app at:
  apps/desktop/release/mac-arm64/Telar.app

Options:
  --dev                 Package a SEPARATE "Telar Dev" app that can run beside
                        the installed Telar: its own appId, its own
                        ~/Library/Application Support/Telar Dev (ignores an
                        inherited TELAR_HOME / TELAR_DESKTOP_URL), updater off,
                        never signed. Lands at:
                          apps/desktop/release/dev/mac-arm64/Telar Dev.app
                        Open it directly; it cannot be combined with --install.
  --install             Install the verified app after packaging
  --destination PATH    Forward the install destination
  --system              Forward installation to /Applications
  --open                Open the installed app
  -h, --help            Show this help

The default package is intentionally unsigned and local-only. It is not a
publishing or auto-update step.
HELP
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dev)
      DEV=1
      shift
      ;;
    --install)
      INSTALL=1
      shift
      ;;
    --destination)
      [ $# -ge 2 ] || { echo "!! --destination needs a path" >&2; exit 2; }
      INSTALL_ARGS+=("--destination" "$2")
      shift 2
      ;;
    --system|--open)
      INSTALL_ARGS+=("$1")
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "!! unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

command -v bun >/dev/null 2>&1 \
  || { echo "!! Bun is required — install it from https://bun.sh" >&2; exit 1; }

# install-app.sh copies to <destination>/Telar.app by name, so installing a dev
# build would overwrite the real one — the collision --dev exists to prevent.
if [ "$DEV" -eq 1 ] && [ "$INSTALL" -eq 1 ]; then
  echo "!! --dev cannot be combined with --install: open the built 'Telar Dev.app' directly" >&2
  exit 2
fi

echo "==> build standalone web app"
NODE_OPTIONS= bash "$DESKTOP_DIR/build-app.sh"

if git -C "$REPO_ROOT" rev-parse --verify HEAD >/dev/null 2>&1; then
  FULL_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  SHORT_SHA="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
else
  FULL_SHA="unknown"
  SHORT_SHA="local"
fi
DIRTY=false
if [ -n "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=normal)" ]; then
  DIRTY=true
fi
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
mkdir -p "$STANDALONE"
# `channel` is what the web tier's build identity reads (apps/web/lib/
# build-identity.ts); "local" for a plain working-tree build, "dev" for --dev so
# a paired client can tell the two apart the way the title bar does.
CHANNEL="local"; [ "$DEV" -eq 1 ] && CHANNEL="dev"
printf '{\n  "shortSha": "%s",\n  "sha": "%s",\n  "ref": "working-tree",\n  "channel": "%s",\n  "dirty": %s,\n  "builtAt": "%s"\n}\n' \
  "$SHORT_SHA" "$FULL_SHA" "$CHANNEL" "$DIRTY" "$BUILT_AT" > "$STANDALONE/build-info.json"
echo "==> stamped local build: $SHORT_SHA (channel=$CHANNEL dirty=$DIRTY)"

cd "$DESKTOP_DIR"
CONFIG_OVERRIDES=()
if [ "$DEV" -eq 1 ]; then
  echo "==> package unsigned macOS arm64 DEV app (Telar Dev, com.telar.desktop.dev)"
  # Everything that gives the dev build an identity of its own, as overrides so
  # package.json — and therefore the nightly/beta pipeline — is untouched:
  #   productName      names the bundle, the menu bar and app.getName();
  #   appId            keeps LaunchServices from treating it as the same app;
  #   extraMetadata    is what main.js reads at boot (telarDev) to refuse an
  #                    inherited TELAR_HOME/TELAR_DESKTOP_URL and to keep the
  #                    updater off. The hardened runtime is off because nothing
  #                    signs this build and it never needs a notarized shape.
  CONFIG_OVERRIDES=(
    "-c.productName=Telar Dev"
    "-c.appId=com.telar.desktop.dev"
    "-c.extraMetadata.productName=Telar Dev"
    "-c.extraMetadata.telarDev=true"
    "-c.mac.hardenedRuntime=false"
    "-c.mac.identity=null"
    "-c.mac.notarize=false"
    "-c.directories.output=release/dev"
  )
  APP="$DESKTOP_DIR/release/dev/mac-arm64/Telar Dev.app"
  BIN="$APP/Contents/MacOS/Telar Dev"
else
  echo "==> package unsigned macOS arm64 app"
  APP="$DESKTOP_DIR/release/mac-arm64/Telar.app"
  BIN="$APP/Contents/MacOS/Telar"
fi
# Force unsigned regardless of any Developer ID cert sitting in Keychain — this
# script is for fast local iteration, not a release build. `--publish never`
# for the same reason: nothing here ever talks to an update feed.
CSC_IDENTITY_AUTO_DISCOVERY=false NODE_OPTIONS= bunx electron-builder --dir --publish never "${CONFIG_OVERRIDES[@]}"

test -d "$APP" || { echo "!! expected app not found at $APP" >&2; exit 1; }
test -x "$BIN" || { echo "!! packaged executable missing at $APP" >&2; exit 1; }
if [ "$DEV" -eq 1 ]; then
  # The identity the overrides were supposed to produce, checked on the artefact
  # rather than trusted: a dev build that answers to the installed app's bundle
  # id is the collision this flag exists to prevent.
  BUNDLE_ID="$(plutil -extract CFBundleIdentifier raw -o - "$APP/Contents/Info.plist")"
  [ "$BUNDLE_ID" = "com.telar.desktop.dev" ] || { echo "!! dev build has bundle id $BUNDLE_ID" >&2; exit 1; }
  # And the flag main.js keys everything on, as the BOOLEAN it tests for — a
  # CLI override could land as the string "true", which `=== true` ignores.
  # Extracted into a scratch dir: extract-file writes into the cwd.
  META_DIR="$(mktemp -d "${TMPDIR:-/tmp}/telar-dev-meta.XXXXXX")"
  ( cd "$META_DIR" && NODE_OPTIONS= bunx --bun @electron/asar extract-file "$APP/Contents/Resources/app.asar" package.json )
  META_OK="$(NODE_OPTIONS= bun -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(p.telarDev===true && p.productName==="Telar Dev" ? "ok" : JSON.stringify({telarDev:p.telarDev,productName:p.productName}))' "$META_DIR/package.json")"
  rm -rf "$META_DIR"
  [ "$META_OK" = "ok" ] || { echo "!! dev build metadata is wrong: $META_OK" >&2; exit 1; }
  echo "==> dev identity verified: $BUNDLE_ID, telarDev=true"
fi

echo "==> smoke packaged app"
# ELECTRON_RUN_AS_NODE IS UNSET FOR THIS LINE, and it is not paranoia: main.js
# sets it for the children it forks, so any shell descended from a running Telar
# — including one an agent session opens — has it. Inherited here it turns the
# app binary into a bare node, which parses `--smoke` as a node flag and exits
# with "bad option: --smoke" long before any Telar code runs. The failure names
# the flag, not the cause, and reads like the packaging broke.
#
# BOUNDED, AND JUDGED ON ITS OWN WORD. main.js's smoke has 30s waits inside it,
# but a hung Electron never reaches them; and an exit code of 0 with no
# SMOKE_OK printed has happened (a child that exited before the check ran).
#
# The bound is enforced by Bun (already a prerequisite) rather than coreutils'
# `timeout`, which macOS does not ship. Exit 124 on the deadline, like timeout.
SMOKE_LOG="$(mktemp "${TMPDIR:-/tmp}/telar-smoke.XXXXXX")"
SMOKE_STATUS=0
env -u ELECTRON_RUN_AS_NODE NODE_OPTIONS= bun -e '
  const [bin, seconds] = [process.argv[1], Number(process.argv[2])];
  const child = Bun.spawn([bin, "--smoke"], { stdout: "inherit", stderr: "inherit" });
  const timer = setTimeout(() => { child.kill("SIGKILL"); process.exit(124); }, seconds * 1000);
  process.exit(await child.exited);
' "$BIN" "${TELAR_SMOKE_TIMEOUT:-120}" 2>&1 | tee "$SMOKE_LOG" || SMOKE_STATUS=$?
if [ "$SMOKE_STATUS" -ne 0 ] || ! grep -q '^SMOKE_OK$' "$SMOKE_LOG"; then
  echo "!! packaged smoke failed (exit $SMOKE_STATUS, SMOKE_OK $(grep -q '^SMOKE_OK$' "$SMOKE_LOG" && echo present || echo missing))" >&2
  rm -f "$SMOKE_LOG"
  exit 1
fi
# A daemon that answers health but has no registered worker accepts no turn;
# main.js prints this only after /v2/health reports one.
if ! grep -q '^ENGINE_WORKER_OK ' "$SMOKE_LOG"; then
  echo "!! packaged smoke: the engine came up without a registered worker (ENGINE_WORKER_OK missing)" >&2
  rm -f "$SMOKE_LOG"
  exit 1
fi
rm -f "$SMOKE_LOG"
echo "==> packaged app ready: $APP"

if [ "$INSTALL" -eq 1 ]; then
  bash "$DESKTOP_DIR/install-app.sh" --app "$APP" --verified "${INSTALL_ARGS[@]}"
fi
