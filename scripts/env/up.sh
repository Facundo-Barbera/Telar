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
# 0.0.0.0 so the cockpit is reachable over the tailnet (and the LAN) — the
# owner's explicit call, 2026-08-23. The engine API keeps its own token.
# The allowed-origins list is the OTHER half (next.config.ts explains): the
# names a browser actually reaches this machine by, which a 0.0.0.0 bind
# cannot imply on its own.
TS_IP="$(/Applications/Tailscale.app/Contents/MacOS/Tailscale ip -4 2>/dev/null || true)"
TELAR_HOME="$APP_HOME" TELAR_WEB_PORT="$TELAR_PORT_BASE" TELAR_WEB_HOST="0.0.0.0" \
  TELAR_WEB_ALLOWED_ORIGINS="${TS_IP:+$TS_IP,}$(hostname -s),$(hostname -s).local" \
  nohup bun scripts/dev.mjs >> "$APP_HOME/env-run.log" 2>&1 &
echo $! > "$PIDFILE"
