// WHAT A COMPACTION LEAVES BEHIND (issue #25).
//
// A compaction used to be a pure STATE TOGGLE: `compacting` on, `compacting`
// off, nothing recorded. Both surfaces that describe what the model is holding
// — the transcript and the context wheel — went on reading as if the history
// behind them had never been replaced by a summary. This module is the small
// shared vocabulary that fixes that on BOTH sides of the wire: the chat route
// collects these facts while a compaction streams, the store persists them
// beside the transcript, and the session view folds the same records into the
// same divider.
//
// THE DIVIDER IS PERSISTED, AND THAT IS THE DECISION. A marker that vanishes on
// refresh is worse than none — the transcript would then disagree with itself
// between sessions, which is exactly the confusion the marker exists to prevent
// ("was that summarized, or am I looking at a different conversation?"). So a
// compaction is written to chats.json (store.ts `Chat.compactions`) as a fact
// ABOUT the transcript rather than an entry IN it: no role, no author, no
// parts. A compaction is still not a turn, and the store's message list is
// still exactly the turns.
//
// PURE DATA + PURE FUNCTIONS. This file is reachable from a client component
// (session-view.tsx) and from server-only modules (store.ts, the chat route) at
// the same time, so it holds nothing either side cannot have: no @telar/core,
// no node:*, no React (AD-3, and INV-4c enforces the client half).

import { fmtTokens } from "./format";

/** Who asked. "manual" is a Compact press (this app's own `compact: true`);
 *  "auto" is the harness compacting an ordinary turn on its own to stay under
 *  its context window — the case that is completely invisible without a
 *  marker, because nothing the user did produced it. Same enumeration as
 *  HarnessEvent's compact_start/compact_end in packages/core. */
export type CompactionTrigger = "manual" | "auto";

/** Everything a harness tells us about ONE compaction. Every token field is
 *  optional because CODEX REPORTS NONE OF THEM: its `compact_end` carries a
 *  null summary and no counts at all (see runCodexCompact in
 *  lib/codex-app-server.ts), so a Codex divider is legitimately bare. Absent
 *  means "not reported", never zero — see `compactionMarkerText`, which omits
 *  what it was not told rather than printing a number nobody measured. */
export type CompactionFacts = {
  at: number;
  trigger: CompactionTrigger;
  preTokens?: number;
  postTokens?: number;
  durationMs?: number;
};

/** A compaction as the STORE holds it, anchored by HOW MANY MESSAGES stood
 *  above the line when it was drawn. An index, not a message id: the store's
 *  messages have no ids of their own, and the transcript is append-only, so a
 *  count is a stable address for "between message n-1 and message n".
 *
 *  `remeasured` records the one thing the anchor CANNOT express: a compaction
 *  that happened MID-TURN is written with the same `afterMessages` as one that
 *  happened after the turn, because both are stamped once the turn has landed.
 *  Only the first of those had its context re-measured by that turn, and only
 *  the second leaves the persisted `contextTokens` describing a context that no
 *  longer exists — see `seedCompactedContext`. Absent on records written before
 *  the flag existed, which the anchor comparison still covers. */
export type CompactionRecord = CompactionFacts & {
  afterMessages: number;
  remeasured?: boolean;
};

/** A compaction as the CLIENT holds it. `key` identifies the compaction across
 *  the two or three SSE events that describe it (and doubles as the marker's
 *  React key); `afterMessageId` is the same anchor as `afterMessages` in the
 *  live transcript's own vocabulary, with null meaning "above everything". */
export type TranscriptCompaction = CompactionFacts & {
  key: string;
  afterMessageId: string | null;
};

/** The wheel's post-compaction reading: a number the harness reported, the
 *  honest "unknown" when it reported none, or null for "no compaction has
 *  invalidated the last measurement". */
export type CompactedContext = number | "unknown" | null;

const definedOnly = <T extends object>(value: T): Partial<T> =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;

/**
 * ONE COMPACTION, TWO OR THREE EVENTS. Claude describes a single compaction
 * through its PreCompact hook ("compacting"), its PostCompact hook
 * ("compacted", which knows the trigger and the summary but no counts) and the
 * SDK's own `compact_boundary` system message (which knows the counts but is
 * not a hook). Nothing on that wire carries a shared id, so the key is minted
 * locally when the compaction OPENS and reused for everything that describes
 * it — `foldCompactionEvent` below is that rule, and both the route and the
 * session view run it, which is why one compaction yields exactly one record on
 * each side.
 *
 * Merging keeps what it already knew: a later event that omits a field never
 * erases one an earlier event supplied.
 */
