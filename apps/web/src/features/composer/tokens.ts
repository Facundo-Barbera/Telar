// The draft is plain text only; a chip is a way of drawing a run of it, never
// something stored beside it, so what the agent receives is the typed string.
import type { ReferenceKind, TelarReference } from "./drag-reference";

type ComposerTriggerKind = "path" | "command" | "skill";

export type ComposerTrigger = {
  kind: ComposerTriggerKind;
  query: string;
  /** The half-open range the accepted candidate replaces, sigil included. */
  rangeStart: number;
  rangeEnd: number;
};

function isWhitespace(char: string): boolean {
  return char === " " || char === "\n" || char === "\t" || char === "\r";
}

function clampCursor(text: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return text.length;
  return Math.max(0, Math.min(text.length, Math.floor(cursor)));
}

/**
 * `/` is anchored to the start of a line (so "9/10" never opens a menu), `@` is not,
 * and `$` must start a word and not be `${` so shell snippets don't trigger it.
 */
export function detectComposerTrigger(text: string, cursorInput: number): ComposerTrigger | null {
  const cursor = clampCursor(text, cursorInput);
  const lineStart = text.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
  const linePrefix = text.slice(lineStart, cursor);

  // The whole line after the slash is the query, spaces included, so `/model op` narrows multi-word rows.
  const command = /^\/([^\n]*)$/.exec(linePrefix);
  if (command) return { kind: "command", query: command[1] ?? "", rangeStart: lineStart, rangeEnd: cursor };

  let index = cursor - 1;
  while (index >= 0 && !isWhitespace(text[index] ?? "")) index -= 1;
  const tokenStart = index + 1;
  const token = text.slice(tokenStart, cursor);
  if (token.startsWith("@")) return { kind: "path", query: token.slice(1), rangeStart: tokenStart, rangeEnd: cursor };
  // The token scan walks back to whitespace, so a `$` mid-token (`PATH=$HOME`) never matches.
  if (token.startsWith("$") && !token.startsWith("${")) {
    return { kind: "skill", query: token.slice(1), rangeStart: tokenStart, rangeEnd: cursor };
  }
  return null;
}

/** Splice a replacement into a draft and return where the caret lands. */
export function replaceTextRange(text: string, rangeStart: number, rangeEnd: number, replacement: string): { text: string; cursor: number } {
  const safeStart = Math.max(0, Math.min(text.length, rangeStart));
  const safeEnd = Math.max(safeStart, Math.min(text.length, rangeEnd));
  return { text: `${text.slice(0, safeStart)}${replacement}${text.slice(safeEnd)}`, cursor: safeStart + replacement.length };
}

type ComposerSegment =
  | { type: "text"; text: string }
  /** A run of the draft that draws as a chip. `reference.text` IS `draft.slice(start, end)`. */
  | { type: "chip"; reference: TelarReference; start: number; end: number };

/** Conservative: no whitespace, scheme or leading dash, then a separator or short extension. */
function looksLikePath(value: string): boolean {
  if (!value || /\s/.test(value)) return false;
  if (value.includes("://") || value.startsWith("-")) return false;
  return value.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(value);
}

/** A path's basename, keeping a directory's trailing slash. */
export function chipBasename(path: string): string {
  const directory = path.endsWith("/");
  const trimmed = path.replace(/\/+$/, "");
  const name = trimmed.split("/").at(-1) || trimmed;
  return directory ? `${name}/` : name;
}

/**
 * The output of `drag-reference.ts` read backwards, for drafts restored as plain strings.
 * Order matters: a PR's text contains an issue's, and the PR match starts earlier.
 */
