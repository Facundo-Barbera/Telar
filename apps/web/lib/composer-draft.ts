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

function key(sessionId: string | undefined, projectId: string): string {
  // A fresh canvas has no session id, so it is keyed by project — which is the
  // scope its message will be created in anyway.
  return `${PREFIX}${sessionId ?? `new:${projectId}`}`;
}

export function readDraft(sessionId: string | undefined, projectId: string): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(key(sessionId, projectId)) ?? "";
  } catch {
    return "";
  }
}

export function writeDraft(sessionId: string | undefined, projectId: string, draft: string): void {
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
