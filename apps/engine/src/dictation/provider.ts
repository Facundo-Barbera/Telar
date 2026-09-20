/**
 * WHO TRANSCRIBES, AS A SEAM RATHER THAN AN ASSUMPTION (#544).
 *
 * ── NOTHING IS FORCED, WHICH IS WHY `off` IS A PROVIDER ─────────────────────
 * `off` is the DEFAULT, and it is not a disabled state bolted onto a feature
 * that wants to be on. macOS and iOS dictation work on the composer already —
 * it is a plain editable — and so do Wispr Flow and everything like it. A mic
 * button that appeared uninvited would be Telar claiming a job the person may
 * well have given to something else. So with `off` there is no key row, no mic
 * button on any surface, and no route that spends anything.
 *
 * ── TWO KINDS OF PROVIDER, AND THE DIFFERENCE IS WHERE THE AUDIO GOES ───────
 * `token`  the client opens its own socket to the vendor with a short-lived
 *          credential this engine mints. The audio never touches the Mac,
 *          which is the whole reason the first step was a token route:
 *          relaying a real-time stream through a machine that has no reason
 *          to see it is a hop for nothing. Deepgram is this.
 *
 * `stream` the engine transcribes. The audio comes here, which is what an
 *          on-device model (whisper.cpp, Apple's SpeechAnalyzer) needs by
 *          definition, and what an OpenAI transcription behind the Agent's
 *          own key resolver would most naturally be.
 *
 * `kind` RIDES THE ANSWER for the same reason `provider` does: a client must
 * be able to tell which shape it is dealing with without a table of vendor
 * names compiled into it.
 *
 * ── AND ONLY ONE OF THEM IS BUILT ───────────────────────────────────────────
 * Deepgram, because it is what the headset already dictates with and what the
 * bearer fix was probed against. OpenAI and on-device are named here as the
 * shapes this interface exists to hold and are NOT implemented: a seam with
 * nothing on the other side of it is cheap, and two half-built providers would
 * be the expensive version of the same idea. Adding one is a `DictationProvider`
 * and an entry in `PROVIDERS`; nothing else in the engine learns its name.
 *
 * ── WHICH LANGUAGE, AND WHY THAT IS THE PROVIDER'S LIST TOO (#560) ──────────
 * The language is a property of the SETTING — one field beside the provider and
 * the key — but the vocabulary it is written in belongs to whoever transcribes.
 * So a provider DECLARES its languages and MAPS the stored code onto its own
 * wire, and the engine validates against what the declarations add up to. A
 * provider with a different set of names, or the same set spelled differently,
 * is a list and a mapping function rather than an edit to the settings route.
 *
 * ── AND WHAT TO PRIME IT WITH, WHICH IS THE SAME SHAPE AGAIN (#581) ─────────
 * The setting stores a person's plain `vocabulary`; the engine reads the names
 * this Mac is currently about off the store. Neither is a `keyterm` — that word
 * is Deepgram's, and `mintToken` is where it is spoken. The alternative was a
 * route that built a vendor's query parameters and a provider that passed them
 * through, which is the seam pointing the wrong way.
 */

import { DEEPGRAM_LANGUAGES, DICTATION_LANGUAGE_DEFAULT, deepgramLanguage } from "./deepgram-languages";
import { diagnoseDictation, type DictationDiagnosis } from "./diagnose";
import { fitDeepgramKeyterms } from "./fit";
import { deepgramKeyterms, type DictationContext } from "./keyterms";
import { grantDictationToken, type DictationToken } from "./token";

/** The value stored and served. `off` is a real member rather than an absent
 *  setting: "nobody has chosen" and "chosen: nobody" are the same decision
 *  here, and one name for it means no client has to handle `undefined`. */
export type DictationProviderId = "off" | "deepgram";

export const DICTATION_PROVIDER_IDS: readonly DictationProviderId[] = ["off", "deepgram"];

