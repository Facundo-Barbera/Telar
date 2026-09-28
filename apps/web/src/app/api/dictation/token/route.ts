import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

/**
 * A TOKEN FOR ONE DICTATION, PROXIED (#544).
 *
 * WHAT THIS ROUTE IS FOR. The browser cannot reach the engine directly — it
 * holds no engine bearer, by design — so every `/api/*` route here is the seam
 * that adds one. This is that seam for dictation, and it carries nothing of its
 * own: the engine spends the long-lived Deepgram key and answers a JWT that
 * dies in minutes, and this forwards it.
 *
 * THE LONG-LIVED KEY IS NEVER IN THIS PROCESS. It is read inside the engine at
 * the moment of the grant call and put into one `Authorization` header there.
 * What crosses this route is the short-lived token, which is the whole point of
 * the design: a credential worth little if it is caught, scoped to the voice
 * APIs, and gone in five minutes.
 *
 * THE PHONE REACHES IT THROUGH THE HOST PROXY unchanged: `/api/hosts/:id/*`
 * forwards any path to that Mac's `/api/*` with its bearer (see
 * `lib/hosts/proxy.ts`), so `/api/hosts/:id/dictation/token` is this route on
 * the other Mac. Nothing had to be allowlisted — the proxy is path-agnostic on
 * purpose, and the timeout table only names the rail's polling reads.
 *
 * POST BECAUSE IT MINTS. Every call spends a round trip against Deepgram and
 * produces a new credential; a GET that did that would be cached by something
 * eventually.
 *
 * THE TWO REFUSALS SURVIVE AS THEMSELVES. A 409 is "no key on this Mac" and
 * names the pane to fix it on; a 502 is Deepgram refusing, carrying Deepgram's
 * own words — "401" alone cannot tell a person whether the key is wrong or the
 * account is out of credit. `engineErrorResponse` keeps both, so the mic button
 * has a sentence to show rather than a status.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST() {
  try {
    return Response.json(await (await engineClient()).dictationToken());
  } catch (error) {
    return engineErrorResponse(error);
  }
}
