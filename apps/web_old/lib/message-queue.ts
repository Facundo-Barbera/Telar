// THE PERSISTED SEND QUEUE — issue #5.
//
// A queued message is the most expensive thing a user can lose: they wrote it,
// committed it with Enter, and the UI answered with a chip that says it is
// safely pending. It then lived in component state and died on the next
// navigation. This module is the durable half.
//
// NO REACT HERE, ON PURPOSE. Every rule below is a pure function over a storage
// interface, so the policy that matters — what happens when the queue does not
// fit — is provable without a DOM. `Storage` is injected rather than reached for
// so a test can drive a quota failure, which is the one path that decides
// whether a user loses words.
//
// WHY LOCALSTORAGE AND NOT THE SERVER. The queue is a client-side staging area
// for text the server has not been told about yet; persisting it server-side
// would mean inventing an endpoint for messages that are explicitly not sent.
// localStorage matches the existing `telar:*` convention (composer prefs, dock
// entries, sidebar width) and survives exactly the events that were losing data:
// navigation, reload, and a closed panel.
//
// The one import is TYPE-ONLY and erased at compile time, so this module still
// carries no runtime dependency on the server-side @telar/core — see
// `QueueItemLifecycle` for why the union has to come from there.
import type { SessionQueueState } from "@telar/core";

/** Per-session key. Namespaced like every other `telar:*` client key. */
export const queueStorageKey = (sessionId: string) => `telar:queue:${sessionId}`;

/**
 * `window.localStorage`, or `undefined` when there isn't one.
 *
 * Two callers need this and both would otherwise write the same guard: it is
 * absent during SSR, and *accessing the property itself* throws in Safari's
 * private mode and under a third-party-cookie block — so `typeof window` alone
 * is not enough, the read has to be wrapped too.
 */
export function browserQueueStorage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * How many bytes of serialized queue we are willing to hand localStorage.
 *
 * The origin budget is ~5 MB for EVERYTHING — composer prefs, dock entries,
 * sidebar width, theme — and a queue is not entitled to most of it. Attachments
 * ride as data URLs (base64, so ~1.37× the file), which means a single dropped
 * screenshot can be several hundred KB on its own. Half a megabyte holds a
 * realistic queue and leaves the rest of the app room to write.
 */
export const MAX_QUEUE_BYTES = 512 * 1024;

/**
 * One queued message as the transcript surfaces hold it. `files` carries
 * PromptInput's already-converted DATA URLs (not blob: URLs, which are revoked
 * the moment the composer clears), which is what makes an attachment
 * serialisable at all — and also what makes it enormous.
 */
// GENERIC OVER THE FILE TYPE, because this module does not care what an
// attachment IS — only that one can be dropped to save the text beside it.
// Naming the real type here would mean importing the composer kit (a 1465-line
// "use client" module) into a lib that is otherwise pure and DOM-free.
export type QueuedMessage<F = unknown> = {
  id: string;
  text: string;
  files?: F[];
};

/**
 * The engine's lifecycle for an item it has durably accepted.
 *
 * IMPORTED, NOT RE-SPELLED. This used to be a hand copy of core's union, which
 * made the "closed list" below closed over nothing: TypeScript never requires
 * an array to cover a union, so a state added to the engine would have compiled
 * here, defaulted into `waiting`, and reproduced the exact bug #31 fixes. The
 * union that decides this belongs to the module that persists it
 * (packages/core/src/session-queue.ts) and there may be only one of it.
 *
 * TYPE-ONLY, which is what makes it legal in a module the client bundle pulls
 * in: `import type` is erased, so no @telar/core runtime edge is created. Same
 * boundary the loom components document.
 *
 * `committed` and `cancelled` are the two TERMINAL states; they are named
 * separately because a terminal item is not a queue entry in any sense — it is
 * history.
 */
export type QueueItemLifecycle = SessionQueueState;
/** The lifecycle minus history: every state an item can be IN the queue in. */
export type QueueItemState = Exclude<QueueItemLifecycle, "committed" | "cancelled">;

