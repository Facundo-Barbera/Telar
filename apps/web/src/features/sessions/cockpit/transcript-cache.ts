import type { HydratedSession } from "@/platform/engine";

/** What a switch needs in hand to paint: the same rows `hydrate` commits. */
export type CachedTranscript = HydratedSession;

export const TRANSCRIPT_CACHE_LIMIT = 16;

/** One conversation, on one Mac. See the note above on why the id alone is not
 *  an identity. */
export function transcriptKey(host: string, sessionId: string): string {
  return JSON.stringify([host, sessionId]);
}

const held = new Map<string, CachedTranscript>();

/** Keep this transcript, evicting the least recently used beyond the limit. */
export function rememberTranscript(key: string, transcript: CachedTranscript): void {
  held.delete(key);
  held.set(key, transcript);
  // One at a time: the map can only have grown by one, and a loop here would be
  // a way for a future off-by-one to silently empty the cache.
  if (held.size > TRANSCRIPT_CACHE_LIMIT) held.delete(held.keys().next().value!);
}

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
