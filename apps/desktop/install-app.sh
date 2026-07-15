#!/usr/bin/env bash
# Install the packed Telar.app: fail-closed smoke first, then refresh the
# installed copies — /Applications for the human, release/from-origin for repo flows.
set -euo pipefail
cd "$(dirname "$0")"

APP=release/mac-arm64/Telar.app
test -d "$APP" || { echo "!! no packed app at $APP — run: bun run pack" >&2; exit 1; }

echo "==> smoke the packed app"
"./$APP/Contents/MacOS/Telar" --smoke

install_to() {
  local dst="$1"
  rm -rf "$dst.new" "$dst.prev"
  ditto "$APP" "$dst.new"
  if [ -d "$dst" ]; then mv "$dst" "$dst.prev"; fi
  mv "$dst.new" "$dst"
  rm -rf "$dst.prev"
  echo "==> installed: $dst"
}

install_to /Applications/Telar.app
install_to release/from-origin/Telar.app
