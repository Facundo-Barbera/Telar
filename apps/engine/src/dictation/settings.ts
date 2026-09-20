/**
 * WHICH PROVIDER THIS MAC DICTATES WITH — one field, beside the key (#544).
 *
 * ── ITS OWN DOCUMENT, NOT THE KEY'S FILE ────────────────────────────────────
 * `credentials.json` is 0600 and write-only: it is read by exactly one caller
 * and never echoed. This one is the opposite — it is READ by every client that
 * opens the composer, because it decides whether there is a mic button at all.
 * Two rules, two files, and the one with the secret in it keeps having exactly
 * one author.
 *
 * ── OFF IS THE DEFAULT AND AN ABSENT FILE MEANS OFF ─────────────────────────
 * Which makes the upgrade honest: a Mac that has this engine for the first
 * time, and a Mac that had the previous build with a key already pasted, both
 * come up with no mic button until somebody asks for one. A key that was pasted
 * before is kept and simply not spent — see `dictationState`, where `configured`
 * is still answered for `off` so the pane can say a key is there.
 *
 * NEVER THROWS ON READ. An absent, unreadable or malformed file is `off`, which
 * is the safe answer in both directions: nothing starts recording because a
 * JSON file got truncated.
 *
 * ── AND WHICH LANGUAGE, BESIDE IT (#560) ────────────────────────────────────
 * One more field in the same document, for the same reason `provider` is here
 * rather than beside the key: it is read by every client that opens a composer
 * and it is not a secret. It defaults to `multi` — Nova-3 code-switching across
 * the languages it supports — because English-by-default is the bug that made
 * this field exist, and because a person who speaks two languages in one
 * sentence is not a corner case.
 *
 * ── AND THE WORDS THIS PERSON SAYS THAT NOTHING COULD GUESS (#581) ──────────
 * `vocabulary` is a third field of the same kind: not a secret, read by the one
 * route that mints a token, and a preference rather than a fact about the
 * machine. It holds the person's PLAIN TERMS — "Kubernetes", a colleague's
 * name, a product nobody spells the obvious way — and nothing about how a
 * provider expresses them. Deepgram turns them into `keyterm` parameters
 * (`keyterms.ts`); the next provider will do something else with the same list,
 * and neither the file nor the route learns which.
 *
 * FIELD-AT-A-TIME WRITES READ THE OTHERS FIRST. Three callers write this file
 * and each of them writes one field, so the write has to carry the whole
 * document — a `{ provider }` written over a stored language is how a person's
 * choice disappears the next time they switch provider.
 */
import fs from "node:fs";
import path from "node:path";
import { atomicWrite } from "../atomic";
import { DICTATION_LANGUAGE_DEFAULT, isDictationLanguage, isDictationProviderId, type DictationProviderId } from "./provider";

/** Everything the settings document holds. The key is NOT in it — see the
 *  header. */
export type DictationSettings = { provider: DictationProviderId; language: string; vocabulary: string[] };

/**
 * HOW MANY TERMS A PERSON MAY STORE, and it is deliberately larger than the
 * forty any one socket carries: the box is a place to keep a glossary, and the
 * provider decides what fits. Storing only what fits today would silently throw
 * away the rest the first time somebody pasted a list.
 */
export const DICTATION_VOCABULARY_LIMIT = 200;

/** Longest single stored term. A paragraph pasted into the box is not a term —
 *  see `MAX_TERM_CHARACTERS` in `keyterms.ts`, which draws the same line lower
 *  for what actually goes on a socket. */
export const DICTATION_TERM_LIMIT = 200;

/**
 * ONE TERM PER ENTRY, TRIMMED, WITHOUT BLANKS OR REPEATS.
 *
 * SHARED BY THE READER AND THE WRITER so a hand-edited file and a PATCH reach
 * the same list. The clean-up is not validation — nothing is refused for being
 * untidy, because the only thing a person can do wrong here is leave a blank
 * line, and refusing a save over one would be a settings box that argues.
 */
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

/** `<engineRoot>/dictation/settings.json`. */
export function dictationSettingsFile(dictationDir: string): string {
  return path.join(dictationDir, "settings.json");
}

/** Both fields, each falling back on its own. A file with a provider in it and
 *  a language this build does not know still answers that provider: one bad
 *  field is not a reason to forget the other. */
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
      // ABSENT IS EMPTY, which is every Mac that had this file before #581 —
      // the keyterms built from the store are the same either way.
      vocabulary: cleanDictationVocabulary(stored.vocabulary),
    };
  } catch {
    return { provider: "off", language: DICTATION_LANGUAGE_DEFAULT, vocabulary: [] };
  }
}

/** The whole document, every time — see the header for why a one-field write
 *  would drop the other. */
export function writeDictationSettings(dictationDir: string, settings: DictationSettings): void {
  atomicWrite(dictationSettingsFile(dictationDir), settings, 0o600);
}
