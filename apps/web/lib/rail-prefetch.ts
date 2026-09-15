/**
 * WHICH ROWS THE RAIL IS ALLOWED TO OPEN AHEAD OF YOU (#497).
 *
 * Opening a conversation cost three serial round trips: the rail's links were
 * `prefetch={false}`, so the route's chunks were fetched on the click; the page
 * is `force-dynamic`, so nothing of it existed before that; and `/bootstrap`
 * then queued behind the reads the cockpit makes on mount. None of those three
 * waits is doing any work you asked for — they are all the app finding out what
 * you already told it by pointing at a row.
 *
 * SO THE RAIL WARMS ROWS, AND THIS MODULE SAYS HOW MANY. Two signals, both
 * t3 code's: rows near the viewport (an IntersectionObserver with a 160 px
 * margin, so a row warms just before it is scrollable-to) and rows you are
 * actually pointing at (hover or focus, after a 150 ms pause — below that a
 * pointer crossing the rail on its way somewhere else would warm every row it
 * swept over).
 *
 * THE CAP IS THREE — the row you are reading plus at most two preloaded — and
 * it is t3's own number, chosen because a prefetch is a MULTIPLIER on two
 * things at once. On HEAP: every warmed row holds a route payload and a
 * windowed transcript in memory, so an uncapped rail of forty rows retains
 * forty transcripts nobody opened. On SERVER LOAD: each warm is a real
 * `/bootstrap` against the engine, so the same uncapped rail turns one person
 * scrolling their list into forty reads the engine has to answer — and the
 * engine is a laptop. Three keeps both multipliers at one-ish while still
 * covering the switch anybody actually makes: the row above and the row below
 * where you are.
 *
 * THE ACTIVE ROW IS PINNED AND NEVER EVICTED. It is the conversation on screen;
 * a cap that could evict it would be spending its budget on the one row whose
 * data is already in hand.
 */
import { createEngineApi } from "@/lib/engine/client";
import { sessionConnection } from "@/lib/engine/session-connection";
import { INITIAL_TURNS } from "@/lib/engine/session-sync";
import { hostFetcher, LOCAL_HOST_ID } from "@/lib/hosts/client";
import { LOCAL_HOST } from "@/lib/snapshot-cache";

/** The row you are reading, plus at most two more. See the note above for why
 *  this is a heap and server-load multiplier rather than a style preference. */
export const PREFETCH_CAP = 3;

/** How long a pointer must rest on a row before it counts as intent. */
export const PREFETCH_INTENT_MS = 150;

/** How far outside the rail's viewport a row still counts as near — t3's
 *  figure, and about one card's height, so a row warms as it becomes the next
 *  thing you could scroll to rather than once it has arrived. */
export const PREFETCH_MARGIN = "160px";

/**
 * The warmed rows, least recently claimed first — insertion order IS the
 * recency list, the same trick `lib/transcript-cache.ts` uses. The value says
 * whether the entry is the ACTIVE row, which is the only thing eviction has to
 * treat differently.
 */
const warmed = new Map<string, { active: boolean }>();

/**
 * Ask for one of the three slots.
 *
 * `intent` is the difference between "this row is near the viewport" and "you
 * are pointing at it", and it is the only claim allowed to EVICT: a full cap
 * must not stop the rail warming the row somebody is about to press, and it
 * must stop the rail warming the twentieth row that happens to be on screen.
 * Answers whether the row now holds a slot — a row told `false` simply stays
 * cold, because a refusal here is the cap working rather than a failure.
 */
export function claimPrefetch(key: string, options: { active?: boolean; intent?: boolean } = {}): boolean {
  const active = options.active ?? false;
  const held = warmed.get(key);
  if (held) {
    // Already warm: refresh its recency, and let a row that has since become
    // the active one take the pin.
    warmed.delete(key);
    warmed.set(key, { active: held.active || active });
    return true;
  }
  if (warmed.size >= PREFETCH_CAP) {
    // THE ACTIVE ROW ALWAYS FITS. It is the conversation on screen, and the cap
    // exists to bound speculative work — which this is not.
    if (!active && !options.intent) return false;
    const evictable = [...warmed].find(([, entry]) => !entry.active);
    // Three active rows cannot happen (one address, one active row), so this is
    // an impossible state rather than a case to handle: refuse rather than
    // evict the row being read.
    if (!evictable && !active) return false;
    if (evictable) warmed.delete(evictable[0]);
  }
  warmed.set(key, { active });
  return true;
}

/** This row is gone — scrolled away, or unmounted. Frees its slot for whatever
 *  scrolled in behind it. Idempotent. */
export function releasePrefetch(key: string): void {
  warmed.delete(key);
}

/** Tests: which rows hold a slot, least recently claimed first. */
export function warmedRows(): string[] {
  return [...warmed.keys()];
}

/** Tests: the rail is a singleton, so a suite has to be able to empty it. */
export function resetPrefetch(): void {
  warmed.clear();
}

/**
 * Pay this conversation's `/bootstrap` NOW, so the cockpit's first read is
 * already in hand when it mounts.
 *
 * THROUGH `sessionConnection`, NOT A BARE FETCH, and that is the whole reason
 * this works: the cockpit reads the same connection under the same key, so a
 * warm that is still in flight when the click lands is JOINED rather than
 * raced (`read()` returns the in-flight promise), and one that finished is
 * answered from memory with a cheap tail behind it. A second copy of this read
 * would double the engine's work and win nothing.
 *
 * THE WINDOW MUST MATCH THE COCKPIT'S. `sessionConnection` keys on it, so
 * warming a different window would fill a cache entry nothing ever reads.
 */
export function warmConversation(hostId: string | undefined, sessionId: string): void {
  /**
   * A ROW CARRIES NO `hostId` WHEN IT IS LOCAL; the cockpit reaches the same
   * connection through `hostFromPathname`, which answers `LOCAL_HOST_ID` rather
   * than nothing. So the two must stand for the same string, and they do —
   * `lib/hosts/book.ts` and `lib/snapshot-cache.ts` both spell it `"local"`.
   * If they ever diverged this would warm a cache entry the cockpit never
   * reads, silently, so the suite pins the two together.
   */
  void sessionConnection(hostId ?? LOCAL_HOST, createEngineApi(hostFetcher(hostId ?? LOCAL_HOST_ID)), sessionId, { turns: INITIAL_TURNS })
    .read()
    // A WARM THAT FAILS IS NOT AN ERROR ANYBODY ASKED FOR. Nobody pressed this
    // row; if the engine is away, the click will say so in the place a person
    // is looking. Swallowing it here is what keeps a scroll past a dead remote
    // host from painting the rail with failures.
    .catch(() => undefined);
}
