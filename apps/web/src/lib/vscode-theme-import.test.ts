// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import {
  contrastRatio,
  flattenOver,
  humanizeThemeName,
  isVsCodeThemeFile,
  parseVsCodeColor,
  vsCodeThemeToDefinition,
  vsCodeThemeToHalf,
} from "./vscode-theme-import";
import { TELAR_DARK, TELAR_LIGHT } from "./theme-palettes";

describe("parseVsCodeColor", () => {
  test("expands the short forms", () => {
    expect(parseVsCodeColor("#abc")).toEqual({ r: 170, g: 187, b: 204, a: 1 });
    expect(parseVsCodeColor("#abcf")).toEqual({ r: 170, g: 187, b: 204, a: 1 });
  });

  test("reads the long forms, alpha included", () => {
    expect(parseVsCodeColor("#1e1e1e")).toEqual({ r: 30, g: 30, b: 30, a: 1 });
    expect(parseVsCodeColor("#1e1e1e80")).toEqual({ r: 30, g: 30, b: 30, a: 128 / 255 });
  });

  test("a missing hash is still a colour; anything else is not", () => {
    expect(parseVsCodeColor("1e1e1e")).toEqual({ r: 30, g: 30, b: 30, a: 1 });
    expect(parseVsCodeColor("#12345")).toBeNull();
    expect(parseVsCodeColor("rebeccapurple")).toBeNull();
    // The wide-gamut path is deliberately out of scope.
    expect(parseVsCodeColor("color(display-p3 1 0 0)")).toBeNull();
    expect(parseVsCodeColor(undefined)).toBeNull();
    expect(parseVsCodeColor(0x1e1e1e)).toBeNull();
  });
});

describe("flattenOver", () => {
  test("an opaque colour ignores the surface under it", () => {
    expect(flattenOver({ r: 255, g: 0, b: 0, a: 1 }, { r: 0, g: 0, b: 0 })).toBe("#ff0000");
  });

  test("half alpha lands halfway to the base", () => {
    expect(flattenOver({ r: 255, g: 255, b: 255, a: 0.5 }, { r: 0, g: 0, b: 0 })).toBe("#808080");
  });

  test("fully transparent is the base", () => {
    expect(flattenOver({ r: 255, g: 0, b: 0, a: 0 }, { r: 30, g: 30, b: 30 })).toBe("#1e1e1e");
  });
});

describe("contrastRatio", () => {
  test("the WCAG extremes", () => {
    expect(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 })).toBeCloseTo(21, 5);
    expect(contrastRatio({ r: 30, g: 30, b: 30 }, { r: 30, g: 30, b: 30 })).toBeCloseTo(1, 5);
  });
});

describe("isVsCodeThemeFile", () => {
  test("dotted workbench keys, or a tokenColors array", () => {
    expect(isVsCodeThemeFile({ colors: { "editor.background": "#1e1e1e" } })).toBe(true);
    expect(isVsCodeThemeFile({ tokenColors: [] })).toBe(true);
  });

  test("Telar's own export is not one", () => {
    expect(isVsCodeThemeFile({ label: "Mine", light: TELAR_LIGHT, dark: TELAR_DARK })).toBe(false);
    expect(isVsCodeThemeFile({ colors: { background: "#fff" } })).toBe(false);
    expect(isVsCodeThemeFile(null)).toBe(false);
    expect(isVsCodeThemeFile([{ colors: {} }])).toBe(false);
  });
});

describe("humanizeThemeName", () => {
  test("slugs become words", () => {
    expect(humanizeThemeName("one-dark-pro")).toBe("One Dark Pro");
    expect(humanizeThemeName("night_owl.light")).toBe("Night Owl Light");
  });

  test("a name that already reads as words is left alone", () => {
    expect(humanizeThemeName("  Solarized Light  ")).toBe("Solarized Light");
    expect(humanizeThemeName("Dracula")).toBe("Dracula");
  });

  test("punctuation-only humanizes to nothing, so the caller can fall through", () => {
    expect(humanizeThemeName("---")).toBe("");
  });
});

describe("vsCodeThemeToHalf — mode", () => {
  test("the declared type wins", () => {
    // A dark canvas declared light: the file's own word is taken at face value.
    expect(vsCodeThemeToHalf({ type: "light", colors: { "editor.background": "#1e1e1e" } }).mode).toBe("light");
    expect(vsCodeThemeToHalf({ type: "hc-light", colors: { "editor.background": "#1e1e1e" } }).mode).toBe("light");
    expect(vsCodeThemeToHalf({ type: "hc-black", colors: { "editor.background": "#ffffff" } }).mode).toBe("dark");
  });

  test("an untyped theme follows its editor luminance", () => {
    expect(vsCodeThemeToHalf({ colors: { "editor.background": "#1e1e1e" } }).mode).toBe("dark");
    expect(vsCodeThemeToHalf({ colors: { "editor.background": "#fafafa" } }).mode).toBe("light");
    expect(vsCodeThemeToHalf({ type: "sepia", colors: { "editor.background": "#fafafa" } }).mode).toBe("light");
  });
});

