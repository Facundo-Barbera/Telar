"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BellIcon,
  BotIcon,
  CheckIcon,
  ExternalLinkIcon,
  FoldVerticalIcon,
  FolderGit2Icon,
  PencilIcon,
  PictureInPicture2Icon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
// THE CONVERSATION SHELL AND ITS PRIMITIVES, through the ONE import path
// (AD-12 / story 3.1 AC1). After the carve-out this file is the shell's first
// OWNER ADAPTER: it keeps the route, the state and the whole API surface — every
// request, both event streams, applyServerEvent, send — and hands the shell a
// PROJECTION of `messages` plus the callbacks its item payloads need. The render
// seam, and only the render seam, moved out.
import {
  BUILTIN_KINDS,
  CONVERSATION_KINDS,
  Conversation,
  ConversationEmptyState,
  Message,
  MessageContent,
  MessageResponse,
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionAddScreenshot,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputAttachments,
  PromptInputBody,
  PromptInputFooter,
  PromptInputProvider,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  Shimmer,
  agentLabel,
  agentStatus,
  createItemKindRegistry,
  deriveAgentProjection,
  groupParts,
  isAsyncLaunchAck,
  isTrailingItem,
  parentOf,
  showsLiveStatus,
  toTranscriptItems,
  usePromptInputController,
  type AgentBucket,
  type AttachmentRef,
  type ChatMessage,
  type ItemKind,
  type PermissionPart,
  type PromptInputMessage,
  type StatusPayload,
  type StoreMessage,
  type TranscriptItem,
  type TurnPayload,
} from "@/components/conversation";
import {
  SubagentRail,
  SubagentBanner,
  type RailAgent,
} from "@/components/session/subagent-rail";
import {
  LoomsPill,
  InlineLoomRow,
  type PillLoom,
  type LoomTone,
  type LoomEventRow,
} from "@/components/session/session-loom";
import { ContextPill } from "@/components/session/session-meters";
import { useDockOptional } from "@/components/dock/dock-provider";
import { stepPreview, type AgentInfo, type ToolPart } from "@/components/session/tool-step";
import type { WorkState } from "@/components/session/working-indicator";
import {
  browserQueueStorage,
  queueStorageKey,
  readQueue,
  stripQueuedAttachments,
  writeQueue,
  type QueuedMessage,
} from "@/lib/message-queue";

/** The queue's message type with THIS surface's attachment shape filled in —
 *  the lib stays generic so it need not import the composer kit. */
type SessionQueuedMessage = QueuedMessage<PromptInputMessage["files"][number]> & {
  /** Present only after the engine durably acknowledges this intent. */
  accepted?: boolean;
  revision?: number;
  state?: "queued" | "claimed" | "running" | "failed" | "ambiguous";
  error?: string;
};
import { ComposerControls } from "@/components/session/composer-settings";
import { WorkspaceEnvironment } from "@/components/session/workspace-environment";
import { WorkspaceInspector } from "@/components/session/workspace-inspector";
import { RightPanel, RightPanelTrigger } from "@/components/right-panel/right-panel";
import {
  adoptRightPanelSession,
  DEFAULT_ACTIVITY_TAB,
  openRightPanelActivity,
  openRightPanelBrowser,
  useRightPanelStore,
} from "@/lib/right-panel-store";
import { TELAR_BROWSER_MUTATION_EVENT } from "@/lib/browser-runtime-contract";
import { useDisclosureMap } from "@/lib/use-disclosure-map";
import { MainSidebarTrigger } from "@/components/main-sidebar-trigger";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { shortId } from "@/lib/format";
import { consumeSSE } from "@/lib/sse";
import type { ContextUsageSnapshot } from "@/lib/context-usage";
// Type-only (this is a "use client" file — no runtime value from @telar/core).
import type { Watch, WorkUnitState } from "@telar/core";
import {
  DEFAULT_RUNTIME_MODE,
  RUNTIME_MODE_OPTIONS,
  isRuntimeMode,
} from "@/lib/runtime-mode-client";
import type { RuntimeMode } from "@telar/core/runtime-mode";
import {
  DEFAULT_CODEX_MODEL,
  DEFAULT_MODEL,
  contextLabelForModel,
  modelById,
  modelsForProvider,
  type ModelInfo,
} from "@/lib/models";
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_FILES,
  type AttachmentUploadResponse,
} from "@/lib/attachment-contract";
import {
  groupAccepts,
  groupDefault,
  providerOptionGroups,
} from "@/lib/provider-options";
import { dispatchTelarRefresh, dispatchTelarSessionRun } from "@/lib/telar-refresh";
import { cachedJson } from "@/lib/client-json-cache";
import {
  ESCALATION_KICKOFF_SENTINEL,
  shouldFireEscalationKickoff,
} from "@/lib/escalation-kickoff";
import {
  freshUltraWakes,
  shouldEnqueueUltraWake,
  ULTRA_WAKE_SENTINEL,
} from "@/lib/ultra-wake";
import { useAccounts } from "@/lib/use-accounts";
import { sessionProviders } from "@/lib/account-visibility";
import { useUltraWake } from "@/lib/use-ultra-wake";
// Story 4.2 — the Ultra session surface. `@/lib/ultra-runs` is the pure
// projection layer (no React, no fetch, no @telar/core runtime); the two
// components below render it and read nothing else.
import {
  launchedRunId,
  orderRunsForPanel,
  runSnapshot,
  spliceRunAnchors,
  ultraTabId,
  ultraTabRunId,
  type RunSnapshot,
  type UltraAnchorPayload,
} from "@/lib/ultra-runs";
import { useUltraRuns } from "@/lib/use-ultra-runs";
import { ultraRunAnchorKind } from "@/components/session/ultra-anchor";
import { UltraRail } from "@/components/session/ultra-rail";
import {
  UltraTabBanner,
  UltraTabView,
  type UltraTabViewProps,
} from "@/components/session/ultra-tab";
import { cn } from "@/lib/utils";

type Provider = "claude" | "codex";

function modelProvider(modelId: string): Provider | undefined {
  const known = modelById(modelId);
  if (known) return known.provider ?? "claude";
  if (/^(gpt-|codex-|o\d)/i.test(modelId)) return "codex";
  if (/^claude-/i.test(modelId)) return "claude";
  return undefined;
}

// Mirrors lib/loom-mcp.ts's own LOOM_START_TOOL export — kept as a plain
// literal here (not imported) since that module pulls in server-only
// @telar/core code that has no business in the client bundle.
const LOOM_START_TOOL = "mcp__loom__start_loom";

// Map a real WorkUnitState to the loom pill/row urgency tone (accent only) and a
// human verb. blocked/failed/halted demand the human (amber + pulse); ready /
// needs-review / done are the green human-touchpoints; everything else weaves.
function loomTone(s: WorkUnitState | null | undefined): LoomTone {
  if (s === "blocked" || s === "failed" || s === "halted") return "blocked";
  if (s === "ready" || s === "needs-review" || s === "done") return "ready";
  return "weaving";
}
// Parse a model's context-window label ("1M", "200K", "200000") to a token
// count, so the CTX hover can show a real used/window fill. Undefined when the
// label isn't parseable — the hover then omits the bar (data-light).
function parseWindow(label: string | undefined): number | undefined {
  if (!label) return undefined;
  const m = label.trim().match(/^([\d.]+)\s*([mMkK]?)/);
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return undefined;
  const unit = m[2].toLowerCase();
  return Math.round(n * (unit === "m" ? 1_000_000 : unit === "k" ? 1_000 : 1));
}

function loomVerb(s: WorkUnitState | null | undefined): string {
  switch (s) {
    case "blocked":
      return "Loom parked";
    case "ready":
      return "Loom ready";
    case "needs-review":
      return "Loom needs review";
    case "done":
      return "Loom done";
    case "failed":
      return "Loom failed";
    case "halted":
      return "Loom halted";
    default:
      return "Loom weaving";
  }
}

// The Loom Session's agent-first greeting (docs/loom-model.md §5, feature
// #34): rendered ONLY as a fresh-session seed — see the `planner && !sessionId
// && messages.length === 0` guard where it's used — never sent to the model,
// never persisted, never billed. Purely a templated render so the agent
// visibly speaks first; the instant the user sends anything, `messages`
// stops being empty and this stops rendering, permanently, for the rest of
// the session (it's not part of `messages` state at all).
const PLANNER_GREETING =
  "I'll help you plan a loom. Tell me what you'd like to build, and I'll shape it into a spec — the objective, any context, and a contract we can verify — then we start it together. What are we making?";

// M11 finding-1 — the escalation session no longer uses a render-only greeting.
// Unlike PLANNER_GREETING (static copy the human answers), the blocked-loom
// "Discuss with the orchestrator" chat opens with a REAL agent turn: on mount
// (post-Discuss-click) SessionView auto-fires ONE hidden kickoff (see the
// escalationKickoff effect below and @/lib/escalation-kickoff) so the FIRST
// visible bubble is the agent's genuine analysis proposing a verification
// method — not a templated prompt. Until its first token lands, a transient
// "Reviewing…" shimmer stands in (see the escalation branch in the transcript
// render), identical to the in-flight empty-assistant render, so the pre-fire →
// streaming transition is seamless.

// THE TRANSCRIPT'S TYPES AND ITS PROJECTION MOVED OUT (story 3.1's carve-out).
// `StorePart`, `StoreMessage`, `Part`, `ChatMessage`, `PermissionPart`,
// `parentOf`, `AgentBucket`, `agentLabel`, `agentStatus`, `isAsyncLaunchAck`,
// `RenderItem` and `groupParts` now live in components/conversation/items.ts —
// verbatim, comments and all — and are imported above through the barrel. They
// left because they describe a TRANSCRIPT, not a session: every one of them is
// needed by surfaces that have no route, no stream and no API of their own.
//
// `Status` stayed. It is this adapter's own turn state machine (it drives
// `send`, the composer's submit button and the queue-drain gates) and means
// nothing at all to a transcript.
type Status = "ready" | "submitted" | "streaming" | "error";

// RE-EXPORTED, NOT REDECLARED. apps/web/lib/gallery-fixtures/showcase.ts imports
// this type from THIS module, and lib/gallery-fixtures/** sits outside story
// 3.1's write set — so the name has to keep resolving here. It is the same
// symbol either way: one declaration, in items.ts.
export type { PermissionPart };

type ProjectCommand = {
  name: string;
  description: string;
  kind: "command" | "skill";
};

// Mirrored rather than imported, exactly like ProjectCommand above it: the
// module that produces these (lib/project-files.ts) reaches node:child_process
// and node:fs to read the repo. `import type` would erase cleanly today, but
// the day someone drops the `type` keyword the whole file index follows it into
// the client bundle — and a local shape cannot be de-erased by accident.
type ProjectFile = { path: string; name: string };

// The `@token` the cursor is sitting at the end of. Anchored on
// start-of-string-or-whitespace so `foo@bar` and an email never open the menu,
// and stopping at the next whitespace so a COMPLETED mention closes it again.
// Module scope, and no /g flag — so it carries no lastIndex between calls and
// is safe to share across every render and both readers below.
const MENTION_AT_CARET = /(?:^|\s)@([^\s@]*)$/;

export type InitialChat = {
  id: string;
  model: string;
  effort?: string;
  // Absent on chats persisted before mode selection existed — reads as
  // "default" (the prior hardcoded behavior), same fallback the state below
  // uses.
  runtimeMode?: RuntimeMode;
  // Compatibility seed for chats written before runtimeMode unified the two
  // harnesses. New turns persist runtimeMode instead.
  permissionMode?: "default" | "auto" | "acceptEdits";
  fastMode?: boolean;
  serviceTier?: string;
  messages: StoreMessage[];
  // Persisted accounting remains part of the session contract even though the
  // workspace now presents one reduced context-window readout. The provider's
  // latest context snapshot is the preferred seed; contextTokens is the
  // backwards-compatible fallback for older sessions.
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  contextTokens: number;
  contextUsage?: ContextUsageSnapshot;
  // Session<->Loom link (docs/loom-model.md §5, store.ts's Chat.loomId/role)
  // — set once this session's loom MCP tools have drafted/started a bundle.
  // Seeds the header's persistent "Planning loom" chip on reload.
  loomId?: string;
  role?: "planner" | "steerer" | "escalation";
};

// consumeSSE (the frame-by-frame `event:`/`data:` reader shared by the POST
// send() path and the §1b reconnect subscriber) now lives in @/lib/sse — the
// dock's own live tail (session-runtime-host.tsx) reuses the exact same
// parser rather than a second implementation of the wire format.

function seedMessages(chat: InitialChat | undefined): ChatMessage[] {
  if (!chat) return [];
  return chat.messages.map((m, i) => ({
    id: `seed-${i}`,
    role: m.role,
    parts: m.parts.map((p) =>
      p.type === "text"
        ? { type: "text" as const, text: p.text, done: true, parentId: p.parentId }
        : // Attachments seed straight through: the part IS its own render input
          // (metadata only), and the chip decides for itself whether the bytes
          // behind each id still exist. A chat archived since it was written
          // reloads to tombstones rather than to broken images.
          p.type === "attachments"
          ? { type: "attachments" as const, files: p.files }
          : {
            type: "tool" as const,
            name: p.name,
            id: p.id,
            input: p.input,
            output: p.output,
            isError: p.isError,
            interrupted: p.interrupted,
            parentId: p.parentId,
            agent: p.agent,
            taskStatus: p.taskStatus,
            autoDenied: p.autoDenied,
          },
    ),
  }));
}

function runtimeModeFromLegacy(
  mode: InitialChat["permissionMode"],
): RuntimeMode {
  if (mode === "default") return "approval-required";
  if (mode === "acceptEdits") return "auto-accept-edits";
  return DEFAULT_RUNTIME_MODE;
}

// `permissionPreview` and `ThinkingRow` moved to components/conversation/kinds.tsx,
// and `PermissionCard` became the `ApprovalCard` PRIMITIVE there — merged with the
// gate card's mono-uppercase header so one component serves every moment a human
// is asked to approve something (UX-DR7, and the resolution of readiness finding
// UX-2). The exported component had zero importers, measured, so nothing outside
// this file had to change. All three now render through the item-kind registry.

// One queued message chip (1.5): a compact editable/removable row above the
// composer. Click the text (or the pencil) to edit in place; Enter/blur commits,
// Escape cancels; the ✕ drops it before it ever sends. No programmatic .focus()
// beyond the input's own autoFocus (WebKit-safe — it's mount focus, not a
// roving .focus() call on an existing element).
/**
 * Persist a turn's staged attachments and return the ids the wire carries.
 *
 * The urls arriving here are DATA urls, not blob urls: PromptInput converts
 * them before it calls onSubmit precisely so the payload survives the composer
 * clearing (which revokes every blob it created). That conversion is also why
 * this can run after the UI has already reset.
 *
 * Throws on failure, which puts the turn on send()'s existing error path — an
 * attachment that silently failed to upload would produce a turn whose text
 * refers to a screenshot the agent was never given.
 */
async function uploadAttachments(
  files: PromptInputMessage["files"],
): Promise<{ id: string; name: string; mediaType: string; size: number }[]> {
  const form = new FormData();
  for (const file of files) {
    if (!file.url) continue;
    const blob = await fetch(file.url).then((r) => r.blob());
    form.append("file", blob, file.filename ?? "attachment");
  }
  const res = await fetch("/api/chat/attachments", { method: "POST", body: form });
  if (!res.ok) {
    const detail = await res
      .json()
      .then((b) => (b as { error?: string })?.error)
      .catch(() => null);
    throw new Error(detail ?? `attachment upload failed (HTTP ${res.status})`);
  }
  const body = (await res.json()) as AttachmentUploadResponse;
  return body.attachments;
}

function QueueChip({
  index,
  text,
  editing,
  onEdit,
  onCommit,
  onRemove,
  state,
  error,
}: {
  index: number;
  text: string;
  editing: boolean;
  onEdit: () => void;
  onCommit: (v: string) => void;
  onRemove: () => void;
  state?: SessionQueuedMessage["state"];
  error?: string;
}) {
  const [draft, setDraft] = useState(text);
  useEffect(() => setDraft(text), [text, editing]);

  return (
    <div className="group flex items-center gap-2 rounded-lg bg-background/80 px-2 py-1.5 ring-1 ring-border">
      <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[10px] font-medium text-primary">
        {index}
      </span>
      {editing ? (
        <Input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onCommit(draft.trim() || text);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCommit(text);
            }
          }}
          onBlur={() => onCommit(draft.trim() || text)}
          className="h-6 min-w-0 flex-1 border-0 border-b border-primary/40 bg-transparent px-0 text-sm shadow-none focus-visible:ring-0"
        />
      ) : (
        <button
          type="button"
          onClick={onEdit}
          className="min-w-0 flex-1 truncate text-left text-sm text-foreground hover:text-foreground"
          title="Click to edit"
        >
          {text}
        </button>
      )}
      {state && state !== "queued" && (
        <span
          className={cn(
            "shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground",
            (state === "failed" || state === "ambiguous") && "text-destructive",
          )}
          title={error}
        >
          {state}
        </span>
      )}
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label="Edit queued message"
        className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
        onClick={onEdit}
      >
        <PencilIcon />
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label="Remove queued message"
        className="text-muted-foreground hover:text-destructive"
        onClick={onRemove}
      >
        <XIcon />
      </Button>
    </div>
  );
}

// `RenderItem` / `groupParts` moved to components/conversation/items.ts;
// `AgentStepRow` and `ToolStepGroup` moved to components/conversation/kinds.tsx as
// the tools kind's rendering. `ToolStepGroup` still takes `agentSteps`/`onSelectAgent`
// as optional props — they now arrive through the tools item's PAYLOAD, built by this
// adapter, rather than being read from anywhere ambient.

// ── the item-kind registry this adapter composes ────────────────────────────
// The six built-ins plus exactly ONE kind of its own. `session` is a declared
// module in MODULE_NAMESPACES (AD-13) and this is what that vocabulary is for:
// an owner adapter registering a kind nothing else needs, under a namespace that
// cannot collide with `ultra:`, `loom:` or `workspace:`.
//
// WHY THE SUBAGENT BUCKET IS A COMPOSITE KIND AND NOT A FLAT LIST OF ITEMS. A
// bucket's items are not direct children of the transcript's scroll column: they
// sit inside their own `gap-3 text-sm` reading column, with the bucket's header
// above them and the spawn's result panel below, while the scroll column itself
// spaces its children `gap-8`. Emitting them flat would silently re-space and
// re-size every subagent transcript in the app, and — with no DOM harness in
// this repo — nothing would catch it until a human opened the dev server.
// Rendering the children through `view.render` keeps that wrapper byte-identical
// AND keeps the bucket on the SAME registry Main uses, which is the point:
// `renderAgentBucket`'s inline switch, whose own comment admitted it "mirrors
// Main's exhaustive RenderItem switch exactly", is gone.
type AgentBucketPayload = {
  banner: ReactNode;
  header: ReactNode;
  empty: ReactNode;
  result: ReactNode;
  items: readonly TranscriptItem[];
};

const SESSION_AGENT_BUCKET = "session:agent-bucket";

const agentBucketKind: ItemKind<AgentBucketPayload> = {
  id: SESSION_AGENT_BUCKET,
  render: (payload, view) => (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
      {/* Sticky for the same reason the Ultra tab's is: a long sub-agent
          transcript scrolled the only Back affordance off the top. */}
      <div className="sticky top-0 z-20 -mx-1 bg-background px-1 pb-1.5 pt-1">
        {payload.banner}
      </div>
      {/* Same reading column as the main transcript's <Message> wrapper, so a
          subagent tab lines up with Main instead of spanning the whole pane. */}
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 text-sm">
        {payload.header}
        {payload.empty}
        {payload.items.map((child, i) =>
          view.render(child, { live: view.live && isTrailingItem(payload.items, i) }),
        )}
        {payload.result}
      </div>
    </div>
  ),
};

// THE FULL-PANE ULTRA VIEW USED TO LIVE HERE, AS A COMPOSITE ITEM KIND
// (`session:ultra-tab`) rendered through this same registry — same mechanism
// `agentBucketKind` above still uses. Issue #13's traced root cause is exactly
// that choice: registering Ultra detail as a TRANSCRIPT ITEM meant selecting a
// run could only ever show it by REPLACING `transcriptItems` with a
// single-element array holding that item — there is no way to render "one
// item, instead of the transcript" within a scroll column that also owns the
// transcript. That is the mechanism behind "Ultra workflows render on top of
// the main chat": it was never a z-index stacking bug, it was the main column
// being handed different content.
//
// The #15 design comment on #13 is the settled call: Ultra/agent detail
// belongs in the right-panel dock, which already owns resize + fullscreen and
// is a SIBLING of the main chat rather than a replacement for it. `UltraTabView`
// and `UltraTabBanner` (components/session/ultra-tab.tsx) are unchanged and
// still do the rendering — the panel's `activity` slot below composes them
// directly, with its own isOpen/setOpen (`useDisclosureMap`) rather than the
// Conversation shell's, since the pane no longer renders inside that shell.
//
// Composed once, at module scope, and passed to the shell as a PROP — never read
// by the shell from anywhere global (project-context.md forbids a global client
// store, and a shared mutable registry would also let two surfaces on one page
// clobber each other's registrations).
const SESSION_KINDS = createItemKindRegistry([
  ...BUILTIN_KINDS,
  agentBucketKind as unknown as ItemKind<never>,
  // Story 4.2 — the Ultra run anchor. REGISTERED HERE AND NEVER IN THE
  // GALLERY'S registry: `lib/demo-gallery/conversation/shell.tsx`'s
  // GALLERY_KINDS deliberately omits `ultra:run-anchor` so configuration 6 can
  // show a real tombstone, and two tests pin that. The two registries are
  // INDEPENDENT INSTANCES passed as props, so registering here cannot reach
  // there — which is exactly the property that makes the tombstone honest.
  ultraRunAnchorKind as unknown as ItemKind<never>,
]);

