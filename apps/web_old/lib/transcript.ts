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

// --- Subagent attribution -------------------------------------------------
// Helpers backing route.ts's `forwardSubagentText` handling: naming the
// agent-spawn tool, reading its AgentInput, and flattening arbitrarily deep
// subagent nesting to the top-level spawn a tab can actually be drawn from.

// The tool the model calls to spawn a subagent isn't a stable name across
// harness versions — "Task" historically, "Agent" as of the SDK's current
// tool-schema naming (sdk-tools.d.ts's `AgentInput`). Both are checked
// against the live `init.tools` list rather than assuming either.
export const AGENT_SPAWN_TOOL_CANDIDATES = ["Agent", "Task"] as const;

// Contract: given the init message's `tools` list, returns whichever
// candidate name is actually registered for this session, or null if
// neither is (spawning unavailable/disabled). Iterates the candidate list
// (not `tools`) so that if both were ever somehow present, the current
// canonical name ("Agent") wins over the legacy one — pure lookup, no
// guessing beyond that fixed, ordered candidate list.
export function detectAgentSpawnTool(tools: string[] | undefined): string | null {
  if (!tools) return null;
  return AGENT_SPAWN_TOOL_CANDIDATES.find((c) => tools.includes(c)) ?? null;
}

// Contract: extracts the small `{ type, description, name? }` a spawn
// tool_use's part is enriched with, straight from its raw AgentInput. Input
// is model-controlled JSON, not a typed value — every field is optional and
// individually validated rather than trusted.
export function agentMetaFromInput(input: Record<string, unknown>): {
  type: string | null;
  description: string;
  name?: string;
} {
  const description = typeof input.description === "string" ? input.description : "";
  const type = typeof input.subagent_type === "string" ? input.subagent_type : null;
  const name = typeof input.name === "string" ? input.name : undefined;
  return { type, description, ...(name ? { name } : {}) };
}

// Contract: collapses subagent nesting of any depth to the nearest ancestor
// id the caller already knows about. The SDK attributes a message via
// `parent_tool_use_id`, but for a subagent's own subagent that id names the
// *inner* spawn's tool_use — one that only ever appeared nested inside an
// already-forwarded message, never as a top-level part. `noteSpawn` records,
// for each spawn tool_use seen (at any depth), which already-resolved
// ancestor it was itself created under; `resolve` then walks a raw
// parent_tool_use_id through that one-hop map to the flattened id a tab can
// be drawn from. A spawn with no recorded ancestor (i.e. a top-level one) is
// its own resolution — `resolve` falls back to the id unchanged.
export class ParentFlattener {
  private readonly ancestor = new Map<string, string>();

  resolve(parentToolUseId: string | null | undefined): string | null {
    if (!parentToolUseId) return null;
    return this.ancestor.get(parentToolUseId) ?? parentToolUseId;
  }

  // `id` is a spawn tool_use's own id; `resolvedParent` is `resolve()`'s
  // output for the message that contained it (null when that spawn is
  // itself top-level, in which case there's nothing to record — `resolve`
  // already returns `id` unchanged for it).
  noteSpawn(id: string, resolvedParent: string | null): void {
    if (resolvedParent) this.ancestor.set(id, resolvedParent);
  }
}

// Whether a spawn part's tool_result text is only the BACKGROUND LAUNCH ACK —
// the near-instant "Async agent launched successfully…" (plus internal
// plumbing addressed to the orchestrating agent), NOT the subagent's real
// result. Lived in components/conversation/items.ts (whose agentStatus still
// consumes it, re-exported); moved here because the server needs the same
// predicate: a window that ends leaves no one running, so a spawn still
// carrying only its ack must be marked stopped rather than shimmering
// "running" forever after a reload. Matched on the literal launch phrase, or
// (in case wording drifts) the "internal metadata" + "agentId" combination
// specific to this ack.
export function isAsyncLaunchAck(text: string): boolean {
  if (text.includes("Async agent launched successfully")) return true;
  return text.includes("internal metadata") && text.includes("agentId");
}
