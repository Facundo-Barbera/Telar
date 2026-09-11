/**
 * THE THINGS IN A MESSAGE THAT ARE NOT PROSE.
 *
 * A composer that only holds prose makes you spell out addresses a machine
 * already knows: the path of the file you mean, the number of the issue, the
 * name of the check that went red. Two gestures fix that — typing `@` and
 * picking, or dragging a row out of the right panel — and both produce the same
 * thing, a REFERENCE.
 *
 * MODELLED ON t3 code's composer (`packages/shared/composerTrigger.ts` and
 * `composerInlineTokens.ts`), whose central decision this file keeps: THE DRAFT
 * IS PLAIN TEXT AND ONLY PLAIN TEXT. A chip is a way of DRAWING a run of that
 * text, never a thing stored beside it. Delete the chip and the text goes with
 * it; send the message and what the agent receives is the string you could have
 * typed by hand. The alternative — chips as objects the editor resolves at send
 * time — makes `turn.input` disagree with what the model was given, which is the
 * divergence this codebase refuses everywhere else (see `drag-reference.ts`).
 *
 * TWO DELIBERATE DEVIATIONS FROM THE DONOR, both named here:
 *
 *   - ONE WIRE FORM PER KIND, and it is the one `drag-reference.ts` already
 *     defines. t3 code writes a file as a markdown link, `[driver.ts](src/…)`;
 *     Telar writes it as a backticked path, because that module explains why a
 *     backtick is what stops a model reading `apps/web/src/auth.ts` as prose,
 *     and because two spellings for one idea means two parsers and a choice at
 *     every insertion point. `@` is a TRIGGER here, not a syntax: it opens the
 *     menu and is gone by the time anything is inserted.
 *   - NO `$skill` TRIGGER. The donor lists the provider's skills and slash
 *     commands because its server asks the provider for them. Telar's engine
 *     does not expose either yet (`supportedCommands()` on the Agent SDK is
 *     unwired), and a menu of commands that do not exist is worse than no menu.
 *     `/` therefore offers what THIS composer can actually do.
 */

import type { ReferenceKind, TelarReference } from "./drag-reference";

/* ------------------------------------------------------------------ *
 * Triggers — what the caret is sitting in the middle of, right now.
 * ------------------------------------------------------------------ */

export type ComposerTriggerKind = "path" | "command";