export function isDictationProviderId(value: unknown): value is DictationProviderId {
  return typeof value === "string" && (DICTATION_PROVIDER_IDS as readonly string[]).includes(value);
}

/**
 * ONE LANGUAGE A PROVIDER WILL TRANSCRIBE, and the label a person picks it by.
 *
 * THE LABEL TRAVELS WITH THE CODE because the alternative is a translation
 * table per client: the web pane, the phone's screen and the headset would each
 * hold seventy names, and the day a provider adds one, three of them would be
 * out of date. The engine already knows; it says.
 */
export type DictationLanguage = { code: string; label: string };

/** What the engine can do about transcription for one provider. */
export type DictationProvider = {
  id: DictationProviderId;
  /** What a person sees. Held here rather than in every client so a new
   *  provider names itself once. */
  label: string;
  /** Where the audio goes — see the header. */
  kind: "token" | "stream";
  /**
   * Mint one dictation's worth of credential. Present on `token` providers and
   * absent on the others, which is the type saying what the header says: a
   * `stream` provider has no token to give, and a route that called this on one
   * would be asking the wrong question rather than getting a null answer.
   */
  mintToken?: (input: {
    key: string | undefined;
    language: string;
    /**
     * THE PERSON'S OWN TERMS AND WHAT THIS MAC IS ABOUT, RAW (#581).
     *
     * Two arguments rather than a built list, which is the seam: the engine
     * knows what there IS — a stored glossary, the unsettled conversations, the
     * projects — and the provider knows what to DO with it. Deepgram makes
     * `keyterm` parameters out of them; a provider that primes with a prompt
     * string, or with nothing, takes the same two and answers differently.
     */
    vocabulary: readonly string[];
    context: DictationContext;
    fetchImpl?: typeof fetch;
  }) => Promise<DictationToken>;
  /**
   * WHY THE LAST DICTATION FAILED, ASKED OF THE PROVIDER ITSELF (#711).
   *
   * Present for the same reason `mintToken` is and absent for the same reason:
   * a provider that transcribes nothing has no refusal to explain, and a route
   * that called this on `off` would be asking the wrong question rather than
   * getting a null answer. An on-device model would answer this off its own
   * state and never open a socket at all.
   *
   * IT TAKES THE RAW NAMES, like `mintToken`, because the question has to be
   * the one the client's socket asked — and the glossary is the part of it that
   * can be refused. Turning them into `keyterm` parameters is this provider's
   * job and nobody else's.
   */
  diagnose?: (input: {
    key: string | undefined;
    language: string;
    vocabulary: readonly string[];
    context: DictationContext;
    fetchImpl?: typeof fetch;
  }) => Promise<DictationDiagnosis>;
  /** Whether this provider needs a key pasted on this Mac. `off` does not, and
   *  neither will an on-device model — the settings pane draws the key row off
   *  this rather than off the provider's name. */
  needsKey: boolean;
  /** What it will transcribe, in the order a picker should offer it. Empty for
   *  a provider that transcribes nothing, which is what gives `off` no language
   *  row rather than an empty one. */
  languages: readonly DictationLanguage[];
};

