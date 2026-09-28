import type { DictationProviderId } from "@telar/engine-client";

// Deepgram's grant takes `Authorization: Token <key>` (not Bearer) and `{ ttl_seconds }`, and has no scopes.
export const DEEPGRAM_GRANT_URL = "https://api.deepgram.com/v1/auth/grant";

export const DEEPGRAM_MAX_TTL_SECONDS = 3600;

// The token only has to survive the handshake: an open socket is not re-authenticated when it expires.
export const DICTATION_TTL_SECONDS = 300;

export type DictationToken = {
  provider: DictationProviderId;
  language: string;
  keyterms: string[];
  token: string;
  expiresAt: number;
};

export class DictationError extends Error {
  constructor(
    readonly kind: "off" | "unconfigured" | "upstream",
    message: string,
  ) {
    super(message);
    this.name = "DictationError";
  }
}

export const NO_KEY_CONFIGURED =
  "No Deepgram key is configured on this Mac, so dictation cannot start. Paste one in Settings → Dictation.";

export const DICTATION_OFF = "Dictation is switched off on this Mac. Choose a provider in Settings → Dictation to turn it on.";

export async function grantDictationToken(input: {
  key: string | undefined;
  language: string;
  keyterms?: string[];
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
    throw new DictationError("upstream", `Deepgram could not be reached: ${scrub(cause instanceof Error ? cause.message : String(cause), key)}`);
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

  const lifetime = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : ttlSeconds;
  return { provider: "deepgram", token, expiresAt: now() + lifetime * 1000, language: input.language, keyterms: input.keyterms ?? [] };
}

// Deepgram's own sentence from an error body: `err_msg` on most refusals, `message` on some.
export function deepgramSaid(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { err_msg?: unknown; message?: unknown };
    if (typeof parsed.err_msg === "string" && parsed.err_msg.trim()) return parsed.err_msg.trim();
    if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message.trim();
  } catch {
    return undefined;
  }
  return undefined;
}

async function refusal(response: Response): Promise<string> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return `HTTP ${response.status}.`;
  }
  const said = deepgramSaid(text);
  if (said) return `HTTP ${response.status} — ${said}`;
  const trimmed = text.trim();
  return trimmed ? `HTTP ${response.status} — ${trimmed.slice(0, 300)}` : `HTTP ${response.status}.`;
}

// A backstop: the key should never reach an error text at all.
export function scrub(text: string, key: string): string {
  return text.split(key).join("[redacted]");
}
