import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

/**
 * Move the checkouts already cut to the configured root.
 *
 * THE ONE DESTRUCTIVE THING ON THE STORAGE PANE, and it is arranged so that it
 * cannot lose work: each checkout is RE-CUT from its own branch rather than
 * copied, `git worktree remove` is never forced, and the branch is verified to
 * still exist before anything is removed. A checkout git refuses is reported
 * and left exactly where it was.
 *
 * SLOW — one pair of git commands per checkout — and partial by design.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST() {
  try {
    return Response.json(await (await engineClient()).moveWorktrees());
  } catch (error) {
    return engineErrorResponse(error);
  }
}
