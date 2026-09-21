// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cssColorReader, terminalFont, terminalTheme, type CssVarReader } from "@/lib/terminal-theme";

// Only `cssColorReader` needs one — everything above it is pure, which is the
// point of the injected reader. Registered at module scope and handed back in
// `afterAll`, because the registrator refuses a second registration and the
// suite shares a process.
GlobalRegistrator.register({ url: "http://localhost/" });
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const reader = (values: Record<string, string>): CssVarReader => (variable) => values[variable];

describe("terminalTheme", () => {
  test("the three the Look owns come from the Look", () => {
    const theme = terminalTheme(reader({ "--card": "#101214", "--foreground": "#e8e8e8", "--primary": "#7aa2f7" }));
    expect(theme.background).toBe("#101214");
    expect(theme.foreground).toBe("#e8e8e8");
    expect(theme.cursor).toBe("#7aa2f7");
    // The caret's own text colour is the surface under it, so a character
    // inside the block stays legible whatever accent the Look carries.
    expect(theme.cursorAccent).toBe("#101214");
  });

  test("`--card`, not `--background` — the panel draws on the raised surface", () => {
    const theme = terminalTheme(reader({ "--card": "#1a1a1a", "--background": "#000000" }));
    expect(theme.background).toBe("#1a1a1a");
  });

  test("a stylesheet that answers nothing still yields a usable terminal", () => {
    // A server render, or a test. xterm throws on a colour it cannot parse, so
    // "no answer" has to become a colour rather than an empty string.
    const theme = terminalTheme(reader({}));
    expect(theme.background).toMatch(/^#[0-9a-f]{6}$/);
    expect(theme.foreground).toMatch(/^#[0-9a-f]{6}$/);
    expect(theme.cursor).toMatch(/^#[0-9a-f]{6}$/);
  });

  test("an empty variable is not an answer", () => {
    // `getPropertyValue` returns "" for an unset property, and handing that to
    // xterm is what would throw.
    expect(terminalTheme(reader({ "--card": "   " })).background).toMatch(/^#[0-9a-f]{6}$/);
  });

  test("all sixteen ANSI colours are present, because a missing one renders as the default fg", () => {
    const theme = terminalTheme(reader({}));
    const ansi = [
      "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
      "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
    ] as const;
    for (const name of ansi) expect(theme[name]).toMatch(/^#[0-9a-f]{6}$/);
    // Sixteen DISTINCT colours: a palette with duplicates is one where `ls
    // --color` cannot tell a directory from a symlink.
    expect(new Set(ansi.map((name) => theme[name])).size).toBe(16);
  });

  test("the Look does not reach the ANSI sixteen — that cut is deliberate", () => {
    // No Look in this app carries an ANSI palette (looks.ts, theme-palettes.ts,
    // appearance.ts), and if one day one appears it must come through
    // `overrides` rather than by these silently reading a new variable.
    const withLook = terminalTheme(reader({ "--card": "#000", "--foreground": "#fff", "--primary": "#f0f" }));
    const without = terminalTheme(reader({}));
    expect(withLook.red).toBe(without.red);
    expect(withLook.brightBlue).toBe(without.brightBlue);
  });

  test("overrides win, which is what `overridable defaults` means", () => {
    const theme = terminalTheme(reader({}), { red: "#ff0000", background: "#123456" });
    expect(theme.red).toBe("#ff0000");
    expect(theme.background).toBe("#123456");
  });
});

describe("terminalFont", () => {
  test("the size is the cockpit's; the face is a chain with the person's Nerd Fonts ahead of the cockpit's mono", () => {
    // `appearance.ts:111` already documents `fontMonoSize` as covering "the
    // terminal", so the SIZE reads that token. The FACE does not: a terminal is
    // the person's, so an installed Nerd Font (which is what draws a prompt's and
    // `eza --icons`'s glyphs) comes before whatever Appearance chose for the
    // cockpit, and the platform monospace closes the chain. The assertion is on
    // ORDER, not equality: equality with the app font is the old behaviour.
    const font = terminalFont(reader({ "--app-font-mono": '"Fira Code", monospace', "--app-font-mono-size": "13px" }));
    const at = (needle: string) => font.fontFamily.indexOf(needle);
    expect(at('"JetBrainsMono Nerd Font"')).toBe(0);
    expect(at('"Fira Code"')).toBeGreaterThan(at('"MesloLGS NF"'));
    expect(at("ui-monospace")).toBeGreaterThan(at('"Fira Code"'));
    expect(font.fontSize).toBe(13);
  });

  test("a size that is not a size falls back rather than collapsing the grid", () => {
    // xterm computes rows and columns from the font size; a 0 or a NaN is not a
    // small terminal, it is a division by zero in the fit addon.
    for (const value of ["", "0px", "-4px", "inherit", "3px"]) {
      expect(terminalFont(reader({ "--app-font-mono-size": value })).fontSize).toBeGreaterThanOrEqual(6);
    }
  });

  test("no tokens at all still yields a monospace family", () => {
    expect(terminalFont(reader({})).fontFamily).toContain("monospace");
  });
});

describe("cssColorReader", () => {
  /** A canvas whose 2D context behaves like a browser's: it keeps a colour it
   *  can parse and IGNORES one it cannot, which is the behaviour the sentinel
   *  pair exists to see through. */
  function canvasOf(parse: (value: string) => string | undefined) {
    let current = "#000000";
    const context = {
      get fillStyle() {
        return current;
      },
      set fillStyle(value: string) {
        const parsed = parse(value);
        if (parsed !== undefined) current = parsed;
      },
    };
    return { getContext: () => context } as unknown as HTMLCanvasElement;
  }

  /** A real element carrying a real custom property, because the variable half
   *  goes through `getComputedStyle` and a stub of that would be testing the
   *  stub. */
  function convert(raw: string, parse: (value: string) => string | undefined): string | undefined {
    const element = document.createElement("div");
    element.style.setProperty("--probe", raw);
    document.body.append(element);
    try {
      return cssColorReader(element, canvasOf(parse))("--probe");
    } finally {
      element.remove();
    }
  }

  test("a colour space xterm cannot parse comes back as one it can", () => {
    // `--card` is `oklch(0.2 0 0)` in this app; xterm handles #rgb and rgb()
    // and throws on the rest, so the canvas is what makes the Look usable.
    expect(convert("oklch(0.2 0 0)", (value) => (value.startsWith("oklch") ? "#2b2b2b" : value))).toBe("#2b2b2b");
  });

  test("a value the browser REFUSES answers nothing, rather than the last colour set", () => {
    // This is the whole reason for two sentinels. A rejected `fillStyle` leaves
    // the previous value in place, so a single assignment would hand back
    // whichever sentinel ran last and call it the Look's background — and
    // `terminalTheme` would then treat a parse failure as a deliberate black.
    expect(convert("not-a-colour", (value) => (value.startsWith("#") ? value : undefined))).toBeUndefined();
  });

  test("with no canvas the raw value is passed through, and the fallbacks protect xterm", () => {
    const element = document.createElement("div");
    element.style.setProperty("--card", "oklch(0.2 0 0)");
    document.body.append(element);
    try {
      expect(cssColorReader(element, null)("--card")).toBe("oklch(0.2 0 0)");
    } finally {
      element.remove();
    }
  });
});
