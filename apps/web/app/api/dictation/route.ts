import { requestObject, engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

/**
 * WHETHER THIS MAC CAN DICTATE, AND WHOSE SERVICE IT WOULD USE (#544).
 *
 * MACHINE-SCOPED, like the session defaults and the Agent beside it and for the
 * same reason: remote web, the desktop shell and a paired phone read one
 * engine, and a per-client key would be a key pasted once per device.
 *
 * THE KEY GOES DOWN AND NEVER COMES BACK. `apiKey` on the PATCH is write-only;
 * both methods answer `{ dictation: { provider, configured } }` and nothing
 * else. There is no redacted round trip to preserve — the only field is one a
 * person retypes, and an empty string clears it. See the engine's
 * `dictation/credentials.ts`.
 *
 * `provider` RIDES THE ANSWER rather than being assumed by the client, because
 * it decides which socket the mic button opens and which audio format it
 * encodes. Deepgram is the only value today; the field is what lets a second
 * one arrive without every surface being rebuilt to guess.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    return Response.json(await (await engineClient()).dictation());
  } catch (error) {
    return engineErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await requestObject(request);
    return Response.json(
      // BY PRESENCE, like every other settings patch here: a client that sent
      // no key must not be read as clearing one. An empty string is the
      // explicit clear, which is what the Remove button sends.
      await (await engineClient()).setDictation({ ...("apiKey" in body ? { apiKey: String(body.apiKey ?? "") } : {}) }),
    );
  } catch (error) {
    return engineErrorResponse(error);
  }
}
