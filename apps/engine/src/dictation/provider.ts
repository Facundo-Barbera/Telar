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
 */

import { grantDictationToken, type DictationToken } from "./token";

/** The value stored and served. `off` is a real member rather than an absent
 *  setting: "nobody has chosen" and "chosen: nobody" are the same decision
 *  here, and one name for it means no client has to handle `undefined`. */
export type DictationProviderId = "off" | "deepgram";

export const DICTATION_PROVIDER_IDS: readonly DictationProviderId[] = ["off", "deepgram"];

export function isDictationProviderId(value: unknown): value is DictationProviderId {
  return typeof value === "string" && (DICTATION_PROVIDER_IDS as readonly string[]).includes(value);
}

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
  mintToken?: (input: { key: string | undefined; fetchImpl?: typeof fetch }) => Promise<DictationToken>;
  /** Whether this provider needs a key pasted on this Mac. `off` does not, and
   *  neither will an on-device model — the settings pane draws the key row off
   *  this rather than off the provider's name. */
  needsKey: boolean;
};

const DEEPGRAM: DictationProvider = {
  id: "deepgram",
  label: "Deepgram",
  kind: "token",
  needsKey: true,
  mintToken: (input) => grantDictationToken(input),
};

/** Chosen but not transcribing. It has no `mintToken`, which is what makes the
 *  token route's refusal a property of the provider rather than an `if` that
 *  somebody has to remember to write again next time. */
const OFF: DictationProvider = { id: "off", label: "Off", kind: "token", needsKey: false };

const PROVIDERS: Record<DictationProviderId, DictationProvider> = { off: OFF, deepgram: DEEPGRAM };

export function dictationProvider(id: DictationProviderId): DictationProvider {
  return PROVIDERS[id];
}
