import { describe, expect, test } from "bun:test";
import { installTestDom } from "@/test/dom";
import { encodeForStash, fileFromStashedImage, filesFromStash, fitLongEdge } from "./stash-images";

installTestDom();

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

describe("encodeForStash", () => {
  test("a file that is not an image is stashed as it is and restores byte for byte", async () => {
    const pdf = new File(["%PDF-1.7 notes"], "notes.pdf", { type: "application/pdf" });
    const { images, kept } = await encodeForStash([pdf]);
    expect(kept).toEqual([]);
    const [restored] = filesFromStash(images);
    expect(restored?.name).toBe("notes.pdf");
    expect(restored?.type).toBe("application/pdf");
    expect(await restored?.text()).toBe("%PDF-1.7 notes");
  });

  test("a file over the budget is handed back to the box", async () => {
    const big = new File([new Uint8Array(600_000)], "dump.bin", { type: "application/octet-stream" });
    const { images, kept } = await encodeForStash([big]);
    expect(images).toEqual([]);
    expect(kept).toEqual([big]);
  });
});
