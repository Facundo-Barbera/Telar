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
    /**
     * THE WORKBENCH'S COMPOSED FIELDS — a deadline is `{label, kind}` and a
     * pin is `{day}`, both the user's own words. Shape-checked just enough to
     * satisfy the typed client; the ENGINE stays the authority on content —
     * a bad `day` comes back as its plain 400 sentence, surfaced verbatim,
     * never re-judged here.
     */
    const deadline = body.deadline;
    const hasDeadline =
      typeof deadline === "object" &&
      deadline !== null &&
      typeof (deadline as { label?: unknown }).label === "string" &&
      ((deadline as { kind?: unknown }).kind === "external" || (deadline as { kind?: unknown }).kind === "self");
    if (deadline !== undefined && !hasDeadline) {
      return Response.json(
        { error: { code: "invalid_request", message: "a deadline is {label, kind} — kind is external or self" } },
        { status: 400 },
      );
    }
    const pinned = body.pinned;
    const hasPin = typeof pinned === "object" && pinned !== null && typeof (pinned as { day?: unknown }).day === "string";
    if (pinned !== undefined && !hasPin) {
      return Response.json(
        { error: { code: "invalid_request", message: "a pin is {day} — the day you stated, as YYYY-MM-DD" } },
        { status: 400 },
      );
    }
    return Response.json(
      await (await engineClient()).createSpoolItem({
        title: requiredString(body.title, "title"),
        ...optional("project"),
        ...optional("lane"),
        ...optional("raw"),
        ...optional("rawSource"),
        ...optional("creationNote"),
        ...(hasDeadline
          ? {
              deadline: {
                label: (deadline as { label: string }).label,
                kind: (deadline as { kind: "external" | "self" }).kind,
              },
            }
          : {}),
        ...(hasPin ? { pinned: { day: (pinned as { day: string }).day } } : {}),
      }),
    );
  } catch (error) {
    return engineErrorResponse(error);
  }
}
