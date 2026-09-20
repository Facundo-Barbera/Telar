#!/usr/bin/env bash
# Build everything the desktop shell forks, and lay it out where main.js looks.
#
# TWO CHILDREN, NOT ONE. This script used to build only the Next server, because
# the legacy cockpit WAS the whole product — it ran sessions inside its own
# route handlers. Telar's engine is now its own daemon, so a packaged app that
# ships only the web tier is a cockpit with nothing behind it: every page loads
# and every action answers `engine_unavailable`.
#
# Layout it produces (relative to each app), and what electron-builder maps it to
# in the packaged .app (see apps/desktop/package.json → build.extraResources):
#
#   apps/web/.next-desktop/standalone/apps/web/server.js   -> Resources/standalone/...
#   apps/engine/dist/engine.mjs                            -> Resources/engine/engine.mjs
#   apps/engine/dist/node_modules/@anthropic-ai/…          -> Resources/engine/node_modules/…
#   apps/engine/dist/playwright-mcp/node_modules/…         -> Resources/engine/playwright-mcp/…
#
# server.js chdir's to its own directory and reads PORT + HOSTNAME from env.
# Next does NOT copy static assets or public/ into standalone — we do it here.
set -euo pipefail

DESKTOP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$(cd "$DESKTOP_DIR/../web" && pwd)"
ENGINE_DIR="$(cd "$DESKTOP_DIR/../engine" && pwd)"
DIST="$WEB_DIR/.next-desktop"
STANDALONE_WEB="$DIST/standalone/apps/web"
ENGINE_DIST="$ENGINE_DIR/dist"
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

echo "==> bundle the engine daemon"
# ONE FILE, RUN BY ELECTRON-AS-NODE. There is no `bun install` inside a .app and
# no bun binary in it either, so the engine cannot ship as the TypeScript the dev
# stack runs. `--target=node` because the shell forks it with
# ELECTRON_RUN_AS_NODE, exactly as it forks the Next server.
rm -rf "$ENGINE_DIST"
mkdir -p "$ENGINE_DIST"
cd "$ENGINE_DIR"
# THE AGENT SDK STAYS EXTERNAL, deliberately, and it is the only thing that does.
# Inlining it would work — it imports nothing but node builtins — but
# `cli-resolution.ts` reads the SDK's own package.json to derive which Claude
# Code CLI version this build pairs with, and that read resolves from disk. Bundle
# the package away and the drift check quietly downgrades to "unverified" in the
# packaged app: the one build where a wrapper/CLI mismatch is hardest to notice.
NODE_OPTIONS= bun build src/main.ts \
  --target=node \
  --format=esm \
  --external @anthropic-ai/claude-agent-sdk \
  --outfile "$ENGINE_DIST/engine.mjs"
test -f "$ENGINE_DIST/engine.mjs" || { echo "!! engine bundle missing after build" >&2; exit 1; }

echo "==> materialize the Agent SDK beside the engine bundle"
# THE PACKAGE, AND NOT ITS PLATFORM BINARY. The SDK declares an optional
# ~272MB native CLI per platform and resolves it at runtime when nothing else is
# named. Telar does not ship that — it resolves the user's own Claude Code and
# passes it as `pathToClaudeCodeExecutable` (src/cli-resolution.ts), refusing the
# turn with an actionable message when there is none. T3 Code makes the same
# call: its app.asar carries these three JavaScript files and no binary.
#
# `cp -RL` collapses bun's store symlinks into real files so nothing in the .app
# dangles. The SDK's peerDependencies are NOT copied because it does not import
# them: sdk.mjs imports node builtins only, which is why 3.9MB is the whole cost.
SDK_SRC="$("$JS_RUNTIME" -e 'process.stdout.write(require("fs").realpathSync(require("path").dirname(require.resolve("@anthropic-ai/claude-agent-sdk/package.json"))))')"
mkdir -p "$ENGINE_DIST/node_modules/@anthropic-ai"
cp -RL "$SDK_SRC" "$ENGINE_DIST/node_modules/@anthropic-ai/claude-agent-sdk"
test -f "$ENGINE_DIST/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs" \
  || { echo "!! Agent SDK bundle missing sdk.mjs after copy" >&2; exit 1; }

echo "==> materialize @playwright/mcp for the engine's browser"
# @playwright/mcp is spawned as a CLI by the engine's browser transport
# (src/browser/transport.ts). Next's output tracing never pulled it into the web
# bundle and it isn't on a Finder-launched app's PATH, so the packaged engine's
# TELAR_PLAYWRIGHT_MCP_BIN walk-up/PATH resolution would find nothing. Copy a
# SELF-CONTAINED, symlink-dereferenced closure (cli.js + its runtime deps
# playwright/playwright-core) beside the engine; main.js points the engine child
# at this cli.js.
#
# IT MOVED WITH ITS CONSUMER. This used to be laid down beside the Next server,
# because the legacy cockpit drove the browser. The engine owns it now.
MCP_REAL="$("$JS_RUNTIME" -e 'process.stdout.write(require("fs").realpathSync(require("path").dirname(require.resolve("@playwright/mcp/package.json"))))')"
MCP_NM="$(cd "$MCP_REAL/../.." && pwd)"   # bun store's node_modules: mcp + deps as peers
PW_BUNDLE="$ENGINE_DIST/playwright-mcp"
rm -rf "$PW_BUNDLE"
mkdir -p "$PW_BUNDLE"
cp -RL "$MCP_NM" "$PW_BUNDLE/node_modules"
test -f "$PW_BUNDLE/node_modules/@playwright/mcp/cli.js" \
  || { echo "!! playwright-mcp bundle missing cli.js after copy" >&2; exit 1; }

# NOT BUNDLED: the Claude Code CLI. See the Agent SDK note above — telar depends
# on the user's own install and refuses the turn with an actionable message when
# it is missing or speaks a different control protocol (cli-resolution.ts).

# NOT MATERIALIZED, AND DELIBERATELY SO: the Agent's LangGraph dependencies
# (#531). `@langchain/langgraph`, `@langchain/core`, `@langchain/openai` and
# `@langchain/langgraph-checkpoint-sqlite` are INLINED by the `bun build` above,
# like every other engine dependency — the Agent SDK is external because
# `cli-resolution.ts` reads its package.json off disk, and nothing in the agent
# runtime reads a file out of its own node_modules.
#
# THE NATIVE `better_sqlite3.node` IS NOT IN THE .app, AND DOES NOT NEED TO BE.
# `@langchain/langgraph-checkpoint-sqlite` statically imports `better-sqlite3`,
# so the bundler inlines that package's JAVASCRIPT (~15 modules, negligible next
# to 3 MB of LangChain). It never inlines the addon: better-sqlite3 resolves
# `better_sqlite3.node` through `bindings()` INSIDE the `Database` constructor,
# and Telar never constructs one — `agent/checkpointer.ts` hands the published
# saver Telar's own driver (`bun:sqlite` under Bun, `node:sqlite` under
# Electron-as-Node, the same fork `execution-store.ts` makes). Verified by
# running the bundle under plain `node` in an empty directory: it loads.
#
# So there is nothing to exclude here. If a future change ever calls
# `SqliteSaver.fromConnString` — the one path that DOES construct better-sqlite3
# — this stops being true and the .app would need a per-ABI native build.

echo "==> ready"
echo "    web:    $STANDALONE_WEB/server.js"
echo "    engine: $ENGINE_DIST/engine.mjs"
du -sh "$DIST/standalone" 2>/dev/null || true
du -sh "$ENGINE_DIST" 2>/dev/null || true
