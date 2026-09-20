/**
 * WHAT ONE FRAME SAYS ABOUT THE WORDS (#544).
 *
 * Every claim here is about the three cases the writer has to tell apart: a new
 * guess, a settled phrase, and a frame that says nothing about the words at all
 * — and the fourth that is easy to miss, a finalised SILENCE, which is the
 * signal to take an unconfirmed guess back out of the box rather than leave it
 * there forever. Nothing malformed off the socket may end a dictation somebody
 * is in the middle of.
 */
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
    // The three Deepgram actually walks through on the word "recording". The
    // writer puts each one over the last; appending them would put all three
    // in somebody's message.
    const said = ["recur", "record", "recording"].map((guess) => readFrame(results(guess, false)));
    expect(said.map((step) => step!.final)).toEqual([false, false, false]);
    expect(said.at(-1)!.text).toBe("recording");
  });

  test("a final is the same words, settled", () => {
    expect(readFrame(results("fix the failing test", true))).toEqual({ text: "fix the failing test", final: true });
  });

  test("a finalised silence is still a final, and empty", () => {
    // NOT `undefined`: the writer has an unconfirmed guess in the box and this
    // is the frame that tells it to take the guess back out. Reported as
    // "nothing happened" it would sit there until the person deleted it.
    expect(readFrame(results("   ", true))).toEqual({ text: "", final: true });
    expect(readFrame(results("", true))).toEqual({ text: "", final: true });
  });

  test("the frames that are not results say nothing about the words", () => {
    // Deepgram sends all three on an ordinary dictation. `undefined` is the
    // answer that leaves the draft alone.
    expect(readFrame({ type: "Metadata" })).toBeUndefined();
    expect(readFrame({ type: "SpeechStarted" })).toBeUndefined();
    expect(readFrame({ type: "UtteranceEnd" })).toBeUndefined();
  });

  test("a results frame with no alternatives says nothing either", () => {
    expect(readFrame({ type: "Results", is_final: true })).toBeUndefined();
    // An alternatives array that is present but empty IS an answer — the
    // channel spoke and had no words in it.
    expect(readFrame({ type: "Results", is_final: true, channel: { alternatives: [] } })).toEqual({ text: "", final: true });
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
    expect(readFrame(parseFrame("[1,2]")!)).toBeUndefined();
  });
});
