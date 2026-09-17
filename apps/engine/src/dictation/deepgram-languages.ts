/**
 * WHAT DEEPGRAM WILL TRANSCRIBE, AND WHY THE LIST LIVES WITH DEEPGRAM (#560).
 *
 * ── THE BUG THIS EXISTS TO CLOSE ────────────────────────────────────────────
 * Neither client sent `language` on the listen socket, and Deepgram's default
 * is `en`. So dictation on a Spanish phone produced English words that sounded
 * a bit like what was said — which is worse than a refusal, because it looks
 * like it worked.
 *
 * ── `multi` IS THE DEFAULT AND IT IS NOT A COMPROMISE ───────────────────────
 * Nova-3 streams `multi` as a first-class model, code-switching WITHIN one
 * utterance across English, Spanish, French, German, Hindi, Russian,
 * Portuguese, Japanese, Italian and Dutch. A person who says a product name in
 * English in the middle of a Spanish sentence gets both, which is how people
 * actually talk and is exactly what picking `es` would break. Naming a single
 * language is the narrowing — worth having for accuracy in one tongue, and
 * worth NOT being the default.
 *
 * ── READ OFF THE DOCS ON 2026-09-17, NOT REMEMBERED ─────────────────────────
 * developers.deepgram.com/docs/models-languages-overview, Nova-3's table. That
 * page does not split streaming from batch for Nova-3 — it publishes one list
 * per model — so this is that list, and a code it turns out to refuse on the
 * socket is a bug to fix against the page rather than a guess to re-derive.
 *
 * ── ONE ENTRY PER DISTINCT CHOICE, ALIASES DROPPED ──────────────────────────
 * Deepgram documents several spellings of the same language: `zh`, `zh-CN` and
 * `zh-Hans` are one thing, and Arabic has seventeen country codes behind one
 * model. A picker that offered all of them would be asking a person to choose
 * between synonyms. So each row here is a choice somebody could mean, with the
 * canonical code; the regional rows that survive (`en-GB`, `pt-BR`, `es-419`,
 * `fr-CA`, `de-CH`, `nl-BE`, the three Chinese) are the ones Deepgram models
 * separately.
 *
 * ── AND IT IS DEEPGRAM'S, NOT THE ENGINE'S ──────────────────────────────────
 * The setting stores a code; THIS file is what says the code means anything.
 * The next provider declares its own list and its own `wire` mapping, and
 * nothing in `state.ts`, the daemon or any client learns a vendor's vocabulary
 * — which is the same seam `provider.ts` draws for the token route.
 */

// TYPE-ONLY, so the cycle with `provider.ts` (which imports this file) is
// erased at compile time and there is none at run time — the same trick
// `token.ts` uses for `DictationProviderId`.
import type { DictationLanguage } from "./provider";

/** What a person gets when they have not narrowed it, and the answer for a
 *  household that does not speak one language at a time. */
export const DICTATION_LANGUAGE_DEFAULT = "multi";

/**
 * Nova-3's languages, `multi` first and the rest by name.
 *
 * SORTED FOR A READER, not by code: this list is rendered into a picker on two
 * platforms, and "Deutsch is under D" is the only ordering a person scanning
 * seventy rows can use.
 */
