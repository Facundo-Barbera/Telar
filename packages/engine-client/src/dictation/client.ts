import type { EngineTransport } from "../platform/transport";
import type { DictationAnswer, DictationDiagnosisAnswer, DictationProviderId, DictationTokenAnswer } from "./schema";

export const dictationClient = {
  dictation(this: EngineTransport): Promise<DictationAnswer> {
    return this.request("GET", "/v2/dictation");
  },

  setDictation(
    this: EngineTransport,
    patch: { provider?: DictationProviderId; apiKey?: string; language?: string; vocabulary?: string[] },
  ): Promise<DictationAnswer> {
    return this.request("PATCH", "/v2/dictation", patch);
  },

  dictationToken(this: EngineTransport): Promise<DictationTokenAnswer> {
    return this.request("POST", "/v2/dictation/token");
  },

  dictationDiagnosis(this: EngineTransport): Promise<DictationDiagnosisAnswer> {
    return this.request("POST", "/v2/dictation/diagnose");
  },
};