/**
 * ISSUE #31 — A QUEUE ITEM'S STATE DECIDES WHICH SURFACE OWNS IT.
 *
 * The queue box used to be populated by a filter that removed only the terminal
 * states, so `claimed`/`running` — both of which mean the engine has ALREADY
 * TAKEN the message and is answering it — kept rendering under "Queued · sends
 * in order" while the same message was also a sent user bubble in the
 * transcript. It read as a pending duplicate send.
 *
 * The fix is a partition and not a wider filter, because the states fall into
 * three groups with three different owners, and collapsing them to two loses
 * the one that matters most:
 *
 *   waiting   — `queued`, and local pre-ack items the engine has not seen yet
 *               (no state at all). This is what the queue box is FOR.
 *   inFlight  — `claimed`/`running`. The transcript and the working indicator
 *               already represent these; a queue chip is a second, contradictory
 *               representation of one message.
 *   attention — `failed`/`ambiguous`, AND a local item the engine REFUSED
 *               (`error` set, never accepted). NOT queue entries — they are
 *               errors, and a blanket "keep only queued" would make a message
 *               that failed to send vanish with no trace, which is worse than
 *               showing it twice. The refused local item belongs here for the
 *               same reason it belongs nowhere else: the view's retry effect
 *               skips anything carrying an `error`, so it will never send, and
 *               under "sends in order" it was a promise no one was keeping.
 *
 * Terminal items are dropped from all three. Keeping them would also strand the
 * 2s queue poll, whose stop condition is an empty queue.
 *
 * PURE AND HERE rather than inline in the view: this is the whole membership
 * rule for a surface users curate, and the app has no component harness, so a
 * function over plain objects is the only executable form of the claim.
 */
export type QueuePartition<T> = {
  waiting: T[];
  inFlight: T[];
  attention: T[];
};

export const isTerminalQueueState = (state?: QueueItemLifecycle): boolean =>
  state === "committed" || state === "cancelled";

/**
 * THE PENDING STRIP'S MEMBERSHIP RULE (feel contract rules 5-10) — the
 * successor to partitionQueue's three-bucket lifecycle display. One list:
 * your messages, in order, waiting to send. No lifecycle vocabulary can
 * render, by construction — a line is text + editability + at most one plain
 * error sentence.
 *
 *   pending, editable  — no state yet (between Enter and the engine's ack)
 *                        and engine-`queued`: both are "your next message,
 *                        waiting", and both may be edited or pulled back.
 *   DROPPED            — `claimed`/`running`. The session feed subscriber
 *                        renders the drained turn into the transcript now
 *                        (user bubble, working line, streaming reply), so a
 *                        strip line would be the second, contradictory
 *                        representation rule 9 forbids.
 *   pending with error — `failed`/`ambiguous`/engine-refused. Not history and
 *                        never silently gone: the text is preserved, one
 *                        sentence says why, and the surface offers Retry /
 *                        Discard on the line itself. Editable when the item is
 *                        still purely local (editing IS the retry); an
 *                        engine-settled failure retries by re-enqueue.
 *
 * Terminal items are dropped. The exhaustive switch and `never` guard carry
 * over from partitionQueue — a new core state fails to COMPILE here instead
 * of silently rendering beside a promise to send.
 */
export type PendingLine<T> = {
  item: T;
  /** In-place edit allowed (local or engine-queued — pre-claim). */
  editable: boolean;
  /** Set for a line that did not send; the surface renders Retry/Discard. */
  error?: string;
};

export function pendingView<
  T extends { state?: QueueItemLifecycle; accepted?: boolean; error?: string },
>(items: readonly T[]): PendingLine<T>[] {
  const lines: PendingLine<T>[] = [];
  for (const item of items) {
    if (item.state === undefined) {
      if (item.error && !item.accepted) lines.push({ item, editable: true, error: item.error });
      else lines.push({ item, editable: true });
      continue;
    }
    switch (item.state) {
      case "committed":
      case "cancelled":
        break; // history; belongs to no surface
      case "claimed":
      case "running":
        break; // the transcript owns it now (feed subscriber)
      case "queued":
        lines.push({ item, editable: true });
        break;
      case "failed":
      case "ambiguous":
        lines.push({ item, editable: !item.accepted, error: item.error ?? "Wasn't sent." });
        break;
      default: {
        const unreachable: never = item.state;
        // Runtime fallback for an envelope written by a newer build: show it
        // as an errored line (true of anything this code cannot classify),
        // never as an ordinary promise to send.
        lines.push({ item, editable: false, error: "Wasn't sent." });
        void unreachable;
      }
    }
  }
  return lines;
}

