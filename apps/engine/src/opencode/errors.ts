/**
 * WHAT AN OPENCODE FAILURE IS ALLOWED TO SAY.
 *
 * An ALLOW-LIST, because `APIError` carries `responseHeaders` and
 * `responseBody` verbatim from the provider — tokens, cookies, whole payloads.
 * Only the fields named below can reach a transcript, each bounded, and the
 * message is swept for secret-shaped text on top of that.
 */

/** The SDK's assistant-message error union (`gen/types.gen.d.ts`). Structural,
 *  so a version that adds a member degrades to the unknown fallback rather
 *  than failing to compile. */
export type OpenCodeErrorLike = {
  name?: unknown;
  data?: { message?: unknown; providerID?: unknown; statusCode?: unknown; [key: string]: unknown };
};

/** Long enough for a provider's sentence, short enough that a leaked body is
 *  not a leaked body. */
const MAX_MESSAGE = 300;

/** Secret-shaped runs, redacted inside an otherwise allowed message. The
 *  second lock, not a substitute for the allow-list. */
const SECRET_PATTERNS: RegExp[] = [
  // `sk-…`, `sk_live_…`, GitHub's `gh[pousr]_…`, and friends: a known prefix
  // followed by a long opaque run.
  /\b(?:sk|pk|rk|ghp|gho|ghu|ghs|ghr|xox[abps])[-_][A-Za-z0-9_-]{12,}/gi,
  // `Bearer <token>`, `token=<token>`, `api_key: <token>` — the label is the tell.
  /\b(?:bearer|authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|secret)\b\s*[:=]?\s*[A-Za-z0-9._~+/=-]{12,}/gi,
  // A bare JWT.
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g,
];

function redact(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[redacted]");
  return out;
}

/** Collapse whitespace, redact, then bound. Bounding LAST so a truncation can
 *  never cut a secret in half and leave the front of it showing. */
function clean(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const collapsed = redact(value.replace(/\s+/g, " ").trim());
  if (!collapsed) return undefined;
  return collapsed.length > MAX_MESSAGE ? `${collapsed.slice(0, MAX_MESSAGE - 1)}…` : collapsed;
}

/** A plain HTTP status, or nothing. Never a string a provider chose. */
function statusOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value < 600 ? value : undefined;
}

/** A provider slug (`openai`) — safe, and says which connection failed when
 *  several exist. Charset-checked so it cannot smuggle prose into the line. */
function providerOf(value: unknown): string | undefined {
  return typeof value === "string" && /^[\w.-]{1,64}$/.test(value) ? value : undefined;
}

export type OpenCodeFailure = {
  /** The SDK's error name, kept verbatim — it is a closed vocabulary. */
  name: string;
  /** One sanitized sentence, when the SDK gave one. */
  message?: string;
  providerID?: string;
  statusCode?: number;
  /** What the reader should DO. Absent when nothing specific can be said. */
  hint?: string;
};

const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** The one line a human sees: the ACTION, not the mechanism. Reauth is
 *  OpenCode's own — `opencode auth login`; Telar's Providers pane has no
 *  control for it, so pointing there would be a dead end. */
function hintFor(name: string, statusCode: number | undefined, message: string | undefined): string | undefined {
  if (name === "ProviderAuthError") return "Reconnect this provider in OpenCode (opencode auth login).";
  if (name === "MessageOutputLengthError") return "The reply hit the model's output limit. Ask for a shorter answer, or split the task.";
  if (name === "MessageAbortedError") return undefined; // A stop is not a problem to solve.
  if (statusCode === 401 || statusCode === 403) return "Reconnect this provider in OpenCode (opencode auth login).";
  if (statusCode === 429) return "Rate limited. Wait and try again, or switch model.";
  if (statusCode === 404) return "This model is not available on the connection. Pick another in the model picker.";
  if (statusCode !== undefined && statusCode >= 500) return "The provider is failing. Try again shortly.";
  // The status is often absent while the SENTENCE says 401 — the shape of the
  // live failure this was built for.
  if (message && /\b(401|403|unauthor|token refresh failed|invalid[_ ]api[_ ]key|expired)\b/i.test(message)) {
    return "Reconnect this provider in OpenCode (opencode auth login).";
  }
  if (message && /\b(429|rate limit|quota|too many requests)\b/i.test(message)) return "Rate limited. Wait and try again, or switch model.";
  if (message && /\b(model[_ ]not[_ ]found|unknown model|unsupported model|no such model)\b/i.test(message)) {
    return "This model is not available on the connection. Pick another in the model picker.";
  }
  return undefined;
}

/** Read one SDK error into the bounded, allow-listed shape above. */
export function openCodeFailure(error: OpenCodeErrorLike | undefined): OpenCodeFailure | undefined {
  if (!error) return undefined;
  const name = typeof error.name === "string" && NAME.test(error.name) ? error.name : "UnknownError";
  const message = clean(error.data?.message);
  const providerID = providerOf(error.data?.providerID);
  const statusCode = statusOf(error.data?.statusCode);
  const hint = hintFor(name, statusCode, message);
  return {
    name,
    ...(message ? { message } : {}),
    ...(providerID ? { providerID } : {}),
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(hint ? { hint } : {}),
  };
}

/** The sentence the turn fails with. The name stays: it is the SDK's own
 *  vocabulary, and what a bug report is searched by. */
export function openCodeFailureText(failure: OpenCodeFailure): string {
  const head = failure.providerID ? `OpenCode (${failure.providerID})` : "OpenCode";
  const status = failure.statusCode !== undefined ? ` [${failure.statusCode}]` : "";
  const body = failure.message ? `: ${failure.message}` : "";
  const hint = failure.hint ? ` ${failure.hint}` : "";
  return `${head}: ${failure.name}${status}${body}.${hint}`.replace(/\.\./g, ".");
}
