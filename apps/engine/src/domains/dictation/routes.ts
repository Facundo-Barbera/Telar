import { HttpError } from "../../platform/http/http";
import { ok, type Route } from "../../platform/http/route";
import { dictationProvider } from "./provider";
import { DICTATION_OFF, DictationError } from "./token";
import type { EngineStore } from "../../state";

/** The engine holds the key and mints short-lived tokens; audio never passes through it. */
export function dictationRoutes(store: EngineStore, fetchImpl?: typeof fetch): Route[] {
  const ask = async (verb: "mintToken" | "diagnose") => {
    try {
      const state = store.dictationState();
      const call = dictationProvider(state.provider)[verb];
      if (!call) throw new DictationError("off", DICTATION_OFF);
      return ok(
        await call({
          key: store.dictationKey(),
          language: state.language,
          vocabulary: state.vocabulary,
          context: store.dictationContext(),
          ...(fetchImpl ? { fetchImpl } : {}),
        }),
      );
    } catch (error) {
      if (!(error instanceof DictationError)) throw error;
      const conflict = error.kind === "off" || error.kind === "unconfigured";
      throw new HttpError(conflict ? 409 : 502, conflict ? "conflict" : "provider_unavailable", error.message);
    }
  };
  return [
    { method: "GET", path: "/v2/dictation", auth: "engine", handle: () => ok({ dictation: store.dictationState() }) },
    {
      method: "PATCH",
      path: "/v2/dictation",
      auth: "engine",
      // By key presence: an absent key changes nothing, and the API key is write-only.
      handle({ body }) {
        if ("provider" in body) store.setDictationProvider(body.provider);
        if ("language" in body) store.setDictationLanguage(body.language);
        if ("vocabulary" in body) store.setDictationVocabulary(body.vocabulary);
        if ("apiKey" in body) store.setDictationKey(body.apiKey);
        return ok({ dictation: store.dictationState() });
      },
    },
    { method: "POST", path: "/v2/dictation/token", auth: "engine", handle: () => ask("mintToken") },
    { method: "POST", path: "/v2/dictation/diagnose", auth: "engine", handle: () => ask("diagnose") },
  ];
}
