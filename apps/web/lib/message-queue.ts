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
