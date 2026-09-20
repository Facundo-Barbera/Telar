/**
 * THE DICTATION KEY — one file, 0600, written and never read back out (#544).
 *
 * ── WHY IT IS NOT THE AGENT'S FILE ──────────────────────────────────────────
 * `agent/credentials.ts` holds an OpenCode Go key and has a three-rung ladder
 * under it: the pasted key, `OPENCODE_API_KEY`, then the OpenCode CLI's own
 * sign-in. None of those rungs is a Deepgram key. Sharing the file would mean
 * one `{ key }` field standing for two different accounts at two different
 * vendors, and the first person to paste a Deepgram key into the Agent's row
 * would switch their Agent off without being told why.
 *
 * So dictation gets `<engineRoot>/dictation/credentials.json`, the same shape
 * and the same mode, and exactly one rung. There is no environment fallback
 * on purpose: a Deepgram key in the engine's environment is not something
 * anybody has already exported for another tool, so a rung for it would be a
 * place for a key to come from that nobody could find when it surprised them.
 *
 * ── THE RULES, WHICH ARE THE AGENT'S ────────────────────────────────────────
 * NEVER ECHOED, not even redacted, not even its length. The only thing a
 * client is told is whether one is CONFIGURED — there is no round trip to
 * preserve, because the only field is one a person retypes.
 *
 * NEVER LOGGED. The key leaves this module towards one `Authorization` header
 * on `POST https://api.deepgram.com/v1/auth/grant` and nowhere else; what
 * reaches a browser is the short-lived token that call answers with.
 *
 * NEVER THROWS ON READ. An absent, unreadable or malformed file simply means
 * no key is configured, which is a state the token route has a sentence for.
 */
import fs from "node:fs";
import path from "node:path";
import { atomicWrite } from "../atomic";

/** `<engineRoot>/dictation/credentials.json`. Its own file rather than a field
 *  on a settings document, for `agentKeyFile`'s reason: the settings document
 *  is handed to every client that opens the pane, and a key stored on it would
 *  be one redaction away from being echoed back to a browser. */
export function dictationKeyFile(dictationDir: string): string {
  return path.join(dictationDir, "credentials.json");
}

/** The stored key, or nothing. Spent at call time; never copied, never cached
 *  — a cache is a copy with a nicer name. */
export function readDictationKey(dictationDir: string): string | undefined {
  try {
    const stored = JSON.parse(fs.readFileSync(dictationKeyFile(dictationDir), "utf8")) as { key?: unknown };
    const key = typeof stored.key === "string" ? stored.key.trim() : "";
    return key ? key : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Store a key, or clear it.
 *
 * AN EMPTY STRING CLEARS, which is what a person emptying the field means; the
 * file is left in place holding nothing rather than deleted, so its mode and
 * its existence are one less thing to re-derive.
 *
 * 0600 IS PASSED EXPLICITLY even though it is `atomicWrite`'s default, because
 * this is the one file in `dictation/` where the mode is the point.
 */
export function writeDictationKey(dictationDir: string, key: string | undefined): void {
  const trimmed = key?.trim();
  atomicWrite(dictationKeyFile(dictationDir), trimmed ? { key: trimmed } : {}, 0o600);
}

/** What a client is allowed to know about the key: whether there is one. */
export function dictationCredential(dictationDir: string): { configured: boolean } {
  return { configured: readDictationKey(dictationDir) !== undefined };
}
