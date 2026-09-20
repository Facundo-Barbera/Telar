/**
 * An unsent message, kept across reloads — and listed in the rail.
 *
 * THE ONE THING A COMPOSER MUST NEVER DO IS EAT WHAT YOU TYPED. A reload, a
 * crashed tab, a mis-click on a sidebar row — none of those are a decision to
 * throw the paragraph away, and the cost of remembering it is one localStorage
 * key. Ported in spirit from the donor's `composer-draft.tsx`, which does the
 * same thing for the same reason.
 *
 * KEYED PER SESSION, including the fresh canvas: two sessions each hold their
 * own unsent thought, and restoring one into the other would be worse than
 * forgetting both.
 *
 * A CANVAS DRAFT IS ALSO A LIST ITEM. Remembering the text was only half the
 * promise: a conversation you started writing and walked away from left no mark
 * anywhere, because a canvas mints no session until its first message. So the
 * canvas keys are enumerable (`listCanvasDrafts`) and every write announces
 * itself, which is what lets the rail show a draft the moment it exists and
 * drop it the moment it is sent. Session drafts stay private to their composer
 * — that session already has a row, and listing it twice would be noise.
 */

const PREFIX = "telar:draft:";
/** The canvas half of the namespace: no session yet, so keyed by project. */
const CANVAS = `${PREFIX}new:`;
/** Long enough for a real message, short of filling the quota with one key. */
const MAX_DRAFT = 20_000;

/**
 * Same-window propagation, mirroring `projects.ts`.
 *
 * NEEDED BECAUSE `storage` DOES NOT FIRE IN THE TAB THAT WROTE. The rail and
 * the composer are the same document, so without this the sidebar would only
 * learn about a draft on its next poll — and a draft row that lags the typing
 * by ten seconds reads as a bug. The event carries no payload: every listener
 * re-reads storage, which is the only thing that is actually true.
 */
export const DRAFTS_CHANGED_EVENT = "telar:drafts";

export function announceDraftsChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(DRAFTS_CHANGED_EVENT));
}

/** Just the shape used here, so a test can pass a Map without faking `Storage`. */
export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "length" | "key">;

/**
 * The store, or nothing at all.
 *
 * Absent during the server render, and absent again when a browser has storage
 * disabled. Both are the same answer to every caller here: no drafts, no throw.
 */
function resolve(storage?: DraftStorage): DraftStorage | undefined {
  if (storage) return storage;
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * BOTH HALVES ARE OPTIONAL, and each absence means something different.
 *
 * No SESSION is a fresh canvas: it is keyed by project, which is the scope its
 * message will be created in anyway. No PROJECT is a project-less session,
 * which has a session id — one always exists before anyone can type into it, so
 * the project half is never reached for it.
 *
 * The `new:` arm with neither is unreachable today and is spelled anyway rather
 * than asserted away: one shared key for "a composer belonging to nothing" is a
 * dull failure, and a thrown error inside a draft save is the loud one this
 * module exists to avoid.
 */
function key(sessionId: string | undefined, projectId: string | undefined): string {
  return `${PREFIX}${sessionId ?? `new:${projectId ?? "none"}`}`;
}

/**
 * What is actually in a slot: the text, and when it was last touched.
 *
 * THE TIMESTAMP EXISTS TO ORDER THE RAIL — the draft you were writing a moment
 * ago belongs above the one you abandoned on Tuesday, and a list that cannot
 * say which is which has to fall back on project name, which is arbitrary.
 */
type Stored = { text: string; updatedAt: number };

/**
 * Reads BOTH shapes on purpose.
 *
 * The slot used to hold a bare string, and there are drafts sitting in real
 * browsers in that shape right now. Losing someone's unsent paragraph to a
 * storage-format change would break this module's one promise on the very
 * commit that claims to take drafts seriously, so a plain string is read as
 * text with no known age — it sorts last, and the next keystroke re-dates it.
 */
function parse(raw: string | null): Stored | undefined {
  if (raw === null) return undefined;
  if (!raw.startsWith("{")) return raw.trim() ? { text: raw, updatedAt: 0 } : undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return undefined;
    const { text, updatedAt } = value as { text?: unknown; updatedAt?: unknown };
    if (typeof text !== "string" || !text.trim()) return undefined;
    return { text, updatedAt: typeof updatedAt === "number" ? updatedAt : 0 };
  } catch {
    return undefined;
  }
}

export function readDraft(
  sessionId: string | undefined,
  projectId: string | undefined,
  storage?: DraftStorage,
): string {
  const store = resolve(storage);
  if (!store) return "";
  try {
    return parse(store.getItem(key(sessionId, projectId)))?.text ?? "";
  } catch {
    return "";
  }
}

export function writeDraft(
  sessionId: string | undefined,
  projectId: string | undefined,
  draft: string,
  storage?: DraftStorage,
): void {
  const store = resolve(storage);
  if (!store) return;
  try {
    // An empty draft is a REMOVAL, not an empty string: leaving the key behind
    // accumulates one entry per session anyone ever opened.
    if (!draft.trim()) store.removeItem(key(sessionId, projectId));
    else
      store.setItem(
        key(sessionId, projectId),
        JSON.stringify({ text: draft.slice(0, MAX_DRAFT), updatedAt: Date.now() } satisfies Stored),
      );
  } catch {
    // A full or disabled localStorage must never break typing.
  }
  // ANNOUNCED EVEN WHEN THE WRITE THREW. The rail re-reads storage rather than
  // trusting a payload, so the worst a spurious event costs is one scan of a
  // handful of keys — and staying quiet after a failed write is how a deleted
  // draft stays on screen.
  announceDraftsChanged();
}

/** A started conversation that has no session yet. One per project, at most. */
export type CanvasDraft = { projectId: string; text: string; updatedAt: number };

/**
 * Every canvas draft, newest first.
 *
 * SESSION DRAFTS ARE DELIBERATELY EXCLUDED — see the module docblock. Scanning
 * rather than keeping an index because the index would be the thing that goes
 * stale: storage is already the list, a dozen keys is nothing to walk, and a
 * draft that exists but is not listed is exactly the failure this feature is
 * meant to end.
 */
export function listCanvasDrafts(storage?: DraftStorage): CanvasDraft[] {
  const store = resolve(storage);
  if (!store) return [];
  const drafts: CanvasDraft[] = [];
  try {
    for (let index = 0; index < store.length; index += 1) {
      const name = store.key(index);
      if (!name?.startsWith(CANVAS)) continue;
      const projectId = name.slice(CANVAS.length);
      const stored = parse(store.getItem(name));
      // An empty or unreadable slot is not a draft. It should not exist —
      // `writeDraft` removes rather than blanks — but a row promising text it
      // cannot show is worse than a row that never appears.
      if (projectId && stored) drafts.push({ projectId, text: stored.text, updatedAt: stored.updatedAt });
    }
  } catch {
    return drafts;
  }
  return drafts.sort((left, right) => right.updatedAt - left.updatedAt || left.projectId.localeCompare(right.projectId));
}
