/**
 * ONE SENTENCE PER WAY THE MICROPHONE CAN REFUSE (#643).
 *
 * ── WHY EACH PATH GETS ITS OWN, RATHER THAN ONE APOLOGY ─────────────────────
 * "Dictation did not start" names a symptom the person already had. No
 * permission, no device, the device in use by something else, a page the browser
 * will not grant a microphone to at all — these have four different fixes, and a
 * pane whose only job is diagnosis is worth nothing if it collapses them. The
 * standard here is `apps/ios/TelarMobile/Speech/Dictation.swift`'s
 * `sentence(for:)`, which already does this on the phone: the failure carries the
 * words, and the surface's only move is to show them.
 *
 * ── THE NAME IS THE FACT, NOT THE MESSAGE ───────────────────────────────────
 * `getUserMedia` rejects with a `DOMException` whose `message` is the browser's
 * own and differs between them — Chrome's "Permission denied" against Firefox's
 * "The request is not allowed by the user agent". `name` is the part the spec
 * fixes, so that is what is matched on and the sentence is ours.
 *
 * ── AND A PURE FUNCTION, SO EVERY BRANCH IS CHECKED WITHOUT A MICROPHONE ────
 * Nothing here touches `navigator`; `microphoneUnavailable` is handed the two
 * facts it reasons about rather than reading them, for the same reason.
 */

/**
 * WHY THIS PAGE CANNOT RECORD AT ALL — the two states that are about the page
 * rather than about a device, and `undefined` when it can.
 *
 * SECURE CONTEXT IS CHECKED FIRST because it is the CAUSE of the other one:
 * `navigator.mediaDevices` is simply absent off a secure context, so a page
 * reached over plain HTTP would otherwise be told its browser is too old (#639).
 * That is the wrong sentence and sends somebody to upgrade a browser that is
 * fine.
 *
 * `127.0.0.1` IS A SECURE CONTEXT WITH NO CERTIFICATE — the W3C carve-out, which
 * is why dictation already works on this Mac and why a tunnel is the cheap fix
 * rather than HTTPS. Worth naming in the sentence, because the obvious reading of
 * "not secure" is "go and get a certificate".
 */
export function microphoneUnavailable(facts: { secure: boolean; canRecord: boolean }): string | undefined {
  if (!facts.secure) {
    return "This page is not a secure context, so the browser will not grant a microphone here at all — no setting on either end changes that. Reach Telar over https, or on 127.0.0.1: a tunnel to this Mac counts as local and needs no certificate.";
  }
  if (!facts.canRecord) {
    return "This browser cannot record audio — it has no MediaRecorder, or this page is embedded somewhere that is not allowed a microphone.";
  }
  return undefined;
}

/**
 * The sentence for a rejected `getUserMedia`.
 *
 * EVERY BRANCH NAMES THE FIX, which is the half a reader can act on. A refusal
 * that says only what happened leaves them where they started.
 */
export function microphoneRefusal(cause: unknown): string {
  const name = cause instanceof Error ? cause.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      // THE PERSON'S OWN BROWSER ASKED THEM SOMETHING AND THEY SAID NO — or a
      // policy said it for them. Either way the fix is in the browser's site
      // settings and not in Telar, which is the part worth saying.
      return "This browser did not allow the microphone. Allow it for this site in the browser's own settings, then try again.";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "No microphone is connected, so there is nothing to record.";
    case "NotReadableError":
    case "TrackStartError":
      // Connected, claimed, and not by us. On macOS this is usually a
      // conferencing app holding the input exclusively.
      return "The microphone is connected but could not be started — another app may have it open. Close whatever is recording and try again.";
    case "OverconstrainedError":
      // SHOULD NOT HAPPEN HERE, and is worth a sentence anyway: the chosen
      // device rides as `ideal` rather than `exact` precisely so an unplugged
      // headset degrades to the default (see `devices.ts`). If this ever
      // arrives, the constraint is the bug and the reader should not be left
      // guessing.
      return "The chosen microphone is not available and the browser would not substitute another. Choose the system default.";
    case "AbortError":
      return "The browser stopped opening the microphone before it was ready. Try again.";
    default:
      // A browser's own words are better than a made-up cause — the same call
      // `sentence(for:)` makes with `localizedDescription`. This branch also
      // carries the failures that are not about a device at all, because the
      // start path funnels everything through here: the engine's "no key is
      // configured on this Mac" and the provider's own refusals arrive already
      // written for a reader, and re-labelling them as a microphone problem
      // would send somebody to check a cable over a missing credential.
      return cause instanceof Error && cause.message ? cause.message : "Dictation could not start.";
  }
}
