// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { describeViewport, fitViewport, parseViewportInput, presetFor, resizeByDrag, resizeByKey, sizeFromFields, stageOf, VIEWPORT_PRESETS, VIEWPORT_RAIL } from "./browser-viewport";

describe("the browser viewport vocabulary", () => {
  test("presets are named from their size, and a custom size is just its numbers", () => {
    expect(presetFor({ width: 1280, height: 800 })).toBe("default");
    expect(presetFor({ width: 390, height: 844 })).toBe("phone");
    expect(presetFor({ width: 1000, height: 700 })).toBeUndefined();
    expect(describeViewport({ width: 1280, height: 800 }, "fixed")).toBe("Default · 1280×800");
    expect(describeViewport({ width: 1000, height: 700 }, "fixed")).toBe("1000×700");
    expect(describeViewport({ width: 640, height: 400 })).toBe("Fit panel · 640×400");
    expect(describeViewport({ width: 640, height: 400 }, "fit")).toBe("Fit panel · 640×400");
    // The host's table and this one must agree, or a preset picked here is
    // "custom" there.
    expect(VIEWPORT_PRESETS.map((preset) => [preset.key, preset.width, preset.height])).toEqual([
      ["default", 1280, 800],
      ["laptop", 1440, 900],
      ["tablet", 768, 1024],
      ["phone", 390, 844],
    ]);
  });

  test("a typed size is read in the usual spellings and clamped to what the host accepts", () => {
    expect(parseViewportInput("1024x768")).toEqual({ width: 1024, height: 768 });
    expect(parseViewportInput(" 1024 × 768 ")).toEqual({ width: 1024, height: 768 });
    expect(parseViewportInput("1024, 768")).toEqual({ width: 1024, height: 768 });
    expect(parseViewportInput("50x99999")).toEqual({ width: 200, height: 5000 });
    expect(parseViewportInput("wide")).toBeUndefined();
    expect(parseViewportInput("1024")).toBeUndefined();
  });

  test("the stage reserves the rail, and fit scales down, centres across and top-aligns — the same arithmetic as the host", () => {
    expect(stageOf({ width: 652, height: 412 })).toEqual({ width: 640, height: 400 });
    expect(VIEWPORT_RAIL).toBe(12);
    expect(fitViewport({ width: 1280, height: 800 }, { width: 640, height: 400 })).toEqual({ scale: 0.5, x: 0, y: 0, width: 640, height: 400 });
    // A stage taller than the fitted page: the page starts at the top, like
    // a device toolbar's screen, not centred over a band of nothing.
    expect(fitViewport({ width: 1280, height: 800 }, { width: 640, height: 600 })).toEqual({ scale: 0.5, x: 0, y: 0, width: 640, height: 400 });
    expect(fitViewport({ width: 390, height: 844 }, { width: 1000, height: 900 })).toEqual({ scale: 1, x: 305, y: 0, width: 390, height: 844 });
  });
});

describe("the resize rails' math", () => {
  test("a screen-pixel drag is divided by the presentation scale, per axis the rail controls", () => {
    expect(resizeByDrag({ width: 1280, height: 800 }, { x: 100, y: 40 }, 0.5, "east")).toEqual({ width: 1480, height: 800 });
    expect(resizeByDrag({ width: 1280, height: 800 }, { x: 100, y: 40 }, 0.5, "south")).toEqual({ width: 1280, height: 880 });
    expect(resizeByDrag({ width: 1280, height: 800 }, { x: 100, y: 40 }, 0.5, "southeast")).toEqual({ width: 1480, height: 880 });
    expect(resizeByDrag({ width: 1280, height: 800 }, { x: -30, y: 0 }, 1, "east")).toEqual({ width: 1250, height: 800 });
  });

  test("drags are clamped to the host's limits and a bad scale counts as 1", () => {
    expect(resizeByDrag({ width: 210, height: 800 }, { x: -500, y: 0 }, 1, "east")).toEqual({ width: 200, height: 800 });
    expect(resizeByDrag({ width: 4990, height: 800 }, { x: 500, y: 0 }, 1, "east")).toEqual({ width: 5000, height: 800 });
    expect(resizeByDrag({ width: 1280, height: 800 }, { x: 10, y: 0 }, 0, "east")).toEqual({ width: 1290, height: 800 });
  });

  test("arrow keys step 10 (50 with Shift) on the rail's own axes only, and answer nothing at the clamp", () => {
    expect(resizeByKey({ width: 1280, height: 800 }, "ArrowRight", false, "east")).toEqual({ width: 1290, height: 800 });
    expect(resizeByKey({ width: 1280, height: 800 }, "ArrowLeft", true, "east")).toEqual({ width: 1230, height: 800 });
    expect(resizeByKey({ width: 1280, height: 800 }, "ArrowDown", false, "south")).toEqual({ width: 1280, height: 810 });
    expect(resizeByKey({ width: 1280, height: 800 }, "ArrowUp", false, "east")).toBeUndefined();
    expect(resizeByKey({ width: 1280, height: 800 }, "ArrowDown", false, "southeast")).toEqual({ width: 1280, height: 810 });
    expect(resizeByKey({ width: 200, height: 800 }, "ArrowLeft", false, "east")).toBeUndefined();
    expect(resizeByKey({ width: 1280, height: 800 }, "Enter", false, "east")).toBeUndefined();
  });
});

/**
 * THE DEVICE TOOLBAR'S TWO FIELDS (#473). They commit on submit and on blur,
 * so the rule that matters is which drafts are a size at all: a page relaid
 * out at 1px on the way to 1024 is a page that reflowed for nothing.
 */
describe("the device toolbar's size fields", () => {
  test("two whole numbers are a size, clamped like every other way in", () => {
    expect(sizeFromFields("1024", "768")).toEqual({ width: 1024, height: 768 });
    expect(sizeFromFields("  390 ", "844")).toEqual({ width: 390, height: 844 });
    // The host's own limits, so the toolbar cannot ask for what it refuses.
    expect(sizeFromFields("10", "10")).toEqual({ width: 200, height: 200 });
    expect(sizeFromFields("99999", "99999")).toEqual({ width: 5000, height: 5000 });
  });

  test("a field still being typed into is not a size — it commits nothing", () => {
    expect(sizeFromFields("", "768")).toBeUndefined();
    expect(sizeFromFields("1024", "")).toBeUndefined();
    expect(sizeFromFields("   ", "   ")).toBeUndefined();
  });

  test("and neither is anything that is not digits", () => {
    // `Number` would take every one of these; a size somebody typed is digits.
    expect(sizeFromFields("1e3", "768")).toBeUndefined();
    expect(sizeFromFields("0x10", "768")).toBeUndefined();
    expect(sizeFromFields("-100", "768")).toBeUndefined();
    expect(sizeFromFields("102.4", "768")).toBeUndefined();
    expect(sizeFromFields("wide", "768")).toBeUndefined();
  });
});
