#!/bin/sh
# Environment-contract `up` for Telar itself (cost: light).
#
# Each slot gets its own dedicated dogfood home so leased environments never
# share an engine, a store, or a port with each other or with a manually run
# `bun run dev`. The cockpit binds this slot's leased port base.
set -e
APP_HOME="$HOME/.telar-dogfood-slot$TELAR_SLOT"
PIDFILE="$APP_HOME/env-run.pid"
mkdir -p "$APP_HOME"

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  exit 0  # idempotent: this slot is already up
fi

cd "$TELAR_WORKTREE"
TELAR_HOME="$APP_HOME" TELAR_WEB_PORT="$TELAR_PORT_BASE" \
  nohup bun scripts/dev.mjs >> "$APP_HOME/env-run.log" 2>&1 &
echo $! > "$PIDFILE"
