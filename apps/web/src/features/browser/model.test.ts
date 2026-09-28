import { describe, expect, test } from "bun:test";
import {
  ADDRESS_CONTROLS,
  ADDRESS_INPUT_FLOOR,
  ADDRESS_ROW_PADDING,
  ADDRESS_TOOLS,
  addressInputRoom,
  addressRowFitsTools,
  describeDownload,
  zoomLabel,
} from "./model";

describe("the address row's width budget", () => {
  const row = (panel: number) => panel - ADDRESS_ROW_PADDING;

  test("at the panel's default 510px the input clears the floor — the issue's acceptance", () => {
    expect(addressInputRoom(row(510))).toBeGreaterThanOrEqual(ADDRESS_INPUT_FLOOR);
  });

  test("and at the 420px panel #319 was actually filed about", () => {
    expect(addressInputRoom(row(420))).toBeGreaterThanOrEqual(ADDRESS_INPUT_FLOOR);
  });

  test("the budget is the row's eight children and the seven gaps between them", () => {
    expect(ADDRESS_CONTROLS).toBe(4 * 22 + 18 + 44 + 22 + 7 * 4);
  });

  test("a wider panel is only ever roomier — nothing on this row grows with width", () => {
    for (let width = 200; width < 900; width += 1) {
      expect(addressInputRoom(width + 1)).toBe(addressInputRoom(width) + 1);
    }
  });
});

describe("the two folding tool glyphs", () => {
  const row = (panel: number) => panel - ADDRESS_ROW_PADDING;

  test("they cost two glyphs and the two gaps before them", () => {
    expect(ADDRESS_TOOLS).toBe(2 * 22 + 2 * 4);
  });

  test("at the panel's default 510px the row carries them and the input still clears the floor", () => {
    expect(addressRowFitsTools(row(510))).toBe(true);
    expect(addressInputRoom(row(510), true)).toBeGreaterThanOrEqual(ADDRESS_INPUT_FLOOR);
  });

  test("at the 420px panel #319 was filed about they fold — the input wins", () => {
    expect(addressRowFitsTools(row(420))).toBe(false);
    expect(addressInputRoom(row(420), true)).toBeLessThan(ADDRESS_INPUT_FLOOR);
    expect(addressInputRoom(row(420))).toBe(addressInputRoom(row(420), false));
  });

  test("the fold is monotone: a row that fits them keeps fitting them as it widens", () => {
    let seen = false;
    for (let width = 200; width < 900; width += 1) {
      const fits = addressRowFitsTools(width);
      if (fits) seen = true;
      expect(!seen || fits).toBe(true);
    }
    expect(seen).toBe(true);
  });
});

describe("the download strip's sentence", () => {
  const base = { scopeKey: "s", tabId: "t", path: "/fixture/Downloads/report.pdf", filename: "report.pdf" };
  test("a finished download names its folder; the rest say what happened", () => {
    expect(describeDownload({ ...base, state: "completed" })).toBe("Downloaded report.pdf to /fixture/Downloads");
    expect(describeDownload({ ...base, state: "started" })).toBe("Downloading report.pdf…");
    expect(describeDownload({ ...base, state: "interrupted" })).toBe("Download of report.pdf failed.");
    expect(describeDownload({ ...base, state: "cancelled" })).toBe("Download of report.pdf was cancelled.");
  });
});

describe("the options menu's zoom readout", () => {
  test("it is a whole percentage, and a tab with no factor yet reads 100%", () => {
    expect(zoomLabel(1)).toBe("100%");
    expect(zoomLabel(1.1)).toBe("110%");
    expect(zoomLabel(0.67)).toBe("67%");
    expect(zoomLabel(undefined)).toBe("100%");
    expect(zoomLabel(0)).toBe("100%");
    expect(zoomLabel(Number.NaN)).toBe("100%");
  });
});
