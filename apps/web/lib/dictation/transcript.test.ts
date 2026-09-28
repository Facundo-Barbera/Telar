/** A finalised silence is an empty final, the signal to take an unconfirmed guess back out. */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { parseFrame, readFrame } from "./transcript";

const results = (transcript: string, isFinal: boolean) => ({
  type: "Results",
  is_final: isFinal,
  channel: { alternatives: [{ transcript }] },
});

describe("readFrame", () => {
  test("an interim guess is words that are not settled yet", () => {
    expect(readFrame(results("recur", false))).toEqual({ text: "recur", final: false });
  });

  test("each guess is the whole utterance so far, which is what makes it a replacement", () => {
    // The guesses Deepgram walks through on "recording"; each replaces the last.
    const said = ["recur", "record", "recording"].map((guess) => readFrame(results(guess, false)));
    expect(said.map((step) => step!.final)).toEqual([false, false, false]);
    expect(said.at(-1)!.text).toBe("recording");
  });

  test("a final is the same words, settled", () => {
    expect(readFrame(results("fix the failing test", true))).toEqual({ text: "fix the failing test", final: true });
  });

  test("a finalised silence is still a final, and empty", () => {
    // Not `undefined`: this frame tells the writer to remove its unconfirmed guess.
    expect(readFrame(results("   ", true))).toEqual({ text: "", final: true });
    expect(readFrame(results("", true))).toEqual({ text: "", final: true });
  });

  test("the frames that are not results say nothing about the words", () => {
    // Deepgram sends all three on an ordinary dictation.
    expect(readFrame({ type: "Metadata" })).toBeUndefined();
    expect(readFrame({ type: "SpeechStarted" })).toBeUndefined();
    expect(readFrame({ type: "UtteranceEnd" })).toBeUndefined();
  });

  test("a results frame with no alternatives says nothing either", () => {
    expect(readFrame({ type: "Results", is_final: true })).toBeUndefined();
    // A present but empty alternatives array is an answer with no words.
    expect(readFrame({ type: "Results", is_final: true, channel: { alternatives: [] } })).toEqual({ text: "", final: true });
  });
});

describe("parseFrame", () => {
  test("reads a frame off the wire", () => {
    expect(parseFrame(JSON.stringify(results("hello", true)))?.is_final).toBe(true);
  });

  test("nothing off the socket can throw — a dictation is mid-sentence", () => {
    expect(parseFrame(new ArrayBuffer(8))).toBeUndefined();
    expect(parseFrame("{not json")).toBeUndefined();
    expect(parseFrame("null")).toBeUndefined();
    expect(parseFrame("[1,2]")).toBeDefined(); // an array is an object; readFrame finds nothing in it
    expect(readFrame(parseFrame("[1,2]")!)).toBeUndefined();
  });
});
