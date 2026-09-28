import { requestObject, engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

/**
 * Whether Telar may tell an agent where it is — the orientation preamble and
 * the `telar` skill, each with its own switch.
 *
 * ENVIRONMENT-SCOPED, like the inbox rule beside it and for the sharper version
 * of the same reason: this decides what EVERY session on this machine is told,
 * so a per-browser copy would mean one engine injecting a paragraph some of its
 * own clients had switched off.
 *
 * FORWARDED UNVALIDATED. The engine holds the shape next to the schema that
 * states it (`AgentOrientation`), and the PATCH there also re-syncs the skill
 * on disk — a check repeated here would be a second copy of a rule that can
 * disagree with the first, and could not do the second half at all.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    return Response.json(await (await engineClient()).orientation());
  } catch (error) {
    return engineErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await requestObject(request);
    return Response.json(
      await (await engineClient()).setOrientation({
        // By PRESENCE, not truthiness: `false` is the whole point of this
        // route, and an absent key means "leave that one alone".
        ...("preamble" in body ? { preamble: body.preamble as boolean } : {}),
        ...("skill" in body ? { skill: body.skill as boolean } : {}),
      }),
    );
  } catch (error) {
    return engineErrorResponse(error);
  }
}