export type ComposerTrigger = {
  kind: ComposerTriggerKind;
  /** What has been typed after the sigil, which is what gets ranked. */
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
 * Is the caret inside a `@…` or a `/…`, and what has been typed so far?
 *
 * `/` IS ANCHORED TO THE START OF A LINE and `@` is not, which is the difference
 * between the two sigils in every editor that has both: a slash mid-sentence is
 * a date, a fraction or a path separator, while an at-sign mid-sentence is
 * almost always an address. Anchoring the slash is what keeps "9/10 tests pass"
 * from opening a menu.
 *
 * SCANNING BACK FROM THE CARET, not forward from the sigil: the question is
 * "what am I in the middle of", and only the token the caret is actually inside
 * can answer it. A `@` earlier on the line that has since been completed is not
 * a live trigger, and this cannot see it.
 */
export function detectComposerTrigger(text: string, cursorInput: number): ComposerTrigger | null {
  const cursor = clampCursor(text, cursorInput);
  const lineStart = text.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
  const linePrefix = text.slice(lineStart, cursor);

  /**
   * THE WHOLE LINE AFTER THE SLASH IS THE QUERY, spaces included.
   *
   * The donor stops the command token at the first space and then adds a second
   * regex to rescue `/model <something>`, because that is the one command whose
   * argument people type. Rows here are named `/model Opus` and `/effort high`,
   * so letting the space through gives every multi-word row the same narrowing
   * for free — `/model op` reaches Opus, `/eff hi` reaches high — and removes
   * the special case rather than adding a second one.
   *
   * A line that starts with a slash and is not a command costs nothing: nothing
   * matches, so no menu opens, and Enter sends the line as written.
   */
  const command = /^\/([^\n]*)$/.exec(linePrefix);
  if (command) return { kind: "command", query: command[1] ?? "", rangeStart: lineStart, rangeEnd: cursor };

  let index = cursor - 1;
  while (index >= 0 && !isWhitespace(text[index] ?? "")) index -= 1;
  const tokenStart = index + 1;
  const token = text.slice(tokenStart, cursor);
  if (!token.startsWith("@")) return null;

  return { kind: "path", query: token.slice(1), rangeStart: tokenStart, rangeEnd: cursor };
}

/**
 * Splice a replacement into a draft and say where the caret lands.
 *
 * Returns the caret rather than leaving the caller to add lengths, because the
 * replacement is not always the length of what it replaced and every caller got
 * that arithmetic wrong at least once.
 */
export function replaceTextRange(text: string, rangeStart: number, rangeEnd: number, replacement: string): { text: string; cursor: number } {
  const safeStart = Math.max(0, Math.min(text.length, rangeStart));
  const safeEnd = Math.max(safeStart, Math.min(text.length, rangeEnd));
  return { text: `${text.slice(0, safeStart)}${replacement}${text.slice(safeEnd)}`, cursor: safeStart + replacement.length };
}

/* ------------------------------------------------------------------ *
 * Segmentation — which runs of the draft are references.
 * ------------------------------------------------------------------ */

export type ComposerSegment =
  | { type: "text"; text: string }
  /** A run of the draft that draws as a chip. `reference.text` IS `draft.slice(start, end)`. */
  | { type: "chip"; reference: TelarReference; start: number; end: number };

/**
 * IS THIS BACKTICKED RUN A PATH, OR IS IT CODE?
 *
 * Both are written the same way, so the shape has to decide, and it decides
 * conservatively: no whitespace (`git status` is a command), no scheme (a URL
 * is its own kind), no leading dash (`--force` is a flag), and then either a
 * directory separator or a short extension. Getting this wrong in the generous
 * direction costs a file icon beside something that is not a file; getting it
 * wrong in the strict direction costs nothing at all, because the text is
 * identical either way and the message is unaffected.
 */
function looksLikePath(value: string): boolean {
  if (!value || /\s/.test(value)) return false;
  if (value.includes("://") || value.startsWith("-")) return false;
  return value.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(value);
}

/**
 * What a path is called, with a directory's trailing slash KEPT.
 *
 * The slash is the whole difference between the two chips: `engine` could be a
 * file, `engine/` could not, and `directoryReference` puts it there for exactly
 * that reason. Stripping it in the label would undo the one thing the label has
 * to say.
 */
export function chipBasename(path: string): string {
  const directory = path.endsWith("/");
  const trimmed = path.replace(/\/+$/, "");
  const name = trimmed.split("/").at(-1) || trimmed;
  return directory ? `${name}/` : name;
}

/**
 * THE PATTERNS ARE THE OUTPUT OF `drag-reference.ts`, READ BACKWARDS.
 *
 * Every one of these matches a string this cockpit itself wrote — which is why
 * they can afford to be this literal. They exist for the ONE case a gesture
 * cannot cover: a draft that arrives as a string with no editor history behind
 * it, recalled from the queue or restored from a saved draft. A reference whose
 * title happens to contain a double quote falls out of the pattern and renders
 * as plain text; the message is unchanged, so that is a missing decoration
 * rather than a bug to defend against.
 *
 * ORDER MATTERS AND IS ENCODED BY POSITION: a pull request's text contains an
 * issue's text, so `PR #82 "…"` must be offered first and win on its earlier
 * start. Overlap resolution below is "earliest start wins", so listing the
 * longer form first is not enough on its own — but a PR match starts two
 * characters before the `#`, so it does.
 */
const PATTERNS: { kind: ReferenceKind; pattern: RegExp; label: (match: RegExpExecArray) => string }[] = [
  { kind: "pull", pattern: /PR #(\d+) "[^"]*" \(\S+?\)/g, label: (match) => `PR #${match[1]}` },
  { kind: "issue", pattern: /#(\d+) "[^"]*" \(\S+?\)/g, label: (match) => `#${match[1]}` },
  { kind: "task", pattern: /the "([^"]*)" sub-agent \([^)]*\)/g, label: (match) => match[1] ?? "sub-agent" },
  // A page the session's browser has open — `browserPageReference`. Starts
  // before its own URL, so it wins the overlap against the bare-URL pattern.
  { kind: "page", pattern: /the "([^"]*)" page open in the session's browser \(\S+?\)/g, label: (match) => match[1] || "page" },
  // The head line only. A failing check drags its log in as a fenced block
  // underneath, and a chip that swallowed the fence would hide the thing the
  // reader dropped it FOR.
  { kind: "check", pattern: /the "([^"]*)" check \([^)]*\)(?: — \S+)?/g, label: (match) => match[1] ?? "check" },
  // A project note, whose body follows in a fence for the same reason and is
  // left out of the chip for the same one — see `noteReference`. The id shape is
  // literal (`n-` plus hex) so a sentence that merely says "the X project note"
  // is prose, not a half-recognised reference.
  { kind: "note", pattern: /the "([^"]*)" project note \(n-[0-9a-f]+\)/g, label: (match) => match[1] || "note" },
  { kind: "file", pattern: /`([^`\n]+)`/g, label: (match) => chipBasename(match[1] ?? "") },
  { kind: "page", pattern: /https?:\/\/\S+/g, label: (match) => match[0].replace(/^https?:\/\//, "").replace(/\/$/, "") },
];

/**
 * A BARE URL DOES NOT OWN THE PUNCTUATION AFTER IT. `\S+` happily swallows the
 * `)` of a sentence the URL sits inside — and then the chip's text is a URL
 * that 404s. Trailing sentence punctuation is peeled off; a closing paren stays
 * only while the URL itself still has an unmatched `(` (Wikipedia-style paths).
 */
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

/**
 * Cut a draft into the runs that draw as chips and the prose between them.
 *
 * PURE, AND OFFSET-FAITHFUL: every segment carries where it came from, and
 * concatenating the segments' source text reproduces the draft exactly. The
 * editor relies on that to map a caret position back onto the string.
 */
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

  // Earliest start wins, and a longer match wins a shared start — which is what
  // keeps a URL inside an issue reference from being torn out of it.
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

/**
 * A DIRECTORY IS NOT A FILE, and the trailing slash is how the chip knows.
 *
 * Same rule `directoryReference` writes into the text in the first place, read
 * back out here so a dropped folder and a typed one draw the same glyph.
 */
export function chipIsDirectory(reference: TelarReference): boolean {
  return reference.kind === "file" && chipPath(reference).endsWith("/");
}

/** The path a file chip stands for, without its backticks. For the tooltip,
 *  which is the only place the full address is worth the width. */
export function chipPath(reference: TelarReference): string {
  return reference.text.replace(/^`|`$/g, "");
}
