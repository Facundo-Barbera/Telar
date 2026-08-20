import { engineClient, engineErrorResponse, requestObject } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

/**
 * A human's verdict on one remembered fact: retire it, or confirm it.
 *
 * THIS IS THE OTHER DOOR. An expert pass may PROPOSE retiring a fact and is
 * refused outright for a `person` fact, because nobody but the user can confirm
 * who is involved and how. This caller is the user, so it carries no such rule.
 * An agent proposes; a human decides; the two go through different doors and
 * that asymmetry is the design rather than an oversight.
 *
 * `subject` ABSENT MEANS THE FRONT DOOR'S OWN MEMORY (`spool/memory.json`).
 */
export async function PATCH(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const body = await requestObject(request);
    const subject = typeof body.subject === "string" ? body.subject : undefined;
    const why = (body.retire as { why?: unknown } | undefined)?.why;

    // A retirement with no reason is refused. The reason is the durable half —
    // a drained fact keeps it forever, and a blank one turns the record of why
    // something stopped being true into a shrug.
    if (body.retire !== undefined && (typeof why !== "string" || why.trim() === "")) {
      return Response.json(
        { error: { code: "invalid_request", message: "retire.why is required — say what stopped being true." } },
        { status: 400 },
      );
    }

    return Response.json(
      await (await engineClient()).judgeSpoolFact({
        id,
        ...(subject ? { subject } : {}),
        ...(typeof why === "string" ? { retire: { why } } : {}),
        ...(typeof body.reviewed === "boolean" ? { reviewed: body.reviewed } : {}),
      }),
    );
  } catch (error) {
    return engineErrorResponse(error);
  }
}
