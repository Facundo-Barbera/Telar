import type { DictationProviderId } from "@telar/engine-client";
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
 * `provider` IS THE SETTING, and `off` is the default. It decides whether there
 * is a mic button at all, and where there is one, which socket it opens and
 * what it encodes. See `apps/engine/src/dictation/provider.ts`.
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
      // no key must not be read as clearing one, and one that sent no provider
      // must not be read as switching dictation off. An empty key string is the
      // explicit clear, which is what the Remove button sends.
      //
      // THE PROVIDER IS NOT VALIDATED HERE. The engine owns the set of names it
      // knows and refuses an unknown one with a sentence; a second list in this
      // process would be one more thing to forget the day a third provider
      // lands.
      await (await engineClient()).setDictation({
        ...("provider" in body ? { provider: body.provider as DictationProviderId } : {}),
        ...("apiKey" in body ? { apiKey: String(body.apiKey ?? "") } : {}),
      }),
    );
  } catch (error) {
    return engineErrorResponse(error);
  }
}
