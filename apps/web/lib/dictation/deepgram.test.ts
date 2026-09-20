/**
 * THE SOCKET'S ADDRESS AND ITS CREDENTIAL (#544).
 *
 * Two facts worth holding: the token rides the SUBPROTOCOL as `["bearer", jwt]`
 * and never the query (probed live — the query is refused with close 1002; see
 * the header of `deepgram.ts`), and no `encoding` is declared beside container
 * audio, which is how a stream transcribes as silence.
 *
 * And since #581, a third: the recogniser is PRIMED. `keyterm` is repeated once
 * per term and it is a required argument, because the reason this issue exists
 * is that nothing ever made a caller decide.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { listenProtocols, listenUrl, recordingType } from "./deepgram";

describe("listenProtocols", () => {
  test("the scheme word is `bearer` and the JWT follows it", () => {
    // `token` is for a long-lived API key and is REFUSED for a grant JWT; this
    // pair is the only one of the three probed that opened the socket.
    expect(listenProtocols("jwt-abc")).toEqual(["bearer", "jwt-abc"]);
  });
});

describe("listenUrl", () => {
  const parsed = (language = "multi", keyterms: string[] = []) => new URL(listenUrl(language, keyterms));

  test("no credential is in the URL at all", () => {
    // The query parameter is refused by Deepgram, and a secret in a URL lands
    // in proxy logs and browser history besides.
    expect(parsed().searchParams.get("access_token")).toBeNull();
    expect(listenUrl("multi", [])).not.toContain("jwt");
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

  /* ---------------------------------------------------------------- *
   * WHICH LANGUAGE — issue #560.
   * ---------------------------------------------------------------- */

  test("the language it was given is on the query", () => {
    // THE BUG, AS A TEST. Without this parameter Deepgram falls back to `en`
    // and transcribes Spanish as whatever English it sounded closest to —
    // words in the box, confidently wrong.
    expect(parsed("es").searchParams.get("language")).toBe("es");
    expect(parsed("pt-BR").searchParams.get("language")).toBe("pt-BR");
  });

  test("`multi` goes on the wire like any other code — it is not a word for sending nothing", () => {
    // Nova-3 takes `multi` as a model language and code-switches within an
    // utterance. Sending no parameter at all is the thing that was broken.
    expect(parsed("multi").searchParams.get("language")).toBe("multi");
  });

  test("every URL this builds has a language on it, whichever code is asked for", () => {
    // The parameter went missing on every surface at once because it had no
    // argument to go missing FROM. It is required now — a call with nothing in
    // it does not typecheck, which is the guard `bun run typecheck` keeps — and
    // this is the runtime half: nothing this function returns is languageless.
    for (const code of ["multi", "en", "es-419", "zh-HK"]) {
      expect(new URL(listenUrl(code, [])).searchParams.get("language")).toBe(code);
    }
  });

  /* ---------------------------------------------------------------- *
   * THE GLOSSARY — issue #581.
   *
   * The headset put up to forty of these on every socket and this
   * builder put none, which is the whole of the report: the VR client
   * "understands the glossary much better" because it is the only
   * surface that was ever told what the glossary is.
   * ---------------------------------------------------------------- */

  test("one repeated `keyterm` per term, in the order it was given", () => {
    // MULTI-VALUED, which is why this is `append` and not `set`. A
    // comma-joined string would be one long term nobody ever says.
    const query = parsed("multi", ["Telar", "Zarigüeya", "worktree"]).searchParams;
    expect(query.getAll("keyterm")).toEqual(["Telar", "Zarigüeya", "worktree"]);
  });

  test("they ride alongside `language=multi`, which is the combination every client opens", () => {
    // Keyterm prompting is documented per model, and `multi` is what Telar
    // sends by default — confirmed working on the headset.
    const url = parsed("multi", ["Telar"]);
    expect(url.searchParams.get("language")).toBe("multi");
    expect(url.searchParams.getAll("keyterm")).toEqual(["Telar"]);
  });

  test("a term with a space or an accent in it survives the query intact", () => {
    // Session titles are phrases and project names are words in whatever
    // language somebody named them in; a builder that mangled either would be
    // priming the model with strings it will never hear.
    const query = parsed("multi", ["Nightly build triage", "Zarigüeya"]).searchParams;
    expect(query.getAll("keyterm")).toEqual(["Nightly build triage", "Zarigüeya"]);
  });

  test("no terms means no parameter at all, not an empty one", () => {
    expect(parsed("multi", []).searchParams.has("keyterm")).toBe(false);
  });

  test("the pause budget stays at 300 with them", () => {
    // Worth pinning while the query was being changed anyway: the headset saw
    // monosyllables doubled at 100, and "yes yes" in the box is worse than a
    // final landing a fifth of a second late.
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
