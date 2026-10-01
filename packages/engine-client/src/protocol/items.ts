import { z } from "zod";
import { Artifact } from "../agent-tools/schema";
import { Id, ProviderRefs, RateLimitType, Timestamp, TurnAttachment } from "./common";
import { NotificationDetail, WakeReason } from "./entities";

export const ToolItemType = z.enum([
  /** A shell command. Claude's Bash, Codex's exec_command. */
  "command_execution",
  /** A file written, edited or patched. */
  "file_change",
  /** A file read. Separate from file_change because reading is approvable on
   *  its own in read-restricted postures, and because it is far more common. */
  "file_read",
  /** A tool from a configured MCP server. */
  "mcp_tool_call",
  /** A provider built-in that is not one of the above (WebFetch, Glob, …). */
  "dynamic_tool_call",
  "web_search",
  /** The engine's browser acting on a page. See ./events.ts `browser.*`. */
  "browser_action",
]);
export type ToolItemType = z.infer<typeof ToolItemType>;

export const ItemType = z.enum([
  "user_message",
  "notification",
  "assistant_message",
  /** Extended thinking. Carried as its own item type rather than folded into
   *  assistant_message so a client can collapse it independently — which is the
   *  only way a long reasoning block is readable. */
  "reasoning",
  /** The agent's todo/plan list. Updated in place across a turn. */
  "plan",
  ...ToolItemType.options,
  /** A sub-agent or background job. The row is a handle; the detail is on the
   *  task events in ./tasks.ts. */
  "task",
  /** The provider compacted its own context mid-turn. Worth a visible row: it
   *  explains why the agent appears to forget something. */
  "context_compaction",
  "error",
  "unknown",
]);
export type ItemType = z.infer<typeof ItemType>;

export const ItemStatus = z.enum([
  "inProgress",
  "completed",
  "failed",
  /** A human said no. Distinct from `failed`: nothing went wrong. */
  "declined",
]);
export type ItemStatus = z.infer<typeof ItemStatus>;

export const ContentStream = z.enum([
  "assistant_text",
  "reasoning_text",
  "command_output",
  "tool_output",
  "unknown",
]);
export type ContentStream = z.infer<typeof ContentStream>;

/** A shell command and what it produced. `exitCode` absent while running. */
export const CommandExecutionDetail = z.object({
  command: z.string(),
  cwd: z.string().min(1).optional(),
  exitCode: z.number().int().optional(),
  outputPreview: z.string().optional(),
  durationMs: z.number().int().nonnegative().optional(),
});
export type CommandExecutionDetail = z.infer<typeof CommandExecutionDetail>;

export const FileChangeKind = z.enum(["create", "edit", "delete", "rename"]);
export type FileChangeKind = z.infer<typeof FileChangeKind>;

/**
 * One file touched. The diff is carried as a unified diff string rather than a
 * structured hunk list: every renderer and every review tool already speaks it,
 * and a bespoke structure would have to be converted back at each of them.
 */
export const FileChangeDetail = z.object({
  path: z.string().min(1),
  kind: FileChangeKind,
  renamedFrom: z.string().min(1).optional(),
  unifiedDiff: z.string().optional(),
  diffTruncated: z.boolean().optional(),
  linesAdded: z.number().int().nonnegative().optional(),
  linesRemoved: z.number().int().nonnegative().optional(),
});
export type FileChangeDetail = z.infer<typeof FileChangeDetail>;

export const UNKNOWN_PATH = "(unknown)";

export function isKnownPath(path: string): boolean {
  return path !== UNKNOWN_PATH;
}

export const FileReadDetail = z.object({
  path: z.string().min(1),
  /** Present when the agent read a slice rather than the whole file. */
  fromLine: z.number().int().positive().optional(),
  toLine: z.number().int().positive().optional(),
});
export type FileReadDetail = z.infer<typeof FileReadDetail>;

export const ToolCallDetail = z.object({
  /** Fully-qualified where the provider qualifies it, e.g. `mcp__linear__search`. */
  name: z.string().min(1),
  server: z.string().min(1).optional(),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  /** Provider-side call id, for matching a result back to its call. */
  toolUseId: z.string().min(1).optional(),
});
export type ToolCallDetail = z.infer<typeof ToolCallDetail>;

export const PlanStepStatus = z.enum(["pending", "inProgress", "completed"]);
export type PlanStepStatus = z.infer<typeof PlanStepStatus>;

export const PlanDetail = z.object({
  steps: z.array(z.object({ step: z.string().min(1), status: PlanStepStatus })),
});
export type PlanDetail = z.infer<typeof PlanDetail>;

