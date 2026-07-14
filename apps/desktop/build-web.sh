#!/usr/bin/env bash
# Build the standalone Next server that the desktop shell boots, and lay out the
# files exactly where server.js expects them.
#
# Layout (Next standalone, monorepo, distDir=.next-desktop):
#   .next-desktop/standalone/apps/web/server.js   <- the child we fork
#   server.js chdir's to its own dir and reads PORT + HOSTNAME from env.
#   Next does NOT copy static assets or public/ into standalone — we do it here.
set -euo pipefail

DESKTOP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$(cd "$DESKTOP_DIR/../web" && pwd)"
DIST="$WEB_DIR/.next-desktop"
STANDALONE_WEB="$DIST/standalone/apps/web"

echo "==> next build (standalone) into .next-desktop"
cd "$WEB_DIR"
# Composes with the existing NEXT_DIST_DIR knob so this never collides with the
# always-on dev server's .next.
NEXT_OUTPUT=standalone NEXT_DIST_DIR=.next-desktop NODE_OPTIONS= bunx next build

echo "==> copy static + public into the standalone tree"
rm -rf "$STANDALONE_WEB/.next-desktop/static" "$STANDALONE_WEB/public"
cp -R "$DIST/static" "$STANDALONE_WEB/.next-desktop/static"
[ -d "$WEB_DIR/public" ] && cp -R "$WEB_DIR/public" "$STANDALONE_WEB/public"

echo "==> standalone ready at: $STANDALONE_WEB/server.js"
du -sh "$DIST/standalone" 2>/dev/null || true
