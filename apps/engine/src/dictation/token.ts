/**
 * A SHORT-LIVED DEEPGRAM TOKEN, MINTED FOR A CLIENT THAT HOLDS THE MICROPHONE
 * (#544).
 *
 * ── WHY THE AUDIO DOES NOT COME THROUGH HERE ────────────────────────────────
 * The issue body describes streaming audio to `POST /v2/dictation` and having
 * the engine transcribe it. That is the second step. The microphone is in the
 * CLIENT on every surface Telar has — a browser tab, the desktop shell, a
 * phone, the headset — and relaying every frame through the engine would put a
 * Mac on the hot path of a real-time stream that has no reason to touch it. So
 * the engine does the one thing only it can: it holds the long-lived key, and
 * hands out a token that expires in minutes.
 *
 * ── WHAT DEEPGRAM'S GRANT ENDPOINT ACTUALLY SAYS ────────────────────────────
 * Read off developers.deepgram.com on 2026-09-16 rather than from memory, which
 * is what the owner asked for:
 *
 *   POST https://api.deepgram.com/v1/auth/grant
 *   Authorization: Token <API_KEY>          ← "Token", not "Bearer"
 *   { "ttl_seconds": <1..3600> }            ← optional, DEFAULT 30
 *   → 200 { "access_token": "<JWT>", "expires_in": <seconds> }
 *
 * THERE IS NO SCOPES FIELD. The grant endpoint takes `ttl_seconds` and nothing
 * else, and the token it mints carries `usage::write` for the core voice APIs
 * only — it cannot reach the Manage APIs at all. So "scope" is not something
 * this route chooses; it is a property of the endpoint, and the narrowing that
 * matters is the TTL.
 *
 * THIRTY SECONDS IS THE DEFAULT AND IT IS TOO SHORT FOR THIS. The token is
 * spent opening one websocket, but a person presses the mic button when they
 * are ready to speak and the round trip from a phone over the host proxy is not
 * instant. `DICTATION_TTL_SECONDS` is five minutes: long enough that a fetched
 * token is still good when the user actually starts talking, short enough that
 * one captured off a wire is worth little. The maximum Deepgram allows is 3600
 * and nothing here goes near it — the token only has to survive the HANDSHAKE,
 * because an open Deepgram socket is not re-authenticated when its token
 * expires mid-sentence.
 *
 * ── THE ANSWER IS VENDOR-NEUTRAL ON PURPOSE ─────────────────────────────────
 * `provider` rides every answer so OpenAI's realtime tokens, or an on-device
 * model that needs none, can follow without a second route and without a client
 * guessing which socket to open from the shape of the reply.
 */

/** Deepgram's grant endpoint. Overridable only so a test can point at a stub. */
export const DEEPGRAM_GRANT_URL = "https://api.deepgram.com/v1/auth/grant";

/** Deepgram's documented ceiling for `ttl_seconds`. Stated so the clamp below
 *  is readable as "their limit" rather than a number somebody liked. */
export const DEEPGRAM_MAX_TTL_SECONDS = 3600;

/** Five minutes — see the header. Well under the ceiling, well over the
 *  thirty-second default, which is a handshake budget rather than a human one. */
export const DICTATION_TTL_SECONDS = 300;

/** What a client gets. `provider` is what tells it which socket to open. */
export type DictationToken = {
  provider: "deepgram";
  /** The JWT. Short-lived, single-purpose, and the only credential that ever
   *  leaves this engine towards a browser or a phone. */
  token: string;
  /** Epoch milliseconds. Derived from Deepgram's `expires_in` when it sends
   *  one, and from the TTL asked for when it does not — a client needs an
   *  instant to compare against, not a duration it has to time from a moment it
   *  cannot observe. */
  expiresAt: number;
};

/**
 * WHY THIS IS AN ERROR CLASS AND NOT A STRING. The daemon has to answer 409 for
 * "no key here" and 502 for "Deepgram said no", and those are different facts
 * about whose problem it is. The `message` is a SENTENCE in both cases, because
 * the only thing any client can do with it is show it to a person.
 */
