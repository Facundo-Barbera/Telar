import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * MOVE ONE CAPTURE BETWEEN THREADS — the mitigation `SpoolThread.proposed`
 * names.
 *
 * A wrong grouping is the documented way problem-oriented records fail: a
 * capture filed under the wrong question is a capture you cannot find. So
 * re-filing is ONE gesture against one route, rather than an edit of two records
 * a caller has to keep consistent.
 *
 * `to: null` TAKES IT OFF THE MAP. That is a resting state the surface draws as
 * `loose`, not a hole — the same polarity `item.project` absent already has.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { subject?: string; itemId?: string; to?: string | null };
    if (!body.subject || !body.itemId) {
      return Response.json({ error: "subject and itemId are required." }, { status: 400 });
    }
    return Response.json(
      await (await engineClient()).refileSpoolCapture(body.subject, body.itemId, body.to ?? null),
    );
  } catch (error) {
    return engineErrorResponse(error);
  }
}
