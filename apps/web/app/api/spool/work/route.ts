import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * What the Spool is doing right now, and what it just finished.
 *
 * A POLL, and a cheap one — the daemon holds this in memory, so this route is
 * as expensive as reading a Map. The client asks only while something is
 * running, on the interval it already tails a session with.
 *
 * THERE IS NO `POST`. Work is begun by the verb that spends the money — a
 * consultation, a night — never by asking for a record of one.
 */
export async function GET() {
  try {
    return Response.json(await (await engineClient()).spoolWork());
  } catch (error) {
    return engineErrorResponse(error);
  }
}
