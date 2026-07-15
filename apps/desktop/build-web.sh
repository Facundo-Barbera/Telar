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

echo "==> materialize @playwright/mcp for the packaged Verifier"
# @playwright/mcp is a devDependency: Next's output tracing never pulls it into
# the standalone bundle and it isn't on a Finder-launched app's PATH, so the
# packaged Verifier's TELAR_PLAYWRIGHT_MCP_BIN walk-up/PATH resolution finds
# nothing. Copy a SELF-CONTAINED, symlink-dereferenced closure (cli.js + its
# runtime deps playwright/playwright-core) next to the standalone tree; main.js
# points the packaged server child at this cli.js. `cp -RL` collapses bun's
# .bun-store symlink indirection into real files so nothing dangles in the .app.
MCP_REAL="$(node -e 'process.stdout.write(require("fs").realpathSync(require("path").dirname(require.resolve("@playwright/mcp/package.json"))))')"
MCP_NM="$(cd "$MCP_REAL/../.." && pwd)"   # bun store's node_modules: mcp + deps as peers
PW_BUNDLE="$DIST/playwright-mcp"
rm -rf "$PW_BUNDLE"
mkdir -p "$PW_BUNDLE"
cp -RL "$MCP_NM" "$PW_BUNDLE/node_modules"
test -f "$PW_BUNDLE/node_modules/@playwright/mcp/cli.js" \
  || { echo "!! playwright-mcp bundle missing cli.js after copy" >&2; exit 1; }

echo "==> materialize @anthropic-ai/claude-agent-sdk native CLI binary into the standalone SDK"
# The SDK loads its platform binary (@anthropic-ai/claude-agent-sdk-<os>-<arch>/claude — a
# ~226MB native executable) via createRequire(sdk.mjs).resolve(...) at RUNTIME, not through a
# static import, so Next's output tracing never pulls it into the standalone bundle and bun's
# peer symlink to it is dropped. Without it the packaged app throws "Native CLI binary for
# darwin-arm64 not found." Mirror the @playwright/mcp fix: cp -RL a symlink-dereferenced real
# copy into the EXACT node_modules slot the SDK's createRequire resolves — the sibling of
# claude-agent-sdk inside the standalone .bun store — replacing the dropped symlink with a real
# dir. `cp -RL` collapses bun's store symlink and preserves the binary's executable bit. The
# existing `standalone/node_modules/.bun` extraResources entry then carries it into the .app.
CLAUDE_PKG_SRC="$(node -e '
  const {createRequire}=require("module"), path=require("path");
  const sdkMjs=require.resolve("@anthropic-ai/claude-agent-sdk",{paths:[process.argv[1]]});
  const bin=createRequire(sdkMjs).resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`);
  process.stdout.write(path.dirname(bin));
' "$WEB_DIR")"
test -x "$CLAUDE_PKG_SRC/claude" \
  || { echo "!! source claude binary not found/executable at $CLAUDE_PKG_SRC" >&2; exit 1; }
CLAUDE_PKG_NAME="$(basename "$CLAUDE_PKG_SRC")"   # e.g. claude-agent-sdk-darwin-arm64
# The traced standalone SDK lives under a single version-hash dir in the .bun store; drop the
# native pkg in as claude-agent-sdk's sibling there (the createRequire resolution point).
SDK_PEER_DIR="$(/bin/ls -d "$DIST"/standalone/node_modules/.bun/@anthropic-ai+claude-agent-sdk@*/node_modules/@anthropic-ai 2>/dev/null | head -1)"
test -n "$SDK_PEER_DIR" -a -d "$SDK_PEER_DIR/claude-agent-sdk" \
  || { echo "!! standalone SDK peer dir not found (traced SDK missing?)" >&2; exit 1; }
rm -rf "$SDK_PEER_DIR/$CLAUDE_PKG_NAME"
cp -RL "$CLAUDE_PKG_SRC" "$SDK_PEER_DIR/$CLAUDE_PKG_NAME"
test -x "$SDK_PEER_DIR/$CLAUDE_PKG_NAME/claude" \
  || { echo "!! claude binary missing/not executable after copy into standalone" >&2; exit 1; }

echo "==> standalone ready at: $STANDALONE_WEB/server.js"
du -sh "$DIST/standalone" 2>/dev/null || true
du -sh "$PW_BUNDLE" 2>/dev/null || true