/**
 * The composer's ArrowUp/ArrowDown walk over the strip (message-lifecycle F1):
 * ArrowUp on an empty composer previews the NEWEST editable line; each further
 * press walks one line older; ArrowDown walks back toward newest, and walking
 * past the newest ends the walk (the caller restores whatever draft was
 * displaced). A pure index over the EDITABLE lines, re-resolved per press —
 * the strip can change under a walk (a line fires, an error lands) and the
 * next press simply lands somewhere true. Non-editable lines (engine-settled
 * failures, which retry by re-enqueue) are never walk targets.
 *
 * Here rather than in the component, per the design doc: "this is a pure
 * index over pendingLines, so it belongs in message-queue.ts … not as
 * component state arithmetic."
 */
export type RecallStep<T> = {
  /** The new walk position (an index into the editable sub-list), or null —
   *  either nothing to recall, or the walk ended (ArrowDown past newest). */
  cursor: number | null;
  line: PendingLine<T> | null;
};

export function recallTarget<T>(
  lines: readonly PendingLine<T>[],
  cursor: number | null,
  dir: "up" | "down",
): RecallStep<T> {
  const editable = lines.filter((l) => l.editable);
  if (editable.length === 0) return { cursor: null, line: null };
  if (dir === "up") {
    // First press lands on the newest; further presses walk older, clamped —
    // holding ArrowUp at the oldest line stays there rather than wrapping.
    const next = cursor === null ? editable.length - 1 : Math.max(0, cursor - 1);
    return { cursor: next, line: editable[next] ?? null };
  }
  if (cursor === null) return { cursor: null, line: null };
  const next = cursor + 1;
  if (next >= editable.length) return { cursor: null, line: null };
  return { cursor: next, line: editable[next] ?? null };
}

/**
 * One plain sentence for a queue error (feel contract rules 11/23): raw
 * exception text, HTTP codes, and revision-conflict strings never reach the
 * screen. Pure so the mapping is provable without a DOM.
 */
export function plainQueueError(err: unknown): string {
  const raw =
    typeof err === "string"
      ? err
      : err instanceof Error
        ? err.message
        : String(err ?? "");
  if (/revision|conflict|stale/i.test(raw)) {
    return "Someone else edited this message — reopen it and try again.";
  }
  if (/HTTP 4\d\d/.test(raw) || /not accepted|refused|invalid/i.test(raw)) {
    return "The server didn't accept this message — edit it and try again.";
  }
  if (/HTTP 5\d\d|fetch|network|Failed to fetch|ECONN/i.test(raw)) {
    return "Couldn't reach the server — try again.";
  }
  return raw && raw.length <= 120 ? raw : "Something went wrong sending this — try again.";
}

export function partitionQueue<
  T extends { state?: QueueItemLifecycle; accepted?: boolean; error?: string },
>(items: readonly T[]): QueuePartition<T> {
  const partition: QueuePartition<T> = { waiting: [], inFlight: [], attention: [] };
  for (const item of items) {
    if (item.state === undefined) {
      // NO STATE AT ALL is a purely local item — between the user's Enter and
      // the engine's acknowledgement. Its `error` is the only thing that
      // distinguishes "still uploading" from "the engine said no", and the
      // second one never sends.
      if (item.error && !item.accepted) partition.attention.push(item);
      else partition.waiting.push(item);
      continue;
    }
    // A SWITCH, NOT A CHAIN, and the `never` below is the whole point: adding a
    // state to core's SessionQueueState now fails to COMPILE here instead of
    // silently defaulting into `waiting` — which is precisely how `claimed` and
    // `running` came to be advertised as "sends in order".
    switch (item.state) {
      case "committed":
      case "cancelled":
        break; // history; belongs to no surface
      case "claimed":
      case "running":
        partition.inFlight.push(item);
        break;
      case "failed":
      case "ambiguous":
        partition.attention.push(item);
        break;
      case "queued":
        partition.waiting.push(item);
        break;
      default: {
        const unreachable: never = item.state;
        // Compile-time exhaustiveness is the guard; this is the runtime
        // fallback for a state that reached the browser anyway (an envelope
        // written by a newer build). It goes to `attention` and never to
        // `waiting`: showing an unknown item beside a promise that it will send
        // is the failure mode being fixed, and showing it as needing a human is
        // true of anything this code cannot classify.
        partition.attention.push(item);
        void unreachable;
      }
    }
  }
  return partition;
}

