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
JS_RUNTIME="${TELAR_JS_RUNTIME:-bun}"

command -v "$JS_RUNTIME" >/dev/null 2>&1 \
  || { echo "!! JavaScript runtime '$JS_RUNTIME' was not found — install Bun or set TELAR_JS_RUNTIME" >&2; exit 1; }

echo "==> next build (standalone) into .next-desktop"
cd "$WEB_DIR"
# Composes with the existing NEXT_DIST_DIR knob so this never collides with the
# always-on dev server's .next.
NEXT_OUTPUT=standalone NEXT_DIST_DIR=.next-desktop NODE_OPTIONS= bunx next build

echo "==> copy static + public into the standalone tree"
rm -rf "$STANDALONE_WEB/.next-desktop/static" "$STANDALONE_WEB/public"
cp -R "$DIST/static" "$STANDALONE_WEB/.next-desktop/static"
[ -d "$WEB_DIR/public" ] && cp -R "$WEB_DIR/public" "$STANDALONE_WEB/public"

echo "==> materialize @playwright/mcp for the packaged Verifier"
# @playwright/mcp is a devDependency: Next's output tracing never pulls it into
# the standalone bundle and it isn't on a Finder-launched app's PATH, so the
# packaged Verifier's TELAR_PLAYWRIGHT_MCP_BIN walk-up/PATH resolution finds
# nothing. Copy a SELF-CONTAINED, symlink-dereferenced closure (cli.js + its
# runtime deps playwright/playwright-core) next to the standalone tree; main.js
# points the packaged server child at this cli.js. `cp -RL` collapses bun's
# .bun-store symlink indirection into real files so nothing dangles in the .app.
MCP_REAL="$("$JS_RUNTIME" -e 'process.stdout.write(require("fs").realpathSync(require("path").dirname(require.resolve("@playwright/mcp/package.json"))))')"
MCP_NM="$(cd "$MCP_REAL/../.." && pwd)"   # bun store's node_modules: mcp + deps as peers
PW_BUNDLE="$DIST/playwright-mcp"
rm -rf "$PW_BUNDLE"
mkdir -p "$PW_BUNDLE"
cp -RL "$MCP_NM" "$PW_BUNDLE/node_modules"
test -f "$PW_BUNDLE/node_modules/@playwright/mcp/cli.js" \
  || { echo "!! playwright-mcp bundle missing cli.js after copy" >&2; exit 1; }

# NOT BUNDLED: the Claude Code CLI. The SDK ships an optional ~227MB platform
# binary and this script used to materialize it into the standalone tree, because
# the SDK resolves it via createRequire at runtime and Next's output tracing never
# pulls it in. That made it 227MB of a 625MB app — and telar never ran it:
# packages/core/src/claude-executable.ts prefers the user's own install on every
# candidate path, so the copy was downloaded on every update and then ignored.
#
# telar now depends on the user's Claude Code install, and refuses the turn with
# an actionable message when it is missing or speaks a different control protocol
# (resolveClaudeCli / claudeCliUsable). Removing this step is what makes that
# dependency honest rather than merely true.

echo "==> standalone ready at: $STANDALONE_WEB/server.js"
du -sh "$DIST/standalone" 2>/dev/null || true
du -sh "$PW_BUNDLE" 2>/dev/null || true
