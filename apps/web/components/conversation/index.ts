// THE ONE ROOF (AD-12 / AC1). Every conversational surface in this app imports
// from here and from nowhere else in this directory.
//
// "ONE ROOF" IS THIS BARREL, NOT A FILE MOVE. The primitives physically stay in
// components/ai-elements/ and components/session/: moving them would be ~19
// import-site edits across three tracks' neighbourhoods for zero behaviour
// change and zero contract benefit, and conversation-component.md sanctions both
// readings in as many words ("either way, one roof"). What actually matters is
// that a future surface has ONE import path, and that is what this file is.
// Moving the files later stays a pure-mechanical rename this decision does not
// foreclose.
//
// TWO GROUPS, AND ONLY THE FIRST IS PINNED. The PRIMITIVES below are asserted as
// an EXACT SET by INV-8f in packages/core/test/invariants.test.ts, so a later
// refactor that silently drops one fails by name. The SHELL + CONTRACT group is
// deliberately not pinned: it grows as the contract grows, and pinning it would
// make every legitimate addition look like a violation.
//
// THE VENDORED `Conversation` IS NOT RE-EXPORTED. components/ai-elements/
// conversation.tsx also exports a `Conversation` — the StickToBottom scroll
// viewport. AD-12 gives that name to the SHELL, and after the carve-out the
// viewport's only importer is the shell itself, so it is an implementation
// detail rather than something a surface should be reaching for. Exporting both
// would put two meanings of one name in every consumer's scope; exporting
// neither-but-the-shell means no module can see both, and there is no collision.

// ── the primitives (INV-8f pins this group as an exact set) ─────────────────
export { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
export { Shimmer } from "@/components/ai-elements/shimmer";
export { MarkdownPre } from "@/components/ai-elements/code-block";
export { ToolStepRow } from "@/components/session/tool-step";
export { WorkingIndicator } from "@/components/session/working-indicator";
export { ToolStepGroup } from "./kinds";
export { Marker } from "./marker";
export { ApprovalCard } from "./approval-card";

// The composer kit, re-exported wholesale. It is a 1465-line vendored family of
// ~50 symbols that move together, and enumerating them here would go stale the
// first time the vendor adds one. NOTE FOR KIND AUTHORS: this star also carries
// the module's CONTEXT-CONSUMING HOOKS (usePromptInputController,
// useProviderAttachments, usePromptInputAttachments,
// usePromptInputReferencedSources). A registered item kind must not call any of
// them — a renderer is a pure function of (payload, view) and reads nothing from
// ambient context (AD-12). INV-8b is what enforces that, because the type
// cannot.
export * from "@/components/ai-elements/prompt-input";

// ── the shell and its contract (deliberately NOT pinned — it grows) ─────────
export { Conversation, type ConversationProps } from "./conversation";
// The empty-state block a surface hands the shell through `empty`. Re-exported
// from the vendored module so no consumer has to import
// components/ai-elements/conversation directly — that file is the shell's
// internal scroll layer and its `Conversation` export means something else
// entirely (see this file's header).
export {
  ConversationEmptyState,
  type ConversationEmptyStateProps,
} from "@/components/ai-elements/conversation";
export {
  createItemKindRegistry,
  MODULE_NAMESPACES,
  type ItemKind,
  type ItemKindId,
  type ItemKindRegistry,
  type ItemRenderer,
  type ItemViewState,
  type ModuleNamespace,
} from "./registry";
export { BUILTIN_KINDS, ThinkingRow, AgentStepRow, permissionPreview } from "./kinds";
export {
  CONVERSATION_KINDS,
  agentLabel,
  agentStatus,
  groupParts,
  isAsyncLaunchAck,
  isTrailingItem,
  parentOf,
  toTranscriptItem,
  toTranscriptItems,
  type AgentBucket,
  type ChatMessage,
  type ItemPayloadHooks,
  type MarkerPayload,
  type Part,
  type PermissionPart,
  type PermissionPayload,
  type PermissionRespond,
  type RenderItem,
  type StoreMessage,
  type StorePart,
  type TextPayload,
  type ThinkingPayload,
  type ToolsPayload,
  type TranscriptItem,
  type TurnPayload,
} from "./items";
export {
  ADVANCE_APPROVAL_LABELS,
  TOOL_APPROVAL_LABELS,
  type ApprovalCardProps,
  type ApprovalLabels,
} from "./approval-card";
export { readPreStreamError } from "./pre-stream-error";
