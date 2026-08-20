import { engineClient, engineErrorResponse, optionalString, requestObject, requiredString } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The shelf, listed — retired notes ride along, marked: dismissing drains,
 *  and a list that hid them would make retirement look like deletion. */
export async function GET(request: Request) {
  try {
    const subject = new URL(request.url).searchParams.get("subject") ?? undefined;
    return Response.json(await (await engineClient()).spoolNotes(subject));
  } catch (error) {
    return engineErrorResponse(error);
  }
}

/**
 * Write a note by hand. `author` IS NOT AN INPUT and is deliberately absent
 * from this shape: this is the HUMAN route, so the engine defaults it to
 * "you" — only the engine's own tool wall may declare "session", exactly the
 * rule that keeps an item's provenance honest.
 */
export async function POST(request: Request) {
  try {
    const body = await requestObject(request);
    const subjectKey = optionalString(body.subjectKey, "subjectKey");
    const tags = body.tags;
    if (tags !== undefined && !(Array.isArray(tags) && tags.every((t) => typeof t === "string"))) {
      return Response.json(
        { error: { code: "invalid_request", message: "tags is a list of words" } },
        { status: 400 },
      );
    }
    return Response.json(
      await (await engineClient()).createSpoolNote({
        title: requiredString(body.title, "title"),
        body: requiredString(body.body, "body"),
        ...(subjectKey !== undefined ? { subjectKey } : {}),
        ...(tags !== undefined ? { tags: tags as string[] } : {}),
      }),
    );
  } catch (error) {
    return engineErrorResponse(error);
  }
}
