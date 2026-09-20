/**
 * THE SHELF THE COMPOSER DRAWS — two stores, one list, and the seam in ONE file.
 *
 * There are two places an unsent prompt can be sitting, for reasons that are
 * real rather than historical:
 *
 *   · `prompt-stash.ts` — the ⌘S queue, in `localStorage`. Carries IMAGES, as
 *     data URLs, which is why it is where it is: a screenshot pasted into a
 *     composer has no file on disk to point at, and several megabytes of base64
 *     do not belong in an engine JSON file.
 *   · the engine's PROMPT SHELF (`PreparedPrompt`) — named, unsent prompts an
 *     AGENT can write, from a worker process that has no `localStorage` and no
 *     way into this one. That is the whole reason it exists; see the protocol's
 *     docblock.
 *
 * Whether the first eventually moves onto the second is an open question that
 * is not this file's to answer. What this file guarantees is that the answer
 * stays CHEAP: the composer never learns there are two sources, every row it
 * draws is a `ShelfRow`, and a merge that became a single source would delete
 * one arm of `mergeShelf` and change nothing else.
 *
 * ── WHOSE HAND, AND WHY IT ORDERS THE LIST ──────────────────────────────────
 * An agent's draft and your own set-aside paragraph carry different authority:
 * one is a sentence you wrote, handed back; the other is a PROPOSAL you have
 * not read yet. So they are not interleaved by timestamp — the agent's band
 * sits first, whole, and the cockpit heads it as its own. An undifferentiated
 * list is the failure mode #87 named, and interleaving is that list with
 * different colours on it.
 *
 * NO REACT, NO DOM, NO CLOCK in this file, the rule `prompt-stash.ts` keeps for
 * the same reason: `bun test` reaches all of it. The wiring is in
 * `use-prompt-shelf.ts`.
 */

import type { PreparedPrompt } from "@telar/engine-client";
import { entrySummary, type StashedImage, type StashEntry } from "./prompt-stash";

/** Where a row came from. The composer reads this only to route a pick or a
 *  drop back to the right store — never to decide how a row looks. */
export type ShelfSource = "stash" | "engine";

/**
 * One row, whichever store it came from.
 *
 * DELIBERATELY NOT a union of the two shapes. A menu that had to narrow before
 * it could read a title is a menu that grows a second rendering path, which is
 * how the two bands drift apart into two lists that do not match.
 */
export type ShelfRow = {
  /** Unique across BOTH stores — the two mint ids independently and a React key
   *  that collided would swap two rows' identities on a re-sort. */
  key: string;
  source: ShelfSource;
  /** The id as its own store knows it. */
  id: string;
  /** "you" is the person's; "session" is an agent's. The cockpit bands on this
   *  and nothing else. */
  author: "you" | "session";
  /** The one line the row shows. */
  title: string;
  /** An agent's line on WHY it is offering this. Never the person's own rows:
   *  a prompt you stashed needs no explanation to you. */
  reason?: string;
  /** The message itself. Absent for a stash row, whose text is fetched through
   *  `take` so the pop stays atomic against the other window. */
  text?: string;
  images: StashedImage[];
  /** When it was put here. Orders within a band, never across them. */
  at: number;
};

/** Newest first within a band. */
function byNewest(left: ShelfRow, right: ShelfRow): number {
  return right.at - left.at || left.key.localeCompare(right.key);
}

/**
 * The ⌘S queue as rows. A stash entry has no NAME — it was set aside with a
 * keystroke, not titled — so its first line stands in for one, which is what
 * `entrySummary` already computes for the menu.
 */
export function stashRows(entries: readonly StashEntry[]): ShelfRow[] {
  return entries
    .map((entry) => ({
      key: `stash:${entry.id}`,
      source: "stash" as const,
      id: entry.id,
      // A ⌘S row is always the person's: the key is theirs to press, and
      // nothing else writes to that store.
      author: "you" as const,
      title: entrySummary(entry),
      images: entry.images,
      at: entry.at,
    }))
    .sort(byNewest);
}

/**
 * The engine's shelf as rows, filtered to the ones this composer should offer.
 *
 * THE SESSION FILTER IS REPEATED HERE rather than trusted from the route, and
 * the duplication is deliberate: the engine answers the whole project's shelf
 * because the rail wants the count, so a composer that did not filter would
 * offer you another conversation's follow-up. The engine's
 * `promptsForComposer` states the same rule for the tool wall.
 */
export function engineRows(prompts: readonly PreparedPrompt[], sessionId: string | undefined): ShelfRow[] {
  return prompts
    .filter((prompt) => prompt.sessionId === undefined || prompt.sessionId === sessionId)
    .map((prompt) => ({
      key: `engine:${prompt.id}`,
      source: "engine" as const,
      id: prompt.id,
      author: prompt.author,
      title: prompt.title,
      ...(prompt.reason ? { reason: prompt.reason } : {}),
      text: prompt.text,
      // Always empty today — nothing writes `images` on the engine's side yet.
      // Mapped rather than dropped so the day something does, this list shows
      // them without a second change here.
      images: prompt.images ?? [],
      at: prompt.created.at,
    }))
    .sort(byNewest);
}

/**
 * Both stores, one list: an agent's drafts first, then everything you set aside.
 *
 * THE BAND IS THE FEATURE. `agents` is returned separately rather than as a flag
 * on each row so the menu cannot accidentally render one list — the heading it
 * draws over each half comes from having two arrays, and a component that got a
 * single array with a field on it would be one careless `.map` away from the
 * undifferentiated list this whole design refuses.
 */
export function mergeShelf(
  entries: readonly StashEntry[],
  prompts: readonly PreparedPrompt[],
  sessionId: string | undefined,
): { agents: ShelfRow[]; yours: ShelfRow[]; rows: ShelfRow[]; count: number } {
  const engine = engineRows(prompts, sessionId);
  const agents = engine.filter((row) => row.author === "session");
  // An engine row the PERSON wrote sits with their stash rows, because that is
  // what it is — the same hand, a different store. This arm is what the open
  // migration question would eventually fill.
  const yours = [...engine.filter((row) => row.author === "you"), ...stashRows(entries)].sort(byNewest);
  const rows = [...agents, ...yours];
  return { agents, yours, rows, count: rows.length };
}
