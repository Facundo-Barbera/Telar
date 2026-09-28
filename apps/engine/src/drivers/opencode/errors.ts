export type OpenCodeErrorLike = {
  name?: unknown;
  data?: { message?: unknown; providerID?: unknown; statusCode?: unknown; [key: string]: unknown };
};

const MAX_MESSAGE = 300;

const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|pk|rk|ghp|gho|ghu|ghs|ghr|xox[abps])[-_][A-Za-z0-9_-]{12,}/gi,
  /\b(?:bearer|authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|secret)\b\s*[:=]?\s*[A-Za-z0-9._~+/=-]{12,}/gi,
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g,
];

function redact(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[redacted]");
  return out;
}

function clean(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const collapsed = redact(value.replace(/\s+/g, " ").trim());
  if (!collapsed) return undefined;
  return collapsed.length > MAX_MESSAGE ? `${collapsed.slice(0, MAX_MESSAGE - 1)}…` : collapsed;
}

function statusOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value < 600 ? value : undefined;
}

function providerOf(value: unknown): string | undefined {
  return typeof value === "string" && /^[\w.-]{1,64}$/.test(value) ? value : undefined;
}

export type OpenCodeFailure = {
  name: string;
  message?: string;
  providerID?: string;
  statusCode?: number;
  hint?: string;
};

const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function hintFor(name: string, statusCode: number | undefined, message: string | undefined): string | undefined {
  if (name === "ProviderAuthError") return "Reconnect this provider in OpenCode (opencode auth login).";
  if (name === "MessageOutputLengthError") return "The reply hit the model's output limit. Ask for a shorter answer, or split the task.";
  if (name === "MessageAbortedError") return undefined; // A stop is not a problem to solve.
  if (statusCode === 401 || statusCode === 403) return "Reconnect this provider in OpenCode (opencode auth login).";
  if (statusCode === 429) return "Rate limited. Wait and try again, or switch model.";
  if (statusCode === 404) return "This model is not available on the connection. Pick another in the model picker.";
  if (statusCode !== undefined && statusCode >= 500) return "The provider is failing. Try again shortly.";
  if (message && /\b(401|403|unauthor|token refresh failed|invalid[_ ]api[_ ]key|expired)\b/i.test(message)) {
    return "Reconnect this provider in OpenCode (opencode auth login).";
  }
  if (message && /\b(429|rate limit|quota|too many requests)\b/i.test(message)) return "Rate limited. Wait and try again, or switch model.";
  if (message && /\b(model[_ ]not[_ ]found|unknown model|unsupported model|no such model)\b/i.test(message)) {
    return "This model is not available on the connection. Pick another in the model picker.";
  }
  return undefined;
}

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

export function openCodeFailureText(failure: OpenCodeFailure): string {
  const head = failure.providerID ? `OpenCode (${failure.providerID})` : "OpenCode";
  const status = failure.statusCode !== undefined ? ` [${failure.statusCode}]` : "";
  const body = failure.message ? `: ${failure.message}` : "";
  const hint = failure.hint ? ` ${failure.hint}` : "";
  return `${head}: ${failure.name}${status}${body}.${hint}`.replace(/\.\./g, ".");
}
