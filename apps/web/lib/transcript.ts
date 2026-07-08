// Truncation helpers for tool-call transcripts streamed over SSE (the "tool"
// and "tool_result" events in app/api/chat/route.ts) and persisted on the
// Part["tool"] shape in lib/store.ts. Pure and side-effect free by design —
// both call sites funnel through here so the size caps never drift apart.

export const TOOL_INPUT_CAP = 4000; // JSON.stringify(input).length ceiling
export const TOOL_OUTPUT_CAP = 2500; // extracted output text ceiling

function marker(removedChars: number): string {
  return `… (+${removedChars} chars)`;
}

// Head-truncates `text` to `keep` Unicode code points (iterating a string
// yields code points, so surrogate-pair/astral characters are never split),
// appending a marker describing what was cut. `keep` is clamped to
// [0, length]. Returns `text` unchanged when nothing needs to be removed.
function headTruncate(text: string, keep: number): string {
  const chars = Array.from(text);
  const clamped = Math.max(0, Math.min(keep, chars.length));
  const removed = chars.length - clamped;
  if (removed <= 0) return text;
  return chars.slice(0, clamped).join("") + marker(removed);
}

// Binary-searches the largest head-length for `obj[key]` whose resulting
// JSON.stringify(obj) fits within `cap`. Binary search (rather than a fixed
// ratio) sidesteps having to reason about JSON escaping and multi-byte
// characters changing the byte/char math.
function shrinkFieldToFit(
  obj: Record<string, unknown>,
  key: string,
  cap: number,
): string {
  const original = obj[key] as string;
  const length = Array.from(original).length;
  let lo = 0;
  let hi = length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = headTruncate(original, mid);
    const size = JSON.stringify({ ...obj, [key]: candidate }).length;
    if (size <= cap) lo = mid;
    else hi = mid - 1;
  }
  return headTruncate(original, lo);
}

// Contract: SSE "tool" event input, size-capped. Returns `input` unchanged
// (same reference) when JSON.stringify(input).length is already <= cap;
// otherwise returns a shallow copy with its largest top-level string fields
// head-truncated — largest first — until the whole object's JSON.stringify
// fits within `cap`. Non-string fields (numbers, nested objects/arrays) are
// left as-is; if there are no string fields left to shrink and the object is
// still oversized, this is a best-effort no-op beyond the shallow copy.
export function capToolInput(
  input: Record<string, unknown>,
  cap: number = TOOL_INPUT_CAP,
): Record<string, unknown> {
  if (JSON.stringify(input).length <= cap) return input;

  const result: Record<string, unknown> = { ...input };
  const stringKeys = Object.keys(result)
    .filter((k) => typeof result[k] === "string")
    .sort((a, b) => (result[b] as string).length - (result[a] as string).length);

  for (const key of stringKeys) {
    if (JSON.stringify(result).length <= cap) break;
    result[key] = shrinkFieldToFit(result, key, cap);
  }
  return result;
}

// Contract: extracts plain text from a tool_result block's `content`, which
// per the Anthropic message shape is either a plain string or an array of
// content blocks. Only `{ type: "text" }` blocks contribute — other block
// types (images, etc.) are dropped silently — and their text is concatenated
// in order, with no separator inserted.
export function extractToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (b): b is { type: "text"; text: string } =>
        !!b && typeof b === "object" && b.type === "text" && typeof b.text === "string",
    )
    .map((b) => b.text)
    .join("");
}

// Contract: tool_result output text cap — a flat character-count cap on the
// already-extracted text, independent of capToolInput's JSON-size cap.
export function capToolOutput(text: string, cap: number = TOOL_OUTPUT_CAP): string {
  return headTruncate(text, cap);
}
