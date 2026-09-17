/**
 * WHICH BOX IS BEING TYPED INTO, ANSWERED FOR SOMEBODY OUTSIDE THE PAGE (#548).
 *
 * The page API (`lib/page-api.ts`) is handed a string by a client that is not
 * part of this app — the Quest cockpit, running the real web app in a WebView
 * and holding a transcription — and has to put it where a person would have
 * typed it. `document.activeElement` is not an answer: it is whatever the last
 * click left focused, which on this screen is as likely to be a menu as the
 * composer, and a dictation that lands in a dropdown is a dictation lost.
 *
 * So each `Composer` says it is here, and says when the caret entered it. THE
 * ACTIVE ONE IS THE MOST RECENTLY FOCUSED, falling back to the only one mounted
 * — which is the usual case, because a session screen and the Agent screen are
 * different routes and only one of them is ever on screen.
 *
 * ══ WHY THIS IS NOT IN composer.tsx ══
 * The registry has to be readable from `lib/page-api.ts`, which the app shell
 * installs on EVERY route — settings, `/pair`, the not-found page. Importing it
 * from `composer.tsx` would drag the composer, its completion engine and its
 * menus into the one bundle every one of those routes loads, which is precisely
 * the weight #492 took back out of the root layout. A registry with no React in
 * it costs those routes a Map.
 *
 * NOTHING HERE READS THE DOM. Each entry is a set of closures the composer that
 * owns them wrote, so the guards below are that composer's own — there is no
 * second opinion here about whether a draft may be sent.
 */

export type ComposerKind = "session" | "agent";

/** Why a composer would not do what it was asked. A sentence, because an
 *  external client's only move is to show it to a person. */
export type ComposerRefusal = { ok: false; reason: string };

/** What a write to the box answers: the draft it committed, or why it would
 *  not. One shape for `insert` and `replace` — the caller's next move is the
 *  same either way. */
export type ComposerWrite = { ok: true; draft: string } | ComposerRefusal;
export type ComposerSubmit = { ok: true } | ComposerRefusal;

export type ComposerEntry = {
  /** The editable root's DOM id — `turn-prompt` on a session, `agent-prompt` on
   *  the Agent screen. Stable for external clients; see docs/page-api.md. */
  id: string;
  kind: ComposerKind;
  /** What the box holds right now, exactly as it would be sent. */
  draft: () => string;
  /** Is the caret in it, as opposed to merely being the last box that had it? */
  focused: () => boolean;
  /** Splice text in at the caret and report the committed draft. */
  insert: (text: string) => ComposerWrite;
  /**
   * Swap a run of the draft for other text, by draft offsets.
   *
   * WHY THIS IS HERE AND NOT ON THE PAGE API (#544). A live dictation revises
   * itself — "recur", "record", "recording" — and the owner wants those words
   * IN the box, replaced in place, rather than parked in a caption beside the
   * button. That needs an insertion that can be taken back, which is exactly
   * what `window.telar.dictate` must never grow: an external client that could
   * reach back and delete a run of the draft could delete what the PERSON
   * typed. So the retraction lives on the registry, where the only callers are
   * this app's own components, and `lib/page-api.ts` keeps its three calls.
   *
   * THE CALLER OWNS THE OFFSETS AND MUST CHECK THEM. Nothing here knows
   * whether `start..end` still spans what the caller put there — the composer
   * is a live box, and somebody typing in the middle of a range invalidates
   * it. `lib/dictation/interim.ts` is how that is tracked.
   */
  replace: (start: number, end: number, text: string) => ComposerWrite;
  /**
   * WHAT A RUNNING DICTATION LOOKS LIKE IN THIS BOX (#561).
   *
   * `listening` tints the caret for as long as the microphone is open;
   * `interim` is the run of the draft still being revised, drawn dimmer so a
   * reader can tell settled words from words that are still moving.
   *
   * ON THE REGISTRY FOR `replace`'s REASON, and it is the same reason: this is
   * a mark on the drawing of somebody's draft, and the only callers that may
   * make one are this app's own. `window.telar.dictate` does not grow it —
   * an external client that could grey out a run of the draft could grey out
   * what the PERSON typed, and then leave it that way.
   *
   * IT DRAWS, IT DOES NOT WRITE. Nothing here changes the string `draft()`
   * answers, which is what keeps the composer's one rule true: the chips and
   * the dimming are a drawing of the draft, and `serialize` returns the same
   * text with them or without them.
   */
  dictating: (state: { listening: boolean; interim?: { start: number; end: number } }) => void;
  /** Where the caret is on the screen, for something drawn beside it — the mic
   *  pill at the caret. `undefined` when the caret is not in this box. */
  caretRect: () => DOMRect | undefined;
  /** Send, behind the same guard the Enter key passes. */
  submit: () => ComposerSubmit;
};

/** Keyed by a token the component owns (React's `useId`), never by the DOM id:
 *  two composers of the same kind mounted at once is a bug about ids, and it
 *  must not also be one composer silently unregistering the other. */
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

/** The caret entered this composer. Ignored for a composer that is not mounted,
 *  so a stale token can never make the registry point at nothing. */
export function markComposerActive(token: string): void {
  if (mounted.has(token)) active = token;
}

/**
 * The composer an outside caller means.
 *
 * MOST RECENTLY FOCUSED WINS, and it keeps winning after a blur: clicking a
 * toolbar button does not hand the dictation to some other box. With nothing
 * ever focused, the only mounted composer is the answer; with several and no
 * focus, there is no answer — guessing between two message boxes is the one
 * mistake this registry exists to avoid.
 */
export function activeComposer(): ComposerEntry | undefined {
  const focused = active === undefined ? undefined : mounted.get(active);
  if (focused) return focused;
  if (mounted.size !== 1) return undefined;
  return mounted.values().next().value;
}