const DEEPGRAM: DictationProvider = {
  id: "deepgram",
  label: "Deepgram",
  kind: "token",
  needsKey: true,
  languages: DEEPGRAM_LANGUAGES,
  // THE MAPPING HAPPENS AT MINT TIME, so what a client is handed is already a
  // wire value and not a setting it would have to interpret. Identity for
  // Deepgram — see `deepgramLanguage` for why that is the point rather than an
  // omission. The glossary is the same move one step further out: the engine
  // hands over names, and `deepgramKeyterms` is what makes them this vendor's
  // parameter (#581).
  //
  // ── AND THE GLOSSARY IS CONFIRMED, NOT ASSUMED (#712) ─────────────────────
  // `deepgramKeyterms` builds to a MEASURED bound; `fitDeepgramKeyterms` asks
  // Deepgram whether that list is actually accepted and shortens it when the
  // answer is no. Why here rather than in a browser: the client cannot read the
  // refusal at all — a WebSocket error event carries no reason by design — and
  // this engine holds the key, builds the list, and is one place instead of
  // three. See `fit.ts`.
  //
  // IN PARALLEL WITH THE GRANT, which is what keeps it free. Both are round
  // trips to Deepgram with the same key and neither needs the other's answer,
  // so a press waits for the slower rather than the sum. The fit NEVER THROWS
  // — every failure in it is a shorter list — so this `Promise.all` can only
  // ever reject for the grant's own reasons, and those are the ones the route
  // already turns into a sentence.
  mintToken: async ({ language, vocabulary, context, ...rest }) => {
    const wire = deepgramLanguage(language);
    const built = deepgramKeyterms({ vocabulary, context });
    const [minted, keyterms] = await Promise.all([
      grantDictationToken({ ...rest, language: wire, keyterms: built }),
      fitDeepgramKeyterms({ ...rest, language: wire, keyterms: built }),
    ]);
    return { ...minted, keyterms };
  },
  // ── AND WHEN IT FAILS ANYWAY, ASK WHY (#711) ──────────────────────────────
  // THE SAME QUESTION THE CLIENT'S SOCKET ASKED, which is why this rebuilds the
  // glossary and puts it through the same fit rather than diagnosing the raw
  // list: a client is handed the FITTED one, so asking about the built one
  // would report a keyterm refusal for a request nobody made. The fit memoizes
  // its accepted answer against the exact list, and the press that just failed
  // will have warmed it — so the usual cost of being faithful here is nothing.
  diagnose: async ({ language, vocabulary, context, ...rest }) => {
    const wire = deepgramLanguage(language);
    const keyterms = await fitDeepgramKeyterms({ ...rest, language: wire, keyterms: deepgramKeyterms({ vocabulary, context }) });
    return diagnoseDictation({ ...rest, language: wire, keyterms });
  },
};

/** Chosen but not transcribing. It has no `mintToken`, which is what makes the
 *  token route's refusal a property of the provider rather than an `if` that
 *  somebody has to remember to write again next time. */
const OFF: DictationProvider = { id: "off", label: "Off", kind: "token", needsKey: false, languages: [] };

const PROVIDERS: Record<DictationProviderId, DictationProvider> = { off: OFF, deepgram: DEEPGRAM };

export function dictationProvider(id: DictationProviderId): DictationProvider {
  return PROVIDERS[id];
}

/**
 * EVERY LANGUAGE ANY PROVIDER DECLARES, by code and in declaration order.
 *
 * THE UNION RATHER THAN THE CHOSEN PROVIDER'S LIST, and the reason is the shape
 * of a PATCH: `{ provider, language }` arrives as one body, so validating the
 * language against whichever provider happens to be stored at that instant
 * would make the two fields order-dependent — the same request accepted or
 * refused depending on which `if` ran first. A language is also a preference
 * that outlives the provider it was chosen under, and a provider that cannot
 * honour it maps it (see `deepgramLanguage`) rather than making it unsettable.
 */
export function dictationLanguages(): readonly DictationLanguage[] {
  const byCode = new Map<string, DictationLanguage>();
  for (const id of DICTATION_PROVIDER_IDS) {
    for (const language of PROVIDERS[id].languages) if (!byCode.has(language.code)) byCode.set(language.code, language);
  }
  return [...byCode.values()];
}

/** Whether a code is one this engine will store. The SENTENCE for a refusal
 *  belongs to the caller that refuses; this only answers the question. */
export function isDictationLanguage(value: unknown): value is string {
  return typeof value === "string" && dictationLanguages().some((language) => language.code === value);
}

export { DICTATION_LANGUAGE_DEFAULT };
