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
