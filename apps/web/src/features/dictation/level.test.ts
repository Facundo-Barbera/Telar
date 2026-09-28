import { describe, expect, test } from "bun:test";
import { HEARING_DB, METER_FLOOR_DB, METER_STEPS, glowLevel, hearing, meterLevel, quantise, rms } from "./level";

/** One window of a sine at a given amplitude, in −1..1 like `getFloatTimeDomainData`. */
function tone(amplitude: number, samples = 1024): Float32Array {
  const window = new Float32Array(samples);
  for (let index = 0; index < samples; index += 1) window[index] = amplitude * Math.sin((2 * Math.PI * index * 8) / samples);
  return window;
}

describe("loudness of one window", () => {
  test("digital silence is exactly zero, which is what a dead input looks like", () => {
    expect(rms(new Float32Array(1024))).toBe(0);
    // An empty window must not divide by zero.
    expect(rms(new Float32Array(0))).toBe(0);
  });

  test("a sine's RMS is its amplitude over root two, not its peak", () => {
    expect(rms(tone(1))).toBeCloseTo(1 / Math.SQRT2, 2);
    expect(rms(tone(0.5))).toBeCloseTo(0.5 / Math.SQRT2, 2);
  });

  test("and the sign of a sample cannot cancel another one out", () => {
    expect(rms([1, -1, 1, -1])).toBe(1);
  });
});

describe("the dB scale, which is the part that makes a working mic look working", () => {
  test("silence is the floor and full scale is the top", () => {
    expect(meterLevel(0)).toBe(0);
    expect(meterLevel(1)).toBe(1);
    expect(meterLevel(10 ** ((METER_FLOOR_DB - 20) / 20))).toBe(0);
  });

  test("ordinary speech lands in the middle of the bar rather than in its first eighth", () => {
    // −30 dBFS is a person at arm's length from a laptop; linearly a bar 3% wide.
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

describe("the glow's level", () => {
  test("room noise stays at rest and loud speech reaches the top", () => {
    let calm = 0;
    let loud = 0;
    for (let frame = 0; frame < 60; frame += 1) {
      calm = glowLevel(calm, meterLevel(0.001));
      loud = glowLevel(loud, meterLevel(0.5));
    }
    expect(calm).toBe(0);
    expect(loud).toBeCloseTo(1, 3);
  });

  test("rises faster than it settles", () => {
    const up = glowLevel(0, 1);
    const down = 1 - glowLevel(1, 0);
    expect(up).toBeGreaterThan(down);
    expect(up).toBeLessThan(1);
  });

  test("clamps whatever it is handed to 0..1", () => {
    for (const [previous, meter] of [
      [5, 5],
      [-3, -3],
      [Number.NaN, Number.NaN],
      [0.5, Number.POSITIVE_INFINITY],
    ] as const) {
      const out = glowLevel(previous, meter);
      expect(out).toBeGreaterThanOrEqual(0);
      expect(out).toBeLessThanOrEqual(1);
    }
  });
});
