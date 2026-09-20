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
 *
 * `brief` ASKS FOR AN ANSWER THAT WILL BE SPOKEN (#567) — two or three
 * sentences, no lists, no code. It is carried through because a voice client
 * reaching this Telar over the web goes through this proxy like any other; the
 * cockpit's own composer never sends it, and nothing about the written UI
 * changes when it is absent.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await requestObject(request);
    const brief = body.brief === true;
    return Response.json(await (await engineClient()).sendAgentTurn(String(body.text ?? ""), { brief }), { status: 201 });
  } catch (error) {
    return engineErrorResponse(error);
  }
}
