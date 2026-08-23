#!/bin/sh
# TERM the slot's dev.mjs; it stops the children it owns (engine, worker, web)
# and leaves anything it merely attached to running. Safe on an already-down slot.
APP_HOME="$HOME/.telar-dogfood-slot$TELAR_SLOT"
PIDFILE="$APP_HOME/env-run.pid"

if [ -f "$PIDFILE" ]; then
  PID=$(cat "$PIDFILE")
  if kill -0 "$PID" 2>/dev/null; then
    kill -TERM "$PID" 2>/dev/null || true
    i=0
    while [ $i -lt 20 ] && kill -0 "$PID" 2>/dev/null; do
      sleep 1
      i=$((i + 1))
    done
    kill -KILL "$PID" 2>/dev/null || true
  fi
  rm -f "$PIDFILE"
fi
exit 0
