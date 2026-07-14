import { query } from "@anthropic-ai/claude-agent-sdk";
import { accountEnv, type AccountProfile } from "@telar/core";
import os from "os";

const MODEL = "claude-haiku-4-5";
const MESSAGE_TRUNCATE_CODEPOINTS = 500;
const TITLE_MAX_CODEPOINTS = 60;
// Guards the wait for the *first* SDK message: if the subprocess never emits
// anything — e.g. it's stuck on an interactive re-auth prompt for a stale/
// expired token — the `for await` loop below would hang forever. Mirrors the
// init-timeout hygiene in apps/web/app/api/usage/refresh/route.ts.
const INIT_TIMEOUT_MS = 10_000;

// A single layer of wrapping quotes models sometimes add despite being told
// not to. Maps an opening character to the closing character it must be
// paired with (plain quotes are their own pair; curly quotes are not).
const QUOTE_PAIRS: Record<string, string> = {
  '"': '"',
  "'": "'",
  "`": "`",
  "“": "”", // “ ”
  "‘": "’", // ‘ ’
};

// Anchored, case-insensitive prefixes that indicate the model declined to
// produce a title rather than actually producing one.
const REFUSAL_PATTERNS: RegExp[] = [
  /^(i'?m|i am)\s+(sorry|unable|not able)\b/i,
  /^i\s+(can'?t|cannot|can not|won'?t|will not)\b/i,
  /^i\s+(apologi[sz]e|don'?t have (enough|sufficient|access))\b/i,
  /^(sorry|unable to|as an ai)\b/i,
  /^i need more (context|information)\b/i,
];

// Array.from iterates by Unicode code point (not UTF-16 code unit), so this
// never splits a surrogate pair in half the way `str.slice` can.
function truncateCodePoints(text: string, max: number): string {
  const codePoints = Array.from(text);
  return codePoints.length <= max ? text : codePoints.slice(0, max).join("");
}

function stripWrappingQuotes(text: string): string {
  let out = text;
  while (out.length >= 2) {
    const close = QUOTE_PAIRS[out[0]];
    if (!close || out[out.length - 1] !== close) break;
    out = out.slice(1, -1).trim();
  }
  return out;
}

function isRefusalLike(text: string): boolean {
  return REFUSAL_PATTERNS.some((re) => re.test(text));
}

// Pure post-processing for whatever text the model returned. Never throws.
// Strips wrapping quotes and trailing punctuation (in whatever order they're
// nested — re-checked until stable), collapses whitespace, caps length
// code-point-safely, and rejects empty or refusal-looking output.
export function cleanTitle(raw: string | null | undefined): string | null {
  if (!raw) return null;

  // Collapse all whitespace (including newlines) into single spaces first,
  // so everything below only ever deals with a single line.
  let text = raw.replace(/\s+/g, " ").trim();
  if (!text) return null;

  // Repeatedly strip one layer of wrapping quotes and any trailing
  // punctuation until neither rule finds anything left to remove — this
  // handles arbitrary nesting order, e.g. `"Fix bug!".` -> `Fix bug`.
  let prev: string;
  do {
    prev = text;
    text = stripWrappingQuotes(text);
    text = text.replace(/[.,;:!?…]+$/u, "").trim();
  } while (text !== prev);

  if (!text) return null;
  if (isRefusalLike(text)) return null;

  text = truncateCodePoints(text, TITLE_MAX_CODEPOINTS).trim();
  return text || null;
}

// Deterministic, zero-spend title: the opening message's own first words,
// whitespace-collapsed and length-capped. Used for providers with no cheap
// summarization subprocess of their own (Codex today — a ChatGPT-subscription
// account has no per-token billing and spawning a Claude subprocess would
// charge the wrong provider). Never throws; returns null only for an empty
// message.
export function messagePrefixTitle(message: string): string | null {
  const text = message.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return truncateCodePoints(text, TITLE_MAX_CODEPOINTS).trim() || null;
}

function buildPrompt(message: string): string {
  const truncated = truncateCodePoints(message, MESSAGE_TRUNCATE_CODEPOINTS).trim();
  return [
    "Write a short title (3 to 6 words) that summarizes what this conversation is about, based on the opening message below.",
    "Respond with ONLY the title text. No quotes, no markdown, no trailing punctuation, no preamble or explanation.",
    "",
    "Message:",
    truncated,
  ].join("\n");
}

// Generates a short title for a conversation opening with `message`, running
// on `claude-haiku-4-5` under the given account profile. Never throws —
// returns null on any failure (spawn error, timeout, abort, refusal-looking
// or unusable output).
export async function generateTitle(
  message: string,
  profile: AccountProfile,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!message.trim()) return null;

  // Codex has no cheap summarization path of its own, and a ChatGPT-
  // subscription account isn't per-token billed. Spawning a Claude subprocess
  // here would charge the WRONG provider for a Codex session's title, so use
  // the deterministic message-prefix title instead — no subprocess, no spend.
  // The Claude path below is unchanged.
  if ((profile.provider ?? "claude") === "codex") {
    return messagePrefixTitle(message);
  }

  const abort = new AbortController();
  const forwardAbort = () => abort.abort();
  if (signal) {
    if (signal.aborted) abort.abort();
    else signal.addEventListener("abort", forwardAbort);
  }
  const initTimeout = setTimeout(() => abort.abort(), INIT_TIMEOUT_MS);

  try {
    const q = query({
      prompt: buildPrompt(message),
      options: {
        model: MODEL,
        maxTurns: 1,
        allowedTools: [],
        cwd: os.tmpdir(),
        env: accountEnv(profile),
        abortController: abort,
      },
    });

    let raw: string | null = null;
    let sawMessage = false;
    for await (const msg of q) {
      if (!sawMessage) {
        sawMessage = true;
        clearTimeout(initTimeout);
      }
      if (msg.type === "result") {
        if (msg.subtype === "success") raw = msg.result;
        break;
      }
    }
    return cleanTitle(raw);
  } catch {
    return null;
  } finally {
    // Belt-and-suspenders: a throw, timeout, or early break above must never
    // leave a zombie subprocess behind. abort() is idempotent.
    clearTimeout(initTimeout);
    abort.abort();
    if (signal) signal.removeEventListener("abort", forwardAbort);
  }
}