export const DEEPGRAM_LANGUAGES: readonly DictationLanguage[] = [
  { code: DICTATION_LANGUAGE_DEFAULT, label: "Automatic (any supported language)" },
  { code: "af", label: "Afrikaans" },
  { code: "ar", label: "Arabic" },
  { code: "hy", label: "Armenian" },
  { code: "as", label: "Assamese" },
  { code: "be", label: "Belarusian" },
  { code: "bn", label: "Bengali" },
  { code: "bs", label: "Bosnian" },
  { code: "bg", label: "Bulgarian" },
  { code: "ca", label: "Catalan" },
  { code: "zh-HK", label: "Chinese (Cantonese, Traditional)" },
  { code: "zh", label: "Chinese (Mandarin, Simplified)" },
  { code: "zh-TW", label: "Chinese (Mandarin, Traditional)" },
  { code: "hr", label: "Croatian" },
  { code: "cs", label: "Czech" },
  { code: "da", label: "Danish" },
  { code: "nl", label: "Dutch" },
  { code: "en", label: "English" },
  { code: "en-AU", label: "English (Australia)" },
  { code: "en-IN", label: "English (India)" },
  { code: "en-NZ", label: "English (New Zealand)" },
  { code: "en-GB", label: "English (United Kingdom)" },
  { code: "en-US", label: "English (United States)" },
  { code: "et", label: "Estonian" },
  { code: "fi", label: "Finnish" },
  { code: "nl-BE", label: "Flemish" },
  { code: "fr", label: "French" },
  { code: "fr-CA", label: "French (Canada)" },
  { code: "ka", label: "Georgian" },
  { code: "de", label: "German" },
  { code: "de-CH", label: "German (Switzerland)" },
  { code: "el", label: "Greek" },
  { code: "gu", label: "Gujarati" },
  { code: "he", label: "Hebrew" },
  { code: "hi", label: "Hindi" },
  { code: "hu", label: "Hungarian" },
  { code: "id", label: "Indonesian" },
  { code: "it", label: "Italian" },
  { code: "ja", label: "Japanese" },
  { code: "kn", label: "Kannada" },
  { code: "kk", label: "Kazakh" },
  { code: "ko", label: "Korean" },
  { code: "lv", label: "Latvian" },
  { code: "lt", label: "Lithuanian" },
  { code: "mk", label: "Macedonian" },
  { code: "ms", label: "Malay" },
  { code: "mr", label: "Marathi" },
  { code: "mn", label: "Mongolian" },
  { code: "ne", label: "Nepali" },
  { code: "no", label: "Norwegian" },
  { code: "ps", label: "Pashto" },
  { code: "fa", label: "Persian" },
  { code: "pl", label: "Polish" },
  { code: "pt", label: "Portuguese" },
  { code: "pt-BR", label: "Portuguese (Brazil)" },
  { code: "pt-PT", label: "Portuguese (Portugal)" },
  { code: "pa", label: "Punjabi" },
  { code: "ro", label: "Romanian" },
  { code: "ru", label: "Russian" },
  { code: "sr", label: "Serbian" },
  { code: "sk", label: "Slovak" },
  { code: "sl", label: "Slovenian" },
  { code: "es", label: "Spanish" },
  { code: "es-419", label: "Spanish (Latin America)" },
  { code: "sv", label: "Swedish" },
  { code: "tl", label: "Tagalog" },
  { code: "ta", label: "Tamil" },
  { code: "te", label: "Telugu" },
  { code: "th", label: "Thai" },
  { code: "tr", label: "Turkish" },
  { code: "uk", label: "Ukrainian" },
  { code: "ur", label: "Urdu" },
  { code: "vi", label: "Vietnamese" },
];

/**
 * THE SETTING'S CODE AS DEEPGRAM'S WIRE VALUE.
 *
 * IDENTITY HERE, AND THAT IS THE POINT RATHER THAN AN OMISSION: the codes above
 * ARE Deepgram's, because Deepgram is what declared them. A provider whose wire
 * wants `spanish` where the setting says `es` writes the translation in its own
 * version of this function and nothing else in the engine changes.
 *
 * AN UNKNOWN CODE FALLS BACK TO `multi` RATHER THAN THROWING. The write path
 * already refuses one with a sentence, so reaching here means a settings file
 * edited by hand or written by a newer build — and in that case transcribing
 * everything beats refusing to transcribe at all.
 */
export function deepgramLanguage(code: string): string {
  return DEEPGRAM_LANGUAGES.some((language) => language.code === code) ? code : DICTATION_LANGUAGE_DEFAULT;
}
