/**
 * WHAT THE APP CONTRIBUTES TO A TERMINAL, AND WHAT IT DELIBERATELY DOES NOT
 * (#198).
 *
 * FOUR COLOURS AND A FONT: background, foreground, cursor and its accent, plus
 * the selection wash. THE SIXTEEN ANSI COLOURS ARE NOT OURS. They are the
 * emulator's, exactly as they are in every desktop terminal where the app
 * chrome and the terminal palette are separate things — and exactly as they are
 * in T3 Code, which renders nvim correctly and contributes background,
 * foreground, cursor and selection and nothing else.
 *
 * WHY THIS IS A CHANGE. This module used to restate xterm.js's sixteen as
 * constants "so the theme is one readable object". A hand-copied table is a
 * table that drifts: the owner opened nvim and the palette was wrong, because
 * the copy is what every ANSI-colouring program (his prompt, `ls`, a
 * statusline) painted with. Omitting a key is not a gap — xterm.js fills each
 * of the sixteen from its own `DEFAULT_ANSI_COLORS` when the theme object does
 * not carry it (`ThemeService._setTheme`: `ansi = DEFAULT_ANSI_COLORS.slice()`,
 * then `ansi[n] = v(theme.black, DEFAULT_ANSI_COLORS[n])`, where `v` returns
 * its fallback for `undefined`). So the shortest correct table is no table.
 *
 * `overrides` still accepts ANSI keys, so a future Look that genuinely carries
 * a palette can supply one without this module growing speculative
 * `--terminal-ansi-*` variables nobody has tested.
 *
 * AND WHAT IT LOOKS LIKE UNDER A LIGHT LOOK IS NOT OURS TO FIX. The owner's
 * `~/.zshrc` hardcodes `ZSH_AUTOSUGGEST_HIGHLIGHT_STYLE="fg=#666666"`, which is
 * very nearly invisible on a light background. That is correct behaviour: we
 * were asked for his colour and we drew his colour. No correction pass, no
 * injected shell config, no prompt wrapper — see docs/terminal-host.md §1.
 */

/** The slice of xterm's `ITheme` this builds. Declared structurally rather than
 *  imported, so the builder and its tests never pull the emulator in. */
export type TerminalTheme = {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
};

/**
 * What a caller may override on top of the five above: the ANSI sixteen, each
 * optional, and typed here only so a Look that one day carries a palette has a
 * name for the shape. Nothing in this app supplies them — the emulator's own
 * defaults stand.
 */
export type TerminalAnsiOverrides = Partial<
  Record<
    | "black" | "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "white"
    | "brightBlack" | "brightRed" | "brightGreen" | "brightYellow"
    | "brightBlue" | "brightMagenta" | "brightCyan" | "brightWhite",
    string
  >
>;

/**
 * The three the Look owns, and where each comes from.
 *
 * `--card` rather than `--background` for the surface: the right panel draws on
 * the raised surface, and a terminal painting the window's base colour would
 * read as a hole in it. The fallbacks are what a caller gets where there is no
 * stylesheet at all (a test, a server render) — not a second opinion about the
 * Look.
 */
const LOOK_TOKENS = {
  background: { variable: "--card", fallback: "#111111" },
  foreground: { variable: "--foreground", fallback: "#eeeeee" },
  /** The caret takes the accent. Every other terminal defaults it to the
   *  foreground, which on a block cursor is a solid bar the same colour as the
   *  text around it — findable, but not at a glance. */
  cursor: { variable: "--primary", fallback: "#729fcf" },
} as const;

/**
 * Reads one CSS custom property.
 *
 * INJECTED, AND THAT IS THE POINT: resolving a variable needs a live document,
 * and a colour the app writes as `oklch()` needs a second step on top of that.
 * Passing the reader in leaves this module pure and puts both DOM calls in one
 * named place below.
 */
export type CssVarReader = (variable: string) => string | undefined;

/**
 * The four colours the app owns (plus the selection wash), as one theme object.
 * No ANSI keys: leaving them out is what hands the sixteen back to xterm.js.
 */
