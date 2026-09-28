export type DictationProviderId = "off" | "deepgram";

export type DictationLanguage = { code: string; label: string };

export type DictationAnswer = {
  dictation: {
    provider: DictationProviderId;
    configured: boolean;
    language: string;
    languages: DictationLanguage[];
    vocabulary: string[];
    /** `sent` is what the provider took, never more than `built`. */
    keyterms?: { built: number; sent: number; reason?: "refused" | "unconfirmed" };
  };
};

export type DictationTokenAnswer = {
  provider: DictationProviderId;
  token: string;
  expiresAt: number;
  language: string;
  keyterms?: string[];
};

export type DictationDiagnosisAnswer = {
  fault: "refused" | "unreachable" | "elsewhere" | "unconfigured";
  reason: string;
};
