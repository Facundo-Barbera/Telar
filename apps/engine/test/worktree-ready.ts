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
 * expecting a failure does not sit here until the timeout.
 */
import type { EngineStore } from "../src/state";

export async function worktreeReady(store: EngineStore, sessionId: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (store.getSession(sessionId).preparation?.state !== "preparing") return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`the worktree for ${sessionId} never finished preparing`);
}
