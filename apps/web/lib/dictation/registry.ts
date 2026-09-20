/**
 * THE RUNNING DICTATION OF EACH COMPOSER, SO A CHORD AND A BUTTON ARE ONE
 * TOGGLE (#588).
 *
 * ── WHY THIS EXISTS AT ALL ──────────────────────────────────────────────────
 * `useDictation` is a state machine — a socket, a recorder, a live microphone
 * track and a span into somebody's draft. It used to live inside
 * `DictationButton`, which was correct while the button was the only way to
 * start one. A command handler that called the hook itself would be a SECOND
 * machine over the same microphone: the button would say idle while the chord's
 * copy was streaming, and stopping one would not stop the other.
 *
 * So the composer owns the one instance and puts its toggle here, and both
 * callers press the same function.
 *
 * ── AND WHY IT IS KEYED LIKE THE COMPOSER REGISTRY ──────────────────────────
 * The chord has to reach the dictation of the composer `activeComposer()`
 * names — the box a person is actually typing into — and that question already
 * has an owner. This is a sibling of `lib/composer-registry.ts` rather than a
 * rival: same keys, and the answer comes from `activeComposerToken()`. Nothing
 * here decides which box is active, because a second opinion about that is the
 * bug the composer registry was written to prevent.
 *
 * ── NOT EVERY COMPOSER HAS ONE ──────────────────────────────────────────────
 * A composer registers only while dictation could actually run: a provider is
 * chosen and this browser can record. That is what makes the chord a NO-OP
 * rather than an error on a Mac where dictation is off — the same silence the
 * missing button is — and it is what keeps a dead "Dictate" row out of the
 * command palette, which asks whether a command is runnable before drawing it.
 */

import { activeComposerToken } from "@/lib/composer-registry";

export type DictationControl = {
  /** Start, or stop. THE VERY FUNCTION the mic button's `onClick` calls, not a
   *  second one that does the same thing. */
  toggle: () => void;
};

const mounted = new Map<string, DictationControl>();

/** Register while dictation is available on this composer; the returned
 *  function is the unregister. */
export function registerDictation(token: string, control: DictationControl): () => void {
  mounted.set(token, control);
  return () => {
    // Only if it is still MINE. A re-register under the same token (the toggle
    // changes identity as the phase does) runs the old cleanup after the new
    // entry is in, and an unconditional delete would drop the live one.
    if (mounted.get(token) === control) mounted.delete(token);
  };
}

/** The dictation of the composer the registry names, or none — no composer on
 *  screen, two of them and no focus, or dictation unavailable here. */
export function activeDictation(): DictationControl | undefined {
  const token = activeComposerToken();
  return token === undefined ? undefined : mounted.get(token);
}

/** What the `toggle-dictation` command runs. Silent when there is nothing to
 *  toggle, which is the whole of the refusal: the button is not on screen
 *  either, and a chord that beeped would be explaining a state the reader can
 *  already see. */
export function toggleActiveDictation(): void {
  activeDictation()?.toggle();
}
