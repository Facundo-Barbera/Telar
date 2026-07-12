// M5 ownership oracle — is a loom LIVE (owned by a running executor)? Two
// backings share one signature so the recovery reconciler is agnostic:
//   - inProcessLiveness  (flag-off): the loom is in THIS process's `active`
//     map — byte-identical to today's reconcileStuckLooms `activeLoomIds()`.
//   - crossProcessLiveness (flag-on): the runner owns execution, so liveness is
//     `(runner reachable && id ∈ /active) OR lease fresh within TTL`. The lease
//     is authoritative when the runner is briefly unreachable (D3), so a stale
//     control channel can never strand a live-runner loom.
import { isLeaseFresh, type RunnerLease } from "./lease";

export type Liveness = (id: string) => boolean;

// Flag-off backing. Factory (not a bare const) so it closes over the caller's
// `activeLoomIds` — avoids a dispatcher <-> liveness import cycle while staying
// byte-identical to `activeLoomIds().includes(id)`.
export function makeInProcessLiveness(activeLoomIds: () => string[]): Liveness {
  return (id: string) => activeLoomIds().includes(id);
}

// Flag-on backing. `runnerActive` is the set the runner's GET /active returned
// (empty set when the runner is unreachable — then only a fresh lease can
// prove liveness). `readLease` reads the per-loom lease; `ttlMs`/`now` bound
// freshness. Pure over its inputs.
export function crossProcessLiveness(
  runnerActive: Set<string>,
  readLease: (id: string) => RunnerLease | null,
  ttlMs: number,
  now: () => number = Date.now,
): Liveness {
  return (id: string) => {
    if (runnerActive.has(id)) return true; // corroborated live by the runner
    return isLeaseFresh(readLease(id), ttlMs, now()); // lease authoritative when unreachable
  };
}

// R2 double-execution guard: before any LOCAL dispatch, refuse if the oracle
// shows this loom is already owned by a live runner (a fresh lease / in
// /active). A no-op flag-off, where inProcessLiveness only reports THIS
// process's own active map — so it never blocks a legitimate local (re)dispatch.
export function refuseIfLive(id: string, liveness: Liveness): void {
  if (liveness(id)) {
    throw new Error(`loom ${id} is already owned by a live runner — refusing local dispatch (double-execution guard)`);
  }
}
