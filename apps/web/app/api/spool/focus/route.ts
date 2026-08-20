import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Where to pick up, and the day reading under it — in one call, because they
 *  are two views of the same log and could otherwise disagree on screen. */
export async function GET() {
  try {
    return Response.json(await (await engineClient()).spoolFocus());
  } catch (error) {
    return engineErrorResponse(error);
  }
}

/** Start being on something. YOU set this; the system proposes and never picks. */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { subject?: string; threadId?: string; note?: string };
    if (!body.subject) return Response.json({ error: "subject is required." }, { status: 400 });
    return Response.json(
      await (await engineClient()).openSpoolFocus({
        subject: body.subject,
        ...(body.threadId ? { threadId: body.threadId } : {}),
        ...(body.note ? { note: body.note } : {}),
      }),
    );
  } catch (error) {
    return engineErrorResponse(error);
  }
}
