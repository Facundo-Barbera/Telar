/**
 * THE LIVE SOCKET'S ADDRESS, AND WHY THE TOKEN RIDES IN THE SUBPROTOCOL (#544).
 *
 * ── WHAT WAS PROBED AGAINST THE REAL ENDPOINT ON 2026-09-16 ─────────────────
 * The first cut of this file put the grant JWT in `?access_token=` and reasoned
 * its way there from a Deepgram discussion thread. It does not work. Three ways
 * of authenticating `wss://api.deepgram.com/v1/listen` were tried with a token
 * this engine had just minted, and only one of them opened:
 *
 *   `?access_token=<jwt>`                  refused — close 1002, "Expected 101
 *                                          status code"
 *   `new WebSocket(url, ["bearer", jwt])`  OPENS
 *   `new WebSocket(url, ["token", jwt])`   refused
 *
 * So the browser authenticates through `Sec-WebSocket-Protocol`, and the scheme
 * word is `bearer` — the JWT's own scheme. `token` is for a long-lived API key
 * and is refused for a grant token, which is the one part of the old comment
 * that was right.
 *
 * A BROWSER STILL CANNOT SEND A HEADER ON A WEBSOCKET — `new WebSocket()` has
 * no header argument, which is why Deepgram has a subprotocol path at all. The
 * second argument is that path: the browser sends the two values as the
 * requested subprotocols and Deepgram reads the credential out of them. The
 * phone is not in the same position and does not need this: iOS opens the same
 * socket with `Authorization: Bearer <jwt>` on a `URLRequest`.
 *
 * NOTHING SECRET IS IN THE URL ANY MORE, which is the incidental win. A query
 * parameter lands in proxy logs, `Referer` headers and browser history; a
 * subprotocol is a request header on one handshake and is never written down by
 * anything on the path.
 *
 * ── THE QUERY IS NOVA-3 AND INTERIM RESULTS ─────────────────────────────────
 * `nova-3` is what telar-vr already dictates with on the headset, so the same
 * words come out on the desktop. `interim_results` is what makes the button
 * able to show that it is hearing something — see `transcript.ts` for why those
 * interim words are SHOWN and never inserted. `smart_format` punctuates, which
 * is the difference between a dictated sentence and a wall of lowercase.
 *
 * NO `encoding` OR `sample_rate` IS SENT, and that is deliberate: `MediaRecorder`
 * hands over a container (WebM/Opus, or MP4 on Safari) and Deepgram reads the
 * container's own header. Declaring `linear16` beside Opus bytes is how a
 * stream transcribes as silence.
 *
 * ── AND `language`, WHICH NOT SENDING IT WAS THE BUG (#560) ─────────────────
 * Deepgram defaults to `en`. So a socket opened without this parameter
 * transcribed Spanish as whatever English it sounded closest to — words in the
 * box, confidently wrong, which is worse than a refusal. It is a REQUIRED
 * argument here rather than one with a default, so the next caller cannot open
 * a socket without deciding: the value comes from the setting, and the token
 * answer is what carries it.
 */

export const DEEPGRAM_LISTEN_URL = "wss://api.deepgram.com/v1/listen";

/**
 * The address, which carries no credential — see the header.
 *
 * `language` IS DEEPGRAM'S OWN CODE, mapped from the setting by the engine
 * before it reached this browser. Nothing here validates it: this file writes a
 * query, and a second copy of the vendor's language table on the client is
 * exactly what putting the list on the engine's answer avoids.
 */
export function listenUrl(language: string, base: string = DEEPGRAM_LISTEN_URL): string {
  const url = new URL(base);
  url.searchParams.set("model", "nova-3");
  url.searchParams.set("interim_results", "true");
  url.searchParams.set("smart_format", "true");
  url.searchParams.set("language", language);
  // The one that ends an utterance on a pause rather than on the socket
  // closing, so a final lands while the person is still talking.
  url.searchParams.set("endpointing", "300");
  return url.toString();
}

/**
 * The `Sec-WebSocket-Protocol` values, which are where the credential goes.
 *
 * `bearer` IS THE SCHEME WORD AND IT IS NOT NEGOTIABLE: `token` is refused for
 * a grant JWT and the query parameter is refused outright. Probed, not
 * remembered — see the header.
 */
export function listenProtocols(token: string): [string, string] {
  return ["bearer", token];
}

/**
 * WHAT THIS BROWSER CAN RECORD, most preferred first.
 *
 * Chrome and Firefox give WebM/Opus; Safari gives MP4/AAC and returns `false`
 * for every WebM type. Deepgram reads both containers. The empty string at the
 * end is `MediaRecorder`'s own default, which is the honest last resort — a
 * browser that supports none of the named types still records something, and
 * refusing to try would be this list's bug rather than the browser's.
 */
const RECORDING_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", ""];

export function recordingType(supported: (type: string) => boolean = (type) => MediaRecorder.isTypeSupported(type)): string {
  return RECORDING_TYPES.find((type) => type === "" || supported(type)) ?? "";
}

/**
 * HOW OFTEN A CHUNK GOES UP. 250 ms is the compromise every live-dictation
 * client lands on: short enough that the first interim word appears while the
 * person is still saying it, long enough that a WebM chunk is a useful amount
 * of audio rather than a container header and two frames.
 */
export const CHUNK_MS = 250;
