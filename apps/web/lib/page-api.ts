/**
 * `window.telar` — THE THREE CALLS AN OUTSIDE CLIENT GETS (#548).
 *
 * WHO ASKS. The Quest cockpit (telar-vr) runs this exact web app in a WebView,
 * captures the headset microphone on push-to-talk, transcribes it, and needs
 * the final text to land in the composer as if it had been typed. It can run
 * JavaScript in the page and nothing else: no extension, no other origin, no
 * bridge.
 *
 * THESE THREE CALLS INSERT AND NEVER RETRACT, and that is a boundary rather
 * than an omission. An API that could reach back and delete a run of the draft
 * could delete what the PERSON last typed — the composer is a live box and a
 * dictation is not the only thing going into it. The composer's own mic button
 * (#544) DOES need to take its words back, because it rewrites Deepgram's
 * guesses in place, so it reaches `replace` on the registry underneath this
 * file instead. In-process callers get the sharper tool; the page API's shape
 * is what `docs/page-api.md` promises and does not move.
 *
 * WHY A PAGE API AND NOT `execCommand`. The composer is not a textarea.
 * `components/composer-editor.tsx` is an imperative `contentEditable` whose
 * draft is A STRING painted into chips, committed on `onInput` — so
 * `execCommand('insertText')` does commit, but it inserts raw DOM text past the
 * spacing and chip handling every other insertion goes through, and the caller
 * still has to guess which element on the screen is the message box. These
 * three calls are that guess removed: `composer()` says what would be written
 * to, `dictate()` writes through the editor's own `insertAtCaret`, and
 * `submit()` sends behind the composer's own guard rather than a copy of it.
 *
 * FROZEN, AND NOT A BRIDGE. The object is `Object.freeze`d so a page script
 * cannot quietly replace a call that a later one trusts, and nothing here
 * reaches the engine: every one of these is something the person at the
 * keyboard could do with their hands, which is the whole boundary of it.
 *
 * STABLE. `docs/page-api.md` is the contract these three calls and the two
 * attributes (`data-slot="composer-editor"`, `data-composer`) are promised
 * under; changing their shape is changing an external client's build.
 */

import { activeComposer, type ComposerKind } from "./composer-registry";

export type DictateResult =
  | {
      ok: true;
      /** The draft the box holds after the insertion — what a send would carry. */
      draft: string;
      /** Present only when `submit: true` was asked for. */
      submitted?: boolean;
      /** Why it did not send, when `submitted` is false. The text landed
       *  regardless: an insertion that worked is never reported as a failure. */
      reason?: string;
    }
  | { ok: false; reason: string };

export type SubmitResult = { ok: true } | { ok: false; reason: string };

export type ComposerReport = {
  /** The editable root's DOM id. */
  id: string;
  kind: ComposerKind;
  draft: string;
  /** Whether the caret is in it right now — `dictate` works either way. */
  focused: boolean;
};

export type TelarPageApi = {
  dictate: (text: string, opts?: { submit?: boolean }) => DictateResult;
  submit: () => SubmitResult;
  composer: () => ComposerReport | null;
};

const NO_COMPOSER = "No message box is on screen to type into.";

/**
 * Insert text at the active composer's caret, spaced as a paste would be, and
 * report the draft that was committed. Focus and caret are left after the text,
 * so a second call continues the sentence.
 */
export function dictate(text: string, opts?: { submit?: boolean }): DictateResult {
  if (text.length === 0) return { ok: false, reason: "There was no text to insert." };
  const composer = activeComposer();
  if (!composer) return { ok: false, reason: NO_COMPOSER };

  const inserted = composer.insert(text);
  if (!inserted.ok) return inserted;
  if (!opts?.submit) return { ok: true, draft: inserted.draft };

  // THE INSERTION IS NOT UNDONE BY A REFUSED SEND. A spoken message that could
  // not go out is still a message the person can look at and press Enter on;
  // taking the words back out because the session was busy would be the one
  // outcome a dictation client cannot explain.
  const sent = composer.submit();
  return sent.ok
    ? { ok: true, draft: inserted.draft, submitted: true }
    : { ok: true, draft: inserted.draft, submitted: false, reason: sent.reason };
}

/** The send on its own — a spoken "send it". */
export function submit(): SubmitResult {
  const composer = activeComposer();
  if (!composer) return { ok: false, reason: NO_COMPOSER };
  return composer.submit();
}

/** What `dictate` would write into, so a client can decide before it speaks. */
export function composer(): ComposerReport | null {
  const found = activeComposer();
  if (!found) return null;
  return { id: found.id, kind: found.kind, draft: found.draft(), focused: found.focused() };
}

type PageApiWindow = typeof window & { telar?: TelarPageApi };

/** Once per module instance. A reload of this module under HMR installs its own
 *  object — the old one closes over a registry that no longer has the mounted
 *  composers in it — and `window.telar` is a plain property, so replacing it is
 *  legal however frozen the object it held was. */
let installed = false;

export function installPageApi(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  (window as PageApiWindow).telar = Object.freeze({ dictate, submit, composer });
}
