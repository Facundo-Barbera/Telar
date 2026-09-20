/**
 * WAIT FOR A SESSION'S CHECKOUT — the seam #496 introduced.
 *
 * `git worktree add` no longer runs inside the call that creates the session,
 * so a test that asserts on files in the checkout has to wait for it. Shared
 * rather than copied into each of the six suites that need it, because "how do
 * you know the cut landed" is one answer and six copies of it would drift.
 *
 * POLLS THE ROW rather than the disk: `preparation` absent means ready, and a
 * `failed` one is a settled answer too — so this returns on either and a test
 * expecting a failure does not sit here until the deadline.
 *
 * ── THE DEADLINE IS DERIVED, NOT PICKED (#706) ──────────────────────────────
 * It used to be 400 iterations of a 5 ms sleep — two seconds, chosen as though
 * the cut ran alone. It does not. `createAsyncGitRunner` shares ONE pool of
 * four slots across the whole suite and its own comment says "the deadline
 * includes queue time", so under a full run a preparation waits behind every
 * other test's git work. Two seconds was not a tight budget, it was a budget
 * for a different machine: the runner is permitted `DEFAULT_GIT_TIMEOUT_MS`
 * per git invocation, and a preparation makes several.
 *
 * So the wait is now bounded by what the code is actually allowed to take. A
 * test asserting a deadline the product never promised will fail intermittently
 * for ever, and re-tuning the number only moves the next failure — #706 is the
 * record of that happening twice in one afternoon.
 *
 * ── AND IT IS WALL-CLOCK, NOT AN ITERATION COUNT ────────────────────────────
 * Counting iterations silently assumes every `setTimeout(5)` costs 5 ms. On a
 * loaded machine it does not, which made the old budget vary with exactly the
 * pressure it was supposed to survive. `Date.now()` costs nothing here and
 * means the bound is the bound.
 *
 * Nothing pays this ceiling in the ordinary case: the loop returns the moment
 * the row settles, which on an idle machine is a few milliseconds.
 */
import { DEFAULT_GIT_TIMEOUT_MS } from "../src/worktree";
import type { EngineStore } from "../src/state";

/** What the git runner is allowed per invocation, which is the only honest
 *  ceiling for a wait on work it is doing. Exported so a suite that needs its
 *  own wait uses the same bound rather than inventing a second one. */
export const WORKTREE_READY_TIMEOUT_MS = DEFAULT_GIT_TIMEOUT_MS;

export async function worktreeReady(store: EngineStore, sessionId: string): Promise<void> {
  const deadline = Date.now() + WORKTREE_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (store.getSession(sessionId).preparation?.state !== "preparing") return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (store.getSession(sessionId).preparation?.state !== "preparing") return;
  throw new Error(`the worktree for ${sessionId} never finished preparing within ${WORKTREE_READY_TIMEOUT_MS}ms`);
}