export function upsertCompaction<T extends { key: string }>(
  list: readonly T[],
  next: T,
): T[] {
  const at = list.findIndex((entry) => entry.key === next.key);
  if (at < 0) return [...list, next];
  return list.map((entry, i) => (i === at ? { ...entry, ...definedOnly(next) } : entry));
}

/** The three SSE events that describe a compaction. Provider-neutral by the
 *  time they reach here: Codex's compact_start/compact_end are sent as
 *  "compacting"/"compacted", Claude adds "compact_boundary" for the counts. */
export type CompactionEventName = "compacting" | "compacted" | "compact_boundary";

/** Where a stream is in the "which events belong to which compaction" rule.
 *  `seen` is what the OPEN compaction has already been told, which is the only
 *  thing that decides whether the next event continues it or starts a new one
 *  (see `foldCompactionEvent`). */
export type CompactionFoldState<T extends { key: string }> = {
  seq: number;
  open: { key: string; seen: readonly CompactionEventName[] } | null;
  entries: T[];
};

export function emptyCompactionFold<T extends { key: string }>(): CompactionFoldState<T> {
  return { seq: 0, open: null, entries: [] };
}

/**
 * THE WHOLE COMPACTION STATE MACHINE, IN ONE PLACE. The route folds the events
 * it sends; the session view folds the events it receives; SSE preserves order,
 * so the two lists are the same list. That identity is the point — it is what
 * stops a reload from disagreeing with the live transcript about how many
 * dividers there are, and it was NOT achievable while each side hand-wrote its
 * own open/close lifecycle.
 *
 * THE RULE IS "AN EVENT CANNOT HAPPEN TWICE IN ONE COMPACTION", not "this event
 * closes it". A close rule has to know how many events are still coming, and
 * nothing here does:
 *   - Claude sends "compacted" (PostCompact) and "compact_boundary" in an order
 *     this codebase has never actually traced — route.ts's own note says the
 *     boundary arrives slightly later, the session view's said the opposite —
 *     so ANY rule that closes on one of them splits or merges under the other
 *     ordering. Under this rule both merge, in either order.
 *   - Codex's own auto-compaction is "compacted" ALONE
 *     (normalizeCodexAutoCompact: no start to pair with), so two of them in one
 *     stream must be two compactions. A second "compacted" is a repeat, so it
 *     opens a new one.
 * "compacting" always opens, because a start is a start.
 *
 * "compacting" records nothing: a divider that reads "Compacted" must not
 * appear while the compaction is still running. It only mints the key that the
 * events which DO record will merge into.
 */
export function foldCompactionEvent<T extends CompactionFacts & { key: string }>(
  state: CompactionFoldState<T>,
  event: CompactionEventName,
  facts: Omit<T, "key">,
): CompactionFoldState<T> {
  // `facts` is T minus the one field this function supplies; TS cannot see that
  // putting it back reconstitutes T.
  const record = (key: string): T[] =>
    event === "compacting"
      ? state.entries
      : upsertCompaction(state.entries, { ...facts, key } as T);
  const open = state.open;
  if (!open || event === "compacting" || open.seen.includes(event)) {
    const seq = state.seq + 1;
    const key = `c${seq}`;
    return { seq, open: { key, seen: [event] }, entries: record(key) };
  }
  return {
    seq: state.seq,
    open: { key: open.key, seen: [...open.seen, event] },
    entries: record(open.key),
  };
}

/** Whether a TranscriptCompaction key was minted by the live fold (`c${seq}`)
 *  rather than seeded from the store (`stored-${i}` — see
 *  seedTranscriptCompactions). The session view needs the distinction when a
 *  cursor-less replay restarts from line zero: the replay re-folds the same
 *  events and re-mints the same keys, so the PREVIOUS round's fold-minted
 *  entries must be dropped first — keeping both is exactly the duplicate
 *  divider. Seeded entries describe completed turns the replay never carries,
 *  so they stand. Lives here, beside the mint, so the shape cannot drift. */
export const isFoldMintedKey = (key: string): boolean => /^c\d+$/.test(key);

/** The record the event just folded belongs to, counts and all — the merge of
 *  everything this compaction has said so far. Undefined only before any event
 *  has recorded anything (i.e. after "compacting" alone). */
