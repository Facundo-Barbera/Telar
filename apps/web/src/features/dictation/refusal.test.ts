import { describe, expect, test } from "bun:test";
import { microphoneRefusal, microphoneUnavailable } from "./refusal";

/** As `getUserMedia` rejects: `name` is the spec's, `message` the browser's, so match on `name`. */
const rejection = (name: string, message = "a browser's own wording"): Error => Object.assign(new Error(message), { name });

describe("why this page cannot record at all", () => {
  test("an insecure origin is named as such, and says a certificate is not the only way out (#639)", () => {
    const said = microphoneUnavailable({ secure: false, canRecord: false });
    expect(said).toContain("secure context");
    // Loopback is potentially trustworthy without a certificate.
    expect(said).toContain("127.0.0.1");
  });

  test("and it wins over 'this browser is too old', because it is the CAUSE of it", () => {
    // `navigator.mediaDevices` is absent off a secure context, so the browser check fails too.
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
    // Permission and security share a fix, so five distinct sentences for six names.
    expect(new Set(said).size).toBe(5);
  });

  test("a refusal points at the browser's settings, not at Telar's", () => {
    expect(microphoneRefusal(rejection("NotAllowedError"))).toContain("browser");
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
    // Should not happen since the device rides as `ideal`.
    expect(microphoneRefusal(rejection("OverconstrainedError"))).toContain("system default");
  });

  test("and something else keeps the words whoever threw it wrote", () => {
    // Engine and provider refusals are already written for a reader.
    expect(microphoneRefusal(new Error("No Deepgram key is configured on this Mac, so dictation cannot start."))).toBe(
      "No Deepgram key is configured on this Mac, so dictation cannot start.",
    );
    expect(microphoneRefusal("oh no")).toBe("Dictation could not start.");
    expect(microphoneRefusal(new Error(""))).toBe("Dictation could not start.");
  });
});
