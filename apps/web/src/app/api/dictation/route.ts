import type { DictationProviderId } from "@telar/engine-client";
import { requestObject, engineClient, engineRoute } from "@/platform/engine/server";

/** Machine-scoped dictation settings; `apiKey` is write-only and never comes back. */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = engineRoute(async () => {
  return Response.json(await (await engineClient()).dictation());
});

export const PATCH = engineRoute(async (request: Request) => {
  const body = await requestObject(request);
  return Response.json(
    // Patched by presence; the engine validates names and an empty key or list clears it.
    await (await engineClient()).setDictation({
      ...("provider" in body ? { provider: body.provider as DictationProviderId } : {}),
      ...("language" in body ? { language: String(body.language ?? "") } : {}),
      ...("vocabulary" in body ? { vocabulary: (Array.isArray(body.vocabulary) ? body.vocabulary : []).map(String) } : {}),
      ...("apiKey" in body ? { apiKey: String(body.apiKey ?? "") } : {}),
    }),
  );
});