export function terminalTheme(
  read: CssVarReader,
  overrides: Partial<TerminalTheme> & TerminalAnsiOverrides = {},
): TerminalTheme & TerminalAnsiOverrides {
  const look = (token: keyof typeof LOOK_TOKENS): string => {
    const { variable, fallback } = LOOK_TOKENS[token];
    const value = read(variable);
    return value !== undefined && value.trim() !== "" ? value.trim() : fallback;
  };
  const background = look("background");
  return {
    background,
    foreground: look("foreground"),
    cursor: look("cursor"),
    // The block cursor's own text colour: the surface under it, so a character
    // sitting inside the caret stays legible whichever accent the Look carries.
    cursorAccent: background,
    // Not a Look token, and deliberately not the accent: a selection has to be
    // visible over the background AND over whatever truecolour the shell
    // painted, and a solid accent would hide the text it is selecting.
    selectionBackground: "rgba(120, 150, 200, 0.3)",
    ...overrides,
  };
}

/** Anything below this is a rendering artefact rather than a font size. */
const MIN_FONT_SIZE = 6;
const DEFAULT_FONT_SIZE = 12;

/**
 * THE PERSON'S FONT FIRST, THE COCKPIT'S SECOND.
 *
 * Nerd Fonts a person is likely to have installed, in the order they are
 * likely to have installed them. CSS font-family fallback resolves the first
 * one present at render time, so no detection code and no setting: a machine
 * with JetBrainsMono Nerd Font draws the prompt's and `eza --icons`'s glyphs
 * with it; a machine with none of these falls through to the cockpit's mono
 * face and then the platform's.
 */
/**
 * THE ONE FACE TELAR SHIPS, AND WHY SHIPPING A FONT IS NOT A CONTRADICTION OF
 * "THE CHAIN ONLY USES WHAT IS ALREADY ON THE MACHINE".
 *
 * `SymbolsNerdFontMono-Regular.woff2` (Nerd Fonts, MIT, beside its LICENCE in
 * `public/fonts/`) carries NO text glyphs — no letters, no digits, no
 * punctuation. It is the private-use ranges only: powerline separators,
 * devicons, the symbols a prompt and `eza --icons` draw with. A face with no
 * text glyphs cannot change a single cell's metrics, because it never wins a
 * character the text face can draw. So it goes at the FRONT of the chain and
 * composes with whatever text face follows it.
 *
 * That is what makes it not a font choice: nothing about the terminal's
 * appearance moves, and the person's own Nerd Font — if they have one — still
 * draws every symbol it covers, since the two agree on the codepoints. What
 * changes is the machine with none installed, which used to render tofu.
 *
 * No setting. A setting here would be asking someone to decide whether they
 * want squares instead of icons. T3 Code vendors the same file for the same
 * reason.
 */
export const TERMINAL_SYMBOLS_FONT = "Symbols Nerd Font Mono";
const TERMINAL_SYMBOLS_FONT_URL = "/fonts/SymbolsNerdFontMono-Regular.woff2";

/** One load per page, shared by every terminal. Held as the PROMISE rather than
 *  a boolean so a second terminal opening mid-download waits for the same
 *  download instead of starting another. */
let symbolsFontLoad: Promise<void> | null = null;

/**
 * Register the bundled symbols face, once, lazily — and never fail.
 *
 * FAILURE IS A LOOK, NOT AN ERROR. No network, a 404 from a packaged build, an
 * engine with no `FontFace`: each of those means the chain falls through to a
 * locally installed Nerd Font or to tofu, which is exactly where this app was
 * before. A terminal that refused to open because a decoration did not download
 * would be the worse outcome by a long way.
 */
export function ensureTerminalSymbolsFont(): Promise<void> {
  if (symbolsFontLoad !== null) return symbolsFontLoad;
  symbolsFontLoad = (async () => {
    try {
      const face = new FontFace(TERMINAL_SYMBOLS_FONT, `url(${TERMINAL_SYMBOLS_FONT_URL})`);
      document.fonts.add(await face.load());
    } catch {
      // Whatever is installed locally still applies.
    }
  })();
  return symbolsFontLoad;
}

/**
 * The symbols face, plus the rest of the chain at the size the terminal will
 * draw at — awaited BEFORE the first `fit()`.
 *
 * WHY BEFORE THE FIT. xterm measures one cell to derive cols and rows. Measure
 * it while a face is still downloading and the grid is sized against the
 * fallback, then the real face arrives and every cell is a fraction off: a
 * prompt that wraps one column early, and a `fit()` nobody asked for. Loading
 * first costs a frame and buys a grid measured against what is actually drawn.
 *
 * Swallows everything, for the same reason as above.
 */
