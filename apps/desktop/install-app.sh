#!/usr/bin/env bash
# Install an unsigned packed Telar.app without requiring Apple signing or sudo.
# The default destination is ~/Applications; pass --system for /Applications.
set -euo pipefail

DESKTOP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DESKTOP_DIR"

APP=release/mac-arm64/Telar.app
DEST="${HOME:?}/Applications/Telar.app"
OPEN_AFTER=0
VERIFIED=0

usage() {
  cat <<'HELP'
Usage: install-app.sh [options]

Install a locally packed, unsigned Telar.app.

Options:
  --app PATH          Source .app (default: release/mac-arm64/Telar.app)
  --destination PATH  Destination .app path (default: ~/Applications/Telar.app)
  --system            Install to /Applications/Telar.app
  --open              Open Telar after installation
  --verified          Skip smoke because the caller just passed the same gate
  -h, --help          Show this help
HELP
}

absolute_path() {
  case "$1" in
    /*) printf '%s' "$1" ;;
    *) printf '%s/%s' "$PWD" "$1" ;;
  esac
}

while [ $# -gt 0 ]; do
  case "$1" in
    --app)
      [ $# -ge 2 ] || { echo "!! --app needs a path" >&2; exit 2; }
      APP="$2"
      shift 2
      ;;
    --destination)
      [ $# -ge 2 ] || { echo "!! --destination needs a path" >&2; exit 2; }
      DEST="$2"
      shift 2
      ;;
    --system)
      DEST="/Applications/Telar.app"
      shift
      ;;
    --open)
      OPEN_AFTER=1
      shift
      ;;
    --verified)
      VERIFIED=1
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

APP="$(absolute_path "$APP")"
DEST="$(absolute_path "$DEST")"

test -d "$APP" || {
  echo "!! no packed app at $APP — run: bun run desktop:package" >&2
  exit 1
}
test -x "$APP/Contents/MacOS/Telar" || {
  echo "!! invalid Telar.app: missing Contents/MacOS/Telar" >&2
  exit 1
}

if [ "$VERIFIED" -eq 0 ]; then
  echo "==> smoke the packed app"
  env -u ELECTRON_RUN_AS_NODE "$APP/Contents/MacOS/Telar" --smoke
fi

install_atomic() {
  local source="$1"
  local destination="$2"
  local parent stage backup
  parent="$(dirname "$destination")"
  stage="${destination}.new.$$"
  backup="${destination}.old.$$"

  mkdir -p "$parent" || {
    echo "!! cannot write $parent — use --destination \"$HOME/Applications/Telar.app\" or grant macOS permission" >&2
    exit 1
  }
  rm -rf "$stage" "$backup"
  trap 'rm -rf "$stage" "$backup"' EXIT
  ditto "$source" "$stage"
  if [ -e "$destination" ]; then mv "$destination" "$backup"; fi
  if ! mv "$stage" "$destination"; then
    if [ -e "$backup" ]; then mv "$backup" "$destination" || true; fi
    echo "!! could not replace $destination" >&2
    exit 1
  fi
  rm -rf "$backup"
  trap - EXIT
  echo "==> installed: $destination"
}

install_atomic "$APP" "$DEST"

if [ "$OPEN_AFTER" -eq 1 ]; then
  open "$DEST"
fi
