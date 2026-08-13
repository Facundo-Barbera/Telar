import { vnextEngine, vnextErrorResponse } from "@/lib/vnext/engine-server";

/**
 * Merge a pull request.
 *
 * THE ONE ROUTE IN THIS ADAPTER THAT CHANGES SOMEBODY ELSE'S REPOSITORY. Every
 * other write here lands in the engine's own state directory or in a checkout on
 * this machine; this one is public and effectively permanent. Two things follow
 * from that, and neither is optional:
 *
 *   - `expectedHeadOid` IS FORWARDED, NEVER DEFAULTED. It is the head commit the
 *     person who pressed the button had reviewed, and the engine turns it into
 *     `--match-head-commit` so GitHub refuses when a commit landed since. A route
 *     that filled in a missing one — from the pull request's current head, say —
 *     would quietly convert "merge what I read" into "merge whatever is there",
 *     which is the merge nobody meant.
 *   - NOTHING IS VALIDATED HERE BEYOND FORWARDING. The daemon checks the method,
 *     the number and the precondition, because an in-process caller must not be
 *     able to walk past a check that only ran on this route.
 *
 * A refusal is a 200 with `merged: false` and one of seven reasons — "GitHub
 * would not merge this, and here is which" is an answer, and each of the seven
 * has a different next move.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string; number: string }> };

export async function POST(request: Request, context: Context) {
  try {
    const { projectId, number } = await context.params;
    const input = (await request.json()) as { method?: unknown; expectedHeadOid?: unknown };
    return Response.json(
      await (await vnextEngine()).mergeProjectPull(projectId, Number(number), {
        method: input.method as "merge" | "squash" | "rebase",
        expectedHeadOid: String(input.expectedHeadOid ?? ""),
      }),
    );
  } catch (error) {
    return vnextErrorResponse(error);
  }
}