// A subagent's own tab, as ONE transcript item: the same rendering path as Main
// (groupParts → the registry), just over the bucket's parts instead of a
// message's, plus a header (agent type + spawn description) and the spawn's own
// tool_result rendered at the end as the run's result. Liveness mirrors Main's
// `isCurrentMessage && isTrailing` — "the spawn hasn't produced a result yet"
// stands in for "this is the message currently being streamed into", and the
// per-child half is derived inside the composite renderer above.
//
// The bucket's items get NO `agentSteps`/`onSelectAgent`: v1 doesn't track
// sub-subagents, so a subagent's own tab renders nested tool calls as plain tool
// rows — exactly as the donor's bucket did by omitting those props.
function agentBucketItem(bucket: AgentBucket, onBack: () => void): TranscriptItem {
  const agent = bucket.spawn.agent ?? { type: null, description: "" };
  const status = agentStatus(bucket.spawn);
  const bucketLive = status === "running";
  const items = toTranscriptItems(groupParts(bucket.id, bucket.parts));
  // The prominent line is the same label the tab strip/B.3 chip show (name,
  // else the spawn's own description, else the shared type) so this reads
  // as "which of the N spawns of this type am I looking at" rather than
  // repeating the type. The full description only gets its own line when
  // it says more than the (possibly clipped) label already does — e.g. the
  // label is the name, or the description ran past the label's clip — so a
  // short description isn't printed twice.
  const label = agentLabel(agent);
  const description = agent.description.trim();
  const showDescription = description.length > 0 && description !== label;

  return {
    kind: SESSION_AGENT_BUCKET,
    key: `${SESSION_AGENT_BUCKET}:${bucket.id}`,
    payload: {
      items,
      // Breadcrumb: names the sub-agent you're viewing and makes the exit
      // unmistakable — the "Main" crumb, the highlighted Main anchor in the
      // rail, and Escape all return.
      banner: <SubagentBanner label={label} status={status} onBack={onBack} />,
      header: (
        <div className="flex flex-col gap-1 border-b pb-3 text-xs">
          <div className="flex flex-wrap items-center gap-1.5 font-medium text-foreground">
            <BotIcon className="size-3.5 text-muted-foreground" />
            {label}
            {/* Type demoted to a small secondary badge — still visible as
                context, just no longer the headline every same-type spawn
                shared. */}
            <Badge variant="outline" className="px-1 py-0 text-[10px] font-normal text-muted-foreground">
              {agent.type ?? "subagent"}
            </Badge>
          </div>
          {showDescription && (
            <p
              className={cn(
                "text-muted-foreground",
                description.startsWith("/") && "font-mono text-[10px] text-muted-foreground/60",
              )}
            >
              {description}
            </p>
          )}
        </div>
      ),
      // Empty-while-starting is designed, not blank: the tab exists the
      // instant the spawn tool call arrives, often before the subagent has
      // produced anything yet. A zero-parts "error" bucket (interrupted or
      // failed before it ever forwarded any activity) gets its own
      // destructive-tinted message too — otherwise it's indistinguishable
      // from a run that simply, genuinely finished with nothing to show,
      // and the tab strip's small status dot is the only hint anything
      // went wrong.
      empty:
        bucket.parts.length === 0
          ? bucketLive
            ? <Shimmer className="text-sm">Spinning up…</Shimmer>
            : status === "error"
              ? (
                  <p className="flex items-center gap-1.5 text-sm text-destructive">
                    <TriangleAlertIcon className="size-3.5 shrink-0" />
                    {bucket.spawn.interrupted && bucket.spawn.output === undefined
                      ? "Interrupted before this subagent produced any output."
                      : "This subagent's run failed before producing any output."}
                  </p>
                )
              : (
                  <p className="text-sm text-muted-foreground">
                    No subagent activity was recorded for this run.
                  </p>
                )
          : null,
      result:
        bucket.spawn.output !== undefined
          ? isAsyncLaunchAck(bucket.spawn.output)
            ? (
                // The spawn's tool_result is just the async launch ack, not the
                // subagent's real result (see isAsyncLaunchAck) — the subagent's
                // actual output already rendered above via bucket.parts. Swap
                // the raw metadata dump for a one-line status instead of hiding
                // it outright, so the bucket doesn't end on an unexplained cliff.
                <p className="text-xs text-muted-foreground">
                  {bucketLive ? "Running…" : status === "error" ? "Failed" : "Completed"}
                </p>
              )
            : (
                <div
                  className={cn(
                    "rounded-lg border p-3 text-xs",
                    bucket.spawn.isError ? "border-destructive/40 bg-destructive/10" : "bg-muted/20",
                  )}
                >
                  <div
                    className={cn(
                      "mb-1.5 flex items-center gap-1.5 font-medium",
                      bucket.spawn.isError ? "text-destructive" : "text-muted-foreground",
                    )}
                  >
                    {bucket.spawn.isError ? (
                      <TriangleAlertIcon className="size-3" />
                    ) : (
                      <CheckIcon className="size-3" />
                    )}
                    Result
                  </div>
                  <MessageResponse className="text-xs">{bucket.spawn.output}</MessageResponse>
                </div>
              )
          : null,
    } satisfies AgentBucketPayload,
  };
}

// A project-anchored Claude session. cwd is fixed by the project's manifest.
// The account is choosable up front (contract: an SDK session's resume
// transcript lives under the account's config dir, so it's only choosable
// before the first turn — sessionId === null); once a session exists it's
// locked and shown read-only in the heartbeat bar. Sessions are full
// Claude Code sessions: reads (Read/Grep/Glob) auto-run, while writes,
// edits, and commands gate through canUseTool — the permission cards, Auto
// mode, and guardrails. Looms are the separate deterministic-gate lane.
export function SessionView(props: {
  project: string;
  account: string;
  initialProvider?: Provider;
  accounts: Array<{
    name: string;
    provider?: Provider;
    displayTier?: string;
    runtimeRouted?: boolean;
  }>;
  initialChat?: InitialChat;
  initialTitle?: string;
  // The route's session id (undefined for the "new" front door). Only used to
  // seed sessionId when there's no persisted initialChat yet — the mid-turn
  // cold-reload case; see the sessionId state below.
  routeSessionId?: string;
  // Shared with the sibling right panel so workspace controls can invoke the
  // store directly without a global window event protocol.
  rightPanelScopeKey?: string;
  // Story 4.2 / AC7 — the run to select in the rail's Workflows section on
  // arrival, threaded from the page's `?run=` search param. Undefined on every
  // other entry, and cleared out of the URL once consumed so a later refresh
  // does not re-focus a run the user has since navigated away from.
  focusRunId?: string;
  // Set only for a brand-new session arrived at via the Looms tab's
  // "Plan a loom" front door (?role=planner) — a hint only, see the page's
  // own comment. Drives the empty-state framing below, nothing else.
  initialRole?: "planner";
  // Opt-in, additive (docs/loom-model.md §5's "Loom Session"): true only for
  // the dedicated planning surface that lives in the Looms tab
  // (/looms/plan/[project]). When mcp__loom__start_loom succeeds, a planner
  // session auto-navigates to the god-view instead of just showing the
  // passive handoff banner/chip a normal project session gets — see the
  // "tool_result" case below. Undefined/false (every existing call site)
  // leaves that behavior completely unchanged.
  planner?: boolean;
  // Embedded steerer session (loom Chat tab). Sends role:"steerer"+loomId on
  // the wire so route.ts binds the session to this loom; also suppresses the
  // address-bar rewrite (the Chat tab keeps the /looms/[id] URL). Undefined
  // everywhere else — a plain/planner session is unaffected.
  steerer?: boolean;
  // Embedded escalation session (M11.3, the blocked-loom "Discuss with the
  // orchestrator" chat). Sends role:"escalation"+loomId on the wire so route.ts
  // binds a READ-ONLY toolset whose only write is the human-gated answer_blocked;
  // like steerer it suppresses the address-bar rewrite (the surface stays on the
  // /looms/[id] page). Undefined everywhere else.
  escalation?: boolean;
  // Chrome-light embed (critique 1.7): the loom Chat tab renders this surface
  // INSIDE a page that already carries identity (the loom header + state/cost
  // badges). So the standalone-session chrome — the back button, the "New
  // session / <project>" identity header, and the account/usage heartbeat bar
  // (incl. the mini-dock minimize, meaningless for an embedded chat) — is
  // suppressed, leaving just the transcript + composer. Undefined everywhere a
  // SessionView owns its own page.
  embedded?: boolean;
  loomId?: string;
}) {
  // The slash-command menu and account lock both need to read/drive the
  // composer's text value from outside <PromptInput> itself — the provider
  // lifts that state so this component and the composer share one source.
  return (
    <PromptInputProvider>
      <SessionWorkspace {...props} />
    </PromptInputProvider>
  );
}

