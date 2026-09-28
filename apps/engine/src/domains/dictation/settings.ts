import fs from "node:fs";
import path from "node:path";
import type { DictationProviderId } from "@telar/engine-client";
import { atomicWrite } from "../../platform/fs/atomic";
import { DICTATION_LANGUAGE_DEFAULT } from "./deepgram-languages";
import { isDictationLanguage, isDictationProviderId } from "./provider";

type DictationSettings = { provider: DictationProviderId; language: string; vocabulary: string[] };

// Larger than any socket carries: the box keeps a glossary, and the provider decides what fits.
const DICTATION_VOCABULARY_LIMIT = 200;
const DICTATION_TERM_LIMIT = 200;

export function cleanDictationVocabulary(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const term = entry.replace(/\s+/g, " ").trim().slice(0, DICTATION_TERM_LIMIT);
    const key = term.toLocaleLowerCase();
    if (!term || seen.has(key)) continue;
    seen.add(key);
    kept.push(term);
    if (kept.length >= DICTATION_VOCABULARY_LIMIT) break;
  }
  return kept;
}

function dictationSettingsFile(dictationDir: string): string {
  return path.join(dictationDir, "settings.json");
}

// Each field falls back on its own; an absent or broken file means `off`.
export function readDictationSettings(dictationDir: string): DictationSettings {
  try {
    const stored = JSON.parse(fs.readFileSync(dictationSettingsFile(dictationDir), "utf8")) as {
      provider?: unknown;
      language?: unknown;
      vocabulary?: unknown;
    };
    return {
      provider: isDictationProviderId(stored.provider) ? stored.provider : "off",
      language: isDictationLanguage(stored.language) ? stored.language : DICTATION_LANGUAGE_DEFAULT,
      vocabulary: cleanDictationVocabulary(stored.vocabulary),
    };
  } catch {
    return { provider: "off", language: DICTATION_LANGUAGE_DEFAULT, vocabulary: [] };
  }
}

// Always the whole document: callers each change one field.
export function writeDictationSettings(dictationDir: string, settings: DictationSettings): void {
  atomicWrite(dictationSettingsFile(dictationDir), settings, 0o600);
}
