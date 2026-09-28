// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { listenProtocols, listenUrl, recordingType } from "./deepgram";

describe("listenProtocols", () => {
  test("the scheme word is `bearer` and the JWT follows it", () => {
    // `token` is for long-lived API keys and is refused for a grant JWT.
    expect(listenProtocols("jwt-abc")).toEqual(["bearer", "jwt-abc"]);
  });
});

describe("listenUrl", () => {
  const parsed = (language = "multi", keyterms: string[] = []) => new URL(listenUrl(language, keyterms));

  test("no credential is in the URL at all", () => {
    // Deepgram refuses the query parameter, and URLs land in logs.
    expect(parsed().searchParams.get("access_token")).toBeNull();
    expect(listenUrl("multi", [])).not.toContain("jwt");
  });

  test("nova-3, interim results, smart formatting — the headset's own settings", () => {
    const query = parsed().searchParams;
    expect(query.get("model")).toBe("nova-3");
    expect(query.get("interim_results")).toBe("true");
    expect(query.get("smart_format")).toBe("true");
    expect(query.get("numerals")).toBe("true");
  });

  test("no encoding or sample rate is declared beside container audio", () => {
    // Deepgram reads the WebM/Opus container header; declaring `linear16` yields empty results.
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

  test("the language it was given is on the query", () => {
    // Without it Deepgram falls back to `en`.
    expect(parsed("es").searchParams.get("language")).toBe("es");
    expect(parsed("pt-BR").searchParams.get("language")).toBe("pt-BR");
  });

  test("`multi` goes on the wire like any other code — it is not a word for sending nothing", () => {
    // Nova-3 takes `multi` and code-switches within an utterance.
    expect(parsed("multi").searchParams.get("language")).toBe("multi");
  });

  test("every URL this builds has a language on it, whichever code is asked for", () => {
    for (const code of ["multi", "en", "es-419", "zh-HK"]) {
      expect(new URL(listenUrl(code, [])).searchParams.get("language")).toBe(code);
    }
  });

  test("one repeated `keyterm` per term, in the order it was given", () => {
    // Multi-valued: `append`, not a comma-joined `set`.
    const query = parsed("multi", ["Telar", "Zarigüeya", "worktree"]).searchParams;
    expect(query.getAll("keyterm")).toEqual(["Telar", "Zarigüeya", "worktree"]);
  });

  test("they ride alongside `language=multi`, which is the combination every client opens", () => {
    const url = parsed("multi", ["Telar"]);
    expect(url.searchParams.get("language")).toBe("multi");
    expect(url.searchParams.getAll("keyterm")).toEqual(["Telar"]);
  });

  test("a term with a space or an accent in it survives the query intact", () => {
    const query = parsed("multi", ["Nightly build triage", "Zarigüeya"]).searchParams;
    expect(query.getAll("keyterm")).toEqual(["Nightly build triage", "Zarigüeya"]);
  });

  test("no terms means no parameter at all, not an empty one", () => {
    expect(parsed("multi", []).searchParams.has("keyterm")).toBe(false);
  });

  test("the pause budget stays at 300 with them", () => {
    // At 100 monosyllables came back doubled.
    expect(parsed("multi", ["Telar"]).searchParams.get("endpointing")).toBe("300");
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
