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
 * FIELD-AT-A-TIME WRITES READ THE OTHER ONE FIRST. Two callers write this file
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
export type DictationSettings = { provider: DictationProviderId; language: string };

/** `<engineRoot>/dictation/settings.json`. */
export function dictationSettingsFile(dictationDir: string): string {
  return path.join(dictationDir, "settings.json");
}

/** Both fields, each falling back on its own. A file with a provider in it and
 *  a language this build does not know still answers that provider: one bad
 *  field is not a reason to forget the other. */
export function readDictationSettings(dictationDir: string): DictationSettings {
  try {
    const stored = JSON.parse(fs.readFileSync(dictationSettingsFile(dictationDir), "utf8")) as { provider?: unknown; language?: unknown };
    return {
      provider: isDictationProviderId(stored.provider) ? stored.provider : "off",
      language: isDictationLanguage(stored.language) ? stored.language : DICTATION_LANGUAGE_DEFAULT,
    };
  } catch {
    return { provider: "off", language: DICTATION_LANGUAGE_DEFAULT };
  }
}

/** The whole document, every time — see the header for why a one-field write
 *  would drop the other. */
export function writeDictationSettings(dictationDir: string, settings: DictationSettings): void {
  atomicWrite(dictationSettingsFile(dictationDir), settings, 0o600);
}
