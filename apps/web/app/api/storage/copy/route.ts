import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

/**
 * A safe copy of the store — issue #665.
 *
 * THE ROUTE WHOSE ABSENCE WAS THE FINDING. Before it there was no sanctioned
 * way to look at a store without opening the live one, so every "what is
 * actually in there" became a hand-run query against the one irreplaceable
 * artifact — which is how #646's numbers came to be corrected twice.
 *
 * It writes to a destination that must not already exist and never touches the
 * store it is copying: the database goes through `VACUUM INTO`, which takes a
 * read transaction and writes elsewhere.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const { destination } = (await request.json()) as { destination?: string };
    return Response.json(await (await engineClient()).copyStore(String(destination ?? "")));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
