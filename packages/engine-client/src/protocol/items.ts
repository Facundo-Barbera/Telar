/**
 * engine protocol v2 — timeline items.
 *
 * THIS FILE IS THE POINT OF v2. Protocol v1's driver read `text_delta` and
 * assistant text blocks and dropped `tool_use`, `tool_result` and `thinking` on
 * the floor (`apps/engine/src/driver.ts`), so a session rendered as a wall of
 * prose with no tool timeline, no reasoning, and nothing to approve. Every
 * surface the frozen cockpit has and `apps/web` does not was downstream
 * of that one omission.
 *
 * An ITEM is one row in a turn's timeline. Items have a lifecycle
 * (`item.started` → `item.updated`* → `item.completed`) and streaming text
 * arrives against them as `content.delta` rather than being buffered — a tool's
 * output should appear as it is produced, not when it finishes.
 *
 * The canonical set is adapted from t3 code's `CanonicalItemType`, which is the
 * hard-won part of its contract: it is provider-agnostic, so a Claude
 * `tool_use` for Bash and a Codex `exec_command` land on the SAME row type and
 * the UI needs one renderer rather than one per provider.
 */
import { z } from "zod";
import { Id, ProviderRefs, Timestamp } from "./common";

/**
 * The subset of item types that represent a tool doing something. These are the
 * rows a client renders as expandable tool cards, and the ones an approval can
 * be attached to.
 *
 * SPLIT OUT AS ITS OWN LIST because three separate things need to ask "is this
 * a tool?" — the renderer, the approval router, and the usage roll-up — and
 * three copies of that predicate is how they drift.
 */
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
  /** Forward compatibility. A client MUST render an unknown item rather than
   *  dropping it — a silently missing row is worse than an ugly one. */
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

/**
 * Which stream a `content.delta` belongs to. One item can carry more than one
 * — a command has its own output, and the assistant may narrate around it — so
 * deltas name their stream rather than assuming the item has only one.
 */
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
  /** Truncated for transport; the full text streams as `command_output`
   *  deltas. A client showing only this is showing a preview, not the output. */
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
  linesAdded: z.number().int().nonnegative().optional(),
  linesRemoved: z.number().int().nonnegative().optional(),
});
export type FileChangeDetail = z.infer<typeof FileChangeDetail>;

export const FileReadDetail = z.object({
  path: z.string().min(1),
  /** Present when the agent read a slice rather than the whole file. */
  fromLine: z.number().int().positive().optional(),
  toLine: z.number().int().positive().optional(),
});
export type FileReadDetail = z.infer<typeof FileReadDetail>;

/**
 * Any tool call that is not a command or a file operation.
 *
 * `input`/`output` ARE UNKNOWN AND THAT IS DELIBERATE — MCP tool schemas are
 * defined by the servers a user configures, so this contract cannot know their
 * shape and must not pretend to. Clients render them generically.
 */
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

export const ErrorDetail = z.object({
  message: z.string(),
  /** Provider-supplied classification when there is one. */
  kind: z.string().min(1).optional(),
});
export type ErrorDetail = z.infer<typeof ErrorDetail>;

/**
 * The per-type payload of an item.
 *
 * A DISCRIMINATED UNION ON `type`, not an optional grab-bag, so that narrowing
 * on the type in a renderer gives you exactly the fields that type has. v1's
 * `data: Record<string, unknown>` is the thing this replaces, and it is why
 * `apps/web/lib/engine/journal.ts` had to hand-check `typeof
 * event.data.text === "string"` at the point of use.
 */
export const ItemDetail = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user_message"), text: z.string() }),
  z.object({ type: z.literal("assistant_message"), text: z.string() }),
  z.object({ type: z.literal("reasoning"), text: z.string() }),
  z.object({ type: z.literal("plan"), plan: PlanDetail }),
  z.object({ type: z.literal("command_execution"), command: CommandExecutionDetail }),
  z.object({ type: z.literal("file_change"), change: FileChangeDetail }),
  z.object({ type: z.literal("file_read"), read: FileReadDetail }),
  z.object({ type: z.literal("mcp_tool_call"), call: ToolCallDetail }),
  z.object({ type: z.literal("dynamic_tool_call"), call: ToolCallDetail }),
  z.object({ type: z.literal("web_search"), query: z.string(), resultCount: z.number().int().nonnegative().optional() }),
  z.object({ type: z.literal("browser_action"), call: ToolCallDetail, url: z.string().optional() }),
  z.object({ type: z.literal("task"), taskId: Id }),
  z.object({ type: z.literal("context_compaction"), reason: z.string().optional() }),
  z.object({ type: z.literal("error"), error: ErrorDetail }),
  z.object({ type: z.literal("unknown"), label: z.string().optional(), payload: z.unknown().optional() }),
]);
export type ItemDetail = z.infer<typeof ItemDetail>;

/**
 * One timeline row.
 *
 * `title` is the one-line label a collapsed row shows and is the ENGINE's job
 * to produce, not the client's: three clients deriving "what does an Edit of
 * src/foo.ts say when collapsed" independently is three answers.
 */
export const Item = z.object({
  id: Id,
  runId: Id,
  sessionId: Id,
  status: ItemStatus,
  title: z.string().optional(),
  detail: ItemDetail,
  startedAt: Timestamp,
  completedAt: Timestamp.optional(),
  /** Set when this item was produced inside a sub-agent rather than by the
   *  main loop, so a client can file it under that agent instead of the
   *  parent timeline. */
  taskId: Id.optional(),
  providerRefs: ProviderRefs.optional(),
});
export type Item = z.infer<typeof Item>;
