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
INSTALL_ARGS=()

usage() {
  cat <<'HELP'
Usage: package-desktop.sh [--install [install options...]]

Build the current working tree into an unsigned macOS arm64 Telar.app,
smoke-test the packaged server and bundled binaries, and leave the app at:
  apps/desktop/release/mac-arm64/Telar.app

Options:
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

echo "==> build standalone web app"
NODE_OPTIONS= bash "$DESKTOP_DIR/build-web.sh"

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
printf '{\n  "shortSha": "%s",\n  "sha": "%s",\n  "ref": "working-tree",\n  "dirty": %s,\n  "builtAt": "%s"\n}\n' \
  "$SHORT_SHA" "$FULL_SHA" "$DIRTY" "$BUILT_AT" > "$STANDALONE/build-info.json"
echo "==> stamped local build: $SHORT_SHA (dirty=$DIRTY)"

echo "==> package unsigned macOS arm64 app"
cd "$DESKTOP_DIR"
NODE_OPTIONS= bunx electron-builder --dir

APP="$DESKTOP_DIR/release/mac-arm64/Telar.app"
test -d "$APP" || { echo "!! expected app not found at $APP" >&2; exit 1; }
test -x "$APP/Contents/MacOS/Telar" || { echo "!! packaged executable missing at $APP" >&2; exit 1; }

echo "==> smoke packaged app"
"$APP/Contents/MacOS/Telar" --smoke
echo "==> packaged app ready: $APP"

if [ "$INSTALL" -eq 1 ]; then
  bash "$DESKTOP_DIR/install-app.sh" --app "$APP" --verified "${INSTALL_ARGS[@]}"
fi
