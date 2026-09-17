/**
 * THE LIVE SOCKET'S ADDRESS, AND WHY THE TOKEN RIDES IN THE QUERY (#544).
 *
 * ── WHAT THE DOCS AND THE FIELD ACTUALLY SAY, READ ON 2026-09-16 ────────────
 * Deepgram publishes two ways to authenticate a websocket from a browser, and
 * only one of them works with a token from `/v1/auth/grant`:
 *
 *   `Sec-WebSocket-Protocol: token, <API_KEY>` is the DOCUMENTED browser path
 *   ("Using the Sec-WebSocket-Protocol"), and it is documented for an API KEY.
 *   Passing a grant JWT as `['token', jwt]` fails — a JWT's scheme is `Bearer`,
 *   not `Token`, and a JWT is long enough to run into subprotocol-header length
 *   limits besides (deepgram/discussions#1470).
 *
 *   `?access_token=<JWT>` is what works for a grant token from a browser, and
 *   it is what that discussion lands on.
 *
 * A BROWSER CANNOT SEND A HEADER ON A WEBSOCKET AT ALL — `new WebSocket()` has
 * no header argument, which is the whole reason Deepgram has a subprotocol path
 * in the first place. So the query parameter is not a shortcut here; it is the
 * only door open to this client. The phone is not in the same position: iOS
 * opens the same socket with `Authorization: Bearer <jwt>`, which is the
 * scheme the guide documents for the JWT.
 *
 * ── WHAT PUTTING A CREDENTIAL IN A URL COSTS, AND WHY IT IS ACCEPTABLE HERE ──
 * A query parameter is the worst place for a secret: it lands in proxy logs, in
 * `Referer` headers, in browser history. This one is a token that dies in five
 * minutes, carries `usage::write` for the voice APIs only, and cannot reach the
 * Manage APIs — which is exactly the property the grant endpoint exists to give
 * it, and exactly why the long-lived key stays on the Mac. The URL is built
 * here, used once, and never stored or logged.
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
 */

export const DEEPGRAM_LISTEN_URL = "wss://api.deepgram.com/v1/listen";

/** Built per dictation, from a token that was minted for this one. */
export function listenUrl(token: string, base: string = DEEPGRAM_LISTEN_URL): string {
  const url = new URL(base);
  url.searchParams.set("model", "nova-3");
  url.searchParams.set("interim_results", "true");
  url.searchParams.set("smart_format", "true");
  // The one that ends an utterance on a pause rather than on the socket
  // closing, so a final lands while the person is still talking.
  url.searchParams.set("endpointing", "300");
  url.searchParams.set("access_token", token);
  return url.toString();
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