export const ProviderWaitDetail = z.object({
  kind: z.enum(["api_retry", "rate_limit", "no_response"]),
  /** `api_retry`: which attempt is about to be made, and out of how many. */
  attempt: z.number().int().positive().optional(),
  maxAttempts: z.number().int().nonnegative().optional(),
  /** How long the provider said it would wait before trying again. */
  delayMs: z.number().int().nonnegative().optional(),
  /** HTTP status of the failed request. Absent for a connection error that
   *  never got a response, which the SDK reports as a null status. */
  status: z.number().int().optional(),
  waitedMs: z.number().int().nonnegative().optional(),
  /** `rate_limit`: the account's state. `allowed` is not surfaced — a routine
   *  "still fine" event is not a wait and would be noise on the timeline. */
  limitStatus: z.enum(["allowed", "allowed_warning", "rejected"]).optional(),
  limitType: RateLimitType.optional(),
  /** Unix seconds at which the limit resets, when the provider says. */
  resetsAt: z.number().int().nonnegative().optional(),
  /** Fraction of the window consumed, when the provider says. Finite, because
   *  `z.number()` alone admits Infinity and a meter cannot render one. */
  utilization: z.number().nonnegative().finite().optional(),
});
export type ProviderWaitDetail = z.infer<typeof ProviderWaitDetail>;

export const ErrorDetail = z.object({
  message: z.string(),
  /** Provider-supplied classification when there is one. */
  kind: z.string().min(1).optional(),
});
export type ErrorDetail = z.infer<typeof ErrorDetail>;

export const ConversationImportDetail = z.object({
  provider: z.literal("claude"),
  sourceSessionId: z.string().min(1),
  sessionId: z.string().min(1),
  sourceCwd: z.string().optional(),
  firstPrompt: z.string().max(500).optional(),
  /** Records carried into the fork. */
  records: z.number().int().nonnegative(),
  cut: z.enum(["whole", "since_compact_boundary"]),
  /** Journal rows this import wrote. */
  rows: z.number().int().nonnegative(),
  rowCut: z.enum(["whole", "compact_boundary", "row_budget"]),
  sourceBytes: z.number().int().nonnegative().optional(),
});
export type ConversationImportDetail = z.infer<typeof ConversationImportDetail>;

export const ItemDetail = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("user_message"),
    text: z.string(),
    /** The files sent with a mid-turn message, so the transcript can show
     *  them the way it shows a queued turn's. Absent on every row written
     *  before the steer channel carried attachments. */
    attachments: z.array(TurnAttachment).optional(),
    sender: z.object({ sessionId: z.string().min(1).optional() }).optional(),
    notice: z.string().optional(),
    wakeReason: WakeReason.optional(),
  }),
  z.object({ type: z.literal("notification"), notification: NotificationDetail }),
  z.object({ type: z.literal("assistant_message"), text: z.string() }),
  z.object({
    type: z.literal("reasoning"),
    text: z.string(),
    estimatedTokens: z.number().int().nonnegative().optional(),
  }),
  z.object({ type: z.literal("plan"), plan: PlanDetail }),
  z.object({ type: z.literal("command_execution"), command: CommandExecutionDetail }),
  z.object({ type: z.literal("file_change"), change: FileChangeDetail }),
  z.object({ type: z.literal("file_read"), read: FileReadDetail }),
  z.object({ type: z.literal("mcp_tool_call"), call: ToolCallDetail }),
  z.object({ type: z.literal("dynamic_tool_call"), call: ToolCallDetail }),
  z.object({ type: z.literal("web_search"), query: z.string(), resultCount: z.number().int().nonnegative().optional() }),
  z.object({ type: z.literal("browser_action"), call: ToolCallDetail, url: z.string().optional() }),
  z.object({ type: z.literal("task"), taskId: Id }),
  z.object({
    type: z.literal("context_compaction"),
    /** What triggered it, when the provider says — Claude reports "auto" or
     *  "manual" on its compact boundary. */
    reason: z.string().optional(),
    /** Window occupancy either side of the squeeze, when reported. The pair is
     *  the row's whole story: what it reclaimed. */
    preTokens: z.number().int().nonnegative().optional(),
    postTokens: z.number().int().nonnegative().optional(),
  }),
  z.object({ type: z.literal("provider_wait"), wait: ProviderWaitDetail }),
  z.object({ type: z.literal("conversation_import"), import: ConversationImportDetail }),
  z.object({ type: z.literal("artifact"), artifact: Artifact }),
  z.object({ type: z.literal("error"), error: ErrorDetail }),
  z.object({ type: z.literal("unknown"), label: z.string().optional(), payload: z.unknown().optional() }),
]);
export type ItemDetail = z.infer<typeof ItemDetail>;

export const Item = z.object({
  id: Id,
  runId: Id,
  sessionId: Id,
  status: ItemStatus,
  title: z.string().optional(),
  detail: ItemDetail,
  startedAt: Timestamp,
  completedAt: Timestamp.optional(),
  streamed: z.string().optional(),
  streamedThrough: z.number().int().nonnegative().optional(),
  taskId: Id.optional(),
  providerRefs: ProviderRefs.optional(),
  imported: z.literal(true).optional(),
});
export type Item = z.infer<typeof Item>;
