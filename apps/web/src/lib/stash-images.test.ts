/**
 * The half of the image round trip a test runner can reach.
 *
 * `encodeImagesForStash` is not here and should not be: it is a canvas, this
 * app has no DOM harness, and the answer to an untestable function is to keep
 * it small enough to read rather than to build a harness for it. What IS pinned
 * is the arithmetic that decides the size, and the decode back to a `File` —
 * which bun can run, because it ships `File` and `atob`.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { fileFromStashedImage, filesFromStash, fitLongEdge } from "./stash-images";

function dataUrl(text: string, type = "image/webp") {
  return `data:${type};base64,${btoa(text)}`;
}

describe("fitLongEdge", () => {
  test("scales the long edge down and keeps the ratio", () => {
    expect(fitLongEdge(3200, 1800, 1600)).toEqual({ width: 1600, height: 900 });
    expect(fitLongEdge(1000, 4000, 1600)).toEqual({ width: 400, height: 1600 });
  });

  test("NEVER UPSCALES", () => {
    // A small image is already small; stretching it to the cap makes it bigger
    // to store and no better to look at.
    expect(fitLongEdge(800, 600, 1600)).toEqual({ width: 800, height: 600 });
    expect(fitLongEdge(1600, 900, 1600)).toEqual({ width: 1600, height: 900 });
  });

  test("a zero dimension comes back unchanged rather than dividing by zero", () => {
    expect(fitLongEdge(0, 0, 1600)).toEqual({ width: 0, height: 0 });
  });
});

describe("fileFromStashedImage", () => {
  test("round-trips the name, the type and the bytes", async () => {
    const file = fileFromStashedImage({ name: "shot.webp", type: "image/webp", dataUrl: dataUrl("hello") });
    expect(file?.name).toBe("shot.webp");
    expect(file?.type).toBe("image/webp");
    expect(await file?.text()).toBe("hello");
  });

  test("a malformed URL is skipped, not thrown over", () => {
    // A restore must never be the thing that crashes the composer, and a
    // corrupt row is exactly the shape `readStash` lets through unvalidated —
    // it checks that the string is there, not that it decodes.
    expect(fileFromStashedImage({ name: "a", type: "image/webp", dataUrl: "no-comma-here" })).toBeUndefined();
    expect(fileFromStashedImage({ name: "a", type: "image/webp", dataUrl: "data:image/webp;base64,!!!!" })).toBeUndefined();
  });
});

describe("filesFromStash", () => {
  test("keeps order and drops only what it cannot read", () => {
    const files = filesFromStash([
      { name: "one.webp", type: "image/webp", dataUrl: dataUrl("a") },
      { name: "bad.webp", type: "image/webp", dataUrl: "broken" },
      { name: "two.webp", type: "image/webp", dataUrl: dataUrl("b") },
    ]);
    expect(files.map((file) => file.name)).toEqual(["one.webp", "two.webp"]);
  });
});
