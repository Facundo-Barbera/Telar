/**
 * Why this page cannot record at all, or `undefined` when it can. Secure context is
 * checked first because `navigator.mediaDevices` is absent off a secure context,
 * which would otherwise read as an old browser.
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

// Matches on `DOMException.name`; the message text differs between browsers.
export function microphoneRefusal(cause: unknown): string {
  const name = cause instanceof Error ? cause.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "This browser did not allow the microphone. Allow it for this site in the browser's own settings, then try again.";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "No microphone is connected, so there is nothing to record.";
    case "NotReadableError":
    case "TrackStartError":
      // On macOS this is usually a conferencing app holding the input exclusively.
      return "The microphone is connected but could not be started — another app may have it open. Close whatever is recording and try again.";
    case "OverconstrainedError":
      return "The chosen microphone is not available and the browser would not substitute another. Choose the system default.";
    case "AbortError":
      return "The browser stopped opening the microphone before it was ready. Try again.";
    default:
      // Engine and provider refusals also arrive here, already written for a reader.
      return cause instanceof Error && cause.message ? cause.message : "Dictation could not start.";
  }
}
