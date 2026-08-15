import { engineClient, engineErrorResponse, optionalString, requestObject, requiredString } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Capture an item.
 *
 * `provenance` IS NOT AN INPUT and is deliberately absent from this shape: the
 * engine stamps it server-side, the same rule that keeps a caller from claiming
 * to be a channel it is not. It is a free-form LABEL, never an enum — there is
 * no capture-channel taxonomy to select from here.
 *
 * A LANE THAT DOES NOT EXIST IS NEVER CREATED. The item files into the fallback
 * lane and is marked unplaced, so the desk ASKS rather than an agent making a
 * lane-structure change by side effect.
 */
export async function POST(request: Request) {
  try {
    const body = await requestObject(request);
    const optional = (key: string) => {
      const value = optionalString(body[key], key);
      return value !== undefined ? { [key]: value } : {};
    };
    return Response.json(
      await (await engineClient()).createSpoolItem({
        title: requiredString(body.title, "title"),
        ...optional("project"),
        ...optional("lane"),
        ...optional("raw"),
        ...optional("rawSource"),
        ...optional("creationNote"),
      }),
    );
  } catch (error) {
    return engineErrorResponse(error);
  }
}
