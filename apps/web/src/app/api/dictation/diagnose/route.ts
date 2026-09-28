import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

/**
 * WHY THE LAST DICTATION FAILED, PROXIED (#711).
 *
 * WHAT THIS ROUTE IS FOR. The browser cannot reach the engine directly — it
 * holds no engine bearer, by design — so every `/api/*` route here is the seam
 * that adds one. This is that seam for the diagnosis, and like the token route
 * beside it, it carries nothing of its own.
 *
 * IT IS CALLED AFTER A SOCKET FAILS, NOT BEFORE ONE OPENS. The browser cannot
 * read why its own `WebSocket` was refused — the spec withholds it, because the
 * status of a failed cross-origin handshake would be an oracle — so the engine
 * asks Deepgram on its behalf and answers in Deepgram's words. See
 * `apps/engine/src/dictation/diagnose.ts` for why after rather than before.
 *
 * THE PHONE REACHES IT THROUGH THE HOST PROXY unchanged, like the mint:
 * `/api/hosts/:id/dictation/diagnose` is this route on the other Mac.
 *
 * POST BECAUSE IT SPENDS A HANDSHAKE against Deepgram every time it is called.
 *
 * THE REFUSALS SURVIVE AS THEMSELVES. A 409 is "dictation is off here" or "no
 * key on this Mac"; a 502 is the provider's own trouble. `engineErrorResponse`
 * keeps both — though a caller of THIS route has a sentence already and its job
 * on any failure is to keep showing it.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST() {
  try {
    return Response.json(await (await engineClient()).dictationDiagnosis());
  } catch (error) {
    return engineErrorResponse(error);
  }
}
