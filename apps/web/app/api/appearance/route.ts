import { parsePublishedAppearance } from "@telar/engine-client";
import { requestObject, engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

/**
 * The host cockpit's resolved look, published to the engine and read back by
 * whoever is paired with it.
 *
 * WHY THIS ROUTE EXISTS AT ALL. Appearance — accent, typefaces, text size,
 * translucency, backdrop, both halves of the active theme pair — lives in ONE
 * browser's localStorage, because that is where a person configures it. A
 * paired client (the iOS app) cannot read another device's localStorage, so the
 * cockpit republishes its resolved look through `PUT` and every other client
 * asks `GET`. The browser is the only writer; the engine is only the mailbox.
 *
 * THE BODY IS THE BLOB. Not a wrapper around it: a snapshot of a whole resolved
 * look has no partial form worth expressing, and the engine replaces it
 * wholesale rather than merging — two publishers' merged halves would describe
 * a look neither of them wears.
 *
 * VALIDATED IN BOTH DIRECTIONS, by the same parser the reader uses. The engine
 * is a mailbox that understands nothing about its contents, so the only place
 * a malformed look can be caught is at an end that knows the vocabulary. A PUT
 * that does not parse is refused here rather than stored for somebody else to
 * choke on; a GET is re-parsed on the client (`EngineClient.appearance`).
 *
 * PAIRED-ONLY, DELIBERATELY. This is a description of somebody's machine, and
 * it is NOT in `EXEMPT_API_PATHS`: an unpaired stranger has no business
 * learning what this cockpit looks like, and a client that wants to match the
 * host has already paired by the time it asks. Observers may read it — the
 * gate allows GET for them — and cannot publish, which is exactly the split a
 * "wear the host's look" reader wants.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    return Response.json(await (await engineClient()).appearance());
  } catch (error) {
    return engineErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const blob = parsePublishedAppearance(await requestObject(request));
    if (!blob) {
      return Response.json({ error: { code: "invalid_request", message: "That is not a publishable appearance." } }, { status: 400 });
    }
    return Response.json(await (await engineClient()).setAppearance(blob));
  } catch (error) {
    return engineErrorResponse(error);
  }
}

export async function DELETE() {
  try {
    return Response.json(await (await engineClient()).clearAppearance());
  } catch (error) {
    return engineErrorResponse(error);
  }
}