export class DictationError extends Error {
  constructor(
    readonly kind: "unconfigured" | "upstream",
    message: string,
  ) {
    super(message);
    this.name = "DictationError";
  }
}

export const NO_KEY_CONFIGURED =
  "No Deepgram key is configured on this Mac, so dictation cannot start. Paste one in Settings → General → Dictation.";

/**
 * Spend the key once and hand back a token.
 *
 * EVERY INPUT IS INJECTABLE, so the whole thing is testable with a fake `fetch`
 * and a fake clock and no test ever needs a real Deepgram account.
 *
 * DEEPGRAM'S OWN WORDS SURVIVE. A refusal carries the `err_msg` from its error
 * body when there is one, because "401" alone cannot tell a person whether they
 * pasted the wrong key or ran out of credit.
 *
 * THE KEY NEVER APPEARS IN A THROWN MESSAGE. Deepgram does not echo the header
 * back, but a body is a remote string and this is the seam where one becomes a
 * sentence a person reads — so the key is scrubbed out of it on the way.
 */
export async function grantDictationToken(input: {
  /** The long-lived key. Absent means unconfigured, which is a refusal rather
   *  than a call. */
  key: string | undefined;
  ttlSeconds?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  url?: string;
}): Promise<DictationToken> {
  const key = input.key?.trim();
  if (!key) throw new DictationError("unconfigured", NO_KEY_CONFIGURED);

  const ttlSeconds = Math.min(Math.max(Math.round(input.ttlSeconds ?? DICTATION_TTL_SECONDS), 1), DEEPGRAM_MAX_TTL_SECONDS);
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? Date.now;

  let response: Response;
  try {
    response = await fetchImpl(input.url ?? DEEPGRAM_GRANT_URL, {
      method: "POST",
      headers: { Authorization: `Token ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl_seconds: ttlSeconds }),
    });
  } catch (cause) {
    // A DNS failure, a dropped connection, an offline Mac. Deepgram has said
    // nothing, so there is nothing of theirs to quote.
    throw new DictationError("upstream", `Deepgram could not be reached: ${scrub(messageOf(cause), key)}`);
  }

  if (!response.ok) {
    throw new DictationError("upstream", `Deepgram refused to issue a dictation token: ${scrub(await refusal(response), key)}`);
  }

  let body: { access_token?: unknown; expires_in?: unknown };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    throw new DictationError("upstream", "Deepgram answered the token request with something that is not JSON.");
  }

  const token = typeof body.access_token === "string" ? body.access_token.trim() : "";
  if (!token) throw new DictationError("upstream", "Deepgram answered the token request without a token in it.");

  // THEIR `expires_in` WINS WHEN THEY SEND ONE, because they are the authority
  // on when their own JWT dies; the TTL asked for is the fallback, and it can
  // only ever be the same or longer than what they actually granted.
  const lifetime = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : ttlSeconds;
  return { provider: "deepgram", token, expiresAt: now() + lifetime * 1000 };
}

/** Deepgram's own sentence when its error body carries one, and the status
 *  line when it does not. Bounded: a remote body is not a length this engine
 *  controls, and a page of HTML in a toast helps nobody. */
async function refusal(response: Response): Promise<string> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return `HTTP ${response.status}.`;
  }
  try {
    const parsed = JSON.parse(text) as { err_msg?: unknown; message?: unknown };
    const said = typeof parsed.err_msg === "string" ? parsed.err_msg : typeof parsed.message === "string" ? parsed.message : undefined;
    if (said) return `HTTP ${response.status} — ${said}`;
  } catch {
    // Not JSON; the raw body below is the best there is.
  }
  const trimmed = text.trim();
  return trimmed ? `HTTP ${response.status} — ${trimmed.slice(0, 300)}` : `HTTP ${response.status}.`;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** A backstop, not the design — see `redactKey` in `agent/credentials.ts`. */
function scrub(text: string, key: string): string {
  return text.split(key).join("[redacted]");
}