/**
 * ISSUE #7 — WHAT A CLOSING SURFACE IS ALLOWED TO TAKE WITH IT.
 *
 * Undocking a bubble is a change of viewport, not a decision to abandon what is
 * queued in it. What bounds the damage is OWNERSHIP, not lifecycle: once the
 * engine has acknowledged an item it lives in `queue.json` and drains
 * server-side whether or not any surface is mounted, so dropping the client's
 * copy of it loses nothing. A PRE-ACK item — between the user's Enter and the
 * engine's 202 — exists ONLY in the client, and is the one thing a closing
 * surface can actually destroy.
 *
 * `accepted` and `state` are each sufficient on their own: the session surface
 * sets `accepted` on acknowledgement, the engine projection supplies `state`,
 * and an item carrying either already has a durable home elsewhere.
 *
 * `id` is required rather than incidental — it is the idempotency key the
 * acceptance POST is keyed by, so an item without one could not be handed over
 * without risking a double send.
 */
export type QueueOwnership = {
  id: string;
  state?: QueueItemLifecycle;
  accepted?: boolean;
};

export const isEngineOwned = (item: QueueOwnership): boolean =>
  item.accepted === true || item.state !== undefined;

/**
 * The items a surface must keep rather than unmount with.
 *
 * An engine-REFUSED local item (`error`, never accepted) is deliberately
 * retained: it is still the user's words, and #31 already refused to let that
 * message vanish out of the queue box — it may not vanish through a close
 * button either.
 *
 * THE RULE IS GENERAL; ITS FIRST CALLER IS NOT. The dock's bridge is pre-ack by
 * construction (nothing writes `state`/`accepted` onto its items), so there this
 * filter keeps everything — see `releaseRuntime` in the dock provider. It is
 * written as a filter anyway because the session surface DOES set `accepted`,
 * and a second caller getting the split backwards re-sends work the engine ran.
 * `fitQueueMapToBudget` below is what bounds what retention accumulates.
 */
export function retainOnSurfaceLoss<T extends QueueOwnership>(items: readonly T[]): T[] {
  return items.filter((item) => !isEngineOwned(item));
}

/** The trimmer `fitToBudget`/`writeQueue` apply when a queue will not fit. */
export const stripQueuedAttachments = <T extends { files?: unknown }>(m: T): T => {
  if (!m.files) return m;
  const rest = { ...m };
  delete rest.files;
  return rest;
};

/** What `fitToBudget` did, so a caller can tell the user the truth. */
export type QueueFit<T> = {
  /** What should actually be written. */
  items: T[];
  /** Attachments were stripped to make it fit — text survived. */
  shedAttachments: boolean;
  /** Whole messages dropped from the FRONT because even bare text overflowed. */
  droppedCount: number;
};

const bytesOf = (value: unknown): number => {
  // UTF-16 source → UTF-8 storage. TextEncoder measures what the quota counts,
  // and `.length` would undercount every non-ASCII character in the queue.
  try {
    return new TextEncoder().encode(JSON.stringify(value ?? null)).length;
  } catch {
    // A value with a cycle or a BigInt cannot be stored at all; report it as
    // over budget so the caller sheds rather than throwing at write time.
    return Number.POSITIVE_INFINITY;
  }
};

/**
 * Fit a queue into the byte budget, and — this is the whole point — SHED
 * ATTACHMENTS BEFORE TEXT.
 *
 * A user who queued "fix the flaky test" with a 3 MB screenshot attached would
 * rather keep the sentence and lose the screenshot than lose both. Attachments
 * are re-attachable from disk; the sentence only exists here. The escalation is
 * therefore strictly ordered:
 *
 *   1. everything fits            → store it unchanged
 *   2. attachments are the problem → store text-only, report `shedAttachments`
 *   3. even bare text overflows    → drop from the FRONT (oldest first), because
 *                                    the newest message is the one still on the
 *                                    user's mind
 *
 * Step 3 is close to unreachable — half a megabyte is a lot of prose — but a
 * total function that cannot get stuck beats one that throws inside a render.
 */
export function fitToBudget<T>(
  items: readonly T[],
  stripAttachments: (item: T) => T,
  maxBytes: number = MAX_QUEUE_BYTES,
): QueueFit<T> {
  if (items.length === 0) return { items: [], shedAttachments: false, droppedCount: 0 };

  if (bytesOf(items) <= maxBytes) {
    return { items: [...items], shedAttachments: false, droppedCount: 0 };
  }

  const stripped = items.map(stripAttachments);
  if (bytesOf(stripped) <= maxBytes) {
    return { items: stripped, shedAttachments: true, droppedCount: 0 };
  }

  // Oldest-first eviction until the remainder fits. `shift` on a copy rather
  // than an index walk so the returned array is exactly what gets written.
  const kept = [...stripped];
  let dropped = 0;
  while (kept.length > 0 && bytesOf(kept) > maxBytes) {
    kept.shift();
    dropped += 1;
  }
  return { items: kept, shedAttachments: true, droppedCount: dropped };
}

