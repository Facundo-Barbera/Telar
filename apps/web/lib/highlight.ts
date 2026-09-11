/**
 * SYNTAX HIGHLIGHTING, THE WAY THIS APP ALREADY DOES IT.
 *
 * The transcript's fenced code blocks are highlighted by Streamdown, which uses
 * Shiki with `github-light` / `github-dark` and emits per-token CSS custom
 * properties that globals.css switches on `.dark`. So the file viewer uses the
 * SAME library, the SAME two themes and the SAME convention: a snippet quoted in
 * the conversation and the file it came from now look identical, which they did
 * not when one was highlighted and the other was flat monospace.
 *
 * TOKENS, NOT HTML. `codeToHtml` would mean `dangerouslySetInnerHTML` and a
 * pre-built `<pre>` — and the viewer needs its own line-numbered layout, so the
 * markup has to be ours. `codeToTokens` hands back the colours per token and
 * React draws them, which also means no HTML from a library is ever injected
 * into this document.
 *
 * `defaultColor: false` IS WHAT MAKES BOTH THEMES SURVIVE. With it, each token's
 * `htmlStyle` carries `--shiki-light` and `--shiki-dark` rather than one resolved
 * colour, so switching theme is a CSS variable flip with no re-tokenising and no
 * React state — see the `[data-shiki]` rules in globals.css.
 *
 * ONE HIGHLIGHTER FOR THE PAGE. Shiki's singleton loads a grammar once and keeps
 * it; a second viewer tab on the same language costs nothing. Grammars arrive as
 * their own lazy chunks, so opening one TypeScript file does not download Fortran.
 */
import type { ThemedToken } from "shiki";

const THEMES = { light: "github-light", dark: "github-dark" } as const;

/**
 * How much text is worth tokenising in a panel.
 *
 * A 500KB file is ~15,000 lines and tokenising it blocks the main thread for
 * long enough to feel like a hang — for content nobody is reading past the first
 * screen. Past this the viewer shows plain monospace and says why. The engine's
 * own read cap is 512KB (apps/engine/src/files.ts), so this is the tighter of
 * the two and the one a reader actually notices.
 */
export const MAX_HIGHLIGHT_BYTES = 128 * 1024;

/** One line, as coloured runs. `undefined` from `highlight` means "not
 *  highlighted" — the caller draws plain text, which is the honest fallback. */
export type HighlightedLine = { text: string; style: Record<string, string> }[];

/**
 * A COLOURED LAYER WITH HOLES IN IT — one entry per source line, and `undefined`
 * where this line has no tokens yet. The caller draws plain text for a hole,
 * which it already did for a file with no tokens at all.
 */
export type CarriedLines = readonly (HighlightedLine | undefined)[];

/**
 * KEEP THE COLOURS THAT ARE STILL TRUE WHILE THE NEW ONES ARE COMPUTED.
 *
 * THE BUG THIS EXISTS FOR. Tokenising is async and debounced, so between a
 * keystroke and its tokens the editor holds tokens made from text that is now
 * one character out of date. The rule used to be all-or-nothing — tokens whose
 * `of` did not match the current text were dropped entirely — and dropping them
 * repaints EVERY line of the file as plain uncoloured text until Shiki answers.
 * At typing speed that is the whole file blinking monochrome on every keystroke,
 * which is what "the colours flicker while typing" is.
 *
 * Almost none of those lines changed. Typing on line 40 of a 300-line file
 * leaves 299 lines whose text is character-for-character what it was, and their
 * tokens are still exactly right. So: match the unchanged HEAD and TAIL of the
 * file by line, carry those lines' tokens across (shifted, so an inserted line
 * moves the tail's colours down with it), and leave a hole only for the region
 * that actually changed. One line of the file goes plain for ~120ms instead of
 * all of it.
 *
 * WHAT THIS IS WILLING TO BE WRONG ABOUT, briefly. A line's tokens depend on the
 * lines before it — type `/*` on line 5 and lines 6 onward really are comments
 * now, but their text did not change, so this carries their old colours until
 * the real answer lands a moment later. That is a stale colour on a line for one
 * debounce, against a monochrome blink of the entire file on every keystroke.
 */
export function carryTokens(previous: { of: string; lines: CarriedLines }, next: string): CarriedLines {
  if (previous.of === next) return previous.lines;
  const before = previous.of.split("\n");
  const after = next.split("\n");
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head += 1;
  /** Bounded so head and tail cannot claim the same line twice — an insert at
   *  the very end would otherwise carry a line's tokens to two places. */
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  )
    tail += 1;
  const carried: (HighlightedLine | undefined)[] = new Array(after.length).fill(undefined);
  for (let at = 0; at < head; at += 1) carried[at] = previous.lines[at];
  for (let at = 0; at < tail; at += 1) carried[after.length - 1 - at] = previous.lines[before.length - 1 - at];
  return carried;
}

/**
 * Tokenise, or answer that this one should not be.
 *
 * EVERY FAILURE IS A FALLBACK, NOT AN ERROR. A grammar that will not load, a
 * language id this build of Shiki does not have, a file too big to be worth it —
 * all of them mean "show it as text", which is what the viewer was doing before
 * highlighting existed. A file viewer must never fail to show a file because it
 * could not colour it.
 */
export async function highlight(code: string, lang: string | undefined): Promise<HighlightedLine[] | undefined> {
  if (!lang || code.length > MAX_HIGHLIGHT_BYTES) return undefined;
  try {
    const { getSingletonHighlighter, bundledLanguages } = await import("shiki");
    /**
     * CHECKED AGAINST THE BUNDLE, NOT TRIED. An unknown id throws inside Shiki's
     * loader, and a typo in the kind table should degrade to plain text rather
     * than to a caught exception on every render. The narrowing is this check —
     * `lang` is an open string because it comes from a data table, and the guard
     * is what proves it is one Shiki actually ships.
     */
    if (!Object.hasOwn(bundledLanguages, lang)) return undefined;
    const id = lang as keyof typeof bundledLanguages;
    const highlighter = await getSingletonHighlighter({ themes: [THEMES.light, THEMES.dark], langs: [id] });
    const { tokens } = highlighter.codeToTokens(code, { lang: id, themes: THEMES, defaultColor: false });
    return tokens.map((line: ThemedToken[]) =>
      line.map((token) => ({ text: token.content, style: (token.htmlStyle as Record<string, string> | undefined) ?? {} })),
    );
  } catch {
    return undefined;
  }
}
