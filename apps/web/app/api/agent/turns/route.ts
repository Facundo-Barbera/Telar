import { requestObject, engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

/**
 * SAY SOMETHING TO THE AGENT (#531).
 *
 * THE RUN ID COMES BACK BEFORE THE TURN RUNS, which is what the composer
 * follows: it has something to name in a Cancel before the first token exists.
 * A turn already running QUEUES this one behind it rather than interleaving —
 * one thread, one turn at a time, and the count of what is waiting rides the
 * answer.
 *
 * A SWITCHED-OFF AGENT AND AN EMPTY MESSAGE ARE BOTH A 409 from the engine, in
 * the sentence the runtime wrote for them. Neither is re-checked here: this
 * route would be a second opinion about a state it does not own.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await requestObject(request);
    return Response.json(await (await engineClient()).sendAgentTurn(String(body.text ?? "")), { status: 201 });
  } catch (error) {
    return engineErrorResponse(error);
  }
}