function SessionWorkspace({
  project,
  account,
  initialProvider,
  accounts,
  initialChat,
  initialTitle,
  routeSessionId,
  rightPanelScopeKey,
  focusRunId,
  initialRole,
  planner,
  steerer,
  escalation,
  embedded,
  loomId,
}: {
  project: string;
  account: string;
  initialProvider?: Provider;
  accounts: Array<{
    name: string;
    provider?: Provider;
    displayTier?: string;
    runtimeRouted?: boolean;
  }>;
  initialChat?: InitialChat;
  initialTitle?: string;
  routeSessionId?: string;
  rightPanelScopeKey?: string;
  focusRunId?: string;
  initialRole?: "planner";
  planner?: boolean;
  steerer?: boolean;
  escalation?: boolean;
  embedded?: boolean;
  loomId?: string;
}) {
  const textInput = usePromptInputController().textInput;
  const pathname = usePathname();

  // Seed once from the server-resolved transcript. Later prop changes are
  // ignored on purpose: when a fresh session is minted mid-stream we rewrite
  // the URL to its new id, which re-renders this page with initialChat still
  // undefined — re-seeding would tear the live stream down.
  const [sessionId, setSessionId] = useState<string | null>(
    initialChat?.id ?? routeSessionId ?? null,
  );
  const draftBrowserId = useId().replaceAll(":", "");
  const provisionalRightPanelScopeKey = `${project}:draft:${draftBrowserId}`;
  const resolvedRightPanelScopeKey = sessionId
    ? `${project}:${sessionId}`
    : provisionalRightPanelScopeKey;
  // READ-ONLY, for #14's composer disable below. `<RightPanel>` (further down
  // this render) is the WRITER of this store; this is a second, independent
  // subscription to the same external store, the same pattern `right-panel.tsx`
  // itself already uses twice (`RightPanel` and `RightPanelTrigger`) and
  // `workspace-inspector.tsx` uses a third time — subscribe/snapshot was built
  // to have more than one reader.
  const rightPanelSession = useRightPanelStore(resolvedRightPanelScopeKey).session;
  const [messages, setMessages] = useState<ChatMessage[]>(() =>
    seedMessages(initialChat),
  );
  // The header title lives here so a freshly-minted session shows its derived
  // thread title immediately — the server can't re-title mid-stream (getChat is
  // undefined until the first turn persists, long after the URL is rewritten).
  const [title, setTitle] = useState(initialTitle ?? "New session");
  const [workspaceInspectorOpen, setWorkspaceInspectorOpen] = useState(false);
  const [workspaceInspectorReserved, setWorkspaceInspectorReserved] = useState(false);
  // Mini-dock: docking the current session is its natural entry point. Optional
  // context so an out-of-provider render (dev gallery) simply hides the button.
  const dock = useDockOptional();
  const [model, setModel] = useState(initialChat?.model ?? DEFAULT_MODEL);
  // "default" = omit `effort` from the POST body entirely (let the model/SDK
  // pick). Any other value is a real EffortLevel string sent as-is.
  const [effort, setEffort] = useState(() => {
    const storedEffort = initialChat?.effort;
    return storedEffort === "ultracode" || storedEffort === "ultrathink"
      ? "default"
      : storedEffort ?? "default";
  });
  const [fastMode, setFastMode] = useState(initialChat?.fastMode ?? false);
  const [serviceTier, setServiceTier] = useState(initialChat?.serviceTier ?? "standard");
  // One provider-neutral mode is translated by the server at the harness
  // boundary. Older Claude-only chats migrate from their persisted SDK mode.
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(
    initialChat?.runtimeMode ?? runtimeModeFromLegacy(initialChat?.permissionMode),
  );
  // The caller already resolves the effective account (chat.account for an
  // existing session, the user's global default for a fresh one). Resume
  // transcripts live under the account's config dir, so we seed from it once
  // and lock further edits once a session exists (below).
  const [activeAccount, setActiveAccount] = useState(account);
  // Which agent backend the composer is talking to. Defaults to "claude" —
  // the overwhelmingly common case and the only thing we can assume before
  // the account registry (fetched async, below) resolves `activeAccount`'s
  // real provider. Drives which model/effort/sandbox-or-permission controls
  // render and which fields go in the POST body.
  const [provider, setProvider] = useState<Provider>(initialProvider ?? "claude");
  // Old composer preferences could store a Codex model under a Claude project.
  // Keep that stale value
  // from ever reaching the wrong harness; unknown provider-specific aliases
  // remain allowed, while recognizable cross-provider ids fall back safely.
  const effectiveModel = modelProvider(model) === (provider === "claude" ? "codex" : "claude")
    ? (provider === "codex" ? DEFAULT_CODEX_MODEL : DEFAULT_MODEL)
    : model;
  // Full account registry (name + provider + auth, unlike the server-resolved
  // `accounts` prop which predates multi-provider and only carries
  // name/displayTier). Used to scope the account picker to the selected
  // provider and to recover a resumed session's real provider below.
  const { accounts: accountProfiles, allAccounts } = useAccounts();
  // The server seed already carries provider identity, so a fresh composer is
  // fully usable before the client registry request finishes. Once that request
  // lands it becomes authoritative. Every provider/account decision below reads
  // this same source to avoid a half-loaded state where a provider is visible
  // but has no account to select.
  const selectableAccountProfiles = accountProfiles.length > 0 ? accountProfiles : accounts;
  const availableProviders = useMemo(
    () => sessionProviders(selectableAccountProfiles),
    [selectableAccountProfiles],
  );
  // `account`'s real provider may be either one (a fresh session starts from
  // the global default; a resumed session uses whatever it was created with)
  // — re-derive
  // `provider` once the registry loads instead of trusting the "claude"
  // guess above. Only runs in "auto" mode: the moment the user actually
  // touches the agent selector, selectProvider flips providerTouched and
  // this effect stops overwriting their choice.
  const providerTouched = useRef(false);
  useEffect(() => {
    if (providerTouched.current) return;
    const match =
      allAccounts.find((a) => a.name === activeAccount) ??
      accounts.find((a) => a.name === activeAccount);
    if (match) setProvider(match.provider ?? "claude");
  }, [allAccounts, accounts, activeAccount]);
  // Harness-owned model catalog. Claude exposes stable routing slots whose
  // concrete targets are resolved by the user's Claude configuration; Codex
  // exposes its local models cache. The account still selects the runtime
  // environment and routed-spend semantics, but a gateway inventory never
  // becomes a second model picker.
  const [modelOptions, setModelOptions] = useState<ModelInfo[]>(() =>
    modelsForProvider(initialProvider ?? "claude"),
  );
  const [catalogDefault, setCatalogDefault] = useState(
    initialProvider === "codex" ? DEFAULT_CODEX_MODEL : DEFAULT_MODEL,
  );
  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({
      provider,
      account: activeAccount,
      project,
    });
    const url = `/api/models?${params.toString()}`;
    cachedJson<{ models?: ModelInfo[]; default?: string; proxied?: boolean }>(url, { maxAgeMs: 60 * 60 * 1000 })
      .then((d) => {
        if (cancelled) return;
        const list: ModelInfo[] = Array.isArray(d?.models) && d.models.length > 0 ? d.models : modelsForProvider(provider);
        setModelOptions(list);
        setCatalogDefault(
          typeof d?.default === "string"
            ? d.default
            : provider === "codex"
              ? DEFAULT_CODEX_MODEL
              : DEFAULT_MODEL,
        );
      })
      .catch(() => {
        if (!cancelled) {
          setModelOptions(modelsForProvider(provider));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [provider, activeAccount, project]);
  // Project-local memory can outlive a provider integration. Normalize the
  // effective value of a BRAND-NEW session against the loaded catalog; an
  // existing chat remains locked to what it actually used. Keeping this a
  // projection avoids a corrective setState/render cycle after every catalog
  // fetch while still ensuring the value shown, persisted and submitted is
  // always selectable.
  const catalogFallback =
    modelOptions.find((option) => option.id === catalogDefault) ?? modelOptions[0];
  const sessionModel =
    initialChat || modelOptions.some((option) => option.id === effectiveModel)
      ? effectiveModel
      : (catalogFallback?.id ?? effectiveModel);
  // Switching the agent selector: sets the provider, resets model/effort to
  // that provider's defaults (a Claude model id sent to Codex, or vice versa,
  // is meaningless), and — unless the currently active account already
  // belongs to the new provider — jumps to that provider's first account.
  const selectProvider = useCallback(
    (next: Provider) => {
      providerTouched.current = true;
      setProvider(next);
      setModel(next === "codex" ? DEFAULT_CODEX_MODEL : DEFAULT_MODEL);
      setEffort("default");
      setFastMode(false);
      setServiceTier("standard");
      const stillValid = selectableAccountProfiles.find(
        (a) => a.name === activeAccount && (a.provider ?? "claude") === next,
      );
      if (!stillValid) {
        const candidates = selectableAccountProfiles.filter(
          (a) => (a.provider ?? "claude") === next,
        );
        if (candidates[0]) setActiveAccount(candidates[0].name);
      }
    },
    [selectableAccountProfiles, activeAccount],
  );
  const [status, setStatus] = useState<Status>("ready");
  // Latest status for the reconnect effect's point-in-time "ready" gate, read
  // via a ref so mutating status inside that effect can't re-trigger it.
  const statusRef = useRef(status);
  statusRef.current = status;
  const [thinking, setThinking] = useState(false);
  // True while EITHER harness is rewriting this session's own history down to
  // a summary — driven by the "compacting"/"compacted" SSE pair (see
  // applyServerEvent below), fired for a manual Compact press exactly the
  // same way it is for a harness's own auto-compaction on an ordinary turn.
  // Deliberately not folded into `status`/`thinking`: those describe a TURN
  // producing output, and a compaction produces none — collapsing them would
  // make an idle composer's Compact press look like a new turn started.
  const [compacting, setCompacting] = useState(false);
  // True once the chat record is actually confirmed persisted server-side —
  // NOT the same as `sessionId` being set. sessionId is assigned the moment
  // the "session" SSE event arrives, right at the START of a turn (just
  // after the SDK's system:init); the chat itself is only created/persisted
  // at the very END of that same turn, inside route.ts's teardown (the
  // appendTurn call, confirmed by its "saved" event) — which for an agentic
  // multi-tool-call turn can be tens of seconds to minutes later. Gating the
  // rename affordance on sessionId alone lets the user PATCH a chat that
  // doesn't exist on disk yet, which 404s and silently reverts. Seeded true
  // for a page load that already has an existing chat (initialChat).
  const [chatPersisted, setChatPersisted] = useState(!!initialChat);
  // Context-window occupancy: the LATEST turn's prompt size, set (not summed)
  // each turn — see the "done" handler and store.ts contextTokens.
  const [context, setContext] = useState(initialChat?.contextTokens ?? 0);
  const [contextUsage, setContextUsage] = useState<ContextUsageSnapshot | undefined>(
    initialChat?.contextUsage,
  );
  const [turnStartedAt, setTurnStartedAt] = useState(Date.now);
  const messageActivity = useMemo(
    () => ({ messages, at: Date.now() }),
    [messages],
  );
  const lastActivityAt = messageActivity.at;
  // 1.2 remembered config: a fresh session boots from this project's last-used
  // Claude config (model · effort · permission); a project never configured
  // stays on the Auto default. Persisted per project in localStorage. The seed
  // runs once and only for a brand-new session — a resumed chat keeps its own
  // persisted config (route.ts) and must never be clobbered.
  const rememberedSeeded = useRef(false);
  useEffect(() => {
    if (rememberedSeeded.current) return;
    rememberedSeeded.current = true;
    if (initialChat || typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(`telar:composer:${project}`);
      if (!raw) return;
      const saved = JSON.parse(raw) as {
        provider?: Provider;
        model?: string;
        effort?: string;
        runtimeMode?: unknown;
        fastMode?: boolean;
        serviceTier?: string;
      };
      const savedProvider = typeof saved.model === "string"
        ? (modelProvider(saved.model) ?? saved.provider ?? "claude")
        : saved.provider;
      if (
        typeof saved.model === "string" &&
        savedProvider === provider
      ) setModel(saved.model);
      if (typeof saved.effort === "string") setEffort(saved.effort);
      if (isRuntimeMode(saved.runtimeMode)) setRuntimeMode(saved.runtimeMode);
      if (typeof saved.fastMode === "boolean") setFastMode(saved.fastMode);
      if (typeof saved.serviceTier === "string") setServiceTier(saved.serviceTier);
    } catch {
      // ignore malformed / storage-blocked
    }
  }, [initialChat, project]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        `telar:composer:${project}`,
        JSON.stringify({
          provider,
          model: sessionModel,
          effort,
          runtimeMode,
          fastMode,
          serviceTier,
        }),
      );
    } catch {
      // ignore storage-blocked
    }
  }, [provider, project, sessionModel, effort, runtimeMode, fastMode, serviceTier]);
  const nextId = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  // The current turn's server run id (docs/runtime-architecture.md §A.4) — sent
  // with the POST so an explicit Stop can reach the DETACHED run. A client
  // disconnect (navigate/unmount) no longer stops the run.
  const runIdRef = useRef<string | null>(null);

  // §1b: the current turn's assistant-message id, read by applyServerEvent so
  // the extracted switch patches the right message on BOTH the POST path
  // (send() pre-sets it) and the reconnect path (lazily created there).
  const asstIdRef = useRef<string | null>(null);
  // §1b: an "error" SSE event stashes its message here (formerly a local in
  // send()); the POST path reads it after the read loop to render the banner.
  const streamErrorRef = useRef<string | null>(null);
  // §1b: subscriber to a live turn's event log when returning to a running
  // session — its own AbortController, aborted on unmount / sessionId change.
  // Aborting only closes THIS reader, never the detached server run.
  const reconnectAbortRef = useRef<AbortController | null>(null);
  /** State twin of `reconnectAbortRef`, existing ONLY so the queue drains can
   *  depend on it. The ref stays the synchronous truth every gate reads; this
   *  is what re-runs those effects when the tail opens or closes. */
  const [reconnectLive, setReconnectLive] = useState(false);
  // Guard so the reconnect effect attaches at most once per session id.
  const reconnectedRef = useRef<string | null>(null);

  // The god-view handoff (docs/loom-model.md §5's "make this real" moment):
  // set the instant mcp__loom__start_loom's tool_result reports {loomId,
  // url} (see the "tool_result" case below), and seeded from the persisted
  // chat on reload so the header chip survives a refresh. `dismissed` only
  // hides the banner — the chip stays up for the life of the session either
  // way, since the loom itself doesn't go away when the banner is closed.
  const [loomHandoff, setLoomHandoff] = useState<{ loomId: string; url: string } | null>(
    initialChat?.loomId ? { loomId: initialChat.loomId, url: `/looms/${initialChat.loomId}` } : null,
  );
  const [handoffDismissed, setHandoffDismissed] = useState(false);
  // Live loom lifecycle for the aggregate pill + inline transcript rows (replaces
  // the persistent "Loom started" banner). `loomLive` is the latest state/title
  // from the loom's own event stream; `loomEvents` is the durable in-stream
  // record appended on each transition. Both are seeded/driven by loomHandoff.
  const [loomLive, setLoomLive] = useState<{ title: string; state: WorkUnitState } | null>(null);
  const [loomEvents, setLoomEvents] = useState<LoomEventRow[]>([]);
  // tool_use id -> tool name, populated as "tool" events arrive so the
  // "tool_result" case (which only carries id/output/isError) can tell
  // whether a given result belongs to start_loom. A ref, not state: purely
  // internal bookkeeping that never drives a render itself.
  const toolNamesRef = useRef<Map<string, string>>(new Map());

  // ── Loom watchers (docs/watchers-design.md §6) ──────────────────────────
  // Active watches for THIS session, seeded from the server on mount and after
  // each turn (loadWatches). watchesRef mirrors it (like statusRef above) so the
  // background subscriber's handlers read the LATEST triggerStates without
  // `watches` being in the effect's dep set — which would re-subscribe on every
  // edit rather than only when the watched-loom set changes.
  const [watches, setWatches] = useState<Watch[]>([]);
  const watchesRef = useRef<Watch[]>(watches);
  watchesRef.current = watches;
  // Fired alerts surfaced as cards near the loom-handoff banner.
  const [watcherAlerts, setWatcherAlerts] = useState<
    { id: string; loomId: string; title: string; state: WorkUnitState }[]
  >([]);
  // Synthetic turns waiting for the composer to go idle before they dispatch
  // through send() (never mid-turn — the busy guard forbids it): the loom
  // watcher's "[watcher] …" messages, and story 4.1's Ultra completion-wake
  // trigger.
  //
  // `hidden` IS NEW IN 4.1 AND IS NOT OPTIONAL MACHINERY. Before it, the item
  // type was `{ id; text }` and the §6.D drain dispatched `send(next.text)` with
  // no options object at all — so `send`'s `opts?.hidden` read falsy and its
  // `...(opts?.hidden ? [] : [{ role: "user", … }])` spread pushed a real user
  // bubble. Enqueuing a sentinel and "letting the existing effect drain it"
  // would therefore have rendered the raw sentinel as something the human
  // appeared to type — the exact opposite of AC1. The watcher sets no flag, so
  // its own "[watcher] …" turns stay VISIBLE, which is what they are meant to be.
  const [injectionQueue, setInjectionQueue] = useState<
    { id: string; text: string; hidden?: boolean }[]
  >([]);
  // De-dupe: watchId -> last trigger state we fired on. A ref, so it survives
  // re-subscribes and a connect-time `run` snapshot of an already-fired state
  // can't re-fire; re-arms only when the loom reaches a DIFFERENT trigger state.
  const lastFiredRef = useRef<Map<string, WorkUnitState>>(new Map());
  // Monotonic id source for alert / injection items.
  const watcherSeqRef = useRef(0);
  // Stable, sorted, comma-joined set of watched loomIds. The background
  // subscriber keys on THIS primitive so it re-subscribes only when the SET
  // changes — never on every render or an unrelated `watches` field edit.
  const watchedLoomIds = Array.from(new Set(watches.map((w) => w.loomId)))
    .sort()
    .join(",");

  // Agent types the live SDK session reports as available (init message's
  // `agents` list) — surfaced as a subtle one-liner on the tab strip, not its
  // own overlay. Null until a turn actually runs (matches sdkSlashCommands).
  const [availableAgents, setAvailableAgents] = useState<string[] | null>(null);
  // "main" or a spawn's tool_use id. Pure client-side selection state — tabs
  // themselves are derived from the transcript (agentBuckets below), never
  // stored separately, so there's nothing else to keep in sync here.
  const [activeTab, setActiveTab] = useState<string>("main");

  // Slash-command autocomplete. `projectCommands` comes from the project's
  // .claude/commands scan (has descriptions); `sdkSlashCommands` narrows it to
  // what the live SDK session actually reports once a turn's "session" event
  // arrives (that list also contains built-ins we deliberately don't show).
  const [projectCommands, setProjectCommands] = useState<ProjectCommand[]>([]);
  const [sdkSlashCommands, setSdkSlashCommands] = useState<string[] | null>(
    null,
  );
  const [menuDismissed, setMenuDismissed] = useState(false);

  // Composer attachments. The staged FILES live in PromptInputProvider's own
  // context (this surface is wrapped in one) — all that is held here is the
  // one-line failure text shown above the composer, since the app has no toast
  // primitive and a cap rejection that says nothing reads as a dead button.
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  // Same one-line-banner idiom as attachmentError above, for the Compact
  // affordance's own failure path — compactNow never appends a message, so
  // there is no assistant bubble to carry an "**Error:**" line the way a
  // normal turn's send() does.
  const [compactError, setCompactError] = useState<string | null>(null);

  // `@` file mentions. `caret` is tracked because — unlike the slash menu, which
  // only ever fires when the WHOLE value starts with "/" — a mention is typed
  // mid-sentence, so the query is whatever `@token` the cursor currently sits
  // at the end of. Null means "not measured yet", which reads as end-of-text.
  const [caret, setCaret] = useState<number | null>(null);
  const [mentionFiles, setMentionFiles] = useState<ProjectFile[]>([]);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const [mentionIndex, setMentionIndex] = useState(0);
  // The composer textarea, and the caret position to restore into it once React
  // has committed a programmatic edit. Accepting a mention rewrites the value
  // through the controlled `setInput`, which puts the cursor at the END of the
  // new text — so completing `@rou` mid-sentence would drop the human's cursor
  // after the rest of their sentence rather than after the path they just
  // inserted. The DOM write has to happen after the commit, hence the ref pair
  // plus the effect below rather than a straight-line assignment.
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const pendingCaretRef = useRef<number | null>(null);
  // The conversation column, which is the composer's drop zone — see the
  // `dropTarget` prop and the element this is attached to.
  const sessionSurfaceRef = useRef<HTMLDivElement | null>(null);

  // Reveal the browser panel when an AGENT mutates a tab in one of THIS
  // session's scopes.
  //
  // It lives here rather than inside <RightPanel> because it is session
  // semantics — a window subscription plus a comparison against this session's
  // own scope keys — and AD-12 keeps both out of the shell (INV-8a fails the
  // shell by name for either). The panel is a pure projection of the store; the
  // adapter decides when to open it.
  //
  // Draft scopes are valid browser owners until the first session event adopts
  // them into the persisted session key, so BOTH keys are accepted: without the
  // provisional one, an agent that opens a tab before that adoption reveals
  // nothing.
  useEffect(() => {
    const revealAgentBrowser = (event: Event) => {
      const eventScopeKey = (event as CustomEvent<string>).detail;
      if (
        eventScopeKey !== resolvedRightPanelScopeKey &&
        eventScopeKey !== provisionalRightPanelScopeKey
      ) {
        return;
      }
      openRightPanelBrowser(resolvedRightPanelScopeKey);
    };
    window.addEventListener(TELAR_BROWSER_MUTATION_EVENT, revealAgentBrowser);
    return () => window.removeEventListener(
      TELAR_BROWSER_MUTATION_EVENT,
      revealAgentBrowser,
    );
  }, [resolvedRightPanelScopeKey, provisionalRightPanelScopeKey]);

  useEffect(() => {
    const pos = pendingCaretRef.current;
    if (pos === null) return;
    pendingCaretRef.current = null;
    const el = composerRef.current;
    if (!el) return;
    // focus() because accepting by MOUSE leaves the textarea unfocused; the
    // mousedown handler on the menu item prevents the blur, but a click that
    // landed before the composer ever had focus still needs it back.
    el.focus();
    el.setSelectionRange(pos, pos);
  }, [textInput.value]);
  const [selectedIndex, setSelectedIndex] = useState(0);

  // The three per-item disclosure maps that used to live here — groupOverrides,
  // rowOverrides and thinkingOpen — moved INTO the shell (story 3.1's carve-out).
  // They are transcript view state, not session state: nothing outside the
  // transcript ever read them (grepped), and every surface that renders a
  // transcript needs the same three. The shell now holds one opaque keyed map
  // and hands each renderer `view.isOpen`/`view.setOpen` scoped to its own item,
  // so it never learns what a "tool group" or a "thinking block" is.

  // Click-to-edit for the header title (item 5's rename affordance). Only
  // meaningful once a session exists server-side (PATCH /api/chats/[id]
  // needs a chat to already be in the store).
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(title);

  // Message queue (1.5): typing + Enter while the agent works QUEUES the message
  // (never dropped, never force-sent mid-turn — the busy guard forbids that).
  // Queued messages render as editable/removable chips above the composer; the
  // engine accepts and dispatches them in order independently of this mount.
  // A queued message carries its attachments with it. They ride as data URLs
  // (PromptInput converts the blob URLs before handing them over), so they stay
  // valid after the composer has cleared and revoked the originals — the queue
  // can outlive several turns.
  const [messageQueue, setMessageQueue] = useState<SessionQueuedMessage[]>([]);
  const [engineQueuePaused, setEngineQueuePaused] = useState(false);
  const [editingQueueId, setEditingQueueId] = useState<string | null>(null);
  const queueSeqRef = useRef(0);

  // ISSUE #5 — THE QUEUE OUTLIVES THIS COMPONENT.
  //
  // It used to be `useState` and nothing else, so navigating to another
  // conversation unmounted this component and destroyed messages the user had
  // written, committed with Enter, and been shown a chip for. The chips are
  // editable and removable, which is what made the loss read as data loss: the
  // affordances say "this is a durable list you are curating."
  //
  // Seeded in an EFFECT rather than a `useState` initializer on purpose. This
  // component is server-rendered, so an initializer that read localStorage would
  // render `[]` on the server and restored chips on the client — a hydration
  // mismatch on the very first paint. Restoring after mount costs one frame and
  // is the standard shape for client-only persisted state.
  const queueHydratedFor = useRef<string | null>(null);
  useEffect(() => {
    // A draft session has no id to key by, and nothing to navigate back TO —
    // there is no session yet. Persistence starts when identity does.
    if (!sessionId || queueHydratedFor.current === sessionId) return;
    queueHydratedFor.current = sessionId;
    const restored = readQueue<SessionQueuedMessage>(
      browserQueueStorage(),
      queueStorageKey(sessionId),
    );
    if (restored.length === 0) return;
    // Restored entries are legacy/pre-ack work only. Once the engine accepts an
    // item it is removed from localStorage and projected back from queue.json.
    // Never clobber a queue this mount already has: when a draft session is
    // minted mid-stream its id arrives AFTER the user may have queued something,
    // and that in-memory queue is newer than anything on disk.
    setMessageQueue((current) => (current.length > 0 ? current : restored));
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    // Drains write too: an emptied queue REMOVES its key rather than leaving a
    // tombstone in a budget shared with every other chat the user has opened.
    writeQueue(
      browserQueueStorage(),
      queueStorageKey(sessionId),
      // Once the engine acknowledges an item, localStorage is no longer an
      // owner or backup. Keep only pre-ack migration/upload work locally.
      messageQueue.filter((item) => !item.accepted),
      stripQueuedAttachments,
    );
  }, [sessionId, messageQueue]);

  const busy = status === "submitted" || status === "streaming";

  // ── item 3: auto-dock on leaving a STANDALONE session mid-turn ────────────
  // Stable callbacks off the optional dock context (each is a useCallback with
  // empty deps in the provider, so destructuring keeps the effects from
  // re-firing on unrelated dock state changes).
  const autoDock = dock?.autoDock;
  const clearAutoDock = dock?.clearAutoDock;

  // Re-entering the standalone view for a session removes ITS auto-docked head
  // (a manual head is left in place — clearAutoDock checks the flag). This is
  // also what makes "pop out from the dock panel back into the session" safe:
  // the pop-out mounts this view, which clears the head, and no unmount fires
  // to immediately re-dock it. Never runs for an embedded surface (loom Chat
  // tab / escalation never auto-dock, so they have nothing to clear).
  useEffect(() => {
    if (embedded || !clearAutoDock || !sessionId) return;
    clearAutoDock(sessionId);
  }, [embedded, clearAutoDock, sessionId]);

  // On unmount (leaving the surface — App Router route change / navigation)
  // auto-dock IFF the turn is still live and this is a real, persisted,
  // non-embedded session. Latest values ride a ref so the cleanup, which runs
  // only at unmount, reads leave-time state rather than a stale closure.
  //
  // STORY 4.2 / AC7 WIDENED THE GUARD BY ONE TERM. `busy` is the CHAT TURN's
  // liveness, and an Ultra run is DETACHED — it routinely outlives the turn that
  // launched it, so leaving a session with a live run would have left no head
  // for the very case FR-UW-6 exists to describe. The dock signal
  // (`components/common/ultra-dock-signal.tsx`) covers the other direction — a
  // session the user never visited at all — and this covers leaving one.
  const leaveRef = useRef({ busy, chatPersisted, sessionId, title, project, embedded });
  leaveRef.current = { busy, chatPersisted, sessionId, title, project, embedded };
  // A SEPARATE REF, and not a seventh field on `leaveRef`, for a mechanical
  // reason: `ultraLiveCount` is derived from the `useUltraRuns` hook further
  // down this component, so reading it into `leaveRef.current` here would be a
  // temporal-dead-zone throw on every render. This ref is declared here (where
  // the cleanup that reads it lives) and ASSIGNED at the hook's own site.
  const ultraLiveRef = useRef(0);
  useEffect(() => {
    return () => {
      const s = leaveRef.current;
      if (!autoDock) return;
      // Guards: embedded surfaces never auto-dock; a session with neither a live
      // turn nor a live Ultra run never auto-docks; need a confirmed persisted id
      // to follow. autoDock itself no-ops if the id is already docked, so no
      // duplicate heads.
      if (s.embedded || (!s.busy && ultraLiveRef.current === 0) || !s.chatPersisted || !s.sessionId)
        return;
      autoDock({
        id: s.sessionId,
        title: s.title,
        project: s.project,
        initial: (s.title.trim()[0] ?? s.project.trim()[0] ?? "·").toUpperCase(),
      });
    };
  }, [autoDock]);

  // Buckets a spawn's own transcript by its tool_use id — reconstructed fresh
  // from `messages` every render (live streaming or a persisted load look
  // identical here), never a separate piece of state. First pass finds every
  // TOP-LEVEL enriched spawn part (in first-appearance order, so tabs don't
  // reorder as later events refresh a spawn's output); second pass files
  // every part whose parentId names one of those spawns into its bucket, in
  // transcript order — including parts that land in a later message than the
  // spawn.
  //
  // "Top-level" (parentOf(part) === undefined) matters here: a subagent that
  // itself spawns a sub-subagent produces a tool part that is BOTH enriched
  // with its own `agent` info AND carries a parentId — the server's
  // ParentFlattener already collapsed it onto its top-level ancestor's
  // bucket, so treating it as a second bucket-worthy spawn here would open a
  // phantom tab that nothing could ever file parts into (everything the
  // nested subagent produces resolves straight to the same ancestor id, per
  // ParentFlattener, never to this nested id). It still renders inside its
  // ancestor's own tab content — as a plain ToolStepRow, same as any other
  // tool call that tab's subagent made — just without the agent-chip
  // treatment or a tab of its own; see AgentBucket and `agentBucketItem`,
  // which (unlike Main's projection) passes no onSelectAgent/agentSteps into
  // its `conversation:tools` payloads. (This pointer used to name
  // `renderAgentBucket` — the second copy of the kind dispatch that story 3.1
  // deleted; `agentBucketItem` is where that rendering lives now.)
  const agentProjection = useMemo(
    () => deriveAgentProjection(messages, busy),
    [busy, messages],
  );
  const agentBuckets = agentProjection.buckets;

  const agentBucketById = useMemo(
    () => new Map(agentBuckets.map((b) => [b.id, b])),
    [agentBuckets],
  );

  // A pending permission card always lives on Main (see the Part union
  // comment) — badge the Main tab with it so an approval can never be
  // stranded behind a subagent tab the user happens to be viewing.
  const mainNeedsAttention = useMemo(
    () =>
      messages.some((m) =>
        m.parts.some((p) => p.type === "permission" && p.status === "pending"),
      ),
    [messages],
  );

  const activeBucket = activeTab === "main" ? null : (agentBucketById.get(activeTab) ?? null);

  // Record the turn boundary once. The live one-second clock lives inside the
  // tiny WorkingIndicator leaf so it cannot rerender this entire session view.
  useEffect(() => {
    if (!busy) return;
    setTurnStartedAt(Date.now());
  }, [busy]);

  // AN INTERRUPTED TURN IS NOT A FINISHED TURN — issue #5's real cause.
  //
  // `status` flips to "ready" the instant a turn is torn down, and the queue
  // drain reads "ready" as "the agent is free, send the next one". On a
  // navigation that was catastrophic: aborting the turn made the drain dispatch
  // the user's queued message from a component that was already unmounting, so
  // the POST went out with nowhere to deliver its stream and the queue was then
  // persisted as empty. The message was gone, having never been seen or sent.
  //
  // The latch says "the last turn ended because something killed it", and the
  // drain refuses to fire while it is set. It covers the Stop button for the
  // same reason: stopping the agent and having it immediately restart itself
  // with a queued message is the opposite of what Stop means.
  const turnInterruptedRef = useRef(false);

  // Abort any in-flight turn if the session is navigated away from.
  //
  // THE BODY IS NOT DEAD CODE — IT IS THE WHOLE CORRECTNESS OF THE LATCH. React
  // StrictMode double-invokes effects in development: body → cleanup → body. An
  // effect that only had a cleanup therefore ran that cleanup on the FIRST
  // mount, arming `turnInterruptedRef` before the user had done anything, and
  // nothing ever disarmed it. The drain gate then refused forever, so a queued
  // message was restored, displayed, and never sent — on every mount, in dev.
  //
  // Arming on teardown and disarming on setup makes the pair symmetric, so the
  // StrictMode cycle lands where a single mount would: false.
  useEffect(() => {
    turnInterruptedRef.current = false;
    return () => {
      turnInterruptedRef.current = true;
      abortRef.current?.abort();
    };
  }, []);

  // Non-200 (including a project scan with no .claude/commands dir, which the
  // endpoint itself answers with an empty list) is treated as "no commands" —
  // autocomplete is a nicety, never worth an error UI.
  useEffect(() => {
    let cancelled = false;
    cachedJson<{ commands?: ProjectCommand[] }>(
      `/api/projects/${encodeURIComponent(project)}/commands`,
      { maxAgeMs: 60_000 },
    )
      .then((data: { commands?: ProjectCommand[] }) => {
        if (!cancelled) setProjectCommands(data.commands ?? []);
      })
      .catch(() => {
        if (!cancelled) setProjectCommands([]);
      });
    return () => {
      cancelled = true;
    };
  }, [project]);

  const patch = (id: string, fn: (m: ChatMessage) => ChatMessage) =>
    setMessages((ms) => ms.map((m) => (m.id === id ? fn(m) : m)));

  // A thinking block's end is never sent explicitly by the server (see the
  // "thinking" SSE case) — it's inferred from the next delta/text/tool for
  // the SAME parent. Closes (marks `done`), never deletes, so ThinkingRow
  // switches from the live growing block to the collapsed "✻ Thought" row
  // instead of the text vanishing.
  const closeThinking = (m: ChatMessage, parent: string | undefined): ChatMessage => ({
    ...m,
    parts: m.parts.map((p) =>
      p.type === "thinking" && !p.done && parentOf(p) === parent ? { ...p, done: true } : p,
    ),
  });

  // A tool part still missing output when the turn ends abnormally (Stop
  // clicked, mid-turn server error, dropped connection) never got its
  // tool_result — flag it so it renders as "interrupted" instead of looking
  // identical to a tool that genuinely finished with an empty result.
  const markToolsInterrupted = (id: string) =>
    patch(id, (m) => ({
      ...m,
      parts: m.parts.map((p) =>
        p.type === "tool" && p.output === undefined ? { ...p, interrupted: true } : p,
      ),
    }));

  const respondPermission = useCallback(
    (id: string, behavior: "allow" | "deny", always: boolean, rule?: string) => {
      // Optimistic — the "permission_result" SSE event (or the server's 120s
      // timeout deny) is authoritative and will overwrite this regardless.
      setMessages((ms) =>
        ms.map((m) => ({
          ...m,
          parts: m.parts.map((p) =>
            p.type === "permission" && p.id === id
              ? { ...p, status: behavior === "allow" ? "allowed" : "denied" }
              : p,
          ),
        })),
      );
      fetch("/api/chat/permission", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // `rule` is only sent when the user picked a non-default option off
        // the card — the route validates it's one of THIS request's
        // remembered ruleOptions (isOfferedRule) and 400s otherwise.
        body: JSON.stringify({ id, behavior, always, ...(rule ? { rule } : {}) }),
      }).catch(() => {
        // Fire-and-forget: the SSE event / server timeout still resolves this.
      });
    },
    [],
  );

  // The rename affordance's commit path: optimistic update, PATCH, revert on
  // failure. Only ever called once a session exists (see commitTitleEdit,
  // gated on sessionId, below) — a chat has to already be in the store for
  // PATCH to find it.
  const saveTitle = useCallback(
    (id: string, next: string) => {
      const prev = title;
      setTitle(next);
      fetch(`/api/chats/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: next }),
      })
        .then((res) => {
          if (!res.ok) throw new Error("rename failed");
          dispatchTelarRefresh({ domains: ["chats"], project, sessionId: id });
        })
        .catch(() => setTitle(prev));
    },
    [title],
  );

  const applyServerEvent = useCallback((event: string, payload: any): void => {
    // The reconnect log (session-log.ts) opens with a synthetic "user" event so
    // a returning client renders the user bubble exactly how send() adds it
    // optimistically. On the POST path this event never fires.
    if (event === "user") {
      const userId = `m${nextId.current++}`;
      setMessages((ms) => [
        ...ms,
        { id: userId, role: "user", parts: [{ type: "text", text: payload.text, done: true }] },
      ]);
      return;
    }
    // Compaction is not a turn — no assistant text, no tool calls, and (on
    // the Codex side especially) no `session`/`done` events at all — so it
    // gets its own early return, mirroring the "user" case above, rather than
    // falling into the "every other event targets this turn's assistant
    // message" block below. Falling through there would spuriously open an
    // empty assistant bubble for a Compact press, which is exactly the
    // landmine this guards against. `compact_boundary` (Claude-only, richer
    // token-count metadata) rides the same pair but changes nothing further
    // yet — it deliberately does not reset `compacting`, since Claude's own
    // "compacted" event (PostCompact) already does, and always fires after.
    if (event === "compacting" || event === "compacted" || event === "compact_boundary") {
      if (event === "compacting") setCompacting(true);
      if (event === "compacted") setCompacting(false);
      return;
    }
    // Every other event targets this turn's assistant message. On the POST path
    // send() pre-created it and set asstIdRef; on reconnect there is none yet,
    // so the first assistant-side event lazily creates it here (same shape
    // send() uses) and records its id for the rest of the turn.
    let asstId = asstIdRef.current;
    if (!asstId) {
      const id = `m${nextId.current++}`;
      asstIdRef.current = id;
      asstId = id;
      setMessages((ms) => [...ms, { id, role: "assistant", parts: [] }]);
    }
    switch (event) {
              case "session":
                // A newly minted session id — reflect it in the URL shallowly.
                // router.replace here would be a real App Router navigation:
                // it remounts the page, cancels this fetch, and the abort kills
                // the SDK turn server-side. history.replaceState updates the
                // address bar only; the next real navigation loads the
                // persisted transcript from the new URL.
                if (payload.sessionId !== sessionId) {
                  if (!sessionId) {
                    adoptRightPanelSession(
                      provisionalRightPanelScopeKey,
                      `${project}:${payload.sessionId}`,
                    );
                  }
                  if (!sessionId) {
                    void window.telarDesktop?.browser.adoptScope(
                      provisionalRightPanelScopeKey,
                      `${project}:${payload.sessionId}`,
                    );
                  }
                  setSessionId(payload.sessionId);
                  // An embedded steerer session (loom Chat tab) OR escalation
                  // session (blocked-loom discuss surface) keeps the /looms/[id]
                  // URL — never rewrite the address bar out from under the
                  // cockpit. Both now persist with a role (store.ts's
                  // Chat.role) and reattach via initialChat on remount — see
                  // discuss-escalation.tsx's own seed fetch.
                  if (!steerer && !escalation) {
                    window.history.replaceState(
                      null,
                      "",
                      `/projects/${encodeURIComponent(project)}/sessions/${payload.sessionId}`,
                    );
                  }
                }
                if (Array.isArray(payload.slashCommands)) {
                  setSdkSlashCommands(payload.slashCommands);
                }
                // Available subagent types for this session — surfaced as a
                // muted one-liner on the tab strip, nothing more (contract #6).
                if (Array.isArray(payload.agents)) {
                  setAvailableAgents(payload.agents);
                }
                break;
              case "thinking": {
                // Still drives the turn-wide busy wording (unchanged — see
                // below), but now ALSO opens a live "thinking" part attributed
                // to `parent` (main thread when omitted) — the growing muted
                // italic block ThinkingRow renders while it streams.
                //
                // A BLOCK START CLOSES THE PREVIOUS OPEN BLOCK for the same
                // parent before opening its own. This used to assume the close
                // had already happened — "by the time a second thinking block
                // starts, the first was closed by whatever delta/text/tool
                // followed it" — which is true only of a provider that puts
                // something between two block starts. Codex emits them
                // back to back with no deltas in between, so nothing ever ran
                // closeThinking and the open blocks accumulated, one per start,
                // each stuck at `done: false` for the rest of the turn.
                //
                // Closing here makes the invariant hold by construction rather
                // than by luck: AT MOST ONE thinking part per parent is open at
                // any moment, whatever the provider sends.
                setThinking(true);
                const parent: string | undefined = payload.parent ?? undefined;
                patch(asstId, (m) => {
                  const closed = closeThinking(m, parent);
                  return {
                    ...closed,
                    parts: [
                      ...closed.parts,
                      { type: "thinking", text: "", done: false, parentId: parent },
                    ],
                  };
                });
                break;
              }
              case "thinking_delta": {
                // Merges into the trailing OPEN thinking part of this same
                // parent — mirrors "delta"'s merge-into-trailing-part
                // pattern, just scoped to type "thinking" instead of "text"
                // so the two never merge into each other.
                const parent: string | undefined = payload.parent ?? undefined;
                patch(asstId, (m) => {
                  const idx = m.parts.findLastIndex((p) => parentOf(p) === parent);
                  const last = idx >= 0 ? m.parts[idx] : undefined;
                  if (last?.type === "thinking" && !last.done) {
                    const parts = [...m.parts];
                    parts[idx] = { ...last, text: last.text + payload.text };
                    return { ...m, parts };
                  }
                  // No open thinking part for this parent (e.g. it already
                  // got closed by an interleaved event) — open one so the
                  // text isn't dropped.
                  return {
                    ...m,
                    parts: [...m.parts, { type: "thinking", text: payload.text, done: false, parentId: parent }],
                  };
                });
                break;
              }
              case "delta": {
                // `parent` (parent_tool_use_id) routes this chunk to its own
                // tab's bucket — null/omitted means the main thread. Several
                // parents can stream concurrently (main + N subagents), so the
                // merge target is "the trailing part *of this same parent*",
                // not just the array's last element — otherwise an
                // interleaved chunk from another tab would either get
                // appended onto the wrong text run or split one parent's text
                // across two parts.
                const parent: string | undefined = payload.parent ?? undefined;
                setStatus("streaming");
                setThinking(false);
                patch(asstId, (m) => {
                  const closed = closeThinking(m, parent);
                  const idx = closed.parts.findLastIndex((p) => parentOf(p) === parent);
                  const last = idx >= 0 ? closed.parts[idx] : undefined;
                  if (last?.type === "text" && !last.done) {
                    const parts = [...closed.parts];
                    parts[idx] = { ...last, text: last.text + payload.text };
                    return { ...closed, parts };
                  }
                  return {
                    ...closed,
                    parts: [...closed.parts, { type: "text", text: payload.text, done: false, parentId: parent }],
                  };
                });
                break;
              }
              case "text": {
                const parent: string | undefined = payload.parent ?? undefined;
                setStatus("streaming");
                setThinking(false);
                patch(asstId, (m) => {
                  const closed = closeThinking(m, parent);
                  const idx = closed.parts.findLastIndex((p) => parentOf(p) === parent);
                  const last = idx >= 0 ? closed.parts[idx] : undefined;
                  if (last?.type === "text" && !last.done) {
                    const parts = [...closed.parts];
                    parts[idx] = { type: "text", text: payload.text, done: true, parentId: parent };
                    return { ...closed, parts };
                  }
                  return {
                    ...closed,
                    parts: [...closed.parts, { type: "text", text: payload.text, done: true, parentId: parent }],
                  };
                });
                break;
              }
              case "tool": {
                const parent: string | undefined = payload.parent ?? undefined;
                setStatus("streaming");
                setThinking(false);
                // Seed the name lookup the "tool_result" case below needs to
                // recognize a start_loom result (that event carries only
                // id/output/isError, never the name).
                if (payload.id) toolNamesRef.current.set(payload.id, payload.name);
                patch(asstId, (m) => {
                  const closed = closeThinking(m, parent);
                  return {
                    ...closed,
                    parts: [
                      ...closed.parts,
                      {
                        type: "tool",
                        name: payload.name,
                        id: payload.id,
                        input: payload.input,
                        ...(parent ? { parentId: parent } : {}),
                        // Only a spawn call's own "tool" event carries `agent`
                        // (pulled server-side from its AgentInput) — everything
                        // else is undefined here, same as before this feature.
                        ...(payload.agent ? { agent: payload.agent as AgentInfo } : {}),
                      },
                    ],
                  };
                });
                break;
              }
              case "tool_result":
                // Can arrive after later parts already exist (more tool calls
                // or text streamed in since) — find the part by id wherever
                // it landed in this turn's own message rather than assuming
                // it's the newest part. Scoped to asstId (like every other
                // case here) rather than scanning every message in the
                // conversation — this turn's tool ids only ever land on the
                // message this same turn opened.
                patch(asstId, (m) => ({
                  ...m,
                  parts: m.parts.map((p) =>
                    p.type === "tool" && p.id === payload.id
                      ? { ...p, output: payload.output, isError: payload.isError }
                      : p,
                  ),
                }));
                // The "make this real → god-view" moment (docs/loom-model.md
                // §5): mcp__loom__start_loom's success result is
                // `{loomId, url}` (lib/loom-mcp.ts's start_loom tool) —
                // surface the handoff banner + header chip the instant it
                // lands, live, without waiting for a reload.
                if (
                  !payload.isError &&
                  toolNamesRef.current.get(payload.id) === LOOM_START_TOOL
                ) {
                  try {
                    const parsed = JSON.parse(payload.output) as { loomId?: unknown; url?: unknown };
                    if (typeof parsed.loomId === "string" && typeof parsed.url === "string") {
                      setLoomHandoff({ loomId: parsed.loomId, url: parsed.url });
                      setHandoffDismissed(false);
                      // Loom Session (docs/loom-model.md §5): never
                      // auto-navigate away from the planning session — the
                      // "Loom started" banner below (with its new-tab "View
                      // god-view" link) is the only affordance, for planner
                      // and normal sessions alike.
                    }
                  } catch {
                    // Non-JSON output — nothing to surface.
                  }
                }
                break;
              case "task_status":
                // Authoritative completion signal for a backgrounded
                // subagent (route.ts's task_notification handler) — see
                // agentStatus's comment. Scoped to asstId like "tool_result".
                patch(asstId, (m) => ({
                  ...m,
                  parts: m.parts.map((p) =>
                    p.type === "tool" && p.id === payload.id
                      ? { ...p, taskStatus: payload.status }
                      : p,
                  ),
                }));
                break;
              case "permission":
                // The turn stays in flight while the card is pending — status
                // mirrors the "tool" case so the busy shimmer keeps showing.
                // Permission cards never carry a parent (contract #7) and
                // always need a response — auto-switch to Main so a pending
                // approval is never stranded behind whichever subagent tab
                // the user happens to be looking at.
                setStatus("streaming");
                setThinking(false);
                setActiveTab("main");
                patch(asstId, (m) => ({
                  ...m,
                  parts: [
                    ...m.parts,
                    {
                      type: "permission",
                      id: payload.id,
                      toolName: payload.toolName,
                      input: payload.input ?? {},
                      rule: payload.rule,
                      ruleOptions: Array.isArray(payload.ruleOptions) ? payload.ruleOptions : [],
                      // Left undefined when the route sent nothing — the main
                      // turn asking is not the same as an unnamed agent asking,
                      // and the card renders the two differently.
                      agentId: typeof payload.agentId === "string" ? payload.agentId : undefined,
                      status: "pending",
                    },
                  ],
                }));
                break;
              case "permission_result":
                // Scoped to asstId — see the "tool_result" case above.
                patch(asstId, (m) => ({
                  ...m,
                  parts: m.parts.map((p) =>
                    p.type === "permission" && p.id === payload.id
                      ? { ...p, status: payload.behavior === "allow" ? "allowed" : "denied" }
                      : p,
                  ),
                }));
                break;
              case "permission_denied": {
                // Auto/acceptEdits mode's classifier (or the guardrail hook)
                // blocked a call without an interactive prompt — patch the
                // matching "tool" part (from the earlier "tool" event) so it
                // renders with the destructive auto-denied chip; the rare
                // out-of-order case (this arrives before that "tool" event
                // ever did) falls back to synthesizing one, mirroring
                // route.ts's own persisted-part fallback.
                let matched = false;
                patch(asstId, (m) => {
                  const parts = m.parts.map((p) => {
                    if (p.type === "tool" && p.id === payload.toolUseId) {
                      matched = true;
                      return { ...p, isError: true, autoDenied: true, output: p.output ?? payload.message };
                    }
                    return p;
                  });
                  return matched
                    ? { ...m, parts }
                    : {
                        ...m,
                        parts: [
                          ...parts,
                          {
                            type: "tool" as const,
                            id: payload.toolUseId,
                            name: payload.toolName,
                            isError: true,
                            autoDenied: true,
                            output: payload.message,
                          },
                        ],
                      };
                });
                break;
              }
              case "interrupted":
                // The server's teardown just flagged some still-unresolved
                // tool part(s) of THIS turn as interrupted (route.ts's
                // `finally` block) — mirror that locally so the live view
                // matches what a reload would show instead of leaving a
                // subagent tab's dot shimmering "running" forever after the
                // stream has actually ended (status goes to "ready" right
                // after this same read loop finishes).
                markToolsInterrupted(asstId);
                break;
              case "title":
                // Fired once, only for a fresh session (route.ts contract #2)
                // — arrives before "saved". Only ever overwrites the
                // client-side placeholder (text.slice(0, 60), set in `send`
                // above) with the AI-generated title; never fires again for
                // this chat's later turns, so it can never clobber a
                // subsequent user rename.
                if (typeof payload.title === "string" && payload.title) {
                  setTitle(payload.title);
                }
                break;
              case "done":
                // Context is the server-computed final-call prompt size
                // (payload.context), not a cumulative lifetime token count.
                if (typeof payload.context === "number") setContext(payload.context);
                if (
                  payload.contextUsage?.source === "claude-sdk" ||
                  payload.contextUsage?.source === "codex-app-server"
                ) {
                  setContextUsage(payload.contextUsage as ContextUsageSnapshot);
                }
                break;
              case "saved":
                setChatPersisted(true);
                dispatchTelarRefresh({
                  domains: ["chats", "usage"],
                  project,
                  sessionId: sessionId ?? undefined,
                });
                break;
              case "error":
                streamErrorRef.current = payload.message;
                break;
    }
  }, [sessionId, project, rightPanelScopeKey, provisionalRightPanelScopeKey]);

  // §1b reconnect: returning to a session whose turn is STILL running. The
  // page seeded prior turns from chats.json; here we tail the live event log so
  // the in-flight turn (its "user" header + assistant events, none of them in
  // chats.json yet) rebuilds and plays to completion. Runs at most once per
  // session id, never while a local POST turn drives this mount (abortRef), and
  // only for a real, confirmed session id that's currently idle.
  useEffect(() => {
    if (!sessionId) return;
    if (statusRef.current !== "ready") return;
    if (abortRef.current) return; // a local turn already owns this mount
    if (reconnectedRef.current === sessionId) return;
    reconnectedRef.current = sessionId;
    // Fresh assistant container for the (not-yet-persisted) in-flight turn.
    asstIdRef.current = null;

    const abort = new AbortController();
    reconnectAbortRef.current = abort;
    // A REF CANNOT WAKE AN EFFECT. The queue drain gates on
    // `reconnectAbortRef.current`, and that ref goes null in the `finally`
    // below — on the `!sawEvent` path (the turn had already finished before
    // this mount), NOTHING ELSE CHANGES: `setStatus` is skipped, so the drain
    // effect never re-runs and a queue that was blocked at mount stays blocked
    // forever. This state mirrors the ref for the sole purpose of being a
    // dependency; the gates keep reading the ref, which is the synchronous
    // truth. See the drain effect's deps.
    setReconnectLive(true);
    let sawAnyEvent = false;

    (async () => {
      try {
        let retryMs = 250;
        while (!abort.signal.aborted) {
          let sawEvent = false;
          let sawClosed = false;
          const res = await fetch(`/api/chat/${encodeURIComponent(sessionId)}/events`, {
            signal: abort.signal,
          });
          if (!res.ok || !res.body) throw new Error(`tail HTTP ${res.status}`);
          await consumeSSE(res.body.getReader(), (event, payload) => {
            sawEvent = true;
            sawAnyEvent = true;
            if (event === "closed") sawClosed = true;
            // First byte of a live turn — flip to streaming so the busy UI shows
            // while applyServerEvent rebuilds it. A not-live session emits nothing.
            setStatus((current) => (current === "ready" ? "streaming" : current));
            applyServerEvent(event, payload);
          });
          if (sawClosed || abort.signal.aborted) break;
          // No first event means the session was idle at connect time. Once a
          // live stream has begun, however, a close without its durable terminal
          // marker is a transport drop and must retry in this same mount.
          if (!sawEvent && !sawAnyEvent) break;
          await new Promise<void>((resolve, reject) => {
            const onAbort = () => {
              clearTimeout(timer);
              reject(new DOMException("Aborted", "AbortError"));
            };
            const timer = setTimeout(() => {
              abort.signal.removeEventListener("abort", onAbort);
              resolve();
            }, retryMs);
            abort.signal.addEventListener("abort", onAbort, { once: true });
          });
          retryMs = Math.min(4_000, retryMs * 2);
          // Rebuild from line zero on reconnect; applyServerEvent's id-based
          // updates are authoritative and avoid a half-visible sub-agent.
          asstIdRef.current = null;
        }
        // The run's own "done" set cost/tokens but never touches status; once the
        // log drains ("closed" → reader done), settle a still-streaming view back.
        if (sawAnyEvent) setStatus((s) => (s === "streaming" ? "ready" : s));
      } catch {
        // Aborted on unmount / sessionId change, or a dropped connection — the
        // detached server run is untouched; a later mount can reconnect again.
      } finally {
        // Clear the ref once the tail drains so it means "a reconnect reader is
        // live" — the injection guard reads it to keep from POSTing a second
        // concurrent turn during the tail (§6.D). Guard on identity so we never
        // clobber a newer reader. (Cleanup nulls it too, on unmount/dep change.)
        if (reconnectAbortRef.current === abort) reconnectAbortRef.current = null;
        setReconnectLive(false);
      }
    })();

    return () => {
      abort.abort();
      reconnectAbortRef.current = null;
      setReconnectLive(false);
    };
  }, [sessionId, applyServerEvent]);

  // The complete immutable envelope handed to either the immediate-turn
  // adapter or the durable queue. Keeping one builder prevents a queued turn
  // from silently losing provider/runtime/loom settings.
  const buildTurnPayload = useCallback(
    (
      text: string,
      attachments: { id: string; name: string; mediaType: string; size: number }[],
      runId: string,
    ) => ({
      message: text,
      ...(attachments.length ? { attachments } : {}),
      sessionId,
      runId,
      model: sessionModel,
      project,
      browserScopeKey: resolvedRightPanelScopeKey,
      account: activeAccount,
      ...(effort !== "default" ? { effort } : {}),
      runtimeMode,
      ...(provider === "claude" && fastMode ? { fastMode: true } : {}),
      ...(provider === "codex" && serviceTier !== "standard" ? { serviceTier } : {}),
      ...(planner
        ? { role: "planner" }
        : steerer
          ? { role: "steerer", loomId }
          : escalation
            ? { role: "escalation", loomId }
            : {}),
    }),
    [
      sessionId,
      sessionModel,
      project,
      resolvedRightPanelScopeKey,
      activeAccount,
      effort,
      runtimeMode,
      provider,
      fastMode,
      serviceTier,
      planner,
      steerer,
      escalation,
      loomId,
    ],
  );

  const send = useCallback(
    // `hidden` (M11 finding-1) fires a turn with NO user bubble — the escalation
    // kickoff, where `text` is the sentinel route.ts swaps for the real prompt.
    // The agent visibly speaks first: only the assistant message is appended, so
    // the human never appears to have typed the sentinel.
    async (
      text: string,
      opts?: { hidden?: boolean; files?: PromptInputMessage["files"] },
    ) => {
      // A new turn clears the interrupted latch: whatever killed the LAST turn
      // is no longer a reason to hold the queue back.
      turnInterruptedRef.current = false;
      const asstId = `m${nextId.current++}`;
      // Named before the array literal below so the Ultra annotation can be
      // recorded against it. THE FLAG LIVES IN THE ADAPTER, NEVER ON THE
      // MESSAGE: `ChatMessage` belongs to the frozen Conversation shell, and
      // INV-10c fails by name the moment a shell file learns the word "ultra" —
      // that is AD-12's "the shell acquires a domain one field at a time" drift,
      // and it caught this exact attempt. A set of ids owned here says the same
      // thing without widening anything the shell has to know.
      const userId = `m${nextId.current++}`;
      // Fresh session (no id yet): the first user message names the thread,
      // mirroring the title the store derives on save. A hidden kickoff has no
      // user text to title from, so it seeds a fixed escalation label instead.
      if (!sessionId) setTitle(opts?.hidden ? "Discuss verification" : text.slice(0, 60));
      setMessages((ms) => [
        ...ms,
        ...(opts?.hidden
          ? []
          : [
              {
                id: userId,
                role: "user" as const,
                parts: [{ type: "text" as const, text, done: true }],
              },
            ]),
        { id: asstId, role: "assistant", parts: [] },
      ]);
      setStatus("submitted");
      setThinking(false);

      const abort = new AbortController();
      abortRef.current = abort;
      const runId =
        globalThis.crypto?.randomUUID?.() ?? String(Math.random()).slice(2);
      runIdRef.current = runId;
      dispatchTelarSessionRun(sessionId);

      try {
        // Bytes first, turn second. The upload returns ids the route resolves
        // to absolute paths, which is how an attachment reaches EITHER harness
        // (see lib/attachment-contract.ts) — so nothing here is base64 and
        // /api/chat's JSON body stays the size it has always been.
        const attachments = opts?.files?.length
          ? await uploadAttachments(opts.files)
          : [];
        // Patched onto the bubble rather than included when it was appended
        // above: the ids do not exist until the upload returns, and delaying the
        // whole bubble behind that upload would make the composer feel like it
        // swallowed the message. The text lands instantly; the chips follow.
        // Persistence sends the same part server-side (see appendTurn's
        // userMessage), so a reload reproduces exactly this.
        if (attachments.length && !opts?.hidden) {
          patch(userId, (m) => ({
            ...m,
            parts: [...m.parts, { type: "attachments", files: attachments }],
          }));
        }

        const turnPayload = buildTurnPayload(text, attachments, runId);
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(turnPayload),
          signal: abort.signal,
        });
        // Another renderer may have won the session between the optimistic
        // idle check and this POST. Preserve the turn by handing the exact
        // payload to the durable engine queue instead of surfacing a lossy 409.
        if (res.status === 409 && sessionId) {
          const queued = await fetch(
            `/api/chat/${encodeURIComponent(sessionId)}/queue`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ idempotencyKey: runId, payload: turnPayload }),
            },
          );
          const queuedBody = await queued.json().catch(() => null);
          if (!queued.ok) {
            throw new Error(queuedBody?.error ?? `Queue handoff failed (HTTP ${queued.status})`);
          }
          setMessages((messages) =>
            messages.filter((message) => message.id !== userId && message.id !== asstId),
          );
          setMessageQueue((items) => [
            ...items,
            {
              id: runId,
              text,
              accepted: true,
              revision: queuedBody?.item?.revision,
              state: queuedBody?.item?.state ?? "queued",
            },
          ]);
          setStatus("ready");
          return;
        }
        if (!res.ok || !res.body) {
          // A project/account rejected server-side (unknown/removed) answers
          // with a plain JSON 400 before any SSE — surface its message.
          let detail = `HTTP ${res.status}`;
          try {
            const body = await res.json();
            if (body?.error) detail = body.error;
          } catch {
            /* not JSON — keep the status line */
          }
          throw new Error(detail);
        }

        const reader = res.body.getReader();
        // The extracted switch (applyServerEvent) patches the assistant message
        // via asstIdRef; reset the per-turn error sink before draining. An
        // "error" event records its message on streamErrorRef instead of
        // throwing mid-loop, so the server's trailing "saved"/"done" still land
        // and we surface the error only once the stream closes.
        asstIdRef.current = asstId;
        streamErrorRef.current = null;
        await consumeSSE(reader, applyServerEvent);
        const streamErrorMessage = streamErrorRef.current;
        if (streamErrorMessage) {
          markToolsInterrupted(asstId);
          patch(asstId, (m) => ({
            ...m,
            parts: [...m.parts, { type: "text", text: `**Error:** ${streamErrorMessage}`, done: true }],
          }));
          setStatus("error");
        } else {
          setStatus("ready");
        }
      } catch (err) {
        // The server's teardown fail-closed-denies any permission still open
        // on this stream once we stop reading it (client abort, unmount, or a
        // dropped connection) — mirror that locally so a stale card doesn't
        // keep showing live Allow/Deny buttons for a turn that's already
        // finished server-side.
        setMessages((ms) =>
          ms.map((m) => ({
            ...m,
            parts: m.parts.map((p) =>
              p.type === "permission" && p.status === "pending"
                ? { ...p, status: "denied" as const }
                : p,
            ),
          })),
        );
        markToolsInterrupted(asstId);
        if (abort.signal.aborted) {
          setStatus("ready");
        } else {
          patch(asstId, (m) => ({
            ...m,
            parts: [...m.parts, { type: "text", text: `**Error:** ${String(err)}`, done: true }],
          }));
          setStatus("error");
        }
      } finally {
        setThinking(false);
        abortRef.current = null;
        runIdRef.current = null;
        // Backstop, same reasoning as compactNow's own: PreCompact can fire
        // on an ORDINARY turn (Claude auto-compacting to stay under its
        // context window, mid-send()) with no `compact: true` anywhere on
        // this request — so a turn that then errors or gets Stopped before
        // its matching PostCompact ever lands would otherwise leave
        // `compacting` permanently true (and the Compact button permanently
        // disabled) for the rest of this mount, with no later "compacted"
        // event ever coming to clear it. A normal turn finishing (success,
        // error, or abort) always closes out whatever compaction it opened,
        // exactly like `compactNow`'s own finally closes out its own.
        setCompacting(false);
      }
    },
    [sessionId, buildTurnPayload, applyServerEvent],
  );

  // The composer's Compact affordance. Deliberately NOT a `send(..., {hidden:
  // true})` call: `send` always appends a fresh assistant bubble (`asstId`)
  // and sets it in `asstIdRef` BEFORE the fetch even starts, so applyServerEvent
  // has somewhere to write text/tool events — but a compaction produces
  // neither, and applyServerEvent's own "compacting"/"compacted" case (above)
  // returns early without touching any bubble at all. Reusing `send` here
  // would leave that pre-created bubble permanently empty. This posts the
  // SAME `/api/chat` route with `compact: true` (see route.ts's trigger-design
  // comment) and drains the identical SSE contract, but touches no message
  // list — `compacting` (state, set true optimistically here and by the
  // "compacting" SSE event either way, reset by "compacted" or the `finally`
  // below as a backstop) is the only visible effect until the harness's own
  // next reply.
  const compactNow = useCallback(async () => {
    if (!sessionId || compacting || busy) return;
    setCompacting(true);
    setCompactError(null);
    const runId = globalThis.crypto?.randomUUID?.() ?? String(Math.random()).slice(2);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...buildTurnPayload("", [], runId), compact: true }),
      });
      if (!res.ok || !res.body) {
        let detail = `HTTP ${res.status}`;
        try {
          const body = await res.json();
          if (body?.error) detail = body.error;
        } catch {
          /* not JSON — keep the status line */
        }
        throw new Error(detail);
      }
      const reader = res.body.getReader();
      await consumeSSE(reader, applyServerEvent);
    } catch (err) {
      setCompactError(String(err));
    } finally {
      // Backstop: a thrown fetch/network error never reaches the "compacted"
      // SSE event that would otherwise clear this, so the indicator would
      // hang forever without an unconditional reset here.
      setCompacting(false);
    }
  }, [sessionId, compacting, busy, buildTurnPayload, applyServerEvent]);

  // M11 finding-1 — auto-fire the escalation opening turn ONCE, on mount.
  // The SACRED no-auto-start rule is enforced one level up: discuss-escalation
  // .tsx only MOUNTS this component after the human clicks "Discuss", so by the
  // time this effect runs the human has already initiated — this is not an
  // auto-start, it is the agent taking the first turn of a human-opened chat.
  // Fires a HIDDEN kickoff (no user bubble) carrying the sentinel; route.ts
  // turns it into the agent's genuine analysis + verification proposal, whose
  // one write (answer_blocked) still waits on the human permission card. The
  // ref makes it strictly one-shot: a remount that already carries a sessionId
  // or messages never re-fires (shouldFireEscalationKickoff is false then), and
  // the guard flips before the async send so a re-render mid-flight can't
  // double-fire.
  const kickoffFiredRef = useRef(false);
  useEffect(() => {
    if (
      !shouldFireEscalationKickoff({
        escalation,
        sessionId,
        messagesLength: messages.length,
        alreadyFired: kickoffFiredRef.current,
      })
    )
      return;
    kickoffFiredRef.current = true;
    void send(ESCALATION_KICKOFF_SENTINEL, { hidden: true });
    // messages.length is read for the guard but intentionally omitted from deps:
    // the ref already makes this one-shot, and re-running as the transcript
    // fills would only hit the (now-false) guard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [escalation, sessionId, send]);

  // ── Loom watchers (docs/watchers-design.md §6) ──────────────────────────
  // Defined after send() so the injection effect below can reference it.
  const loadWatches = useCallback(async () => {
    if (!sessionId) return;
    try {
      const data = await cachedJson<Watch[] | { watches?: Watch[] }>(
        `/api/chat/${encodeURIComponent(sessionId)}/watches`,
        { force: true },
      );
      const list: Watch[] = Array.isArray(data)
        ? data
        : Array.isArray(data?.watches)
          ? data.watches
          : [];
      setWatches(list);
    } catch {
      // Route not ready / offline — keep whatever we already have.
    }
  }, [sessionId]);

  // §6.B — load this session's active watches on mount (sessionId set) AND after
  // each turn completes (status → "ready"), so a watch the agent just registered
  // via watch_loom is picked up without a reload. Gated on "ready" so it never
  // refetches mid-turn; the fresh-session case (sessionId null until the first
  // turn's "session" event) is covered when that turn lands back on "ready".
  useEffect(() => {
    if (!sessionId || status !== "ready") return;
    void loadWatches();
  }, [sessionId, status, loadWatches]);

  // §6.C — background subscriber, sibling to the §1b reconnect one (~1543) but
  // UNGATED on status/idle: it must react while the user keeps chatting and
  // while a turn is in flight. Keyed on the stable watchedLoomIds string, one
  // EventSource per watched loom; the connect-time `run` snapshot (route.ts:63)
  // also catches a state change missed while the tab was closed.
  useEffect(() => {
    const loomIds = watchedLoomIds ? watchedLoomIds.split(",") : [];
    if (loomIds.length === 0) return;
    const sources = loomIds.map((loomId) => {
      const es = new EventSource(
        `/api/looms/${encodeURIComponent(loomId)}/events`,
      );
      es.addEventListener("run", (e) => {
        let loom: any;
        try {
          loom = JSON.parse((e as MessageEvent).data);
        } catch {
          return;
        }
        const state = loom?.state as WorkUnitState | undefined;
        if (!state) return;
        // Read the live watch from the ref, not a stale closure — triggerStates
        // can change without the watched-loom SET (this effect's dep) changing.
        const watch = watchesRef.current.find(
          (w) => w.loomId === loomId && w.status === "active",
        );
        if (!watch || !watch.triggerStates.includes(state)) return;
        // Fire once per (watch, state); re-arm only on a DIFFERENT trigger state.
        if (lastFiredRef.current.get(watch.id) === state) return;
        lastFiredRef.current.set(watch.id, state);
        const title =
          typeof loom.title === "string" && loom.title ? loom.title : loomId;
        const seq = watcherSeqRef.current++;
        setWatcherAlerts((prev) => [
          ...prev,
          { id: `wa${seq}`, loomId, title, state },
        ]);
        setInjectionQueue((q) => [
          ...q,
          {
            id: `wi${seq}`,
            text: `[watcher] loom ${loomId} (${title}) reached ${state}. How do you want to proceed?`,
          },
        ]);
      });
      // A terminal loom sends `end` then closes; stop EventSource's auto-reconnect
      // so a done/failed/needs-review loom doesn't churn re-opening the stream.
      es.addEventListener("end", () => es.close());
      return es;
    });
    // CRITICAL: close EVERY source on unmount or when the watched-loom SET
    // changes — no leaks, no double-subscribe.
    return () => {
      for (const es of sources) es.close();
    };
  }, [watchedLoomIds]);

  // Loom-notify (replaces the banner): tail THIS session's loom event stream so
  // the aggregate pill reflects the loom's real state and each transition lands
  // as a durable inline transcript row. Durable-minimum only — state word +
  // title + short id + god-view — no thread/gate detail (the loom UI is still
  // being shaped). Seeded/keyed on loomHandoff.loomId.
  const loomHandoffId = loomHandoff?.loomId;
  const loomHandoffUrl = loomHandoff?.url;
  const loomLastStateRef = useRef<WorkUnitState | null>(null);
  const loomEventSeqRef = useRef(0);
  useEffect(() => {
    if (!loomHandoffId) return;
    loomLastStateRef.current = null;
    const url = loomHandoffUrl ?? `/looms/${loomHandoffId}`;
    const es = new EventSource(`/api/looms/${encodeURIComponent(loomHandoffId)}/events`);
    const onRun = (e: MessageEvent) => {
      let loom: any;
      try {
        loom = JSON.parse(e.data);
      } catch {
        return;
      }
      const state = loom?.state as WorkUnitState | undefined;
      if (!state) return;
      const title =
        typeof loom.title === "string" && loom.title ? loom.title : shortId(loomHandoffId);
      setLoomLive({ title, state });
      // Append an inline row only on a genuine state change (the connect-time
      // snapshot seeds the first row; later transitions each add one).
      if (loomLastStateRef.current !== state) {
        loomLastStateRef.current = state;
        const seq = loomEventSeqRef.current++;
        setLoomEvents((prev) => [
          ...prev,
          {
            id: `le${seq}`,
            loomId: shortId(loomHandoffId),
            title,
            verb: loomVerb(state),
            tone: loomTone(state),
            url,
          },
        ]);
      }
    };
    es.addEventListener("run", onRun as EventListener);
    es.addEventListener("end", () => es.close());
    return () => es.close();
  }, [loomHandoffId, loomHandoffUrl]);

  // The aggregate looms pill's data — one loom per session in practice (the
  // persisted Chat.loomId is single), modelled as an array so N looms roll up
  // cleanly if that ever changes. Tone follows the live state; title/state fall
  // back to sensible defaults before the first event lands.
  const pillLooms: PillLoom[] = useMemo(() => {
    if (!loomHandoff) return [];
    return [
      {
        key: loomHandoff.loomId,
        id: shortId(loomHandoff.loomId),
        title: loomLive?.title ?? title,
        tone: loomTone(loomLive?.state),
        stateWord: loomLive?.state ?? "weaving",
        url: loomHandoff.url,
      },
    ];
  }, [loomHandoff, loomLive, title]);

  // §6.C-bis — story 4.1 / AC1: the Ultra completion wake. Sibling to the
  // watcher subscriber above and, like it, this only ENQUEUES — the §6.D drain
  // below owns when the turn actually fires, and reusing that gate untouched is
  // what keeps a wake from POSTing a second concurrent turn.
  //
  // A POLL, NOT A STREAM (NFR-X-15 / §5.5-D9): one small session-scoped question
  // answered on the house cadence. `/api/ultra/[id]/events` exists and is story
  // 4.2's per-run channel for the anchor; a wake does not need a stream per run.
  const { pending: pendingWakes, reload: reloadUltraWake } = useUltraWake(sessionId);

  // ── story 4.2 — the Ultra run surface (D1 items 3, 10) ────────────────────
  //
  // One `EventSource` per LIVE run plus a session-scoped list poll, projected
  // into `RunSnapshot`s by `@/lib/ultra-runs`. Everything that is a DECISION
  // lives there and is tested there; what follows is wiring.
  // THE LAUNCHES THIS TRANSCRIPT HAS SEEN, which is strictly earlier than any
  // poll can know them. `spliceRunAnchors` below already reads exactly this to
  // draw the pending anchor; handing the same fact to `useUltraRuns` is what
  // lets the run ATTACH while the turn is still going instead of surfacing only
  // as a completion wake at the turn boundary (see the hook's own note on the
  // bootstrap deadlock).
  //
  // The same `p.type === "tool"` narrowing used for `spawnPart` further down,
  // and `launchedRunId` is a pure total function that returns null for every
  // part that is not a successful ultra launch — so this is one linear scan of
  // parts the component already holds, with no fetch and no new state.
  const launchedUltraRunIds = useMemo(() => {
    const ids: string[] = [];
    for (const m of messages) {
      for (const p of m.parts) {
        if (p.type !== "tool") continue;
        const id = launchedRunId(p as ToolPart);
        if (id !== null && !ids.includes(id)) ids.push(id);
      }
    }
    return ids;
  }, [messages]);

  const { runs: ultraRuns, reload: reloadUltraRuns } = useUltraRuns(
    sessionId,
    launchedUltraRunIds,
  );
  // The session's activity index now lives in the unified workspace dock.
  // `activeTab` remains the sole owner of which transcript or Ultra detail is
  // shown in the center pane; the dock is only a navigation projection.
  // Disables an anchor's Stop/Resume between the click and the next manifest
  // snapshot. Resume is NOT idempotent — a second POST while live returns a 400.
  const [ultraBusyRunId, setUltraBusyRunId] = useState<string | null>(null);

  const ultraAct = useCallback(
    async (runId: string, verb: "stop" | "resume") => {
      setUltraBusyRunId(runId);
      try {
        // Resume posts an EMPTY BODY: the route replays the persisted script.js
        // and inherits the original project and account.
        await fetch(`/api/ultra/${encodeURIComponent(runId)}/${verb}`, { method: "POST" });
      } catch {
        // Best-effort. The card and the anchor both reconcile from the next
        // manifest snapshot, never from this reply — which is also what makes an
        // agent-initiated `ultra_stop` visible without any extra wiring.
      } finally {
        setUltraBusyRunId(null);
        void reloadUltraRuns();
      }
    },
    [reloadUltraRuns],
  );

  const ultraAnchorPayloads = useMemo(() => {
    const map = new Map<string, UltraAnchorPayload>();
    for (const [runId, run] of ultraRuns) {
      map.set(runId, {
        run,
        // ALWAYS THE CLAUDE VALUE, on every ultra surface (D6a). The ultra MCP
        // server is constructed only on the Claude branch of the chat route and
        // NFR-UW-8 fixes Ultra as Claude-first, so the Codex arm of
        // `spendReadout` is unreachable here — and passing the session's own
        // `provider` would render a confident "0 tok" the moment anyone flipped
        // it, which is a fabricated figure. If a Codex ultra path ever exists,
        // this literal and the dock signal's are where it changes.
        provider: "claude",
        // OPEN THE DOCK TO THE RUN'S OWN PANE (issue #13). `setActiveTab` names
        // which run the dock should show — see `activeRunTab` above — and
        // `openRightPanelActivity` is what actually reveals the dock, since an
        // inline anchor can be clicked while the panel is closed. Both calls:
        // the first says WHAT to show, the second says SHOW SOMETHING.
        onFocus: () => {
          setActiveTab(ultraTabId(runId));
          openRightPanelActivity(resolvedRightPanelScopeKey);
        },
        onStop: () => void ultraAct(runId, "stop"),
        onResume: () => void ultraAct(runId, "resume"),
        busy: ultraBusyRunId === runId,
      });
    }
    return map;
  }, [ultraRuns, ultraAct, ultraBusyRunId, resolvedRightPanelScopeKey]);

  // D8's PENDING form: a launch whose manifest has not arrived yet. The launch
  // is a FACT the moment the tool result carries a runId, and the window is real
  // — `sessionId` is null until the first turn's `session` event, so the very
  // first turn of a brand-new session can launch a run before the list can
  // answer. Dropping the anchor for that window would make it blink into
  // existence a poll later.
  //
  // `null` FOR THE EVENTS, NOT `[]` (review round 1, B1). `[]` would mean "this
  // reader has the run's journal and it is empty", and the pending window is
  // precisely when it has not looked: `session-view.tsx` seeds `messages`
  // synchronously from `initialChat` while `useUltraRuns` starts empty, so on
  // the first paint of a reloaded session EVERY persisted launch comes through
  // here — including one whose run settled five agents last week. `[]` made that
  // anchor read `0 done` for the width of the list poll, which is B1's own
  // defect wearing D8's clothes.
  const pendingUltraAnchor = useCallback(
    (runId: string): UltraAnchorPayload => ({
      run: runSnapshot(null, null, [], runId),
      provider: "claude",
      onFocus: () => {
        setActiveTab(ultraTabId(runId));
        openRightPanelActivity(resolvedRightPanelScopeKey);
      },
      onStop: () => void ultraAct(runId, "stop"),
      onResume: () => void ultraAct(runId, "resume"),
      busy: ultraBusyRunId === runId,
    }),
    [ultraAct, ultraBusyRunId, resolvedRightPanelScopeKey],
  );

  // AC7 proof 5 — FOCUS ON ARRIVAL. The dock's tap pushes
  // `/projects/<project>/sessions/<id>?run=<runId>`, and "focus" here means
  // SELECT THAT RUN IN THE RAIL AND EXPAND IT — state, never a programmatic
  // `element.focus()`. (The rule is not a repo-wide absence of `.focus()`:
  // `components/ui/input-group.tsx` and `app/demo-gallery/demo-nav.tsx` both
  // call it legitimately to focus an input. What is forbidden is using it to
  // MOVE or SCROLL, which `agent-tabs.tsx`, `subagent-rail.tsx` and this file
  // each record as a WebKit 26.x hazard.)
  //
  // THE EFFECT DEPENDS ON THE PARAM, NEVER ON `[]`: the page renders
  // `<SessionView key={`${name}:${id}`}>`, so a query-only navigation does NOT
  // remount this component and a mount-once effect would never see the value.
  // The param is then cleared so a refresh does not re-focus a run the user has
  // since navigated away from.
  useEffect(() => {
    if (!focusRunId) return;
    // ARRIVAL OPENS THE PANE, not just the rail card. The dock tap's whole
    // premise is "come and look at this run", and the 240px card was only ever
    // the best answer available before a pane existed. Since that pane is now
    // the right-panel dock's Activity content rather than the main transcript
    // (issue #13), opening the dock is a SEPARATE call from selecting the run.
    setActiveTab(ultraTabId(focusRunId));
    openRightPanelActivity(resolvedRightPanelScopeKey);
    // This is URL housekeeping, not navigation. `router.replace(pathname)`
    // starts a new RSC request and leaves `focusRunId` truthy until that request
    // returns. Any intervening render can therefore enqueue the same replace
    // again; on a force-dynamic session route that becomes a self-sustaining
    // render/request loop. Next patches the native history API into the App
    // Router, so this removes only `?run=` synchronously without fetching or
    // remounting the live session.
    window.history.replaceState(null, "", pathname);
  }, [focusRunId, pathname, resolvedRightPanelScopeKey]);

  // Live runs first, finished ones sunk — see `orderRunsForPanel`. Map
  // insertion order is arrival order, which after a busy session put a run that
  // finished an hour ago above one working right now.
  const ultraRunList = useMemo(() => orderRunsForPanel([...ultraRuns.values()]), [ultraRuns]);

  // THE THIRD BRANCH OF `activeTab`, beside `"main"` and a spawn tool_use id.
  // It reads the SAME map `useUltraRuns` already produces — no second fetch, no
  // second hook, no second EventSource. Declared here rather than beside
  // `activeBucket` for one boring reason: `ultraRuns` does not exist yet up
  // there, and hook order is not negotiable.
  //
  // FEEDS THE RIGHT-PANEL DOCK, NOT THE MAIN TRANSCRIPT (issue #13). This used
  // to be the run rendered in place of `transcriptItems`; now it is read only by
  // the `activity` slot passed to `<RightPanel>` below, which shows the Ultra
  // pane instead of the sub-agent/Ultra index exactly while this is non-null.
  // A run tab whose run has fallen out of the map resolves to null and the dock
  // falls back to the index, the same tombstone posture `activeBucket` takes
  // for a vanished bucket (AD-8: a vanished reference is never a throw).
  const activeRunTab = useMemo(() => {
    const id = ultraTabRunId(activeTab);
    return id ? (ultraRuns.get(id) ?? null) : null;
  }, [activeTab, ultraRuns]);
  // The Activity dock's OWN disclosure map for `UltraTabView`'s per-agent
  // transcripts, now that the pane renders there instead of inside the
  // Conversation shell (issue #13) and so can no longer borrow the shell's.
  const activityDisclosure = useDisclosureMap();
  // ISSUE #14, SCOPED TO THE ONE CASE THAT STILL EXISTS after #13(b): the dock
  // is a SIBLING of the main chat at every width except its own fullscreen
  // toggle (`right-panel.tsx`'s `absolute inset-0 z-40 w-full max-w-none`),
  // which is the one state that visually covers this composer too. Disabling
  // whenever the dock is merely OPEN would be wrong — side-by-side, sending is
  // unambiguous, exactly the case #13(b) fixed. `activeRunTab` (not the
  // sub-agent index) is the gate because only the Ultra pane is named in this
  // issue; a fullscreen sub-agent index is unchanged behaviour predating this
  // cluster and out of scope here. Per the #15 comment, this whole block is
  // deletable once Ultra detail gets its own condensed dock-width layout and
  // stops needing fullscreen to be readable — kept deliberately tiny for that.
  const ultraOwnsScreen =
    rightPanelSession.fullscreen &&
    rightPanelSession.activeTabId === DEFAULT_ACTIVITY_TAB.id &&
    activeRunTab !== null;
  const ultraLiveCount = useMemo(
    () => ultraRunList.filter((r) => r.state === "running").length,
    [ultraRunList],
  );
  // Published to the unmount auto-dock guard declared above (AC7 proof 3).
  ultraLiveRef.current = ultraLiveCount;

  // A RUN GOING TERMINAL ASKS THE WAKE MAILBOX, ONCE. Without this the wake
  // hook's own gate (`live > 0 || pending.length > 0`, both filled only by its
  // own reload, which fires on mount and on `telar:refresh` and nowhere else)
  // is the same bootstrap deadlock the run list had: a session whose page
  // mounted BEFORE the launch has nothing live and nothing pending at mount, so
  // it never starts its interval, so the run settles into a mailbox nobody is
  // reading. Measured, not theorised — `u-b051b5580bdb` finished `done` and its
  // wake record sat at `deliveredAt: 0`, while an earlier identical run was
  // delivered only because an unrelated remount happened to re-arm the poll.
  //
  // EDGE-TRIGGERED ON THE TERMINAL SET, NOT GATED ON LIVENESS. Polling only
  // while `ultraLiveCount > 0` would close the gate on the very transition that
  // creates the wake — the run stops being live at the same instant it becomes
  // deliverable. Keying on WHICH runs are terminal fires exactly once per run
  // that settles, and one fetch is all that is needed: a wake that exists then
  // lands in `pending`, which opens the wake hook's own interval and keeps it
  // open until the §6.D drain has fired the turn.
  const settledRunKey = useMemo(
    () =>
      ultraRunList
        .filter((r) => r.state === "done" || r.state === "failed" || r.state === "stopped")
        .map((r) => r.runId)
        .sort()
        .join(","),
    [ultraRunList],
  );
  useEffect(() => {
    if (settledRunKey === "") return;
    void reloadUltraWake();
  }, [settledRunKey, reloadUltraWake]);

  // ONE TRIGGER PER PASS, however many runs finished (T10). The appendix carries
  // all of them — its formatter takes a list — so three finished runs must not
  // fire three turns. The wakes stay pending until the ROUTE acks them (which it
  // does on the turn that consumes them), so without a latch every poll in that
  // window would enqueue again.
  //
  // THE LATCH IS THE SET OF RUNS ALREADY ANNOUNCED, NOT A BOOLEAN (review SF-1).
  // It was a boolean cleared only by `pendingWakes.length === 0`, and that has a
  // reachable hole: several runs can be live for one session (§5.6-T10's own
  // premise, and `packages/core/src/ultra/executor.ts`'s `RUN_CONCURRENCY = 3`
  // is what bounds it), so run A settles and its wake turn streams for 30s, run B
  // settles a second later, and every subsequent poll returns a NON-empty
  // mailbox — so the latch never cleared, B was never enqueued, and when the
  // session went idle no unprompted turn ever appeared for it. AC1's
  // Given/When/Then was simply unmet for the second run.
  //
  // Keying on the run-ids themselves fixes it without re-opening T10: a poll
  // enqueues exactly one trigger if it carries any run this component has not
  // announced yet, however many that is. Pruning to the currently-pending set is
  // what re-arms a RESUMED run — `deliveredTerminalAt` makes it pending again
  // under the same id, and it must be announceable again — while a run that is
  // merely still-unacked stays in the set and cannot re-fire.
  //
  // NOTE the deliberate non-re-arm: if the wake turn DIES before the route acks
  // (the SDK binary missing, a mid-stream abort), the run stays pending and
  // stays announced, so no second trigger fires for it. That is the old
  // behaviour preserved on purpose — a permanently failing turn must not become
  // a turn loop — and the outcome still reaches the model on the next turn the
  // human starts, which is AC2's path and needs no trigger at all.
  //
  // The decision itself is `freshUltraWakes` in lib/ultra-wake.ts — pure, and
  // out of this file precisely so a test can drive it. All this ref holds is the
  // carry-over between polls.
  const announcedWakesRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const { fresh, announced } = freshUltraWakes(
      announcedWakesRef.current,
      pendingWakes.map((w) => w.runId),
    );
    announcedWakesRef.current = announced;
    if (fresh.length === 0) return;
    const seq = watcherSeqRef.current++;
    // BOTH HALVES OF T10 ARE IN THE SEAM, not here — `freshUltraWakes` decides
    // WHICH runs are new, `shouldEnqueueUltraWake` decides whether a trigger may
    // be added given what is already queued. Read that second one's header
    // before touching this: dropping it re-opens exactly what T10 forbids, and
    // it is asked inside the updater so it sees the real queue rather than a
    // render-time closure over it. (`seq` is simply not consumed on the skip
    // path; it is an id source, and a gap in it means nothing.)
    setInjectionQueue((q) =>
      shouldEnqueueUltraWake(fresh, q)
        ? [
            ...q,
            // The SENTINEL, never the outcome text. route.ts swaps it for the
            // server-authored instruction and the system-prompt appendix carries
            // the facts, so this client authors the trigger and nothing else.
            // `hidden` suppresses the local bubble; the route's `hideUserMessage`
            // is what keeps it out of the persisted transcript (they are two
            // different suppressions, and a wake needs both).
            { id: `uw${seq}`, text: ULTRA_WAKE_SENTINEL, hidden: true },
          ]
        : q,
    );
  }, [pendingWakes]);

  // §6.D — injection: when the composer is idle ("ready" — mid-turn is forbidden
  // by the busy guard) and a watcher turn is queued, dequeue exactly ONE and
  // dispatch it via the normal send() path. Removing the item BEFORE send()
  // (which synchronously flips status to "submitted") plus this status gate
  // guarantees no double-injection / infinite loop: the queue shrinks each pass
  // and the next item can only fire once the turn settles back to "ready".
  // Also require no active reader: during the §1b reconnect tail status is
  // transiently "ready" while a detached turn still runs server-side (the
  // reconnect effect only flips to "streaming" on its first live event), so
  // injecting then would POST a second concurrent turn — the mid-turn injection
  // the busy guard forbids. abortRef/reconnectAbortRef being null means truly idle.
  useEffect(() => {
    if (
      status !== "ready" ||
      abortRef.current ||
      reconnectAbortRef.current ||
      injectionQueue.length === 0
    )
      return;
    const [next, ...rest] = injectionQueue;
    setInjectionQueue(rest);
    // A WAKE TRIGGER IS ONLY VALID WHILE THE MAILBOX IT SPEAKS FOR IS STILL FULL
    // (review SF-2). Nothing else re-validates it: the server's
    // `isUltraWakeTrigger` is `!!sessionId && message === ULTRA_WAKE_SENTINEL`
    // and consults no state. So a trigger enqueued while the drain was blocked
    // and dispatched after the wakes were already acked would run
    // ULTRA_WAKE_PROMPT — "the COMPLETED ULTRA RUNS block in your context above
    // carries each run's outcome" — against a prompt with no such block, on a
    // turn that renders no user bubble. The reachable path is the §1b reconnect
    // tail: `status` is transiently "ready" while `reconnectAbortRef.current` is
    // non-null, so the composer is enabled and the drain is not; the human types;
    // that POST acks and renders the wakes; the tail clears and this drains the
    // stale trigger. Dropping it here (already removed from the queue above) is
    // the whole fix. The sentinel IS the discriminator — the same seam the route
    // recognizes on — so no second flag has to be kept in sync with it.
    if (next.text === ULTRA_WAKE_SENTINEL && pendingWakes.length === 0) return;
    // THE DISPATCH CHANGED IN STORY 4.1; THE GATE DID NOT. The three conditions
    // above are untouched and must stay that way — writing a second idleness
    // predicate is how "an assistant turn appears on its own" becomes "two turns
    // fire at once". What changed is one line: the flag is threaded through, so
    // a hidden item (the Ultra wake trigger) reaches send()'s `hidden` branch
    // and renders no user bubble, while an unflagged item (the loom watcher)
    // dispatches EXACTLY as before — `undefined` is what send() already received.
    void send(next.text, next.hidden ? { hidden: true } : undefined);
    // Same dependency, same reason as the message-queue drain below: this gate
    // also reads `reconnectAbortRef`, so it also needs waking when that ref
    // clears without a status change.
  }, [status, injectionQueue, send, pendingWakes, reconnectLive]);

  const queueUploadsRef = useRef<Set<string>>(new Set());

  const enqueueWithEngine = useCallback(
    async (item: SessionQueuedMessage) => {
      if (!sessionId || item.accepted || queueUploadsRef.current.has(item.id)) return;
      queueUploadsRef.current.add(item.id);
      try {
        const attachments = item.files?.length ? await uploadAttachments(item.files) : [];
        const response = await fetch(
          `/api/chat/${encodeURIComponent(sessionId)}/queue`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              idempotencyKey: item.id,
              payload: buildTurnPayload(item.text, attachments, item.id),
            }),
          },
        );
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
        const accepted = body?.item as
          | { revision?: number; state?: SessionQueuedMessage["state"] }
          | undefined;
        setMessageQueue((queue) =>
          queue.map((queued) =>
            queued.id === item.id
              ? {
                  ...queued,
                  accepted: true,
                  files: undefined,
                  revision: accepted?.revision,
                  state: accepted?.state ?? "queued",
                  error: undefined,
                }
              : queued,
          ),
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        setMessageQueue((queue) =>
          queue.map((queued) =>
            queued.id === item.id ? { ...queued, error: detail } : queued,
          ),
        );
        setAttachmentError(`Queue was not accepted: ${detail}`);
      } finally {
        queueUploadsRef.current.delete(item.id);
      }
    },
    [sessionId, buildTurnPayload],
  );

  // Local entries exist only until the engine owns them. This also migrates an
  // issue-#5 localStorage queue when a session remounts after this upgrade.
  useEffect(() => {
    if (!sessionId) return;
    for (const item of messageQueue) {
      if (!item.accepted && !item.error) void enqueueWithEngine(item);
    }
  }, [sessionId, messageQueue, enqueueWithEngine]);

  const refreshEngineQueue = useCallback(async () => {
    if (!sessionId) return;
    const response = await fetch(`/api/chat/${encodeURIComponent(sessionId)}/queue`);
    if (!response.ok) return;
    const envelope = (await response.json()) as {
      paused?: boolean;
      items?: Array<{
        idempotencyKey: string;
        revision: number;
        state: SessionQueuedMessage["state"] | "committed" | "cancelled";
        payload?: { message?: string };
        error?: string;
      }>;
    };
    setEngineQueuePaused(Boolean(envelope.paused));
    const active = (envelope.items ?? [])
      .filter((item) => item.state !== "committed" && item.state !== "cancelled")
      .map<SessionQueuedMessage>((item) => ({
        id: item.idempotencyKey,
        text: item.payload?.message ?? "Queued message",
        accepted: true,
        revision: item.revision,
        state: item.state as SessionQueuedMessage["state"],
        error: item.error,
      }));
    setMessageQueue((current) => [
      ...current.filter((item) => !item.accepted),
      ...active,
    ]);
  }, [sessionId]);

  const resumeEngineQueue = useCallback(async () => {
    if (!sessionId) return;
    const response = await fetch(`/api/chat/${encodeURIComponent(sessionId)}/queue`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paused: false }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      setAttachmentError(body?.error ?? `Queue resume failed (HTTP ${response.status})`);
      return;
    }
    setEngineQueuePaused(false);
    await refreshEngineQueue();
  }, [sessionId, refreshEngineQueue]);

  const editEngineQueueItem = useCallback(
    async (item: SessionQueuedMessage, text: string) => {
      if (!sessionId || !item.accepted || item.revision === undefined) return;
      const response = await fetch(
        `/api/chat/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(item.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ revision: item.revision, message: text }),
        },
      );
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setAttachmentError(body?.error ?? `Queue edit failed (HTTP ${response.status})`);
      }
      await refreshEngineQueue();
    },
    [sessionId, refreshEngineQueue],
  );

  const removeEngineQueueItem = useCallback(
    async (item: SessionQueuedMessage) => {
      if (!sessionId || !item.accepted || item.revision === undefined) return;
      const response = await fetch(
        `/api/chat/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(item.id)}`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ revision: item.revision }),
        },
      );
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setAttachmentError(body?.error ?? `Queue removal failed (HTTP ${response.status})`);
      }
      await refreshEngineQueue();
    },
    [sessionId, refreshEngineQueue],
  );

  useEffect(() => {
    if (!sessionId) return;
    void refreshEngineQueue();
    if (!busy && messageQueue.length === 0) return;
    // Queue transitions are coarse lifecycle changes, not token deltas. A
    // sub-second poll multiplied across open tabs competes with the live stream
    // and was visible in the browser trace as continuous request churn.
    const timer = setInterval(() => void refreshEngineQueue(), 2_000);
    return () => clearInterval(timer);
  }, [sessionId, busy, messageQueue.length, refreshEngineQueue]);

  const handleSubmit = (message: PromptInputMessage) => {
    const text = message.text.trim();
    // An attachment IS a message. Sending a screenshot with no words is a
    // normal thing to want ("look at this"), so the empty-text guard now only
    // rejects a genuinely empty composer.
    if (!text && message.files.length === 0) return;
    // Agent busy → queue instead of dropping. Returning void (sync) lets
    // PromptInput clear the textarea, exactly as a real send would.
    if (busy) {
      const stableId = `q-${globalThis.crypto?.randomUUID?.() ?? queueSeqRef.current++}`;
      const queued = { id: stableId, text, files: message.files };
      setMessageQueue((q) => [...q, queued]);
      if (sessionId) void enqueueWithEngine(queued);
      return;
    }
    void send(text, { files: message.files });
  };

  // Prefer the fetched catalog (matches what's actually offered in the
  // select) and fall back to the static list for a model id seeded from a
  // resumed chat before the fetch resolves.
  const activeModel = modelOptions.find((m) => m.id === sessionModel) ?? modelById(sessionModel);
  const optionGroups = providerOptionGroups(provider, activeModel, modelOptions);
  const optionValues = Object.fromEntries(
    optionGroups.map((group) => {
      const requested =
        group.id === "effort"
          ? effort
          : group.id === "model"
            ? sessionModel
            : group.id === "fastMode"
              ? fastMode ? "on" : "off"
              : group.id === "serviceTier"
                ? serviceTier
                : groupDefault(group);
      return [group.id, groupAccepts(group, requested) ? requested : groupDefault(group)];
    }),
  );
  const changeProviderOption = (group: string, value: string) => {
    if (group === "effort") setEffort(value);
    else if (group === "model") setModel(value);
    else if (group === "fastMode") setFastMode(value === "on");
    else if (group === "serviceTier") setServiceTier(value);
  };

  // 1.4 working indicator: the current main-thread tool call still in flight
  // (no output yet) — the thing the agent is actively doing right now. Scans
  // the latest assistant message's trailing tool part; a finished trailing
  // tool means "no tool running" (we're between calls / streaming text).
  const runningTool = useMemo<{ name: string; target: string } | null>(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== "assistant") continue;
      for (let j = m.parts.length - 1; j >= 0; j--) {
        const p = m.parts[j];
        if (p.type !== "tool" || p.parentId) continue;
        if (p.output === undefined && !p.isError && !p.interrupted) {
          return { name: p.name, target: stepPreview(p.input) ?? "" };
        }
        return null;
      }
      return null;
    }
    return null;
  }, [messages]);

  // Derive the single live-work state the header indicator renders while busy.
  const liveWork = useMemo<WorkState | null>(
    () =>
      !busy
        ? null
        : status === "submitted"
          ? { kind: "starting" }
          : runningTool
            ? {
                kind: "tool",
                tool: runningTool.name,
                target: runningTool.target,
                startedAt: turnStartedAt,
                lastActivityAt,
              }
            : thinking
              ? { kind: "thinking", startedAt: turnStartedAt }
              : { kind: "working", startedAt: turnStartedAt },
    [busy, lastActivityAt, runningTool, status, thinking, turnStartedAt],
  );

  // Merge project's scanned commands+skills with what the live SDK session
  // actually reports (once known) — the SDK's slash_commands list includes
  // repo skills alongside .claude/commands entries, so a name match here
  // keeps skills exactly like commands. The SDK list also carries built-ins
  // and plugin commands we don't advertise, so this only ever narrows, never
  // adds names the project scan didn't already find.
  const availableCommands = useMemo(() => {
    // Codex sessions don't run slash commands (a Claude-session feature today),
    // so a Codex session offers none — regardless of what .claude/commands the
    // repo has. The menu still opens (below) to say so honestly, rather than
    // listing commands that would only be sent as literal text.
    if (provider === "codex") return [];
    if (sdkSlashCommands === null) return projectCommands;
    const known = new Set(sdkSlashCommands);
    return projectCommands.filter((c) => known.has(c.name));
  }, [projectCommands, sdkSlashCommands, provider]);

  const slashQuery =
    textInput.value.startsWith("/") && !textInput.value.includes(" ")
      ? textInput.value.slice(1)
      : null;

  const filteredCommands = useMemo(() => {
    if (slashQuery === null) return [];
    const q = slashQuery.toLowerCase();
    return availableCommands.filter((c) => c.name.toLowerCase().startsWith(q));
  }, [availableCommands, slashQuery]);

  // The menu also opens on a genuinely empty project (zero commands AND zero
  // skills) so it can show the "how to add some" hint below instead of just
  // silently doing nothing — that read as a broken feature to users. A query
  // that merely doesn't match anything (project has commands, none start
  // with what's typed) still closes the menu as before.
  const slashMenuOpen =
    slashQuery !== null &&
    !menuDismissed &&
    (filteredCommands.length > 0 ||
      projectCommands.length === 0 ||
      // Codex: open even with a non-empty project scan, to show the honest
      // "commands are a Claude-session feature" copy instead of nothing.
      provider === "codex");

  // Reset the selection whenever the query text changes so it never points
  // past a shrunk list or feels stale after typing.
  useEffect(() => {
    setSelectedIndex(0);
  }, [slashQuery]);

  const acceptCommand = useCallback(
    (c: ProjectCommand) => {
      textInput.setInput(`/${c.name} `);
    },
    [textInput],
  );

  // ── `@` file mentions ─────────────────────────────────────────────────────
  //
  // The token under the cursor, if the cursor is at the end of one.
  const mentionQuery = useMemo(() => {
    const value = textInput.value;
    return MENTION_AT_CARET.exec(value.slice(0, caret ?? value.length))?.[1] ?? null;
  }, [textInput.value, caret]);

  const mentionMenuOpen = mentionQuery !== null && !mentionDismissed && mentionFiles.length > 0;

  // Re-query on every keystroke of the mention, debounced. The index resets
  // with the query so the highlight never points past a shrunk list.
  useEffect(() => {
    if (mentionQuery === null) {
      setMentionFiles([]);
      return;
    }
    setMentionIndex(0);
    const abort = new AbortController();
    const timer = setTimeout(() => {
      void fetch(
        `/api/projects/${encodeURIComponent(project)}/files?q=${encodeURIComponent(mentionQuery)}`,
        { signal: abort.signal },
      )
        .then((r) => (r.ok ? r.json() : { files: [] }))
        .then((body: { files?: ProjectFile[] }) => setMentionFiles(body.files ?? []))
        .catch(() => {
          /* aborted or offline — leave the previous list rather than flashing empty */
        });
    }, 120);
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [mentionQuery, project]);

  const acceptMention = useCallback(
    (file: ProjectFile) => {
      const value = textInput.value;
      const pos = caret ?? value.length;
      const match = MENTION_AT_CARET.exec(value.slice(0, pos));
      if (!match) return;
      // Replace from the "@" itself — match[1] is the query, so the "@" sits one
      // character before it — and leave a trailing space so the next word does
      // not extend the path that was just completed.
      const start = pos - match[1].length - 1;
      const next = `${value.slice(0, start)}@${file.path} ${value.slice(pos)}`;
      // "@" + path + the trailing space — where the human should carry on typing.
      const after = start + file.path.length + 2;
      textInput.setInput(next);
      pendingCaretRef.current = after;
      setCaret(after);
      setMentionDismissed(true);
    },
    [textInput, caret],
  );

  // No focus() anywhere here — navigation and acceptance are driven entirely
  // by the textarea's own keydown, so the textarea never loses focus.
  const handleComposerKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    // The caret moves on arrows/home/end without the value changing, so onChange
    // alone would leave `caret` stale and the mention query measured against the
    // wrong slice. Read it AFTER the browser has applied the key, hence the
    // deferral — currentTarget is captured first because React pools nothing
    // here but the event object is still not safe to close over.
    const el = e.currentTarget;
    queueMicrotask(() => setCaret(el.selectionStart));

    // The mention menu takes the keys FIRST when it is open: both menus are
    // driven by the same textarea, and a "/" command can only ever be at the
    // very start of the value, so the two can never both be open on the same
    // token — but if that ever changes, the one the cursor is actually inside
    // should win, and that is this one.
    if (mentionMenuOpen) {
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionDismissed(true);
        return;
      }
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setMentionIndex((i) => (i + 1) % mentionFiles.length);
          return;
        case "ArrowUp":
          e.preventDefault();
          setMentionIndex((i) => (i - 1 + mentionFiles.length) % mentionFiles.length);
          return;
        case "Enter":
        case "Tab":
          e.preventDefault();
          acceptMention(mentionFiles[mentionIndex] ?? mentionFiles[0]);
          return;
      }
    }

    if (!slashMenuOpen) return;
    // Escape always dismisses, including the empty-project hint panel. The
    // rest only make sense once there's something to navigate/accept — the
    // hint panel has no items, so leave those keys to behave normally
    // (e.g. Enter still submits the composer).
    if (e.key === "Escape") {
      e.preventDefault();
      setMenuDismissed(true);
      return;
    }
    if (filteredCommands.length === 0) return;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setSelectedIndex((i) => (i + 1) % filteredCommands.length);
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelectedIndex((i) => (i - 1 + filteredCommands.length) % filteredCommands.length);
        break;
      case "Enter":
      case "Tab":
        e.preventDefault();
        acceptCommand(filteredCommands[selectedIndex] ?? filteredCommands[0]);
        break;
    }
  };

  // Everything attached to this session, for the pinned summary's Context
  // section. DERIVED FROM THE TRANSCRIPT, never stored on its own (contract #5,
  // same rule the sub-agent rail below follows): the messages already hold every
  // attachment part, both the ones this mount sent and the ones seeded from the
  // store on reload, so a second list could only ever disagree with them.
  //
  // Newest first, because the question the section answers is "what did I just
  // give it?" — and de-duplicated by id, since a queued message re-sent after an
  // edit can legitimately carry the same attachment twice.
  const sessionAttachments = useMemo(() => {
    const byId = new Map<string, AttachmentRef>();
    for (let i = messages.length - 1; i >= 0; i--) {
      for (const part of messages[i].parts) {
        if (part.type !== "attachments") continue;
        for (const file of part.files) if (!byId.has(file.id)) byId.set(file.id, file);
      }
    }
    return [...byId.values()];
  }, [messages]);

  // Sub-agents rail data — derived straight from agentBuckets, never stored on
  // its own (contract #5). Order follows first appearance so a card never jumps
  // around later as its own spawn's status changes. Per-sub-agent elapsed/cost
  // don't exist in the transcript (recon), so a card carries the real, available
  // step count plus, while running, its current tool as a live activity line.
  const railAgents: RailAgent[] = useMemo(
    () =>
      agentBuckets.map((b) => {
        const lastTool = [...b.parts]
          .reverse()
          .find((p): p is ToolPart => p.type === "tool");
        const preview = lastTool ? stepPreview(lastTool.input) : null;
        const activity = lastTool
          ? preview
            ? `${lastTool.name} · ${preview}`
            : lastTool.name
          : undefined;
        return {
          id: b.id,
          label: agentLabel(b.spawn.agent ?? { type: null, description: "" }),
          tool: b.spawn.agent?.type ?? "general",
          status: agentStatus(b.spawn),
          steps: b.parts.length,
          activity,
        };
      }),
    [agentBuckets],
  );

  // ISSUE #18 — THE TRACED CASCADE, removed. This used to read: "a newly-started
  // sub-agent is an immediate runtime fact, not a turn-end summary — reveal it
  // once when its authoritative spawn event first enters the projection," and
  // it did that by calling BOTH the tab setter with the new bucket's id (which
  // swaps the MAIN transcript to the bucket — the same mechanism #13(b) fixed
  // for Ultra runs) AND the inspector's open setter with `true` (which pops
  // open the pinned env) THE MOMENT ANY spawn's first tool_result arrived,
  // with no gate on whether a human was looking for it. That is the whole
  // mechanism: ONE cascade forcing two of the three surfaces the issue names,
  // not three surfaces independently rendering an agent they each separately
  // noticed.
  // (The third — the dock's `SubagentRail` highlighting this bucket's row via
  // `activeId={activeTab}` — only ever happened as a SIDE EFFECT of the first,
  // and only when the dock was already open; it never had its own trigger.)
  //
  // `agentStatus`'s own comment says why removing this loses nothing real:
  // "Subagents run in the background by default" — there is no separate
  // "background" flag to gate on, because EVERY spawn is background work by
  // this app's own model, so a reveal keyed on "just started running" fires
  // for literally every spawn, which is exactly the complaint.
  //
  // WHAT STAYS DISCOVERABLE WITHOUT A FORCED REVEAL: the pinned-summary
  // trigger already renders a quiet dot whenever `activityRunning` is true —
  // computed from the same `railAgents`/`workflows` data, never gated on a
  // "just started" transition — so a session with live background work still
  // reads as active the instant you glance at its own trigger. That is #17's
  // ask (visible in passing) held alongside this one (not a takeover): #17
  // never asked for panes to POP OPEN, and nothing here removes the dot.
  // Opening the pinned env or the Activity dock and clicking the running row
  // (#13's fixed hand-off) is how a user who wants the detail gets it now.

  // `renderAgentBucket` is gone. Its inline switch — the SECOND copy of the
  // RenderItem dispatch, whose own comment admitted it "mirrors Main's exhaustive
  // RenderItem switch exactly" — was the duplication this whole extraction exists
  // to end. The bucket now renders through `agentBucketItem` and the SAME registry
  // Main uses, above.

  // The rename affordance's commit path: Enter and blur both go through
  // here (a plain, non-empty, changed value is saved via saveTitle; an
  // unchanged/empty draft just closes the editor with no PATCH). Escape
  // (below) bypasses this entirely — it never touches titleDraft's value.
  const commitTitleEdit = () => {
    setEditingTitle(false);
    const trimmed = titleDraft.trim().slice(0, 120);
    if (!sessionId || !chatPersisted || !trimmed || trimmed === title) return;
    saveTitle(sessionId, trimmed);
  };

  // No .focus() call anywhere in this — WebKit 26.x. The input renders
  // un-focused; the user clicks into it themselves (it just replaced the
  // pencil button they clicked, so it's already under the pointer).
  const titleNode = editingTitle ? (
    <Input
      value={titleDraft}
      onChange={(e) => setTitleDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commitTitleEdit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          setEditingTitle(false);
        }
      }}
      onBlur={commitTitleEdit}
      className="h-6 max-w-xs text-base font-semibold"
    />
  ) : (
    <span className="group/title inline-flex min-w-0 items-center gap-1">
      <span className="truncate">{title}</span>
      {/* Only once the chat is CONFIRMED persisted server-side (chatPersisted,
          not just sessionId) — PATCH /api/chats/[id] needs a chat already in
          the store to rename, and sessionId alone is set well before that
          (see chatPersisted's own comment above). */}
      {sessionId && chatPersisted && (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Rename session"
          onClick={() => {
            setTitleDraft(title);
            setEditingTitle(true);
          }}
          className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/title:opacity-100 focus-visible:opacity-100"
        >
          <PencilIcon />
        </Button>
      )}
    </span>
  );

  // ── the projection the shell renders ───────────────────────────────────────
  // ONE `conversation:turn` per message carrying that message's OWN parts, or —
  // when a subagent tab is selected — the single `session:agent-bucket`
  // composite. Owner behaviour rides in the PAYLOADS: `respondPermission`,
  // `agentSteps` and `onSelectAgent` are closures over this component's state,
  // handed down rather than read from a context. That is AD-12's purity rule and
  // it is what lets a surface with no providers at all render the same kinds.
  //
  // The projection changes on every meaningful SSE frame, but it must remain
  // referentially stable between those frames. SessionWorkspace also owns the
  // composer, side panels and workspace chrome; without this memo any update in
  // those siblings makes the transcript replay markdown, syntax highlighting
  // and every tool renderer even though no conversation data changed.
  // NO THIRD ARM HERE FOR AN ACTIVE ULTRA RUN (issue #13). Selecting a run no
  // longer replaces this array with a single Ultra item — that replacement WAS
  // the "renders on top of the main chat" bug, because this is the transcript
  // the main column shows and there is no way to swap in one item without
  // losing the rest. `activeRunTab` (below) still exists and still names the
  // selected run, but it now feeds the right-panel dock's `activity` slot
  // instead of this memo — see the note above `SESSION_KINDS`.
  const transcriptItems = useMemo<TranscriptItem[]>(() =>
    activeBucket
      ? [agentBucketItem(activeBucket, () => setActiveTab("main"))]
      : messages.map((m) => {
        // Main renders only this message's OWN parts — anything a subagent
        // produced lives in its own tab (see agentBuckets), not interleaved
        // here even though it rode in on the same SSE stream and the same
        // message's parts array.
        const mainParts = [
          ...(agentProjection.inferredSpawnsByMessage.get(m.id) ?? []),
          ...m.parts.filter((p) => parentOf(p) === undefined),
        ];
        // The persistent in-flight row rides the STREAMING turn's items, after
        // the anchor splice, so it always renders last inside the bubble. Only
        // once real parts exist — the empty turn keeps `pending`'s shimmer
        // (items must stay empty for the shell to render it at all). Live-only,
        // like thinking parts: nothing here persists, so a reload of a finished
        // turn can never grow a stale status row. isTrailingItem exempts it, so
        // the tools group ahead of it keeps its liveness (and its spinner).
        // The RULE is `showsLiveStatus`, in items.ts, where a test can drive it.
        // The trailing `&& liveWork` is narrowing and nothing else — the
        // predicate already answered the question, but TypeScript cannot carry
        // `liveWork !== null` back out of a call.
        const statusItem: TranscriptItem | null =
          showsLiveStatus({
            role: m.role,
            hasLiveWork: liveWork !== null,
            partCount: mainParts.length,
            isLast: m.id === messages[messages.length - 1]?.id,
          }) && liveWork
            ? {
                kind: CONVERSATION_KINDS.status,
                key: `${m.id}:status`,
                payload: { state: liveWork } satisfies StatusPayload,
              }
            : null;
        return {
          kind: CONVERSATION_KINDS.turn,
          key: m.id,
          payload: {
            from: m.role,
            // Story 4.2 — THE ANCHOR SPLICE, AND IT WRAPS THIS EXPRESSION AND
            // NOT `transcriptItems`. Measured: `transcriptItems` is exclusively
            // `conversation:turn` items (or, on a subagent tab, one
            // `session:agent-bucket`); `conversation:tools` exists only ONE
            // LEVEL DOWN, inside `TurnPayload.items`, which is what
            // `toTranscriptItems(groupParts(...))` produces right here. A
            // wrapping call around `transcriptItems` would find zero groups and
            // return its input unchanged — and because `spliceRunAnchors` is a
            // TOTAL function, that failure would be GREEN. Two consequences
            // worth writing down rather than rediscovering: the anchor is a
            // NESTED item rendered through `view.render(child)` by the turn
            // kind, so it lays out in the assistant bubble's reading column; and
            // `isTrailingItem` now sees it, so replacing the LAST tools group of
            // a streaming turn hands the anchor `view.live === true`.
            // `agentBucketItem`'s own nested list is deliberately NOT spliced —
            // ultra is called from the main thread.
            items: [
              ...spliceRunAnchors(
                toTranscriptItems(groupParts(m.id, mainParts), {
                  onRespond: respondPermission,
                  agentSteps: (id) => agentBucketById.get(id)?.parts.length ?? 0,
                  onSelectAgent: setActiveTab,
                }),
                ultraAnchorPayloads,
                pendingUltraAnchor,
              ),
              ...(statusItem ? [statusItem] : []),
            ],
            pending:
              mainParts.length === 0 && m.role === "assistant" && busy ? (
                <Shimmer className="text-sm">
                  {thinking ? "Thinking…" : "Weaving…"}
                </Shimmer>
              ) : undefined,
          } satisfies TurnPayload,
        };
      }),
    [
      activeBucket,
      agentBucketById,
      agentProjection,
      busy,
      liveWork,
      messages,
      pendingUltraAnchor,
      respondPermission,
      thinking,
      ultraAnchorPayloads,
    ],
  );

  // The three empty states, unchanged. The shell renders whichever of these it
  // is handed, and only while `items` is empty — which for a project session is
  // exactly `messages.length === 0`.
  const emptyState =
    messages.length === 0 && planner && !sessionId ? (
      // Agent-first greeting (feature #34): a templated assistant
      // bubble — same Message/MessageContent/MessageResponse
      // primitives the real transcript uses, so it reads exactly
      // like the agent spoke first — with no model call behind it.
      // Gone the instant a real turn starts (messages.length > 0).
      <Message from="assistant">
        <MessageContent>
          <MessageResponse>{PLANNER_GREETING}</MessageResponse>
        </MessageContent>
      </Message>
    ) : messages.length === 0 && escalation && !sessionId ? (
      // M11 finding-1 — the escalation chat opens with a REAL agent turn,
      // auto-fired on mount (escalationKickoff effect above). This branch
      // is the transient pre-fire window (before the effect runs / before
      // the first token lands): a shimmer that reads as the agent
      // reviewing, mirroring the in-flight empty-assistant render so
      // the hand-off to the streaming proposal is seamless. It never shows
      // static copy the human is expected to answer.
      <Message from="assistant">
        <MessageContent>
          <Shimmer className="text-sm">Reviewing the blocked context…</Shimmer>
        </MessageContent>
      </Message>
    ) : (
      <ConversationEmptyState
        title={initialRole === "planner" ? "Plan a loom" : "Work in this repo"}
        description={
          initialRole === "planner"
            ? "Describe what you want built. Once the spec is ready, say “make this real” and this session commits the bundle and starts the loom."
            : "Ask about the code, plan a change, or make edits directly. Reads run freely; writes and commands ask for your approval — or go automatically in Auto mode."
        }
      />
    );

  // T3's fresh-thread posture: the composer is the workspace's starting object,
  // centered until the first user turn exists. It remains the same mounted form
  // and moves with a transform, so submit/focus and the stream are never torn
  // down merely to animate into the conversation layout.
  const freshWorkspace =
    messages.length === 0 && !sessionId && !planner && !escalation && !steerer;

  // `!activeRunTab` DROPPED (issue #13): selecting an Ultra run no longer
  // displaces this pane, so main chat — and its trailing loom rows — stays
  // exactly as visible as when no run is selected. Only an active subagent
  // bucket still hides them, same as before.
  const transcriptTrailing = useMemo(
    () =>
      !activeBucket && loomEvents.length > 0 ? (
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 pt-3">
          {loomEvents.map((row) => (
            <InlineLoomRow
              key={row.id}
              row={row}
              onDismiss={() =>
                setLoomEvents((previous) => previous.filter((item) => item.id !== row.id))
              }
            />
          ))}
        </div>
      ) : undefined,
    [activeBucket, loomEvents],
  );

  const agentRunning = railAgents.filter((agent) => agent.status === "running").length;
  const agentNeedsAttention = railAgents.some((agent) => agent.status === "error");
  const activityRunning = agentRunning + ultraLiveCount;
  const activityCount = railAgents.length + ultraRunList.length;
  const activityAttention = mainNeedsAttention || agentNeedsAttention;

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden">
      {/* The conversation column — header, transcript, composer. It is also the
          composer's DROP ZONE (see `dropTarget` below): the right panel is a
          SIBLING of this element, not a child, so scoping here is exactly what
          leaves the browser and git surfaces free to own their own drops. */}
      <div
        ref={sessionSurfaceRef}
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      >
      {/* Workspace identity, not telemetry. Account/model/context/spend belong
          to the composer where the next turn is configured. This edge only tells the user where they are and
          surfaces truly workspace-level live actions. */}
      {!embedded && (
      <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-2 bg-background/65 px-4 py-1.5 backdrop-blur">
        <div className="mr-1 flex min-w-0 items-center gap-2 text-sm">
          <MainSidebarTrigger
            className="-mx-[7px]"
            fallback={<FolderGit2Icon className="size-3.5 shrink-0 text-muted-foreground" />}
          />
          <span className="shrink-0 text-muted-foreground">{project}</span>
          <span className="text-border">/</span>
          <div className="min-w-0 truncate font-semibold">{titleNode}</div>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {/* NO WORKING INDICATOR HERE. `liveWork` feeds the transcript's tail
              status row (CONVERSATION_KINDS.status, appended below) and that is
              now its ONLY consumer. Rendering the same state through the same
              component in both places meant a streaming turn showed two
              identical "Thinking 1m 01s" cards at once — one pinned to this bar
              and one in the bubble — and the composer's "Agent is working…"
              placeholder plus its Stop button said it twice more. The tail row
              wins because it sits WHERE THE WORK IS: next to the steps it
              describes, in the reading column, scrolling with the turn it
              belongs to. Embedded surfaces have no header bar at all, so it was
              also the only one of the two that was always present. */}
          {/* The aggregate looms pill (replaces the persistent banner + the old
              "Planning loom" chip). Solo → state + short id; N → most-urgent
              rollup. Hover previews the per-loom overlay, click pins. */}
          <LoomsPill looms={pillLooms} />
          {/* Minimize this session to the mini-dock — the dock's natural entry
              point. Only once a real, persisted session id exists to follow. */}
          {dock && sessionId && chatPersisted && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={dock.isDocked(sessionId) ? "In the dock" : "Minimize to dock"}
              title={dock.isDocked(sessionId) ? "Already in the dock" : "Minimize to dock"}
              className={cn(
                "shrink-0 text-muted-foreground hover:text-foreground",
                dock.isDocked(sessionId) && "text-primary",
              )}
              onClick={() =>
                dock.dockSession({
                  id: sessionId,
                  title,
                  project,
                  initial: (title.trim()[0] ?? project.trim()[0] ?? "·").toUpperCase(),
                })
              }
            >
              <PictureInPicture2Icon className="size-4" />
            </Button>
          )}
          <WorkspaceInspector
            project={project}
            scopeKey={resolvedRightPanelScopeKey}
            open={workspaceInspectorOpen}
            onOpenChange={setWorkspaceInspectorOpen}
            onReservedChange={setWorkspaceInspectorReserved}
            agents={railAgents}
            workflows={ultraRunList}
            attachments={sessionAttachments}
            needsAttention={activityAttention}
            onSelectAgent={setActiveTab}
            onSelectWorkflow={(id) => setActiveTab(ultraTabId(id))}
          />
          <RightPanelTrigger scopeKey={resolvedRightPanelScopeKey} />
        </div>
      </div>
      )}

      {/* The "make this real → god-view" handoff (docs/loom-model.md §5) no
          longer pins a permanent banner: it now surfaces as the aggregate looms
          PILL in the heartbeat bar above (live state, hover for detail, one-click
          god-view) plus durable INLINE event rows in the transcript below. Both
          replace the old momentary-event-as-permanent-chrome banner. */}

      {/* §6.E watcher alerts — the loom-handoff banner pattern (above) reused
          for a watched loom reaching a trigger state. Surfaces immediately,
          regardless of turn state; the injected turn lands once idle. */}
      {watcherAlerts.map((a) => (
        <div key={a.id} className="shrink-0 border-b px-4 py-2.5">
          <div className="flex items-center gap-3 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2.5">
            <BellIcon className="size-4 shrink-0 text-primary" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">Watcher: {a.title}</p>
              <p className="truncate text-xs text-muted-foreground">
                Reached <span className="font-medium text-foreground">{a.state}</span> · reacts while this tab is open
              </p>
            </div>
            <Button
              size="sm"
              render={<Link href={`/looms/${a.loomId}`} target="_blank" rel="noopener noreferrer" />}
            >
              View loom
              <ExternalLinkIcon />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Dismiss"
              className="text-muted-foreground hover:text-foreground"
              onClick={() =>
                setWatcherAlerts((prev) => prev.filter((x) => x.id !== a.id))
              }
            >
              <XIcon />
            </Button>
          </div>
        </div>
      ))}

      {/* THE SHELL (AD-12). The conversation column with the sub-agents RAIL
          docked on its right (replaces the old top tab strip). The rail lists
          spawns as rich cards — running up top with a live activity line,
          failures pinned in destructive, completions folded into a compact
          "Done" section — with a pinned Main anchor always one click back. It
          only appears once at least one sub-agent has spawned. The composer
          below stays full-width.

          Everything here is CONFIGURATION: four slots and a projection. This
          component still owns `messages`, every request, both event streams,
          `applyServerEvent` and the whole turn state machine — it simply no
          longer owns a render loop. */}
      <Conversation
        className={cn(
          "relative transition-[padding-right] duration-300 ease-[cubic-bezier(.22,1,.36,1)] motion-reduce:transition-none",
          workspaceInspectorReserved && "min-[1180px]:pr-[21rem]",
        )}
        items={transcriptItems}
        kinds={SESSION_KINDS}
        // Leaving a sub-agent tab swaps in a DIFFERENT transcript, and the old
        // tab's scroll position came with it — so returning to the main chat
        // landed at the top, above the message you came back to read. Selecting
        // an Ultra run is NOT one of these any more (issue #13): it no longer
        // touches `transcriptItems`, so it must not touch the scroll key either
        // — `activeTab` alone would reset this column's scroll every time a run
        // is opened or closed in the dock, even though what it shows never
        // changed. Only a real bucket switch changes what this key names.
        scrollKey={activeBucket ? activeTab : "main"}
        // The donor's `isCurrentMessage`: the shell marks only the LAST
        // top-level item live, and the turn renderer derives per-child
        // `isTrailing` from there. On a subagent tab, "the spawn hasn't
        // produced a result yet" stands in for "currently streaming" — exactly
        // what the bucket's own `bucketLive` meant. An active Ultra run is no
        // longer a third case here — it never displaces this transcript, so
        // this pane's own liveness (busy) is the honest answer whether or not
        // a run happens to be open in the dock.
        live={activeBucket ? agentStatus(activeBucket.spawn) === "running" : busy}
        empty={freshWorkspace ? undefined : emptyState}
        // Durable in-stream loom record (replaces the banner): a compact row
        // per lifecycle transition — started/parked/resumed/ready — carrying
        // the title, short id, and a god-view link. Scrolls away with
        // history; the live pill in the bar is the at-a-glance status.
        //
        // It rides `trailing` rather than the item list on purpose: the shell
        // marks the LAST top-level item live, so an item appended after the
        // streaming turn would silently steal its liveness and the trailing
        // tool group would stop auto-opening mid-turn.
        trailing={transcriptTrailing}
        composer={
          /* The outer shell is 2rem wider than the 48rem reading column because
              its px-4 gutters sit outside the actual input. That leaves the
              PromptInput at exactly the same rendered width as Message. */
          <div
            className={cn(
              "relative mx-auto w-full max-w-[50rem] px-4 pb-5 transition-transform duration-500 ease-[cubic-bezier(.22,1,.36,1)] motion-reduce:transition-none",
              freshWorkspace && "-translate-y-[calc(45dvh-7.5rem)]",
            )}
          >
            {slashMenuOpen && (
              <div className="absolute inset-x-4 bottom-full z-10 mb-2 max-h-64 overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10">
                {filteredCommands.length === 0 ? (
                  <p className="px-2 py-1.5 text-[11px] text-muted-foreground">
                    {provider === "codex"
                      ? "Slash commands are a Claude-session feature — Codex sessions don't run them today."
                      : "No commands — add .claude/commands/*.md or skills to this repo."}
                  </p>
                ) : (
                  filteredCommands.map((c, i) => (
                    <button
                      type="button"
                      key={c.name}
                      // preventDefault on mousedown keeps focus on the textarea — no
                      // .focus() call, just skipping the browser's default click-to-
                      // focus so the composer stays the active element.
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => acceptCommand(c)}
                      className={cn(
                        "flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left",
                        i === selectedIndex
                          ? "bg-accent text-accent-foreground"
                          : "hover:bg-accent hover:text-accent-foreground",
                      )}
                    >
                      <span className="flex items-center gap-1.5">
                        <span className="font-mono text-xs">/{c.name}</span>
                        {c.kind === "skill" && (
                          <Badge variant="outline" className="px-1 py-0 text-[10px]">
                            skill
                          </Badge>
                        )}
                      </span>
                      {c.description && (
                        <span className="text-[11px] text-muted-foreground">
                          {c.description}
                        </span>
                      )}
                    </button>
                  ))
                )}
              </div>
            )}
            {mentionMenuOpen && (
              <div className="absolute inset-x-4 bottom-full z-10 mb-2 max-h-64 overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10">
                {mentionFiles.map((f, i) => (
                  <button
                    type="button"
                    key={f.path}
                    // Same trick the slash menu uses: preventDefault on
                    // mousedown keeps focus on the textarea, so accepting an
                    // item never costs the composer its cursor.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => acceptMention(f)}
                    className={cn(
                      "flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left",
                      i === mentionIndex
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-accent hover:text-accent-foreground",
                    )}
                  >
                    <span className="shrink-0 font-mono text-xs">{f.name}</span>
                    <span className="min-w-0 flex-1 truncate text-right text-[11px] text-muted-foreground">
                      {f.path}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {messageQueue.length > 0 && (
              <div className="mb-2 space-y-1.5 rounded-xl border border-primary/25 bg-primary/[0.04] p-2">
                <div className="flex items-center justify-between px-1.5 pt-0.5">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {engineQueuePaused ? "Queue paused · review before resuming" : "Queued · sends in order"}
                  </span>
                  <div className="flex items-center gap-1.5">
                    {engineQueuePaused && (
                      <Button type="button" size="xs" variant="outline" onClick={() => void resumeEngineQueue()}>
                        Resume
                      </Button>
                    )}
                    <span className="rounded-full bg-primary/15 px-1.5 text-[10px] font-medium text-primary">
                      {messageQueue.length}
                    </span>
                  </div>
                </div>
                {messageQueue.map((m, i) => (
                  <QueueChip
                    key={m.id}
                    index={i + 1}
                    text={m.text}
                    editing={editingQueueId === m.id}
                    onEdit={() => {
                      if (!m.accepted || m.state === "queued") setEditingQueueId(m.id);
                    }}
                    onCommit={(v) => {
                      setMessageQueue((q) => q.map((x) => (x.id === m.id ? { ...x, text: v } : x)));
                      setEditingQueueId(null);
                      if (m.accepted) void editEngineQueueItem(m, v);
                    }}
                    onRemove={() => {
                      if (m.accepted) void removeEngineQueueItem(m);
                      else setMessageQueue((q) => q.filter((x) => x.id !== m.id));
                    }}
                    state={m.state}
                    error={m.error}
                  />
                ))}
              </div>
            )}
            {attachmentError && (
              <div className="mb-2 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/[0.06] px-2.5 py-1.5 text-[11px] text-destructive">
                <span className="min-w-0 flex-1">{attachmentError}</span>
                <button
                  type="button"
                  onClick={() => setAttachmentError(null)}
                  className="shrink-0 rounded px-1 hover:bg-destructive/10"
                >
                  Dismiss
                </button>
              </div>
            )}
            {compactError && (
              <div className="mb-2 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/[0.06] px-2.5 py-1.5 text-[11px] text-destructive">
                <span className="min-w-0 flex-1">{compactError}</span>
                <button
                  type="button"
                  onClick={() => setCompactError(null)}
                  className="shrink-0 rounded px-1 hover:bg-destructive/10"
                >
                  Dismiss
                </button>
              </div>
            )}
            <PromptInput
              onSubmit={handleSubmit}
              // Drops land anywhere over the CONVERSATION COLUMN, not only on
              // the composer — aiming at a 76px textarea to attach a screenshot
              // is the kind of precision this app asks for nowhere else. Scoped
              // to the column rather than the document (the vendored
              // `globalDrop`) so the right panel keeps its own drop behaviour:
              // the browser and git surfaces live there, and a composer that
              // claimed every drop in the window would silently outrank them.
              // The overlay still paints on the composer, which is where the
              // files are about to appear.
              dropTarget={sessionSurfaceRef}
              multiple
              maxFiles={ATTACHMENT_MAX_FILES}
              // The CEILING, not the policy: 10 MB is the image budget, and the
              // tighter 2 MB cap for everything else is applied in handleSubmit
              // where the media type is known (see ATTACHMENT_MAX_BYTES). Both
              // exist because the bytes are inlined into the turn — a file over
              // its cap is still attachable, it just travels as a path for the
              // agent to read rather than as inlined content.
              maxFileSize={ATTACHMENT_MAX_BYTES.image}
              onError={(err) =>
                setAttachmentError(
                  err.code === "max_files"
                    ? `At most ${ATTACHMENT_MAX_FILES} attachments per message.`
                    : err.code === "max_file_size"
                      ? `Attachments are capped at ${ATTACHMENT_MAX_BYTES.image / 1024 / 1024} MB.`
                      : err.message,
                )
              }
              className="[&_[data-slot=input-group]]:rounded-2xl [&_[data-slot=input-group]]:border-border/80 [&_[data-slot=input-group]]:bg-card/95 [&_[data-slot=input-group]]:shadow-[0_18px_60px_-30px_rgba(0,0,0,.9)] [&_[data-slot=input-group]]:backdrop-blur-xl"
            >
              <PromptInputAttachments />
              <PromptInputBody>
                {/* cmux may attach its private focus marker before hydration.
                    Scope suppression to this one host-mutated element so the
                    real textarea is always present; a client-only placeholder
                    could remain stranded if hydration never schedules its
                    follow-up snapshot, leaving exactly the empty composer the
                    user cannot type into. */}
                <PromptInputTextarea
                  ref={composerRef}
                  suppressHydrationWarning
                  disabled={ultraOwnsScreen}
                  className="min-h-[76px] px-3 pb-2 pt-3 text-[15px] leading-6"
                  placeholder={
                    // ISSUE #14: this takes priority over the busy copy below —
                    // a disabled textarea showing "queues a message…" would
                    // promise something it cannot do. The reason names WHERE the
                    // composer went, not just that it is off, since a silently
                    // disabled box with no explanation is what the issue asked
                    // to avoid.
                    ultraOwnsScreen
                      ? "Exit fullscreen to send a message to this session…"
                      : // The busy half of this used to read "Agent is working —
                        // Enter queues a message…". The transcript's status row and
                        // this composer's own Stop button both already say the agent
                        // is working; what the user cannot infer is what Enter does
                        // RIGHT NOW, so only that survives.
                        busy
                        ? "Enter queues a message…"
                        : "Ask for changes, explore the code, or attach context…"
                  }
                  onKeyDown={handleComposerKeyDown}
                  onChange={(e) => {
                    setMenuDismissed(false);
                    // Typing past a completed mention must be able to re-open
                    // the menu, so this clears the dismissal the same way the
                    // slash menu's does.
                    setMentionDismissed(false);
                    setCaret(e.currentTarget.selectionStart);
                  }}
                  onClick={(e) => setCaret(e.currentTarget.selectionStart)}
                />
              </PromptInputBody>
              <PromptInputFooter className="min-h-11 flex-wrap border-t border-border/40 px-2.5 pb-2 pt-1.5">
                <PromptInputTools className="flex-wrap gap-1.5">
                  <PromptInputActionMenu>
                    <PromptInputActionMenuTrigger
                      aria-label="Add context"
                      title="Add photos, files, or a screenshot"
                    />
                    <PromptInputActionMenuContent>
                      <PromptInputActionAddAttachments />
                      <PromptInputActionAddScreenshot />
                    </PromptInputActionMenuContent>
                  </PromptInputActionMenu>
                  {/* The compact affordance (this task's part 3): only meaningful
                      once a real session/thread exists to compact — route.ts's
                      own 400 guard refuses `compact: true` without a sessionId,
                      so the button never offers a request the server would just
                      reject. Same icon-sm ghost Button pattern as the dock
                      minimize control above; `compacting` drives the same
                      pulsing-icon treatment busy state uses elsewhere rather
                      than inventing a second "in progress" visual language. */}
                  {sessionId && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={compacting ? "Compacting…" : "Compact conversation"}
                      title={
                        compacting
                          ? "Compacting…"
                          : "Compact this conversation — summarize history to free up context"
                      }
                      disabled={compacting || busy}
                      className={cn(
                        "shrink-0 text-muted-foreground hover:text-foreground",
                        compacting && "animate-pulse text-primary",
                      )}
                      onClick={() => void compactNow()}
                    >
                      <FoldVerticalIcon className="size-4" />
                    </Button>
                  )}
                  <ComposerControls
                    project={project}
                    provider={provider}
                    providers={availableProviders}
                    onProviderChange={selectProvider}
                    account={activeAccount}
                    accounts={selectableAccountProfiles}
                    onAccountChange={setActiveAccount}
                    runtimeLocked={sessionId !== null || busy}
                    model={sessionModel}
                    setModel={setModel}
                    modelOptions={modelOptions}
                    optionGroups={optionGroups}
                    optionValues={optionValues}
                    onOptionChange={changeProviderOption}
                    approval={{
                      title: "Runtime mode",
                      value: runtimeMode,
                      options: RUNTIME_MODE_OPTIONS,
                      onChange: (value: string) => {
                        if (isRuntimeMode(value)) setRuntimeMode(value);
                      },
                      defaultValue: DEFAULT_RUNTIME_MODE,
                    }}
                  />
                </PromptInputTools>
                <div className="ml-auto flex shrink-0 items-center gap-1.5 self-end">
                  <ContextPill
                    used={contextUsage?.totalTokens ?? context}
                    windowTokens={
                      (contextUsage?.maxTokens && contextUsage.maxTokens > 0
                        ? contextUsage.maxTokens
                        : parseWindow(
                            activeModel?.context && activeModel.context !== "—"
                              ? activeModel.context
                              : contextLabelForModel(sessionModel, provider),
                          ))
                    }
                    provider={provider}
                  />
                <PromptInputSubmit
                  className="shrink-0"
                  // ISSUE #14: match the textarea above. Enabling only Stop here
                  // would need a second reason ("why can I stop but not send?"),
                  // and this issue never asked for that distinction.
                  disabled={ultraOwnsScreen}
                  status={status === "ready" ? undefined : status}
                  onStop={() => {
                    // Stop the DETACHED server run — a mere disconnect no longer
                    // stops it (§A.4) — then close the local reader. A turn
                    // resumed via the §1b reconnect tail never sets runIdRef
                    // (this mount never started it, and the reconnect SSE never
                    // echoes the server-side runId back) — fall back to
                    // sessionId, which stopChatRun (lib/chat-runs.ts) already
                    // accepts as an alternate lookup key for exactly this case.
                    // The reconnect tail's own reader then unwinds on its own
                    // once the aborted run's "closed" event reaches it.
                    const rid = runIdRef.current;
                    if (rid || sessionId) {
                      void fetch("/api/chat/stop", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(rid ? { runId: rid, sessionId } : { sessionId }),
                      }).catch(() => {});
                    }
                    // Stop means stop. Without this latch the queue drains the
                    // moment `status` returns to "ready", so the agent the user
                    // just halted restarts itself with their queued message.
                    turnInterruptedRef.current = true;
                    abortRef.current?.abort();
                  }}
                />
                </div>
              </PromptInputFooter>
            </PromptInput>
            {!embedded && (
              <WorkspaceEnvironment
                project={project}
                rightPanelScopeKey={resolvedRightPanelScopeKey}
              />
            )}
          </div>
        }
      />
      </div>
      {!embedded && (
        <RightPanel
          project={project}
          scopeKey={resolvedRightPanelScopeKey}
          activityCount={activityCount}
          activityRunning={activityRunning}
          activityAttention={activityAttention}
          activity={
            // ISSUE #13(b): an active Ultra run now takes over the DOCK's
            // activity slot, not the main transcript — the pane it opens is a
            // SIBLING of the main chat, never a replacement for it. This is
            // the one place `activeRunTab` decides what renders; everywhere
            // else in this file it is inert data read by this branch alone.
            activeRunTab ? (
              <div className="flex h-full min-h-0 flex-col gap-2 overflow-hidden p-3">
                <div className="shrink-0">
                  <UltraTabBanner run={activeRunTab} onBack={() => setActiveTab("main")} />
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto pr-1">
                  <UltraTabView
                    run={activeRunTab}
                    provider="claude"
                    onStop={() => void ultraAct(activeRunTab.runId, "stop")}
                    busy={ultraBusyRunId === activeRunTab.runId}
                    isOpen={activityDisclosure.isOpen}
                    setOpen={activityDisclosure.setOpen}
                  />
                </div>
              </div>
            ) : (
              <SubagentRail
                surface="panel"
                agents={railAgents}
                activeId={activeTab}
                onSelect={setActiveTab}
                sessionLabel={title}
                mainNeedsAttention={mainNeedsAttention}
                workflows={
                  <UltraRail
                    // NEVER a run id here (issue #13): this branch only renders
                    // when `activeRunTab` is null, so there is no run for the
                    // rail's own "Here" badge to point at.
                    runs={ultraRunList}
                    activeRunId={null}
                    onOpen={(id) => setActiveTab(ultraTabId(id))}
                  />
                }
                workflowCount={ultraRunList.length}
              />
            )
          }
        />
      )}
    </div>
  );
}
