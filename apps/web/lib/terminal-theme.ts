/**
 * WHAT THE LOOK CONTRIBUTES TO A TERMINAL, AND WHAT IT DELIBERATELY DOES NOT
 * (#198).
 *
 * Three colours and a font. That is the whole of it, and the cut is measured
 * rather than lazy: `lib/looks.ts`, `lib/theme-palettes.ts` and
 * `lib/appearance.ts` carry no sixteen-colour ANSI set between them, and they
 * are not growing one. The owner's prompt (oh-my-posh catppuccin_frappe) and
 * his syntax highlighting are TRUECOLOR and bypass a palette entirely, so a
 * per-Look ANSI set would be sixteen more values to maintain that his own
 * terminal would never draw with.
 *
 * SO THE ANSI SIXTEEN ARE CONSTANTS — xterm.js's own defaults, restated here so
 * the theme is one readable object — and `overrides` is how anything changes
 * them. No speculative `--terminal-ansi-*` variables: a hook with no caller is
 * a hook nobody has tested.
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
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
};

/**
 * xterm.js's own sixteen, verbatim. A terminal whose palette disagrees with
 * every other terminal renders other people's programs wrongly — `ls --color`'s
 * blue directory is meant to be THE blue.
 */
const ANSI_16 = {
  black: "#2e3436",
  red: "#cc0000",
  green: "#4e9a06",
  yellow: "#c4a000",
  blue: "#3465a4",
  magenta: "#75507b",
  cyan: "#06989a",
  white: "#d3d7cf",
  brightBlack: "#555753",
  brightRed: "#ef2929",
  brightGreen: "#8ae234",
  brightYellow: "#fce94f",
  brightBlue: "#729fcf",
  brightMagenta: "#ad7fa8",
  brightCyan: "#34e2e2",
  brightWhite: "#eeeeec",
} as const;

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

/** The Look's three colours and xterm's sixteen, as one theme object. */
export function terminalTheme(read: CssVarReader, overrides: Partial<TerminalTheme> = {}): TerminalTheme {
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
    ...ANSI_16,
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
 * not a font. Nothing here asks anyone to install anything: the chain only ever
 * uses what is already on the machine.
 */
export function terminalFont(read: CssVarReader): { fontFamily: string; fontSize: number } {
  const family = read("--app-font-mono")?.trim();
  const rawSize = read("--app-font-mono-size")?.trim();
  const parsed = rawSize === undefined ? Number.NaN : Number.parseFloat(rawSize);
  const appMono = family !== undefined && family !== "" ? family : undefined;
  return {
    fontFamily: [...NERD_FONTS, ...(appMono ? [appMono] : []), PLATFORM_MONO].join(", "),
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
