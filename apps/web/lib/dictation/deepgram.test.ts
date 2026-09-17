/**
 * THE SOCKET'S ADDRESS (#544).
 *
 * Two facts worth holding: the token goes in the QUERY (a browser cannot send a
 * header on a websocket, and a grant JWT is refused as a `token` subprotocol —
 * see the header of `deepgram.ts`), and no `encoding` is declared beside
 * container audio, which is how a stream transcribes as silence.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { listenUrl, recordingType } from "./deepgram";

describe("listenUrl", () => {
  const parsed = () => new URL(listenUrl("jwt-abc"));

  test("the token rides the query, because the browser has nowhere else to put it", () => {
    expect(parsed().searchParams.get("access_token")).toBe("jwt-abc");
  });

  test("nova-3, interim results, smart formatting — the headset's own settings", () => {
    const query = parsed().searchParams;
    expect(query.get("model")).toBe("nova-3");
    expect(query.get("interim_results")).toBe("true");
    expect(query.get("smart_format")).toBe("true");
  });

  test("no encoding or sample rate is declared beside container audio", () => {
    // MediaRecorder hands over WebM/Opus (or MP4 on Safari) and Deepgram reads
    // the container's header. Declaring `linear16` next to Opus bytes is how a
    // dictation comes back empty.
    const query = parsed().searchParams;
    expect(query.get("encoding")).toBeNull();
    expect(query.get("sample_rate")).toBeNull();
  });

  test("it is a wss URL to Deepgram's listen endpoint", () => {
    const url = parsed();
    expect(url.protocol).toBe("wss:");
    expect(url.host).toBe("api.deepgram.com");
    expect(url.pathname).toBe("/v1/listen");
  });
});

describe("recordingType", () => {
  test("Opus where it is offered", () => {
    expect(recordingType((type) => type.startsWith("audio/webm"))).toBe("audio/webm;codecs=opus");
  });

  test("Safari's MP4 when every WebM type is refused", () => {
    expect(recordingType((type) => type === "audio/mp4")).toBe("audio/mp4");
  });

  test("a browser that names nothing still records — the empty string is MediaRecorder's own default", () => {
    expect(recordingType(() => false)).toBe("");
  });
});
