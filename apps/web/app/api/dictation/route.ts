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
 *
 * `language` IS THE SECOND ONE, and `multi` is ITS default (#560) — Nova-3
 * code-switching rather than the `en` Deepgram falls back to when nobody says.
 * The answer carries `languages` beside it so a pane can draw a picker from one
 * document; the names are the engine's, for the same reason the provider list
 * is.
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
      // NEITHER THE PROVIDER NOR THE LANGUAGE IS VALIDATED HERE. The engine
      // owns both sets of names and refuses an unknown one with a sentence; a
      // second list in this process would be one more thing to forget the day a
      // third provider lands, or the day Deepgram adds a language.
      await (await engineClient()).setDictation({
        ...("provider" in body ? { provider: body.provider as DictationProviderId } : {}),
        ...("language" in body ? { language: String(body.language ?? "") } : {}),
        ...("apiKey" in body ? { apiKey: String(body.apiKey ?? "") } : {}),
      }),
    );
  } catch (error) {
    return engineErrorResponse(error);
  }
}
