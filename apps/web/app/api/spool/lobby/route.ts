import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * MISSION CONTROL — `docs/spool-loops.md` §13.2. Every subject's lobby card,
 * ranked and pre-folded by the engine; the web never re-derives which
 * subject earns a card. `today`, in `YYYY-MM-DD`, rides as a query param —
 * the caller's own statement of what day it is, via the one sanctioned
 * clock read (`lib/spool-today.ts`), never computed here.
 */
export async function GET(request: Request) {
  try {
    const today = new URL(request.url).searchParams.get("today") ?? undefined;
    return Response.json(await (await engineClient()).spoolLobby(today ?? undefined));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