const PATTERNS: { kind: ReferenceKind; pattern: RegExp; label: (match: RegExpExecArray) => string }[] = [
  { kind: "pull", pattern: /PR #(\d+) "[^"]*" \(\S+?\)/g, label: (match) => `PR #${match[1]}` },
  { kind: "issue", pattern: /#(\d+) "[^"]*" \(\S+?\)/g, label: (match) => `#${match[1]}` },
  { kind: "task", pattern: /the "([^"]*)" sub-agent \([^)]*\)/g, label: (match) => match[1] ?? "sub-agent" },
  // `skillReference`. The literal name shape keeps prose like `the "old way" skill` out.
  { kind: "skill", pattern: /the "([A-Za-z0-9][A-Za-z0-9:._-]*)" skill/g, label: (match) => match[1] ?? "skill" },
  // `browserPageReference`. Starts before its URL, so it wins over the bare-URL pattern.
  { kind: "page", pattern: /the "([^"]*)" page open in the session's browser \(\S+?\)/g, label: (match) => match[1] || "page" },
  // Head line only, so the fenced log below stays visible.
  { kind: "check", pattern: /the "([^"]*)" check \([^)]*\)(?: — \S+)?/g, label: (match) => match[1] ?? "check" },
  // `noteReference`; head line only. The literal `n-` + hex id keeps prose out.
  { kind: "note", pattern: /the "([^"]*)" project note \(n-[0-9a-f]+\)/g, label: (match) => match[1] || "note" },
  { kind: "file", pattern: /`([^`\n]+)`/g, label: (match) => chipBasename(match[1] ?? "") },
  { kind: "page", pattern: /https?:\/\/\S+/g, label: (match) => match[0].replace(/^https?:\/\//, "").replace(/\/$/, "") },
];

/** Peels trailing sentence punctuation; a `)` stays only while the URL has an unmatched `(`. */
function trimUrlEnd(url: string): string {
  let end = url.length;
  while (end > 0) {
    const char = url[end - 1]!;
    if (!/[),.;:!?'"]/.test(char)) break;
    if (char === ")") {
      const body = url.slice(0, end - 1);
      const opens = (body.match(/\(/g) ?? []).length;
      const closes = (body.match(/\)/g) ?? []).length;
      if (opens > closes) break;
    }
    end -= 1;
  }
  return url.slice(0, end);
}

/** Offset-faithful: concatenating segments reproduces the draft, which the editor's caret mapping relies on. */
export function segmentDraft(draft: string): ComposerSegment[] {
  if (!draft) return [];

  const found: { start: number; end: number; reference: TelarReference }[] = [];
  for (const { kind, pattern, label } of PATTERNS) {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(draft); match; match = pattern.exec(draft)) {
      let text = match[0];
      if (kind === "file") {
        const inner = match[1] ?? "";
        if (!looksLikePath(inner)) continue;
      }
      if (kind === "page" && text.startsWith("http")) text = trimUrlEnd(text);
      const chipLabel = kind === "page" && text.startsWith("http") ? text.replace(/^https?:\/\//, "").replace(/\/$/, "") : label(match);
      found.push({ start: match.index, end: match.index + text.length, reference: { kind, label: chipLabel, text } });
    }
  }

  // Earliest start wins, then the longer match, so a URL inside an issue reference stays in it.
  found.sort((left, right) => left.start - right.start || right.end - left.end);

  const segments: ComposerSegment[] = [];
  let cursor = 0;
  for (const hit of found) {
    if (hit.start < cursor) continue;
    if (hit.start > cursor) segments.push({ type: "text", text: draft.slice(cursor, hit.start) });
    segments.push({ type: "chip", reference: hit.reference, start: hit.start, end: hit.end });
    cursor = hit.end;
  }
  if (cursor < draft.length) segments.push({ type: "text", text: draft.slice(cursor) });
  return segments;
}

/** The trailing slash `directoryReference` writes is how a chip knows it is a directory. */
export function chipIsDirectory(reference: TelarReference): boolean {
  return reference.kind === "file" && chipPath(reference).endsWith("/");
}

/** The path a file chip stands for, without its backticks. */
export function chipPath(reference: TelarReference): string {
  return reference.text.replace(/^`|`$/g, "");
}
