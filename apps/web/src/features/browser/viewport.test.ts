// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { describeViewport, fitViewport, groupedViewportPresets, keepRatio, parseViewportInput, presetFor, RESIZE_DIRECTIONS, resizeByKey, resizeToEdge, sizeFromFields, stageOf, stepField, viewportPreset, VIEWPORT_PRESETS, VIEWPORT_RAIL, zoomFits, type ViewportPresetEntryKey } from "./viewport";

describe("the browser viewport vocabulary", () => {
  test("presets are named from their size, and a custom size is just its numbers", () => {
    expect(presetFor({ width: 1280, height: 800 })).toBe("default");
    expect(presetFor({ width: 390, height: 844 })).toBe("iphone-12-pro");
    expect(presetFor({ width: 1000, height: 700 })).toBeUndefined();
    expect(describeViewport({ width: 1280, height: 800 }, "fixed")).toBe("Default · 1280×800");
    expect(describeViewport({ width: 390, height: 844 }, "fixed")).toBe("iPhone 12/13 Pro · 390×844");
    expect(describeViewport({ width: 1000, height: 700 }, "fixed")).toBe("1000×700");
    expect(describeViewport({ width: 640, height: 400 })).toBe("Fit panel · 640×400");
    expect(describeViewport({ width: 640, height: 400 }, "fit")).toBe("Fit panel · 640×400");
  });

  test("the shared table is grouped, and the older names still resolve", () => {
    // The host requires this same file; the hand-written key union in
    // viewport-presets.d.ts must not drift from the table.
    const keys: ViewportPresetEntryKey[] = [
      "iphone-se", "iphone-12-pro", "iphone-14-pro-max", "pixel-7", "galaxy-s8-plus",
      "ipad-mini", "ipad-air", "ipad-pro", "surface-pro-7",
      "default", "small-laptop", "laptop", "full-hd",
      "galaxy-z-fold-5", "surface-duo",
    ];
    expect(VIEWPORT_PRESETS.map((preset) => preset.key)).toEqual(keys);
    expect(groupedViewportPresets().map((group) => [group.label, group.presets.length])).toEqual([
      ["Phones", 5],
      ["Tablets", 4],
      ["Desktop", 4],
      ["Foldables", 2],
    ]);
    expect(viewportPreset("phone")?.key).toBe("iphone-12-pro");
    expect(viewportPreset("tablet")?.key).toBe("ipad-mini");
    expect(viewportPreset("laptop")).toMatchObject({ width: 1440, height: 900 });
  });

  test("a typed size is read in the usual spellings and clamped to what the host accepts", () => {
    expect(parseViewportInput("1024x768")).toEqual({ width: 1024, height: 768 });
    expect(parseViewportInput(" 1024 × 768 ")).toEqual({ width: 1024, height: 768 });
    expect(parseViewportInput("1024, 768")).toEqual({ width: 1024, height: 768 });
    expect(parseViewportInput("50x99999")).toEqual({ width: 200, height: 5000 });
    expect(parseViewportInput("wide")).toBeUndefined();
    expect(parseViewportInput("1024")).toBeUndefined();
  });

  test("the stage reserves a rail on every side, and fit scales down and centres on both axes — the same arithmetic as the host", () => {
    expect(stageOf({ width: 664, height: 424 })).toEqual({ x: 12, y: 12, width: 640, height: 400 });
    expect(VIEWPORT_RAIL).toBe(12);
    expect(fitViewport({ width: 1280, height: 800 }, { width: 640, height: 400 })).toEqual({ scale: 0.5, x: 0, y: 0, width: 640, height: 400 });
    expect(fitViewport({ width: 1280, height: 800 }, { width: 640, height: 600 })).toEqual({ scale: 0.5, x: 0, y: 100, width: 640, height: 400 });
    expect(fitViewport({ width: 390, height: 844 }, { width: 1000, height: 900 })).toEqual({ scale: 1, x: 305, y: 28, width: 390, height: 844 });
  });

  test("the fitted rect never reaches past the stage — the frame and the frozen frame are drawn only there", () => {
    for (const viewport of VIEWPORT_PRESETS) {
      for (const stage of [{ width: 975, height: 794 }, { width: 640, height: 1200 }, { width: 1600, height: 500 }, { width: 333, height: 333 }]) {
        const fit = fitViewport(viewport, stage);
        expect(fit.x + fit.width).toBeLessThanOrEqual(stage.width);
        expect(fit.y + fit.height).toBeLessThanOrEqual(stage.height);
        // Centred: the two margins on an axis differ by at most a pixel.
        expect(Math.abs(stage.width - fit.width - 2 * fit.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(stage.height - fit.height - 2 * fit.y)).toBeLessThanOrEqual(1);
        expect(Math.abs(fit.height - viewport.height * fit.scale)).toBeLessThanOrEqual(0.5);
      }
    }
  });

  test("a picked zoom shows the page at that scale, but never past fit", () => {
    expect(fitViewport({ width: 390, height: 844 }, { width: 1000, height: 900 }, 0.5)).toEqual({ scale: 0.5, x: 402, y: 239, width: 195, height: 422 });
    // 100% of a page larger than the stage is not something the native view
    // can show, so it stays at fit — and the toolbar offers it disabled.
    expect(fitViewport({ width: 1280, height: 800 }, { width: 640, height: 400 }, 1).scale).toBe(0.5);
    expect(zoomFits(1, { width: 1280, height: 800 }, { width: 640, height: 400 })).toBe(false);
    expect(zoomFits(0.5, { width: 1280, height: 800 }, { width: 640, height: 400 })).toBe(true);
    expect(zoomFits("fit", { width: 1280, height: 800 }, { width: 10, height: 10 })).toBe(true);
  });
});

/** Where the grabbed edge lands on screen for a size, measured from the
 *  page's centre — the inverse the drag solves for. */
function edgeOf(size: { width: number; height: number }, stage: { width: number; height: number }) {
  const fit = fitViewport(size, stage);
  return { x: fit.width / 2, y: fit.height / 2 };
}

describe("the resize rails' math", () => {
  const stage = { width: 1000, height: 800 };

  test("while the page fits, the dragged edge lands under the pointer on every side and corner", () => {
    const start = { width: 600, height: 500 };
    for (const direction of RESIZE_DIRECTIONS) {
      const next = resizeToEdge(start, direction, { x: 350, y: 300 }, stage);
      const edge = edgeOf(next, stage);
      if (direction.endsWith("east") || direction.endsWith("west")) expect(Math.abs(edge.x - 350)).toBeLessThanOrEqual(1);
      else expect(next.width).toBe(600);
      if (direction.startsWith("north") || direction.startsWith("south")) expect(Math.abs(edge.y - 300)).toBeLessThanOrEqual(1);
      else expect(next.height).toBe(500);
    }
  });

  test("centred, the page grows on both sides: moving the edge d px widens it 2d", () => {
    expect(resizeToEdge({ width: 600, height: 500 }, "east", { x: 310, y: 0 }, stage)).toEqual({ width: 620, height: 500 });
    expect(resizeToEdge({ width: 600, height: 500 }, "north", { x: 0, y: 240 }, stage)).toEqual({ width: 600, height: 480 });
  });

  test("a page scaled down by its OTHER axis still follows the pointer, at the scale it is shown at", () => {
    // 1600 tall in an 800 stage: shown at 0.5, so 300px on screen is 600 CSS.
    const next = resizeToEdge({ width: 600, height: 1600 }, "east", { x: 150, y: 0 }, stage);
    expect(next).toEqual({ width: 600, height: 1600 });
    const wider = resizeToEdge({ width: 600, height: 1600 }, "east", { x: 200, y: 0 }, stage);
    expect(wider).toEqual({ width: 800, height: 1600 });
    expect(Math.abs(edgeOf(wider, stage).x - 200)).toBeLessThanOrEqual(1);
  });

  test("past the stage the edge cannot follow, but the size keeps growing without a jump", () => {
    const atCap = resizeToEdge({ width: 600, height: 500 }, "east", { x: 500, y: 0 }, stage);
    const past = resizeToEdge({ width: 600, height: 500 }, "east", { x: 520, y: 0 }, stage);
    expect(atCap.width).toBe(1000);
    expect(past.width).toBeGreaterThan(1000);
    expect(past.width).toBeLessThan(1100);
    expect(edgeOf(past, stage).x).toBeLessThanOrEqual(500);
  });

  test("a locked ratio keeps its shape from edges and corners", () => {
    const start = { width: 400, height: 800 };
    const east = resizeToEdge(start, "east", { x: 150, y: 0 }, stage, true);
    expect(east).toEqual({ width: 300, height: 600 });
    expect(edgeOf(east, stage).x).toBe(150);
    // The height reaches the stage first (at 400×800), so past it the edge
    // stops following while the size keeps its shape.
    const past = resizeToEdge(start, "east", { x: 250, y: 0 }, stage, true);
    expect(past.width / past.height).toBe(0.5);
    expect(edgeOf(past, stage).x).toBe(200);
    const corner = resizeToEdge(start, "southwest", { x: 150, y: 350 }, stage, true);
    expect(corner.width / corner.height).toBeCloseTo(0.5, 2);
  });

  test("under a picked zoom the edge still lands under the pointer", () => {
    const next = resizeToEdge({ width: 600, height: 500 }, "east", { x: 200, y: 0 }, stage, false, 0.5);
    expect(next).toEqual({ width: 800, height: 500 });
    expect(fitViewport(next, stage, 0.5).width / 2).toBe(200);
  });

  test("drags are clamped to the host's limits, even across the centre", () => {
    expect(resizeToEdge({ width: 600, height: 500 }, "west", { x: -40, y: 0 }, stage)).toEqual({ width: 200, height: 500 });
    expect(resizeToEdge({ width: 600, height: 500 }, "southeast", { x: 90_000, y: 90_000 }, stage)).toEqual({ width: 5000, height: 5000 });
  });

  test("arrow keys step 10 (50 with Shift) outward on the rail's own axes, and answer nothing at the clamp", () => {
    expect(resizeByKey({ width: 1280, height: 800 }, "ArrowRight", false, "east")).toEqual({ width: 1290, height: 800 });
    expect(resizeByKey({ width: 1280, height: 800 }, "ArrowLeft", true, "east")).toEqual({ width: 1230, height: 800 });
    expect(resizeByKey({ width: 1280, height: 800 }, "ArrowLeft", false, "west")).toEqual({ width: 1290, height: 800 });
    expect(resizeByKey({ width: 1280, height: 800 }, "ArrowUp", false, "north")).toEqual({ width: 1280, height: 810 });
    expect(resizeByKey({ width: 1280, height: 800 }, "ArrowDown", false, "south")).toEqual({ width: 1280, height: 810 });
    expect(resizeByKey({ width: 1280, height: 800 }, "ArrowUp", false, "east")).toBeUndefined();
    expect(resizeByKey({ width: 1280, height: 800 }, "ArrowDown", false, "southeast")).toEqual({ width: 1280, height: 810 });
    expect(resizeByKey({ width: 400, height: 800 }, "ArrowRight", false, "east", true)).toEqual({ width: 410, height: 820 });
    expect(resizeByKey({ width: 200, height: 800 }, "ArrowLeft", false, "east")).toBeUndefined();
    expect(resizeByKey({ width: 1280, height: 800 }, "Enter", false, "east")).toBeUndefined();
  });
});

describe("the size fields' keys and the ratio lock", () => {
  test("↑/↓ step 1, 10 with Shift, within the host's limits", () => {
    expect(stepField("1024", "ArrowUp", false)).toBe("1025");
    expect(stepField("1024", "ArrowDown", true)).toBe("1014");
    expect(stepField("205", "ArrowDown", true)).toBe("200");
    expect(stepField("4999", "ArrowUp", true)).toBe("5000");
    expect(stepField("", "ArrowUp", false)).toBeUndefined();
    expect(stepField("1024", "Enter", false)).toBeUndefined();
  });

  test("a locked ratio makes the other field follow the one that changed", () => {
    expect(keepRatio({ width: 800, height: 800 }, { width: 400, height: 800 }, 0.5)).toEqual({ width: 800, height: 1600 });
    expect(keepRatio({ width: 400, height: 400 }, { width: 400, height: 800 }, 0.5)).toEqual({ width: 200, height: 400 });
    expect(keepRatio({ width: 400, height: 800 }, { width: 400, height: 800 }, 0.5)).toEqual({ width: 400, height: 800 });
  });
});

/** The fields commit on submit and blur, so only a complete draft is a size. */
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
