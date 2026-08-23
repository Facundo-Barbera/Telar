import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * CLOSING AND CORRECTING, and the body says which.
 *
 * Not merged: closing records where you LEFT it, correcting records what it
 * SHOULD HAVE SAID. One verb that inferred the difference would eventually pick
 * the wrong one silently — and a correction that overwrote a close would erase
 * the "left mid-way" note that makes the whole record worth keeping.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = (await request.json()) as {
      end?: { reason: "done" | "switched" | "paused"; note?: string };
      amend?: { subject?: string; threadId?: string | null; note?: string; why?: string };
    };
    const client = await engineClient();
    if (body.end) return Response.json(await client.closeSpoolFocus(id, body.end));
    if (body.amend) return Response.json(await client.amendSpoolFocus(id, body.amend));
    return Response.json({ error: "Send either `end: {reason}` or `amend: {...}`." }, { status: 400 });
  } catch (error) {
    return engineErrorResponse(error);
  }
}
