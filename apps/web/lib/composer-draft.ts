/**
 * An unsent message, kept across reloads.
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
 */

const PREFIX = "telar:draft:";
/** Long enough for a real message, short of filling the quota with one key. */
const MAX_DRAFT = 20_000;

/**
 * BOTH HALVES ARE OPTIONAL, and each absence means something different.
 *
 * No SESSION is a fresh canvas: it is keyed by project, which is the scope its
 * message will be created in anyway. No PROJECT is the Spool's master chat,
 * which has one — a project-less session always exists before anyone can type
 * into it, so the project half is never reached for it.
 *
 * The `new:` arm with neither is unreachable today and is spelled anyway rather
 * than asserted away: one shared key for "a composer belonging to nothing" is a
 * dull failure, and a thrown error inside a draft save is the loud one this
 * module exists to avoid.
 */
function key(sessionId: string | undefined, projectId: string | undefined): string {
  return `${PREFIX}${sessionId ?? `new:${projectId ?? "none"}`}`;
}

export function readDraft(sessionId: string | undefined, projectId: string | undefined): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(key(sessionId, projectId)) ?? "";
  } catch {
    return "";
  }
}

export function writeDraft(sessionId: string | undefined, projectId: string | undefined, draft: string): void {
  if (typeof window === "undefined") return;
  try {
    // An empty draft is a REMOVAL, not an empty string: leaving the key behind
    // accumulates one entry per session anyone ever opened.
    if (!draft.trim()) window.localStorage.removeItem(key(sessionId, projectId));
    else window.localStorage.setItem(key(sessionId, projectId), draft.slice(0, MAX_DRAFT));
  } catch {
    // A full or disabled localStorage must never break typing.
  }
}
