import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * THE THREE HUMAN VERBS ON A THREAD, and none is a status change.
 *
 * `settle` RECORDS AN ANSWER. It is refused without one — here, in the daemon,
 * and in the store — because a settle with no answer is exactly the status flip
 * `SpoolThread` promises it cannot express. Three layers say so rather than one,
 * for the same reason the retirement reason is guarded three times: the rule is
 * the record's meaning, not an input-validation nicety.
 *
 * `reviewed` CLEARS `proposed` AND NOTHING ELSE. The provenance law's whole
 * content is that an agent's artifact is marked until a person has looked at it,
 * so the verb that unmarks it may not also edit it.
 *
 * `waiting` SAYS WHO A THREAD IS STUCK ON — the arm the parity rule (loops
 * §9.4) gives the hand: the chat could already mark a thread waiting on
 * someone, so a packet's control reaches the same verb through the same
 * route. Normalised and guarded by the store ("person" naming the human IS
 * "you"; refused on a settled thread), never re-judged here.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ subject: string; threadId: string }> },
) {
  try {
    const { subject, threadId } = await params;
    const body = (await request.json()) as {
      settle?: { answer?: string };
      reviewed?: boolean;
      waiting?: { kind?: "you" | "agent" | "person"; who?: string; note?: string };
    };
    const client = await engineClient();

    if (body.settle !== undefined) {
      const answer = body.settle.answer;
      if (typeof answer !== "string" || answer.trim() === "") {
        return Response.json(
          { error: "settle.answer is required — settling a thread records what was found out, not that it is over." },
          { status: 400 },
        );
      }
      return Response.json(await client.settleSpoolThread(subject, threadId, answer));
    }

    if (body.reviewed === true) {
      return Response.json(await client.reviewSpoolThread(subject, threadId));
    }

    if (body.waiting !== undefined) {
      const kind = body.waiting.kind;
      if (kind !== "you" && kind !== "agent" && kind !== "person") {
        return Response.json(
          { error: "waiting.kind is required — you, agent, or person (with `who` naming them)." },
          { status: 400 },
        );
      }
      return Response.json(
        await client.setSpoolThreadWaiting(subject, threadId, {
          kind,
          ...(body.waiting.who ? { who: body.waiting.who } : {}),
          ...(body.waiting.note ? { note: body.waiting.note } : {}),
        }),
      );
    }

    return Response.json(
      { error: "Send `settle: {answer}`, `reviewed: true`, or `waiting: {kind, who?, note?}`." },
      { status: 400 },
    );
  } catch (error) {
    return engineErrorResponse(error);
  }
}
