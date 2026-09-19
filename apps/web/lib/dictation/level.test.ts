/**
 * THE SCALE A PERSON READS OFF THE BAR (#643).
 *
 * What is checked here is the arithmetic, which is where this can be wrong
 * without looking wrong: a linear meter draws ordinary speech as a bar that never
 * leaves its first eighth, and somebody reads a working microphone as a dead one.
 * The plumbing above it — a real `AudioContext` on a real stream — is named in
 * `level.ts` as the part a test cannot reach, and is why the PR says a human at a
 * microphone is still required.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { HEARING_DB, METER_FLOOR_DB, METER_STEPS, hearing, meterLevel, quantise, rms } from "./level";

/** One window of a sine at a given amplitude — the shape `getFloatTimeDomainData`
 *  hands over, in −1..1. */
function tone(amplitude: number, samples = 1024): Float32Array {
  const window = new Float32Array(samples);
  for (let index = 0; index < samples; index += 1) window[index] = amplitude * Math.sin((2 * Math.PI * index * 8) / samples);
  return window;
}

describe("loudness of one window", () => {
  test("digital silence is exactly zero, which is what a dead input looks like", () => {
    expect(rms(new Float32Array(1024))).toBe(0);
    // AND SO IS AN EMPTY WINDOW. An analyser read before the graph is running
    // must not divide by zero and paint a full bar.
    expect(rms(new Float32Array(0))).toBe(0);
  });

  test("a sine's RMS is its amplitude over root two, not its peak", () => {
    // The distinction that matters: a peak meter reads full scale off one click
    // nobody heard.
    expect(rms(tone(1))).toBeCloseTo(1 / Math.SQRT2, 2);
    expect(rms(tone(0.5))).toBeCloseTo(0.5 / Math.SQRT2, 2);
  });

  test("and the sign of a sample cannot cancel another one out", () => {
    // A mean would answer zero for this; squaring first is the whole reason it
    // does not.
    expect(rms([1, -1, 1, -1])).toBe(1);
  });
});

describe("the dB scale, which is the part that makes a working mic look working", () => {
  test("silence is the floor and full scale is the top", () => {
    expect(meterLevel(0)).toBe(0);
    expect(meterLevel(1)).toBe(1);
    // Below the floor is still the floor, never a negative width.
    expect(meterLevel(10 ** ((METER_FLOOR_DB - 20) / 20))).toBe(0);
  });

  test("ordinary speech lands in the middle of the bar rather than in its first eighth", () => {
    // −30 dBFS is a person at arm's length from a laptop. Linearly that is an
    // RMS of 0.03 and a bar 3% wide; on this scale it is half.
    const speech = 10 ** (-30 / 20);
    expect(speech).toBeLessThan(0.04);
    expect(meterLevel(speech)).toBeCloseTo(0.5, 2);
  });

  test("a quiet room is visible without being mistaken for a voice", () => {
    const room = 10 ** (-55 / 20);
    expect(meterLevel(room)).toBeGreaterThan(0);
    expect(hearing(meterLevel(room))).toBe(false);
  });

  test("the threshold is where a room becomes somebody talking", () => {
    expect(hearing(meterLevel(10 ** ((HEARING_DB + 5) / 20)))).toBe(true);
    expect(hearing(meterLevel(10 ** ((HEARING_DB - 5) / 20)))).toBe(false);
    // Exactly at it counts as hearing: the boundary belongs to the state that
    // says something is happening.
    expect(hearing(meterLevel(10 ** (HEARING_DB / 20)))).toBe(true);
  });

  test("silence never reads as hearing you", () => {
    expect(hearing(0)).toBe(false);
  });
});

describe("the steps, which are what keep a 60 Hz loop from re-rendering a pane 60 times a second", () => {
  test("a level is rounded to one of the bar's steps", () => {
    expect(quantise(0.5)).toBe(0.5);
    expect(quantise(1 / METER_STEPS / 3)).toBe(0);
    expect(quantise(0.999)).toBe(1);
  });

  test("and never leaves 0..1, whatever it is handed", () => {
    expect(quantise(-5)).toBe(0);
    expect(quantise(12)).toBe(1);
  });
});
