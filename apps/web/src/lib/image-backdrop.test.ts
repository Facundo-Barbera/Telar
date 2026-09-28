// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import {
  dataUrlBytes,
  fitWithin,
  FIRST_STEP,
  isImageFile,
  MAX_BACKDROP_EDGE,
  MAX_BACKDROP_IMAGE_BYTES,
  stepDown,
  type CompressionStep,
} from "./image-backdrop";

describe("fitWithin", () => {
  test("caps the LONGEST edge, whichever one that is", () => {
    expect(fitWithin(4000, 3000, 2048)).toEqual({ width: 2048, height: 1536 });
    expect(fitWithin(3000, 4000, 2048)).toEqual({ width: 1536, height: 2048 });
  });

  test("never upscales — a small image stays its own size", () => {
    expect(fitWithin(800, 600, 2048)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(2048, 2048, 2048)).toEqual({ width: 2048, height: 2048 });
  });

  test("aspect ratio survives the scale", () => {
    const { width, height } = fitWithin(1920, 1080, 640);
    expect(width / height).toBeCloseTo(1920 / 1080, 2);
  });

  test("a degenerate source never produces a zero-sized canvas", () => {
    expect(fitWithin(1, 10000, 512)).toEqual({ width: 1, height: 512 });
    expect(fitWithin(0, 0, 512)).toEqual({ width: 1, height: 1 });
    expect(fitWithin(Number.NaN, 400, 512)).toEqual({ width: 1, height: 400 });
  });
});

describe("stepDown", () => {
  test("quality goes first — pixels are the last thing given up", () => {
    const next = stepDown(FIRST_STEP);
    expect(next?.edge).toBe(MAX_BACKDROP_EDGE);
    expect(next?.quality).toBeLessThan(FIRST_STEP.quality);
  });

  test("the edge only shrinks once quality has bottomed out", () => {
    let step: CompressionStep | undefined = FIRST_STEP;
    while (step && step.edge === MAX_BACKDROP_EDGE) {
      expect(step.quality).toBeGreaterThanOrEqual(0.5);
      step = stepDown(step);
    }
    expect(step).toBeDefined();
    expect(step?.edge).toBeLessThan(MAX_BACKDROP_EDGE);
    // And a shrink buys back quality: fewer pixels, same bytes.
    expect(step?.quality).toBeGreaterThan(0.5);
  });

  test("the ladder terminates, and never grows", () => {
    let step: CompressionStep | undefined = FIRST_STEP;
    let previous = FIRST_STEP;
    let rungs = 0;
    while (step) {
      if (rungs > 0) {
        expect(step.edge <= previous.edge).toBe(true);
        expect(step.edge < previous.edge || step.quality < previous.quality).toBe(true);
      }
      previous = step;
      step = stepDown(step);
      rungs += 1;
      if (rungs > 100) break;
    }
    expect(rungs).toBeLessThan(100);
    expect(rungs).toBeGreaterThan(2);
  });

  test("it gives up rather than storing a thumbnail behind the whole app", () => {
    expect(stepDown({ edge: 600, quality: 0.5 })).toBeUndefined();
  });
});

describe("dataUrlBytes", () => {
  test("base64 decodes to three bytes per four characters", () => {
    // "aGk=" is "hi": two bytes from four characters with one pad.
    expect(dataUrlBytes("data:image/jpeg;base64,aGk=")).toBe(2);
    expect(dataUrlBytes("data:image/jpeg;base64,aGlq")).toBe(3);
    expect(dataUrlBytes("data:image/jpeg;base64,aGVsbG8=")).toBe(5);
  });

  test("it tracks the payload, not the whole URL", () => {
    const payload = "A".repeat(4000);
    expect(dataUrlBytes(`data:image/jpeg;base64,${payload}`)).toBe(3000);
  });

  test("a non-base64 or malformed URL is measured, never thrown on", () => {
    expect(dataUrlBytes("data:image/svg+xml,%3Csvg%3E")).toBe("%3Csvg%3E".length);
    expect(dataUrlBytes("not a data url")).toBe("not a data url".length);
    expect(dataUrlBytes("")).toBe(0);
  });

  test("the budget is the number the ladder actually judges", () => {
    const under = `data:image/jpeg;base64,${"A".repeat(4 * 1024 * 1024)}`; // ~3MB decoded
    const over = `data:image/jpeg;base64,${"A".repeat(6 * 1024 * 1024)}`; // ~4.5MB decoded
    expect(dataUrlBytes(under)).toBeLessThanOrEqual(MAX_BACKDROP_IMAGE_BYTES);
    expect(dataUrlBytes(over)).toBeGreaterThan(MAX_BACKDROP_IMAGE_BYTES);
  });
});

describe("isImageFile", () => {
  test("the MIME type decides when there is one", () => {
    expect(isImageFile({ type: "image/png", name: "a.png" })).toBe(true);
    expect(isImageFile({ type: "application/pdf", name: "a.pdf" })).toBe(false);
  });

  test("a typeless drop falls back to the extension", () => {
    expect(isImageFile({ type: "", name: "photo.JPEG" })).toBe(true);
    expect(isImageFile({ type: "", name: "notes.txt" })).toBe(false);
    expect(isImageFile({})).toBe(false);
  });
});
