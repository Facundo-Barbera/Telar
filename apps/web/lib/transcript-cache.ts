/**
 * THE LAST SIXTEEN TRANSCRIPTS THIS TAB RENDERED, SO SWITCHING BACK NEVER
 * FLASHES WHITE (#497, and t3 code's own rule).
 *
 * WHAT THE FLASH ACTUALLY WAS. The cockpit does not remount between
 * conversations — it holds the previous session's rows until the new one's read
 * lands — so `readKey !== syncKey` is what marks the gap, and for the length of
 * one round trip the screen shows a transcript that is not the one you asked
 * for, or nothing. Going BACK to a conversation you read a moment ago paid that
 * gap again in full, for rows this tab had already folded and thrown away.
 *
 * THIS IS NOT THE SNAPSHOT CACHE, and the two answer different questions.
 * `lib/snapshot-cache.ts` is IndexedDB: it survives the tab, it is read
 * asynchronously (so it cannot paint in the commit that switches), and what it
 * holds may be days old — which is why a restore from it dates the screen with
 * a "last true at" banner. This is sixteen entries of plain memory, read
 * SYNCHRONOUSLY during the render that changes conversation, holding rows that
 * were live in this tab seconds ago with a hydrate already in flight behind
 * them. Nothing here is ever stale enough to date.
 *
 * WHY SIXTEEN. t3's number, and it is a working-set figure rather than a
 * capacity one: a person switching between conversations is moving among a
 * handful, and sixteen covers that with room to spare while bounding what a
 * rail left open all day can retain. Each entry is a WINDOWED transcript (ten
 * turns — see `INITIAL_TURNS`), not a whole session, so the ceiling is tens of
 * megabytes at the very worst and a small fraction of that in practice.
 *
 * KEYED BY THE SESSION ID, QUALIFIED BY THE MAC THAT MINTED IT. Ids are minted
 * per engine, so two paired Macs can hold the same one — and a cache that
 * answered one Mac's id with another's transcript would paint the wrong
 * conversation, which is a worse failure than the flash this removes. It is the
 * same composite every other per-session store in this cockpit keys on (see
 * `snapshotKey`, and the cockpit's own `syncKey`).
 */
import type { HydratedSession } from "@/lib/engine/session-sync";

/** What a switch needs in hand to paint: the same rows `hydrate` commits. */
export type CachedTranscript = HydratedSession;

export const TRANSCRIPT_CACHE_LIMIT = 16;

/** One conversation, on one Mac. See the note above on why the id alone is not
 *  an identity. */
export function transcriptKey(host: string, sessionId: string): string {
  return JSON.stringify([host, sessionId]);
}

/**
 * MODULE SCOPE, DELIBERATELY. The point is to outlive the cockpit's own state
 * across a switch, and anything held in a component or a context dies with the
 * thing it is meant to survive. A `Map` is already insertion-ordered, so
 * delete-then-set IS the recency list and no second structure is needed.
 */
const held = new Map<string, CachedTranscript>();

/** Keep this transcript, evicting the least recently used beyond the limit. */
export function rememberTranscript(key: string, transcript: CachedTranscript): void {
  held.delete(key);
  held.set(key, transcript);
  // One at a time: the map can only have grown by one, and a loop here would be
  // a way for a future off-by-one to silently empty the cache.
  if (held.size > TRANSCRIPT_CACHE_LIMIT) held.delete(held.keys().next().value!);
}

/** What this tab last rendered for that conversation, if it still holds it.
 *  READING COUNTS AS USE — a conversation you keep coming back to must not age
 *  out behind fifteen you opened once. */
export function recallTranscript(key: string): CachedTranscript | undefined {
  const transcript = held.get(key);
  if (!transcript) return undefined;
  held.delete(key);
  held.set(key, transcript);
  return transcript;
}

/** Tests, and nothing else: the cache has no invalidation because it has no
 *  authority — every entry is replaced by the read that lands behind it. */
export function clearTranscriptCache(): void {
  held.clear();
}

/** Tests: which conversations are held, least recently used first. */
export function heldTranscripts(): string[] {
  return [...held.keys()];
}
