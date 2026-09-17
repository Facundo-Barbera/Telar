/**
 * WHAT GOES IN THE BOX AND WHAT ONLY GETS SHOWN (#544).
 *
 * The whole reason this reducer exists is that `window.telar.dictate` INSERTS
 * and cannot retract, while a live transcription revises itself. Every claim
 * here is that one rule: interim words are reported for the caption and never
 * committed, a final is committed exactly once, and nothing malformed off the
 * socket can end a dictation somebody is in the middle of.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { EMPTY_TRANSCRIPT, parseFrame, readFrame } from "./transcript";

const results = (transcript: string, isFinal: boolean) => ({
  type: "Results",
  is_final: isFinal,
  channel: { alternatives: [{ transcript }] },
});

describe("readFrame", () => {
  test("an interim guess is shown and never committed", () => {
    expect(readFrame(results("recur", false))).toEqual({ commit: "", interim: "recur" });
  });

  test("a revised guess replaces the one before it, because neither was inserted", () => {
    // The three guesses Deepgram actually walks through on the word
    // "recording". Inserting each would put all three in somebody's message.
    const said = ["recur", "record", "recording"].map((guess) => readFrame(results(guess, false)));
    expect(said.map((step) => step.commit)).toEqual(["", "", ""]);
    expect(said.at(-1)!.interim).toBe("recording");
  });

  test("a final commits once and clears the caption", () => {
    expect(readFrame(results("fix the failing test", true))).toEqual({ commit: "fix the failing test", interim: "" });
  });

  test("a final commits only what THIS frame finalised", () => {
    // The second utterance carries its own words, not the first's again — an
    // accumulating reducer is how a dictation says everything twice.
    expect(readFrame(results("fix the failing test", true)).commit).toBe("fix the failing test");
    expect(readFrame(results("and push it", true)).commit).toBe("and push it");
  });

  test("a finalised silence commits nothing rather than a space", () => {
    expect(readFrame(results("   ", true))).toEqual(EMPTY_TRANSCRIPT);
    expect(readFrame(results("", true))).toEqual(EMPTY_TRANSCRIPT);
  });

  test("the frames that are not results are nothing to this", () => {
    // Deepgram sends all three on an ordinary dictation.
    expect(readFrame({ type: "Metadata" })).toEqual(EMPTY_TRANSCRIPT);
    expect(readFrame({ type: "SpeechStarted" })).toEqual(EMPTY_TRANSCRIPT);
    expect(readFrame({ type: "UtteranceEnd" })).toEqual(EMPTY_TRANSCRIPT);
  });

  test("a results frame with no alternatives is empty, not a crash", () => {
    expect(readFrame({ type: "Results", is_final: true, channel: {} })).toEqual(EMPTY_TRANSCRIPT);
    expect(readFrame({ type: "Results", is_final: true })).toEqual(EMPTY_TRANSCRIPT);
  });
});

describe("parseFrame", () => {
  test("reads a frame off the wire", () => {
    expect(parseFrame(JSON.stringify(results("hello", true)))?.is_final).toBe(true);
  });

  test("nothing off the socket can throw — a dictation is mid-sentence", () => {
    // A binary frame, a truncated one, a shape from a future version of the
    // API. None of them is worth ending a recording over.
    expect(parseFrame(new ArrayBuffer(8))).toBeUndefined();
    expect(parseFrame("{not json")).toBeUndefined();
    expect(parseFrame("null")).toBeUndefined();
    expect(parseFrame("[1,2]")).toBeDefined(); // an array is an object; readFrame finds nothing in it
    expect(readFrame(parseFrame("[1,2]")!)).toEqual(EMPTY_TRANSCRIPT);
  });
});
