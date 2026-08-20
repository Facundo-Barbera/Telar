import { engineClient, engineErrorResponse, requestObject } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ subject: string }> };

/**
 * Settle MANY threads, each with its OWN required answer — the "the world
 * answered N of these" verb. Per-row refusals come back in `refused` beside
 * the ones that landed rather than failing the batch; the store's no-empty-
 * answer law binds every row exactly as it binds the single settle, and the
 * shape check here only keeps the typed client honest — the store re-judges.
 */
export async function POST(request: Request, context: Context) {
  try {
    const { subject } = await context.params;
    const body = await requestObject(request);
    const settles = body.settles;
    const wellFormed =
      Array.isArray(settles) &&
      settles.length > 0 &&
      settles.every(
        (s) =>
          typeof s === "object" &&
          s !== null &&
          typeof (s as { threadId?: unknown }).threadId === "string" &&
          typeof (s as { answer?: unknown }).answer === "string",
      );
    if (!wellFormed) {
      return Response.json(
        { error: "settles is a non-empty list of {threadId, answer} — every settle records what was found out." },
        { status: 400 },
      );
    }
    return Response.json(
      await (await engineClient()).settleSpoolThreadsMany(
        subject,
        (settles as Array<{ threadId: string; answer: string }>).map(({ threadId, answer }) => ({ threadId, answer })),
      ),
    );
  } catch (error) {
    return engineErrorResponse(error);
  }
}
