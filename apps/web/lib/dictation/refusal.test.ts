/**
 * ONE SENTENCE PER FAILURE, AND NO TWO PATHS SHARING ONE (#643).
 *
 * The thing worth pinning is not the wording — it is that the six ways this can
 * fail are six different sentences, each naming a fix. A pane whose only job is
 * diagnosis is worth nothing if "no microphone connected" and "another app has it
 * open" arrive as the same apology, and that collapse is a regression a reader
 * would never report: the pane still looks like it is working.
 *
 * The standard is `apps/ios/TelarMobile/Speech/Dictation.swift`'s
 * `sentence(for:)`, which does this on the phone.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { microphoneRefusal, microphoneUnavailable } from "./refusal";

/** A `DOMException` as `getUserMedia` rejects with one: the `name` is the spec's
 *  and the `message` is the browser's own, which is exactly why the name is what
 *  gets matched on. */
const rejection = (name: string, message = "a browser's own wording"): Error => Object.assign(new Error(message), { name });

describe("why this page cannot record at all", () => {
  test("an insecure origin is named as such, and says a certificate is not the only way out (#639)", () => {
    const said = microphoneUnavailable({ secure: false, canRecord: false });
    expect(said).toContain("secure context");
    // THE HALF THAT WAS MISSED FOR MONTHS: loopback is potentially trustworthy
    // with no certificate at all, which is why a tunnel is the cheap answer.
    expect(said).toContain("127.0.0.1");
  });

  test("and it wins over 'this browser is too old', because it is the CAUSE of it", () => {
    // `navigator.mediaDevices` is simply absent off a secure context, so the
    // browser check fails too — and telling somebody to upgrade a browser that
    // is fine sends them somewhere that cannot help.
    expect(microphoneUnavailable({ secure: false, canRecord: false })).not.toContain("MediaRecorder");
  });

  test("a secure page whose browser cannot record gets the other sentence", () => {
    expect(microphoneUnavailable({ secure: true, canRecord: false })).toContain("MediaRecorder");
  });

  test("and a page that can record says nothing at all", () => {
    expect(microphoneUnavailable({ secure: true, canRecord: true })).toBeUndefined();
  });
});

describe("why one attempt at the microphone failed", () => {
  test("every path is a different sentence", () => {
    const said = [
      "NotAllowedError",
      "SecurityError",
      "NotFoundError",
      "NotReadableError",
      "OverconstrainedError",
      "AbortError",
    ].map((name) => microphoneRefusal(rejection(name)));
    // Permission and security are deliberately the same fix — the browser's own
    // site settings — so five distinct sentences out of six names is the claim.
    expect(new Set(said).size).toBe(5);
  });

  test("a refusal points at the browser's settings, not at Telar's", () => {
    expect(microphoneRefusal(rejection("NotAllowedError"))).toContain("browser");
    // Firefox and Chrome word this differently; neither wording reaches a reader.
    expect(microphoneRefusal(rejection("NotAllowedError", "Permission denied"))).not.toContain("Permission denied");
  });

  test("no device says there is nothing to record, rather than blaming a permission", () => {
    const said = microphoneRefusal(rejection("NotFoundError"));
    expect(said).toContain("No microphone is connected");
    expect(said).not.toContain("allow");
  });

  test("a device held by another app says which fix applies", () => {
    expect(microphoneRefusal(rejection("NotReadableError"))).toContain("another app");
  });

  test("an over-constrained request names the substitution that did not happen", () => {
    // Should not arrive at all — the device rides as `ideal` — and is still a
    // sentence rather than a shrug if it ever does.
    expect(microphoneRefusal(rejection("OverconstrainedError"))).toContain("system default");
  });

  test("and something else keeps the words whoever threw it wrote", () => {
    // THE PATH THE ENGINE'S AND THE PROVIDER'S OWN REFUSALS TAKE. "No Deepgram
    // key is configured on this Mac" is already written for a reader, and
    // re-labelling it as a microphone fault would send somebody to check a cable
    // over a missing credential.
    expect(microphoneRefusal(new Error("No Deepgram key is configured on this Mac, so dictation cannot start."))).toBe(
      "No Deepgram key is configured on this Mac, so dictation cannot start.",
    );
    // And a throw that is not an Error at all still says something true.
    expect(microphoneRefusal("oh no")).toBe("Dictation could not start.");
    expect(microphoneRefusal(new Error(""))).toBe("Dictation could not start.");
  });
});
