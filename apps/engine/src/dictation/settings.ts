/**
 * WHICH PROVIDER THIS MAC DICTATES WITH — one field, beside the key (#544).
 *
 * ── ITS OWN DOCUMENT, NOT THE KEY'S FILE ────────────────────────────────────
 * `credentials.json` is 0600 and write-only: it is read by exactly one caller
 * and never echoed. This one is the opposite — it is READ by every client that
 * opens the composer, because it decides whether there is a mic button at all.
 * Two rules, two files, and the one with the secret in it keeps having exactly
 * one author.
 *
 * ── OFF IS THE DEFAULT AND AN ABSENT FILE MEANS OFF ─────────────────────────
 * Which makes the upgrade honest: a Mac that has this engine for the first
 * time, and a Mac that had the previous build with a key already pasted, both
 * come up with no mic button until somebody asks for one. A key that was pasted
 * before is kept and simply not spent — see `dictationState`, where `configured`
 * is still answered for `off` so the pane can say a key is there.
 *
 * NEVER THROWS ON READ. An absent, unreadable or malformed file is `off`, which
 * is the safe answer in both directions: nothing starts recording because a
 * JSON file got truncated.
 */
import fs from "node:fs";
import path from "node:path";
import { atomicWrite } from "../atomic";
import { isDictationProviderId, type DictationProviderId } from "./provider";

/** `<engineRoot>/dictation/settings.json`. */
export function dictationSettingsFile(dictationDir: string): string {
  return path.join(dictationDir, "settings.json");
}

export function readDictationProvider(dictationDir: string): DictationProviderId {
  try {
    const stored = JSON.parse(fs.readFileSync(dictationSettingsFile(dictationDir), "utf8")) as { provider?: unknown };
    return isDictationProviderId(stored.provider) ? stored.provider : "off";
  } catch {
    return "off";
  }
}

export function writeDictationProvider(dictationDir: string, provider: DictationProviderId): void {
  atomicWrite(dictationSettingsFile(dictationDir), { provider }, 0o600);
}
