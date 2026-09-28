import type { ThemedToken } from "shiki";

const THEMES = { light: "github-light", dark: "github-dark" } as const;

export const MAX_HIGHLIGHT_BYTES = 128 * 1024;

export type HighlightedLine = { text: string; style: Record<string, string> }[];

export type CarriedLines = readonly (HighlightedLine | undefined)[];

export function carryTokens(previous: { of: string; lines: CarriedLines }, next: string): CarriedLines {
  if (previous.of === next) return previous.lines;
  const before = previous.of.split("\n");
  const after = next.split("\n");
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head += 1;
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

export async function highlight(code: string, lang: string | undefined): Promise<HighlightedLine[] | undefined> {
  if (!lang || code.length > MAX_HIGHLIGHT_BYTES) return undefined;
  try {
    const { getSingletonHighlighter, bundledLanguages } = await import("shiki");
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
