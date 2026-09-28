export const DEEPGRAM_LISTEN_URL = "wss://api.deepgram.com/v1/listen";

/**
 * No encoding or sample_rate is sent: MediaRecorder hands over a container and
 * Deepgram reads its header. `language` defaults to `en` on Deepgram's side, so it is required.
 * `keyterms` must already be bounded by the engine; an over-budget list fails the upgrade.
 */
export function listenUrl(language: string, keyterms: readonly string[], base: string = DEEPGRAM_LISTEN_URL): string {
  const url = new URL(base);
  url.searchParams.set("model", "nova-3");
  url.searchParams.set("interim_results", "true");
  url.searchParams.set("smart_format", "true");
  url.searchParams.set("numerals", "true");
  url.searchParams.set("language", language);
  // Lower values double monosyllables ("yes yes").
  url.searchParams.set("endpointing", "300");
  // `keyterm` is a repeated parameter; a comma-joined string would be one term.
  for (const term of keyterms) url.searchParams.append("keyterm", term);
  return url.toString();
}

/**
 * Browsers cannot set headers on a WebSocket, so the grant JWT goes in the subprotocol.
 * The scheme word must be `bearer`; `token` and `?access_token=` are refused.
 */
export function listenProtocols(token: string): [string, string] {
  return ["bearer", token];
}

// Safari returns false for every WebM type; "" is MediaRecorder's own default.
const RECORDING_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", ""];

export function recordingType(supported: (type: string) => boolean = (type) => MediaRecorder.isTypeSupported(type)): string {
  return RECORDING_TYPES.find((type) => type === "" || supported(type)) ?? "";
}

export const CHUNK_MS = 250;
