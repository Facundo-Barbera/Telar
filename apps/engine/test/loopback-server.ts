/**
 * A STUB SERVER NOBODY ELSE CAN ANSWER FOR — issue #610.
 *
 * ── WHAT WENT WRONG ─────────────────────────────────────────────────────────
 * `Bun.serve` defaults to the WILDCARD address, and on macOS a wildcard bind
 * does not conflict with a listener already holding the SAME PORT on
 * `127.0.0.1`. Both sockets end up bound; the more specific one wins every
 * incoming connection. So a stub asked for `port: 0` could be handed a port
 * some OTHER loopback listener already owned, bind cleanly, report that port —
 * and then never see a single request, because the neighbour answered them all.
 *
 * MEASURED on macOS 15 / bun 1.3.11, with 100 node `listen(0, "127.0.0.1")`
 * servers held open: `Bun.serve({ port: 0 })` landed on one of their ports
 * 11 times in 25,000 binds, and the neighbour answered all 11. With the
 * hostname pinned below: 0 in 25,000. `reusePort: false` and `exclusive: true`
 * do NOT close it — the hostname is the whole lever.
 *
 * ── WHY IT READ AS FOUR DIFFERENT FLAKES ────────────────────────────────────
 * The symptom is whatever the neighbour happens to say, so one cause wore four
 * faces across `agent-model.test.ts` — all green locally, all red in CI only:
 *
 *   a neighbour that answers 404   →  `this socket serves one path` (the
 *                                     engine's own sockets say exactly that)
 *   one that answers 401           →  a loud auth error from the daemon
 *   one that answers 200 with a
 *   body that is not a completion  →  `TypeError: undefined is not an object
 *                                     (evaluating '(await this.generatePrompt(
 *                                     …)).generations[0][0].message')`
 *   one that accepts and is silent →  the 20 s test ceiling
 *
 * It is CI-only because the odds scale with how many loopback listeners the
 * box has: a laptop running one file has almost none, and the self-hosted Mac
 * runs the app, the suite's own daemons and every other worktree's.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 * EVERY TEST SERVER IN THIS SUITE BINDS THROUGH HERE. Pinning the hostname
 * makes the bind EXCLUSIVE: a port another loopback listener holds is refused
 * outright, and `port: 0` is never handed one to begin with. A test server is
 * reachable only from this machine anyway, so the wildcard was never buying
 * anything — it was only widening what could answer in its place.
 */
import type { Server } from "bun";

/** Loopback, and never the wildcard. This one string is the fix. */
const LOOPBACK = "127.0.0.1";

/**
 * A stub server on a port nothing else is serving.
 *
 * `port` is for the one test that pins this file's own promise — everything
 * else leaves it at 0 and reads `server.port` back.
 */
export function serveLoopback(fetch: (request: Request) => Response | Promise<Response>, port = 0): Server {
  return Bun.serve({ port, hostname: LOOPBACK, fetch });
}

/** Where a stub from `serveLoopback` answers, shaped like the real Go base —
 *  see `withServer` in `agent-model.test.ts` for why the `/v1` is load-bearing. */
export function loopbackBase(server: Server): string {
  return `http://${LOOPBACK}:${server.port}/v1`;
}