describe("vsCodeThemeToHalf — the floor", () => {
  test("a file with only a canvas keeps Telar's every other token", () => {
    const { half, label } = vsCodeThemeToHalf({ type: "dark", colors: { "editor.background": "#1e1e1e" } });
    expect(half.background).toBe("#1e1e1e");
    expect(half.border).toBe(TELAR_DARK.border);
    expect(half.input).toBe(TELAR_DARK.input);
    expect(half.sidebar).toBe(TELAR_DARK.sidebar);
    expect(half["sidebar-accent"]).toBe(TELAR_DARK["sidebar-accent"]);
    // Telar's dark text reads on #1e1e1e, so the floor survives the repair.
    expect(half.foreground).toBe(TELAR_DARK.foreground);
    expect(label).toBe("VS Code theme");
  });

  test("no editor.background is a named failure, not a silent palette", () => {
    expect(() => vsCodeThemeToHalf({ type: "dark", colors: { foreground: "#ffffff" } })).toThrow(/editor\.background/);
    expect(() => vsCodeThemeToHalf("nope")).toThrow();
  });
});

describe("vsCodeThemeToHalf — the overlay", () => {
  test("each token reads from its own workbench keys", () => {
    const { half } = vsCodeThemeToHalf({
      type: "dark",
      colors: {
        "editor.background": "#1e1e1e",
        "editorWidget.background": "#252526",
        "menu.background": "#2d2d30",
        "textCodeBlock.background": "#0a0a0a",
        "list.hoverBackground": "#2a2d2e",
        "panel.border": "#303031",
        "input.border": "#3c3c3c",
        "sideBar.background": "#181818",
      },
    });
    expect(half.card).toBe("#252526");
    expect(half.popover).toBe("#2d2d30");
    expect(half.secondary).toBe("#0a0a0a");
    expect(half.muted).toBe("#0a0a0a");
    expect(half.accent).toBe("#2a2d2e");
    expect(half.border).toBe("#303031");
    expect(half.input).toBe("#3c3c3c");
    expect(half.sidebar).toBe("#181818");
  });

  test("a translucent overlay flattens onto the canvas it sits on", () => {
    const { half } = vsCodeThemeToHalf({
      type: "dark",
      // 50% white over black is mid grey; over the canvas, not over nothing.
      colors: { "editor.background": "#000000", "editorWidget.background": "#ffffff80" },
    });
    expect(half.card).toBe("#808080");
  });

  test("the rail's hover flattens over the RESOLVED rail, not the canvas", () => {
    const { half } = vsCodeThemeToHalf({
      type: "dark",
      colors: {
        "editor.background": "#000000",
        "sideBar.background": "#404040",
        "list.inactiveSelectionBackground": "#ffffff80",
      },
    });
    expect(half.sidebar).toBe("#404040");
    // Over the canvas this would be #808080; over the rail it is lighter.
    expect(half["sidebar-accent"]).toBe("#a0a0a0");
  });
});

describe("vsCodeThemeToHalf — contrast repair", () => {
  test("an unreadable editor.foreground is refused in favour of the floor", () => {
    const { half } = vsCodeThemeToHalf({
      type: "dark",
      // Nearly the canvas itself: the theme's own chrome may cope, ours will not.
      colors: { "editor.background": "#1e1e1e", "editor.foreground": "#242424" },
    });
    expect(half.foreground).toBe(TELAR_DARK.foreground);
  });

  test("a readable editor.foreground wins", () => {
    const { half } = vsCodeThemeToHalf({
      type: "dark",
      colors: { "editor.background": "#1e1e1e", "editor.foreground": "#d4d4d4" },
    });
    expect(half.foreground).toBe("#d4d4d4");
  });

  test("overriding a surface strands the floor's text, and the greyscale end-stop catches it", () => {
    const { half } = vsCodeThemeToHalf({
      type: "dark",
      // A light card inside a dark theme: neither the canvas text nor Telar's
      // dark card text reads on it.
      colors: { "editor.background": "#1e1e1e", "editorWidget.background": "#fdfdfd" },
    });
    expect(half.card).toBe("#fdfdfd");
    expect(half["card-foreground"]).toBe("#000000");
  });

  test("the canvas text carries to surfaces it still reads on", () => {
    const { half } = vsCodeThemeToHalf({
      type: "dark",
      colors: { "editor.background": "#1e1e1e", "editor.foreground": "#d4d4d4", "menu.background": "#2d2d30" },
    });
    expect(half["popover-foreground"]).toBe("#d4d4d4");
  });

  test("muted text falls back when descriptionForeground is too faint", () => {
    const faint = vsCodeThemeToHalf({
      type: "dark",
      colors: { "editor.background": "#1e1e1e", descriptionForeground: "#282828" },
    });
    expect(faint.half["muted-foreground"]).toBe(TELAR_DARK["muted-foreground"]);
    const usable = vsCodeThemeToHalf({
      type: "dark",
      colors: { "editor.background": "#1e1e1e", descriptionForeground: "#9d9d9d" },
    });
    expect(usable.half["muted-foreground"]).toBe("#9d9d9d");
  });
});

describe("vsCodeThemeToDefinition", () => {
  test("the untouched half stays Telar's base verbatim", () => {
    const theme = vsCodeThemeToDefinition({
      name: "one-dark-pro",
      type: "dark",
      colors: { "editor.background": "#282c34" },
    });
    expect(theme.label).toBe("One Dark Pro");
    expect(theme.dark.background).toBe("#282c34");
    expect(theme.light).toEqual(TELAR_LIGHT);
  });

  test("a light file fills the light half and leaves the dark one home", () => {
    const theme = vsCodeThemeToDefinition({
      displayName: "Solarized Light",
      type: "light",
      colors: { "editor.background": "#fdf6e3" },
    });
    expect(theme.label).toBe("Solarized Light");
    expect(theme.light.background).toBe("#fdf6e3");
    expect(theme.dark).toEqual(TELAR_DARK);
  });
});