/** What `fitQueueMapToBudget` had to evict, so a caller can say so. */
export type QueueMapFit<T> = {
  map: Record<string, T[]>;
  /** Session keys dropped whole, oldest-first, because the map overflowed. */
  droppedSessions: string[];
};

/**
 * ISSUE #7 — A CEILING FOR A MAP WHOSE ONLY EXIT IS A SUCCESSFUL SEND.
 *
 * `fitToBudget` above bounds ONE session's queue under its own key. The dock
 * keeps every docked session's pre-ack queue in a SINGLE key
 * (`telar:dock-queued`), and since #7 stopped undock/clearAutoDock from
 * discarding queues, the only thing that removes an entry from it is a 202 from
 * the engine. A session that can never accept one (deleted server-side, so the
 * POST keeps failing) would otherwise sit there forever, in the same ~5 MB
 * origin budget the header weighs.
 *
 * EVICTION IS WHOLE-SESSION AND OLDEST-FIRST, which is the same rule and the
 * same reason as `fitToBudget`'s step 3: the newest parked words are the ones
 * still on the user's mind. Iteration order IS the eviction order — the caller
 * builds the map from its runtime record, whose keys are in dock order.
 *
 * A half-written session (some of its messages) would be worse than a dropped
 * one: the queue advertises "sends in order", and a queue missing its middle
 * silently breaks that promise. So a session is kept entire or not at all.
 */
export function fitQueueMapToBudget<T>(
  map: Record<string, T[]>,
  maxBytes: number = MAX_QUEUE_BYTES,
): QueueMapFit<T> {
  if (bytesOf(map) <= maxBytes) return { map, droppedSessions: [] };

  const kept = { ...map };
  const dropped: string[] = [];
  for (const id of Object.keys(map)) {
    if (bytesOf(kept) <= maxBytes) break;
    delete kept[id];
    dropped.push(id);
  }
  return { map: kept, droppedSessions: dropped };
}

/**
 * Read a persisted queue. A corrupt or foreign value reads as EMPTY rather than
 * throwing: this runs during a component's first render, and a malformed key
 * (a half-written value, a schema from an older build, something a user pasted
 * into devtools) must not be able to prevent a session from opening.
 */
export function readQueue<T>(storage: Storage | undefined, key: string): T[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/**
 * Write a queue, shedding to fit. An EMPTY queue REMOVES the key rather than
 * storing `[]` — a drained session should not leave a permanent tombstone in a
 * budget this app shares across every project and chat the user has ever opened.
 *
 * Returns what happened, so a surface can say "your attachment was too large to
 * keep" instead of silently handing back a lighter message than it was given.
 * A quota rejection despite the budget (another tab filled the origin between
 * our measurement and our write) degrades to text-only and, failing that, to a
 * removed key — never to an exception escaping into a render.
 */
export function writeQueue<T>(
  storage: Storage | undefined,
  key: string,
  items: readonly T[],
  stripAttachments: (item: T) => T,
  maxBytes: number = MAX_QUEUE_BYTES,
): QueueFit<T> {
  const fit = fitToBudget(items, stripAttachments, maxBytes);
  if (!storage) return fit;

  if (fit.items.length === 0) {
    try {
      storage.removeItem(key);
    } catch {
      // Nothing to salvage: the queue is empty either way.
    }
    return fit;
  }

  try {
    storage.setItem(key, JSON.stringify(fit.items));
    return fit;
  } catch {
    // Over quota despite fitting our own budget — the origin filled up
    // elsewhere. Try text-only before giving up on the words.
    const textOnly = items.map(stripAttachments);
    try {
      storage.setItem(key, JSON.stringify(textOnly));
      return { items: textOnly, shedAttachments: true, droppedCount: 0 };
    } catch {
      try {
        storage.removeItem(key);
      } catch {
        // The queue stays in memory for this session; nothing else to do.
      }
      return { items: [], shedAttachments: true, droppedCount: items.length };
    }
  }
}