export function currentCompaction<T extends { key: string }>(
  state: CompactionFoldState<T>,
): T | undefined {
  return state.entries.find((entry) => entry.key === state.open?.key);
}

/** A folded entry, narrowed to what is worth PERSISTING. The key is a handle
 *  for one stream's events, not a fact about the session — it means nothing to
 *  the next reader and must not reach chats.json. (Undefined fields drop out at
 *  JSON.stringify, so an unreported count is still an absent one.) */
export function compactionFacts(entry: CompactionFacts): CompactionFacts {
  const { at, trigger, preTokens, postTokens, durationMs } = entry;
  return { at, trigger, preTokens, postTokens, durationMs };
}

const terseTokens = (n: number): string => fmtTokens(n).replace(/\.0(?=[kM]$)/, "");

/**
 * The divider's copy. STATE, NEVER PROSE — marker.tsx's rule, and the reason
 * the `summary` Claude's PostCompact hook carries is deliberately NOT rendered
 * here and not persisted: a summary is prose addressed to the model, and a
 * marker is a terse clause of machine facts. The trigger is always spelled out
 * rather than left implicit, because "the harness did this to itself" and "you
 * pressed Compact" are the two readings a reader most needs told apart.
 */
export function compactionMarkerText(facts: CompactionFacts): string {
  const clauses = [facts.trigger === "auto" ? "automatic" : "manual"];
  const { preTokens, postTokens, durationMs } = facts;
  // Either count on its own is still information, and the arrow says which one
  // it is. "?" is the missing side spelled out rather than a blank that reads
  // as a number nobody noticed was absent — the same honesty the wheel's "—"
  // is for. Both absent (every Codex compaction) prints no clause at all.
  if (preTokens !== undefined || postTokens !== undefined) {
    clauses.push(
      `${preTokens === undefined ? "?" : terseTokens(preTokens)} → ${
        postTokens === undefined ? "?" : terseTokens(postTokens)
      }`,
    );
  }
  if (durationMs !== undefined && durationMs > 0) {
    clauses.push(`${(durationMs / 1000).toFixed(1)}s`);
  }
  return ["Compacted", ...clauses].join(" · ");
}

/**
 * Persisted records → the live shape, at seed time. `messageIds` is the seeded
 * transcript's own ids in order, so this function never has to know how the
 * session view spells them.
 *
 * A record anchored past the end of the transcript (impossible today — the
 * transcript is append-only and a record is written after the turn it belongs
 * to) pins to the last message rather than being dropped: losing a boundary is
 * the one failure this whole feature exists to prevent.
 */
export function seedTranscriptCompactions(
  records: readonly CompactionRecord[] | undefined,
  messageIds: readonly string[],
): TranscriptCompaction[] {
  return (records ?? []).map(({ afterMessages, ...facts }, i) => ({
    ...facts,
    key: `stored-${i}`,
    afterMessageId:
      afterMessages <= 0 ? null : messageIds[Math.min(afterMessages, messageIds.length) - 1] ?? null,
  }));
}

/**
 * THE WHEEL, AFTER A RELOAD. `Chat.contextTokens`/`contextUsage` are written by
 * a TURN, so a session that was compacted and then closed CAN reload with the
 * pre-compaction number — the same staleness the live fix removes, arriving by
 * a different door. This seeds the override for exactly that case: the
 * harness's own post-compaction count when it gave one, "unknown" when it did
 * not.
 *
 * IT MUST STAND DOWN WHENEVER SOMETHING NEWER MEASURED, or it installs a
 * staleness of its own — and the anchor alone cannot tell. A compaction that
 * happened MID-TURN is stamped after that turn lands, so its `afterMessages`
 * equals the message count exactly as a compact-only request's does; but that
 * turn went on to re-measure below it, and its `contextTokens` is both newer
 * and true. Deciding on the anchor alone would hand the wheel the boundary's
 * count forever (and "unknown" for a Codex session whose persisted snapshot is
 * perfectly good), which is worse than the bug this exists to fix. `remeasured`
 * is the route's own answer to "did a turn land after this?" — see
 * recordCompactions.
 */
export function seedCompactedContext(
  records: readonly CompactionRecord[] | undefined,
  messageCount: number,
): CompactedContext {
  const last = records?.[records.length - 1];
  if (!last || last.remeasured || last.afterMessages < messageCount) return null;
  return last.postTokens ?? "unknown";
}
