// Every test server binds 127.0.0.1 through here: on macOS a wildcard `Bun.serve({ port: 0 })`
// can land on a port another loopback listener holds, which then answers every request.
import type { Server } from "bun";

/** Loopback, and never the wildcard. This one string is the fix. */
const LOOPBACK = "127.0.0.1";

/**
 * A stub server on a port nothing else is serving.
 *
 * `port` is for the one test that pins this file's own promise — everything
 * else leaves it at 0 and reads `server.port` back.
 */
export function serveLoopback(fetch: (request: Request) => Response | Promise<Response>, port = 0): Server<undefined> {
  return Bun.serve({ port, hostname: LOOPBACK, fetch });
}

/** Where a stub from `serveLoopback` answers, shaped like the real Go base —
 *  see `withServer` in `agent-model.test.ts` for why the `/v1` is load-bearing. */
export function loopbackBase(server: Server<unknown>): string {
  return `http://${LOOPBACK}:${server.port}/v1`;
}
