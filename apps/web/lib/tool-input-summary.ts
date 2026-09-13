/**
 * WHAT A TOOL CALL WAS ABOUT, in one line.
 *
 * A transcript row is a verb and its salient argument — "Ran command · bun
 * test", "Read file · apps/web/lib/looks.ts". A tool call from an MCP server or
 * a plugin had no argument the lane knew how to read, so both halves fell back
 * to the tool's name and the row said "ds_scratch ds_scratch" (#354). Twice is
 * worse than once: the repetition reads as a bug in the row, and the space it
 * takes was the space the argument should have had.
 *
 * INPUT SHAPES BELONG TO THE SERVERS, not to this contract — `ToolCallDetail`
 * says as much, and keeps `input` as `unknown` on purpose. So this cannot know
 * any particular tool, and it does not try: it looks for the field that a call
 * is USUALLY about, in the order those fields are usually the point, and shows
 * the first line of it. A server whose input matches none of them gets its
 * first named value rather than an invented summary, and a call with no input
 * at all gets nothing — the row is then the tool's name, once.
 */

/**
 * The fields a call is usually about, most-specific first.
 *
 * `code` before `path` is the one ordering that matters and it is the reported
 * case: a scratch cell carries both the code and the file it would write, and
 * the code is what the reader is trying to recognise.
 */
const SALIENT_KEYS = [
  "code",
  "script",
  "source",
  "command",
  "cmd",
  "query",
  "sql",
  "pattern",
  "path",
  "file_path",
  "filePath",
  "file",
  "paths",
  "url",
  "expression",
  "prompt",
  "text",
  "message",
  "content",
  "body",
  "title",
  "name",
] as const;

/** The first line with anything on it. A row is one line tall; the rest of the
 *  payload is behind the row's own disclosure. */
function firstLine(text: string): string | undefined {
  const line = text.split(/\r?\n/).map((candidate) => candidate.trim()).find((candidate) => candidate.length > 0);
  return line;
}

/** A value worth printing beside a tool's name, or nothing. Objects are never
 *  flattened — a nested blob rendered inline is the payload, not a summary. */
function scalarText(value: unknown): string | undefined {
  if (typeof value === "string") return firstLine(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const parts = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
    return parts.length > 0 ? parts.join(", ") : undefined;
  }
  return undefined;
}

export function toolInputSummary(input: unknown): string | undefined {
  if (typeof input === "string") return firstLine(input);
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  for (const key of SALIENT_KEYS) {
    const summary = scalarText(record[key]);
    if (summary) return summary;
  }
  /**
   * NAMED, because nothing here is self-describing. A path or a line of code
   * says what it is; `session_399fbd…` on its own says nothing, and the key it
   * arrived under is the only thing that makes it readable.
   */
  for (const [key, value] of Object.entries(record)) {
    const summary = scalarText(value);
    if (summary) return `${key}: ${summary}`;
  }
  return undefined;
}
