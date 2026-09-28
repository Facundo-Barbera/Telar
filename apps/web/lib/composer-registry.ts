/**
 * Which composer an outside caller (`lib/page-api.ts`) means: the most recently focused one,
 * or the only one mounted. Kept free of React so every route that installs the page API
 * can import it without pulling in the composer.
 */

export type ComposerKind = "session";

/** A sentence, because an external client can only show it to a person. */
export type ComposerRefusal = { ok: false; reason: string };

/** What a write answers: the committed draft, or why it would not. */
export type ComposerWrite = { ok: true; draft: string } | ComposerRefusal;
export type ComposerSubmit = { ok: true } | ComposerRefusal;

export type ComposerEntry = {
  /** The editable root's DOM id — `turn-prompt`. Stable for external clients. */
  id: string;
  kind: ComposerKind;
  draft: () => string;
  /** Is the caret in it, as opposed to merely being the last box that had it? */
  focused: () => boolean;
  insert: (text: string) => ComposerWrite;
  /**
   * Swap a run of the draft by draft offsets. App-internal only, never exposed on the page API.
   * The caller owns the offsets and must check they are still valid (`lib/dictation/interim.ts`).
   */
  replace: (start: number, end: number, text: string) => ComposerWrite;
  /**
   * `listening` tints the caret while the mic is open; `interim` dims the run still being revised.
   * Draws only: `draft()` answers the same text either way. App-internal, like `replace`.
   */
  dictating: (state: { listening: boolean; interim?: { start: number; end: number } }) => void;
  /** Screen rect of the caret, or `undefined` when the caret is not in this box. */
  caretRect: () => DOMRect | undefined;
  /** Send, behind the same guard the Enter key passes. */
  submit: () => ComposerSubmit;
};

/** Keyed by a token the component owns (`useId`), not the DOM id, so two composers
 *  sharing an id can never unregister each other. */
const mounted = new Map<string, ComposerEntry>();
let active: string | undefined;

/** Register on mount; the returned function is the unmount. */
export function registerComposer(token: string, entry: ComposerEntry): () => void {
  mounted.set(token, entry);
  return () => {
    mounted.delete(token);
    if (active === token) active = undefined;
  };
}

/** Ignored for a composer that is not mounted, so a stale token never points at nothing. */
export function markComposerActive(token: string): void {
  if (mounted.has(token)) active = token;
}

/**
 * The most recently focused composer wins, even after a blur. With none focused, the only
 * mounted composer; with several and no focus, none.
 */
function activeToken(): string | undefined {
  if (active !== undefined && mounted.has(active)) return active;
  if (mounted.size !== 1) return undefined;
  return mounted.keys().next().value;
}

/** The composer an outside caller means. */
export function activeComposer(): ComposerEntry | undefined {
  const token = activeToken();
  return token === undefined ? undefined : mounted.get(token);
}

/** For sibling registries (`lib/dictation/registry.ts`) that must resolve the same active composer. */
export function activeComposerToken(): string | undefined {
  return activeToken();
}