export async function loadTerminalFonts(fontFamily: string, fontSize: number): Promise<void> {
  await ensureTerminalSymbolsFont();
  try {
    await document.fonts.load(`${fontSize}px ${fontFamily}`);
  } catch {
    // A chain this parser dislikes, or no Font Loading API at all (a test DOM).
    // Locally installed faces need no loading; the rest will arrive when it does.
  }
}

const NERD_FONTS = [
  '"JetBrainsMono Nerd Font"',
  '"JetBrainsMonoNL Nerd Font"',
  '"CaskaydiaCove Nerd Font"',
  '"FiraCode Nerd Font"',
  '"Hack Nerd Font"',
  '"MesloLGS NF"',
] as const;

const PLATFORM_MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

/**
 * The size is the cockpit's — `appearance.ts:111` documents `fontMonoSize` as
 * covering "the terminal". The FACE is a chain, and the cockpit's mono face is
 * the middle of it, not the front.
 *
 * This used to return the Appearance font alone, with a comment calling the
 * resulting tofu in `eza --icons` "the owner's choice in Settings ▸ Appearance".
 * That was backwards. Appearance picks the cockpit's font; a terminal is the
 * person's, and `docs/terminal-host.md` §1 says we contribute a font *fallback*,
 * not a font. Nothing here asks anyone to install anything: the chain uses what
 * is already on the machine, ahead of it the one symbols-only face Telar ships
 * (`TERMINAL_SYMBOLS_FONT`, which draws no text and therefore displaces no text
 * face), and behind it the platform's own monospace.
 */
export function terminalFont(read: CssVarReader): { fontFamily: string; fontSize: number } {
  const family = read("--app-font-mono")?.trim();
  const rawSize = read("--app-font-mono-size")?.trim();
  const parsed = rawSize === undefined ? Number.NaN : Number.parseFloat(rawSize);
  const appMono = family !== undefined && family !== "" ? family : undefined;
  return {
    fontFamily: [`"${TERMINAL_SYMBOLS_FONT}"`, ...NERD_FONTS, ...(appMono ? [appMono] : []), PLATFORM_MONO].join(", "),
    fontSize: Number.isFinite(parsed) && parsed >= MIN_FONT_SIZE ? parsed : DEFAULT_FONT_SIZE,
  };
}

/** Custom properties as the stylesheet resolved them, verbatim. */
export function cssVariableReader(element: Element): CssVarReader {
  const styles = getComputedStyle(element);
  return (variable) => {
    const raw = styles.getPropertyValue(variable).trim();
    return raw === "" ? undefined : raw;
  };
}

/** Two colours no palette would coincidentally resolve to both of. */
const SENTINELS = ["#000000", "#ffffff"] as const;

/**
 * The same reader, with every colour pushed through a canvas first.
 *
 * WHY THE CANVAS. `--card` is `oklch(0.2 0 0)`; xterm's colour parser handles
 * `#rgb`, `#rrggbb`, `rgb()` and `rgba()` and THROWS on anything else.
 * Assigning to `fillStyle` makes the browser's own CSS colour parser do the
 * conversion and hand back exactly the set xterm accepts — and it keeps working
 * the day the palette moves to a colour space that does not exist yet.
 *
 * Without a canvas (no 2D context — a test, an old engine) the raw value is
 * returned and `terminalTheme`'s fallbacks are what protect xterm, which is why
 * those fallbacks are plain hex.
 */
export function cssColorReader(element: Element, canvas?: HTMLCanvasElement | null): CssVarReader {
  const read = cssVariableReader(element);
  const context = canvas?.getContext("2d") ?? undefined;
  if (!context) return read;
  return (variable) => {
    const raw = read(variable);
    if (raw === undefined) return undefined;
    /**
     * A `fillStyle` the parser REJECTS is silently ignored — the previous value
     * stays — so assigning alone cannot tell "converted" from "refused", and
     * the refused case would hand back whatever colour was there before. Two
     * sentinels settle it: a value that comes back the same from both was
     * really parsed; one that comes back as each sentinel in turn never was.
     */
    context.fillStyle = SENTINELS[0];
    context.fillStyle = raw;
    const first = context.fillStyle;
    context.fillStyle = SENTINELS[1];
    context.fillStyle = raw;
    if (typeof first !== "string" || first !== context.fillStyle) return undefined;
    return first;
  };
}
