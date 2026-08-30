#!/bin/sh
# Ready when the cockpit answers on this slot's leased port. dev.mjs only
# starts the web server after the engine is healthy and the worker registered,
# so a responding cockpit implies the whole stack is live.
curl -sf -o /dev/null "http://127.0.0.1:$TELAR_PORT_BASE"
