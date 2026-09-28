import type { DictationLanguage, DictationProviderId } from "@telar/engine-client";
import { DEEPGRAM_LANGUAGES, deepgramLanguage } from "./deepgram-languages";
import { diagnoseDictation, type DictationDiagnosis } from "./diagnose";
import { fitDeepgramKeyterms } from "./fit";
import { deepgramKeyterms, type DictationContext } from "./keyterms";
import { grantDictationToken, type DictationToken } from "./token";

const DICTATION_PROVIDER_IDS: readonly DictationProviderId[] = ["off", "deepgram"];

export function isDictationProviderId(value: unknown): value is DictationProviderId {
  return typeof value === "string" && (DICTATION_PROVIDER_IDS as readonly string[]).includes(value);
}

type ProviderInput = {
  key: string | undefined;
  language: string;
  vocabulary: readonly string[];
  context: DictationContext;
  fetchImpl?: typeof fetch;
};

// `token` providers hand the client a credential to open its own socket; `stream` ones
// would receive the audio here. Only `token` providers have `mintToken`.
type DictationProvider = {
  id: DictationProviderId;
  label: string;
  kind: "token" | "stream";
  mintToken?: (input: ProviderInput) => Promise<DictationToken>;
  diagnose?: (input: ProviderInput) => Promise<DictationDiagnosis>;
  needsKey: boolean;
  languages: readonly DictationLanguage[];
};

const DEEPGRAM: DictationProvider = {
  id: "deepgram",
  label: "Deepgram",
  kind: "token",
  needsKey: true,
  languages: DEEPGRAM_LANGUAGES,
  // The fit runs beside the grant and never throws, so this only rejects for the grant's reasons.
  mintToken: async ({ language, vocabulary, context, ...rest }) => {
    const wire = deepgramLanguage(language);
    const built = deepgramKeyterms({ vocabulary, context });
    const [minted, keyterms] = await Promise.all([
      grantDictationToken({ ...rest, language: wire, keyterms: built }),
      fitDeepgramKeyterms({ ...rest, language: wire, keyterms: built }),
    ]);
    return { ...minted, keyterms };
  },
  // Diagnoses the fitted list, since that is what the client's socket was handed.
  diagnose: async ({ language, vocabulary, context, ...rest }) => {
    const wire = deepgramLanguage(language);
    const keyterms = await fitDeepgramKeyterms({ ...rest, language: wire, keyterms: deepgramKeyterms({ vocabulary, context }) });
    return diagnoseDictation({ ...rest, language: wire, keyterms });
  },
};

const OFF: DictationProvider = { id: "off", label: "Off", kind: "token", needsKey: false, languages: [] };

const PROVIDERS: Record<DictationProviderId, DictationProvider> = { off: OFF, deepgram: DEEPGRAM };

export function dictationProvider(id: DictationProviderId): DictationProvider {
  return PROVIDERS[id];
}

// The union of every provider's languages, so a PATCH of `{ provider, language }`
// validates the same whichever field is applied first.
export function dictationLanguages(): readonly DictationLanguage[] {
  const byCode = new Map<string, DictationLanguage>();
  for (const id of DICTATION_PROVIDER_IDS) {
    for (const language of PROVIDERS[id].languages) if (!byCode.has(language.code)) byCode.set(language.code, language);
  }
  return [...byCode.values()];
}

export function isDictationLanguage(value: unknown): value is string {
  return typeof value === "string" && dictationLanguages().some((language) => language.code === value);
}
