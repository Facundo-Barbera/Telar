"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import Link from "next/link";
import {
  ArrowLeftIcon,
  BellIcon,
  BotIcon,
  CheckIcon,
  ExternalLinkIcon,
  PencilIcon,
  PictureInPicture2Icon,
  TriangleAlertIcon,
  UserRoundIcon,
  WorkflowIcon,
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
  groupParts,
  isAsyncLaunchAck,
  isTrailingItem,
  parentOf,
  toTranscriptItems,
  usePromptInputController,
  type AgentBucket,
  type ChatMessage,
  type ItemKind,
  type PermissionPart,
  type PromptInputMessage,
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
import { CostPill, ContextPill } from "@/components/session/session-meters";
import { useDockOptional } from "@/components/dock/dock-provider";
import { stepPreview, type AgentInfo, type ToolPart } from "@/components/session/tool-step";
import { WorkingIndicator, type WorkState } from "@/components/session/working-indicator";
import { ComposerSettings } from "@/components/session/composer-settings";
import { PageHeader } from "@/components/common/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { fmtTokens, shortId } from "@/lib/format";
import { consumeSSE } from "@/lib/sse";
import { UsagePill } from "@/components/session/usage-pill";
import type { PlanSnapshot } from "@/lib/store";
// Type-only (this is a "use client" file — no runtime value from @telar/core).
import type { Watch, WorkUnitState } from "@telar/core";
import {
  CODEX_APPROVAL_PRESETS,
  CODEX_EFFORT_OPTIONS,
  DEFAULT_CODEX_APPROVAL_ID,
  DEFAULT_CODEX_MODEL,
  DEFAULT_MODEL,
  EFFORT_OPTIONS,
  modelById,
  modelsForProvider,
  type CodexApprovalPolicy,
  type CodexSandbox,
  type ModelInfo,
} from "@/lib/models";
// Client-safe: permission-modes has NO SDK dependency. Importing these from
// @/lib/permissions instead would pull loom-mcp -> the Agent SDK
// (node:async_hooks) into the client bundle.
import { isValidPermissionMode, type ClientPermissionMode } from "@/lib/permission-modes";
import {
  ESCALATION_KICKOFF_SENTINEL,
  shouldFireEscalationKickoff,
} from "@/lib/escalation-kickoff";
import { spendReadout } from "@/lib/spend-readout";
import { ULTRA_WAKE_SENTINEL } from "@/lib/ultra-wake";
import { useAccounts } from "@/lib/use-accounts";
import { useUltraWake } from "@/lib/use-ultra-wake";
import { cn } from "@/lib/utils";
import { PROVIDER_LABEL, ProviderIcon } from "@/components/session/provider-icon";

type Provider = "claude" | "codex";

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

// A tilde estimate (chars/4, the usual rough token heuristic) of the transcript
// actually re-sent as the next turn's prompt — real message + tool text, so the
// CTX overlay's "Messages" bucket has a genuine source rather than an invented
// number. Clamped to `used` on the pill side; here we just measure real chars.
function estimateTranscriptTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === "text" || p.type === "thinking") chars += p.text.length;
      else if (p.type === "tool") {
        if (p.input) chars += JSON.stringify(p.input).length;
        if (p.output) chars += p.output.length;
      }
    }
  }
  return Math.round(chars / 4);
}

type ProjectCommand = {
  name: string;
  description: string;
  kind: "command" | "skill";
};

export type InitialChat = {
  id: string;
  model: string;
  effort?: string;
  // Absent on chats persisted before mode selection existed — reads as
  // "default" (the prior hardcoded behavior), same fallback the state below
  // uses.
  permissionMode?: ClientPermissionMode;
  messages: StoreMessage[];
  // Reload seed for the heartbeat bar — a live turn's "done" events add on
  // top of the token fields (costUsd is replaced outright, see the sessionCost
  // useState below), but without seeding from the persisted chat record a
  // reload of an existing session would show $0.00 / 0 tokens despite the
  // store already holding the true accumulated totals.
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  contextTokens: number;
  // Session<->Loom link (docs/loom-model.md §5, store.ts's Chat.loomId/role)
  // — set once this session's loom MCP tools have drafted/started a bundle.
  // Seeds the header's persistent "Planning loom" chip on reload.
  loomId?: string;
  role?: "planner" | "steerer" | "escalation";
};

const refresh = () => window.dispatchEvent(new Event("telar:refresh"));

// consumeSSE (the frame-by-frame `event:`/`data:` reader shared by the POST
// send() path and the §1b reconnect subscriber) now lives in @/lib/sse — the
// dock's own live tail (session-runtime-host.tsx) reuses the exact same
// parser rather than a second implementation of the wire format.

function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      aria-label={label}
      className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <ArrowLeftIcon className="size-4" />
    </Link>
  );
}

function seedMessages(chat: InitialChat | undefined): ChatMessage[] {
  if (!chat) return [];
  return chat.messages.map((m, i) => ({
    id: `seed-${i}`,
    role: m.role,
    parts: m.parts.map((p) =>
      p.type === "text"
        ? { type: "text" as const, text: p.text, done: true, parentId: p.parentId }
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

// "Ask me" / "Auto" / "Accept edits" — the only three permissionMode values
// a client may pick (see lib/permissions.ts's PERMISSION_MODES); the mode
// select in the composer footer renders these, one-line description and
// all, same idiom as the model select above it.
const PERMISSION_MODE_OPTIONS: Array<{
  value: ClientPermissionMode;
  label: string;
  description: string;
}> = [
  {
    value: "default",
    label: "Ask me",
    description: "Prompt for every tool call that isn't already allowed.",
  },
  {
    value: "auto",
    label: "Auto",
    description: "A classifier approves routine tool calls automatically.",
  },
  {
    value: "acceptEdits",
    label: "Accept edits",
    description: "Auto-accept file edits; still ask about everything else.",
  },
];

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
function QueueChip({
  index,
  text,
  editing,
  onEdit,
  onCommit,
  onRemove,
}: {
  index: number;
  text: string;
  editing: boolean;
  onEdit: () => void;
  onCommit: (v: string) => void;
  onRemove: () => void;
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
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-3">
      {payload.banner}
      {/* Same reading column as the main transcript's <Message> wrapper, so a
          subagent tab lines up with Main instead of spanning the whole pane. */}
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-3 text-sm">
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

// Composed once, at module scope, and passed to the shell as a PROP — never read
// by the shell from anywhere global (project-context.md forbids a global client
// store, and a shared mutable registry would also let two surfaces on one page
// clobber each other's registrations).
const SESSION_KINDS = createItemKindRegistry([
  ...BUILTIN_KINDS,
  agentBucketKind as unknown as ItemKind<never>,
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
          {showDescription && <p className="text-muted-foreground">{description}</p>}
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
  accounts: Array<{ name: string; displayTier?: string }>;
  initialChat?: InitialChat;
  initialTitle?: string;
  // The route's session id (undefined for the "new" front door). Only used to
  // seed sessionId when there's no persisted initialChat yet — the mid-turn
  // cold-reload case; see the sessionId state below.
  routeSessionId?: string;
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
      <SessionViewInner {...props} />
    </PromptInputProvider>
  );
}

function SessionViewInner({
  project,
  account,
  accounts,
  initialChat,
  initialTitle,
  routeSessionId,
  initialRole,
  planner,
  steerer,
  escalation,
  embedded,
  loomId,
}: {
  project: string;
  account: string;
  accounts: Array<{ name: string; displayTier?: string }>;
  initialChat?: InitialChat;
  initialTitle?: string;
  routeSessionId?: string;
  initialRole?: "planner";
  planner?: boolean;
  steerer?: boolean;
  escalation?: boolean;
  embedded?: boolean;
  loomId?: string;
}) {
  const textInput = usePromptInputController().textInput;

  // Seed once from the server-resolved transcript. Later prop changes are
  // ignored on purpose: when a fresh session is minted mid-stream we rewrite
  // the URL to its new id, which re-renders this page with initialChat still
  // undefined — re-seeding would tear the live stream down.
  const [sessionId, setSessionId] = useState<string | null>(
    initialChat?.id ?? routeSessionId ?? null,
  );
  const [messages, setMessages] = useState<ChatMessage[]>(() =>
    seedMessages(initialChat),
  );
  // The header title lives here so a freshly-minted session shows its derived
  // thread title immediately — the server can't re-title mid-stream (getChat is
  // undefined until the first turn persists, long after the URL is rewritten).
  const [title, setTitle] = useState(initialTitle ?? "New session");
  // Mini-dock: docking the current session is its natural entry point. Optional
  // context so an out-of-provider render (dev gallery) simply hides the button.
  const dock = useDockOptional();
  const [model, setModel] = useState(initialChat?.model ?? DEFAULT_MODEL);
  // "default" = omit `effort` from the POST body entirely (let the model/SDK
  // pick). Any other value is a real EffortLevel string sent as-is.
  const [effort, setEffort] = useState(initialChat?.effort ?? "default");
  // Auto Mode is the DEFAULT for a fresh session (owner-locked 1.2 decision):
  // a classifier approves routine tool calls automatically. A resumed session
  // keeps whatever was last persisted (route.ts's appendTurn), so an existing
  // chat that ran under "Ask me" restores exactly that — the Auto default only
  // seeds brand-new sessions with no persisted permissionMode yet.
  const [permissionMode, setPermissionMode] = useState<ClientPermissionMode>(
    initialChat?.permissionMode ?? "auto",
  );
  // The caller already resolves the effective account (chat.account for an
  // existing session, the manifest default for a fresh one — contract #5:
  // resume transcripts live under the account's config dir, so an existing
  // chat must never drift to a since-changed manifest default). We just seed
  // from it once and lock further edits once a session exists (below).
  const [activeAccount, setActiveAccount] = useState(account);
  // Which agent backend the composer is talking to. Defaults to "claude" —
  // the overwhelmingly common case and the only thing we can assume before
  // the account registry (fetched async, below) resolves `activeAccount`'s
  // real provider. Drives which model/effort/sandbox-or-permission controls
  // render and which fields go in the POST body.
  const [provider, setProvider] = useState<Provider>("claude");
  // Codex's counterpart to `permissionMode` — an approval preset (sandbox +
  // approvalPolicy pair, see CODEX_APPROVAL_PRESETS in lib/models.ts) now that
  // the app-server can prompt mid-turn. Kept as its own state rather than
  // reusing permissionMode's slots since the two providers' option sets don't
  // line up 1:1.
  const defaultCodexApproval =
    CODEX_APPROVAL_PRESETS.find((p) => p.id === DEFAULT_CODEX_APPROVAL_ID) ?? CODEX_APPROVAL_PRESETS[0];
  const [sandbox, setSandbox] = useState<CodexSandbox>(defaultCodexApproval.sandbox);
  const [approvalPolicy, setApprovalPolicy] = useState<CodexApprovalPolicy>(
    defaultCodexApproval.approvalPolicy,
  );
  // Full account registry (name + provider + auth, unlike the server-resolved
  // `accounts` prop which predates multi-provider and only carries
  // name/displayTier). Used to scope the account picker to the selected
  // provider and to recover a resumed session's real provider below.
  const { accounts: accountProfiles } = useAccounts();
  // `account`'s real provider may be either one (a fresh session's account
  // is the project manifest's default, which can itself be a Codex account;
  // a resumed session's is whatever it was created with) — re-derive
  // `provider` once the registry loads instead of trusting the "claude"
  // guess above. Only runs in "auto" mode: the moment the user actually
  // touches the agent selector, selectProvider flips providerTouched and
  // this effect stops overwriting their choice.
  const providerTouched = useRef(false);
  useEffect(() => {
    if (providerTouched.current) return;
    const match = accountProfiles.find((a) => a.name === activeAccount);
    if (match) setProvider(match.provider ?? "claude");
  }, [accountProfiles, activeAccount]);
  // Accounts belonging to the currently selected provider, for the agent
  // selector's scoped account picker. Falls back to the server-resolved
  // `accounts` prop for "claude" so the picker isn't empty for the one
  // provider we can resolve before the client-side /api/accounts fetch lands.
  const providerAccounts = useMemo<Array<{ name: string; displayTier?: string }>>(() => {
    const fromRegistry = accountProfiles.filter((a) => (a.provider ?? "claude") === provider);
    if (fromRegistry.length > 0) return fromRegistry;
    return provider === "claude" ? accounts : [];
  }, [accountProfiles, provider, accounts]);
  // Model catalog for the selected provider, fetched from GET /api/models
  // (Claude: live Anthropic /v1/models; Codex: the local models_cache.json),
  // falling back to the curated static list on any hiccup. Refetched whenever
  // the provider changes.
  const [modelOptions, setModelOptions] = useState<ModelInfo[]>(() => modelsForProvider("claude"));
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/models?provider=${provider}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled) return;
        const list: ModelInfo[] = Array.isArray(d?.models) && d.models.length > 0 ? d.models : modelsForProvider(provider);
        setModelOptions(list);
      })
      .catch(() => {
        if (!cancelled) setModelOptions(modelsForProvider(provider));
      });
    return () => {
      cancelled = true;
    };
  }, [provider]);
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
      const stillValid = accountProfiles.find(
        (a) => a.name === activeAccount && (a.provider ?? "claude") === next,
      );
      if (!stillValid) {
        const candidates = accountProfiles.filter((a) => (a.provider ?? "claude") === next);
        if (candidates[0]) setActiveAccount(candidates[0].name);
      }
    },
    [accountProfiles, activeAccount],
  );
  const [status, setStatus] = useState<Status>("ready");
  // Latest status for the reconnect effect's point-in-time "ready" gate, read
  // via a ref so mutating status inside that effect can't re-trigger it.
  const statusRef = useRef(status);
  statusRef.current = status;
  const [thinking, setThinking] = useState(false);
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
  // Seeded from the persisted chat record (reload), which is itself a
  // projection over usage.ndjson (store.ts getChat) — and each live "done"
  // REPLACES this with the session's freshly projected ledger total rather
  // than adding a delta, so the number on screen is the same fold either way.
  // Without the seed, reloading an existing session would show $0.00 despite
  // the ledger already holding the true total (the bug this seed fixes).
  const [sessionCost, setSessionCost] = useState(initialChat?.costUsd ?? 0);
  const [tokens, setTokens] = useState({
    input: initialChat?.inputTokens ?? 0,
    output: initialChat?.outputTokens ?? 0,
    cacheRead: initialChat?.cacheReadTokens ?? 0,
    cacheCreate: initialChat?.cacheCreateTokens ?? 0,
  });
  // Context-window occupancy: the LATEST turn's prompt size, set (not summed)
  // each turn — see the "done" handler and store.ts contextTokens.
  const [context, setContext] = useState(initialChat?.contextTokens ?? 0);
  // Active account's 5h + weekly limit snapshot for the workspace usage pill.
  // Reads the stored plan (populated by the sidebar's refresh) and re-reads on
  // the global telar:refresh event so it stays in step with the sidebar.
  const [usageSnap, setUsageSnap] = useState<PlanSnapshot | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetch("/api/usage")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!cancelled) setUsageSnap(d?.plan?.[activeAccount] ?? null);
        })
        .catch(() => {});
    load();
    window.addEventListener("telar:refresh", load);
    return () => {
      cancelled = true;
      window.removeEventListener("telar:refresh", load);
    };
  }, [activeAccount]);
  const [elapsed, setElapsed] = useState(0);
  // 1.4 working indicator: seconds since the last streamed output, used to flip
  // the indicator to its "still working — no output" reassurance on a long
  // quiet step. Reset whenever `messages` changes (any delta/part is activity).
  const [silentFor, setSilentFor] = useState(0);
  const lastActivityRef = useRef(Date.now());
  useEffect(() => {
    lastActivityRef.current = Date.now();
    setSilentFor(0);
  }, [messages]);
  // 1.2 composer settings popover open/pin state.
  const [settingsOpen, setSettingsOpen] = useState(false);
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
        model?: string;
        effort?: string;
        perm?: unknown;
      };
      if (typeof saved.model === "string") setModel(saved.model);
      if (typeof saved.effort === "string") setEffort(saved.effort);
      if (isValidPermissionMode(saved.perm)) setPermissionMode(saved.perm);
    } catch {
      // ignore malformed / storage-blocked
    }
  }, [initialChat, project]);
  useEffect(() => {
    if (provider !== "claude" || typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        `telar:composer:${project}`,
        JSON.stringify({ model, effort, perm: permissionMode }),
      );
    } catch {
      // ignore storage-blocked
    }
  }, [provider, project, model, effort, permissionMode]);
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
  // Collapse toggle for the right-hand sub-agents rail (replaces the old tab
  // strip). Purely a UI preference for this mount.
  const [railCollapsed, setRailCollapsed] = useState(false);
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
  // Queued messages render as editable/removable chips above the composer and
  // dispatch in order the moment the turn settles, via the same send() path.
  const [messageQueue, setMessageQueue] = useState<{ id: string; text: string }[]>([]);
  const [editingQueueId, setEditingQueueId] = useState<string | null>(null);
  const queueSeqRef = useRef(0);

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
  const leaveRef = useRef({ busy, chatPersisted, sessionId, title, project, embedded });
  leaveRef.current = { busy, chatPersisted, sessionId, title, project, embedded };
  useEffect(() => {
    return () => {
      const s = leaveRef.current;
      if (!autoDock) return;
      // Guards: embedded surfaces never auto-dock; idle sessions never auto-dock
      // (busy); need a confirmed persisted id to follow. autoDock itself no-ops
      // if the id is already docked, so no duplicate heads.
      if (s.embedded || !s.busy || !s.chatPersisted || !s.sessionId) return;
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
  const agentBuckets = useMemo(() => {
    const order: string[] = [];
    const byId = new Map<string, AgentBucket>();
    for (const m of messages) {
      for (const part of m.parts) {
        if (part.type === "tool" && part.agent && part.id && parentOf(part) === undefined) {
          const existing = byId.get(part.id);
          if (existing) {
            existing.spawn = part; // refresh in place (e.g. output just landed)
          } else {
            order.push(part.id);
            byId.set(part.id, { id: part.id, spawn: part, parts: [] });
          }
        }
      }
    }
    for (const m of messages) {
      for (const part of m.parts) {
        const parent = parentOf(part);
        if (parent) byId.get(parent)?.parts.push(part);
      }
    }
    return order.map((id) => byId.get(id)!);
  }, [messages]);

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

  // Elapsed clock — runs only while a turn is in flight.
  useEffect(() => {
    if (!busy) return;
    const started = Date.now();
    setElapsed(0);
    const t = setInterval(() => {
      setElapsed(Math.floor((Date.now() - started) / 1000));
      setSilentFor(Math.floor((Date.now() - lastActivityRef.current) / 1000));
    }, 1000);
    return () => clearInterval(t);
  }, [busy]);

  // Abort any in-flight turn if the session is navigated away from.
  useEffect(() => () => abortRef.current?.abort(), []);

  // Non-200 (including a project scan with no .claude/commands dir, which the
  // endpoint itself answers with an empty list) is treated as "no commands" —
  // autocomplete is a nicety, never worth an error UI.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/projects/${encodeURIComponent(project)}/commands`)
      .then((res) => (res.ok ? res.json() : { commands: [] }))
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
          refresh();
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
                // italic block ThinkingRow renders while it streams. A block
                // start always opens a NEW part rather than reopening a
                // previous one: by the time a second thinking block starts
                // for the same parent, the first was already closed by
                // whatever delta/text/tool followed it (see closeThinking).
                setThinking(true);
                const parent: string | undefined = payload.parent ?? undefined;
                patch(asstId, (m) => ({
                  ...m,
                  parts: [...m.parts, { type: "thinking", text: "", done: false, parentId: parent }],
                }));
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
              case "plan":
                refresh();
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
                // payload.costUsd is the SESSION'S ledger total (route.ts's
                // "done"), not this turn's delta — so SET it. The displayed
                // spend is a projection over usage.ndjson, never a counter
                // this component accumulates (AD-18). Adding would compound
                // the total against itself: turn 2 would render turn 1 twice.
                // The token deltas below are genuinely per-turn and DO
                // accumulate — the difference is in what the payload carries,
                // not in how this handler is written.
                if (typeof payload.costUsd === "number") setSessionCost(payload.costUsd);
                setTokens((t) => ({
                  input: t.input + (payload.usage?.input_tokens ?? 0),
                  output: t.output + (payload.usage?.output_tokens ?? 0),
                  cacheRead: t.cacheRead + (payload.usage?.cache_read_input_tokens ?? 0),
                  cacheCreate: t.cacheCreate + (payload.usage?.cache_creation_input_tokens ?? 0),
                }));
                // Context is the server-computed final-call prompt size
                // (payload.context), NOT derived from the cumulative usage
                // above — that usage sums every step of the turn.
                if (typeof payload.context === "number") setContext(payload.context);
                refresh();
                break;
              case "saved":
                setChatPersisted(true);
                refresh();
                break;
              case "error":
                streamErrorRef.current = payload.message;
                break;
    }
  }, [sessionId, project]);

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
    let sawEvent = false;

    (async () => {
      try {
        const res = await fetch(`/api/chat/${encodeURIComponent(sessionId)}/events`, {
          signal: abort.signal,
        });
        if (!res.ok || !res.body) return;
        await consumeSSE(res.body.getReader(), (event, payload) => {
          // First byte of a live turn — flip to streaming so the busy UI shows
          // while applyServerEvent rebuilds it. A not-live session emits nothing
          // (server gate) and the reader closes at once, leaving status ready.
          if (!sawEvent) {
            sawEvent = true;
            setStatus("streaming");
          }
          applyServerEvent(event, payload);
        });
        // The run's own "done" set cost/tokens but never touches status; once the
        // log drains ("closed" → reader done), settle a still-streaming view back.
        if (sawEvent) setStatus((s) => (s === "streaming" ? "ready" : s));
      } catch {
        // Aborted on unmount / sessionId change, or a dropped connection — the
        // detached server run is untouched; a later mount can reconnect again.
      } finally {
        // Clear the ref once the tail drains so it means "a reconnect reader is
        // live" — the injection guard reads it to keep from POSTing a second
        // concurrent turn during the tail (§6.D). Guard on identity so we never
        // clobber a newer reader. (Cleanup nulls it too, on unmount/dep change.)
        if (reconnectAbortRef.current === abort) reconnectAbortRef.current = null;
      }
    })();

    return () => {
      abort.abort();
      reconnectAbortRef.current = null;
      reconnectedRef.current = null;
    };
  }, [sessionId, applyServerEvent]);

  const send = useCallback(
    // `hidden` (M11 finding-1) fires a turn with NO user bubble — the escalation
    // kickoff, where `text` is the sentinel route.ts swaps for the real prompt.
    // The agent visibly speaks first: only the assistant message is appended, so
    // the human never appears to have typed the sentinel.
    async (text: string, opts?: { hidden?: boolean }) => {
      const asstId = `m${nextId.current++}`;
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
                id: `m${nextId.current++}`,
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

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: text,
            sessionId,
            runId,
            model,
            project,
            account: activeAccount,
            ...(effort !== "default" ? { effort } : {}),
            ...(provider === "codex" ? { sandbox, approvalPolicy } : { permissionMode }),
            // Session<->Loom link (docs/loom-model.md §5): tells route.ts
            // this is a planner turn BEFORE any Chat record exists (turn 1
            // has no persisted chat.role yet) — see its own comment on why
            // it reads this from the body at all. Omitted entirely for a
            // normal (non-planner) session. A steerer session (loom Chat tab)
            // additionally carries loomId so route.ts's turn-1 seed can bind the
            // session to this loom (validated server-side against the project).
            // An escalation session (blocked-loom discuss surface) carries
            // role:"escalation"+loomId the same way — route.ts binds a read-only
            // toolset whose only write is the human-gated answer_blocked.
            ...(planner
              ? { role: "planner" }
              : steerer
                ? { role: "steerer", loomId }
                : escalation
                  ? { role: "escalation", loomId }
                  : {}),
          }),
          signal: abort.signal,
        });
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
      }
    },
    [sessionId, model, effort, permissionMode, provider, sandbox, approvalPolicy, project, activeAccount, planner, steerer, escalation, loomId, applyServerEvent],
  );

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
      const res = await fetch(
        `/api/chat/${encodeURIComponent(sessionId)}/watches`,
      );
      if (!res.ok) return;
      const data = await res.json();
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
  const { pending: pendingWakes } = useUltraWake(sessionId);
  // ONE TRIGGER PER PASS, however many runs finished (T10). The appendix carries
  // all of them — its formatter takes a list — so three finished runs must not
  // fire three turns. This ref is what makes the enqueue one-shot: the wakes
  // stay pending until the ROUTE acks them (which it does on the turn that
  // consumes them), so without it every poll in that window would enqueue again.
  // It re-arms when the poll reports the mailbox empty, exactly as the watcher's
  // `lastFiredRef` re-arms on a different state.
  const ultraWakeFiredRef = useRef(false);
  useEffect(() => {
    if (pendingWakes.length === 0) {
      ultraWakeFiredRef.current = false;
      return;
    }
    if (ultraWakeFiredRef.current) return;
    ultraWakeFiredRef.current = true;
    const seq = watcherSeqRef.current++;
    setInjectionQueue((q) => [
      ...q,
      // The SENTINEL, never the outcome text. route.ts swaps it for the
      // server-authored instruction and the system-prompt appendix carries the
      // facts, so this client authors the trigger and nothing else. `hidden`
      // suppresses the local bubble; the route's `hideUserMessage` is what keeps
      // it out of the persisted transcript (they are two different suppressions,
      // and a wake needs both).
      { id: `uw${seq}`, text: ULTRA_WAKE_SENTINEL, hidden: true },
    ]);
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
    // THE DISPATCH CHANGED IN STORY 4.1; THE GATE DID NOT. The three conditions
    // above are untouched and must stay that way — writing a second idleness
    // predicate is how "an assistant turn appears on its own" becomes "two turns
    // fire at once". What changed is one line: the flag is threaded through, so
    // a hidden item (the Ultra wake trigger) reaches send()'s `hidden` branch
    // and renders no user bubble, while an unflagged item (the loom watcher)
    // dispatches EXACTLY as before — `undefined` is what send() already received.
    void send(next.text, next.hidden ? { hidden: true } : undefined);
  }, [status, injectionQueue, send]);

  const handleSubmit = (message: PromptInputMessage) => {
    const text = message.text.trim();
    if (!text) return;
    // Agent busy → queue instead of dropping. Returning void (sync) lets
    // PromptInput clear the textarea, exactly as a real send would.
    if (busy) {
      setMessageQueue((q) => [...q, { id: `q${queueSeqRef.current++}`, text }]);
      return;
    }
    void send(text);
  };

  // Dispatch the head of the message queue once the composer is genuinely idle
  // — mirrors the watcher-injection gate (§6.D): status "ready" AND no live
  // reader (so the reconnect tail can't race a second concurrent turn). Removing
  // the item before send() (which synchronously flips status to "submitted")
  // guarantees strictly one-at-a-time, in order.
  useEffect(() => {
    if (
      status !== "ready" ||
      abortRef.current ||
      reconnectAbortRef.current ||
      messageQueue.length === 0
    )
      return;
    const [next, ...rest] = messageQueue;
    setMessageQueue(rest);
    void send(next.text);
  }, [status, messageQueue, send]);

  // Prefer the fetched catalog (matches what's actually offered in the
  // select) and fall back to the static list for a model id seeded from a
  // resumed chat before the fetch resolves.
  const activeModel = modelOptions.find((m) => m.id === model) ?? modelById(model);
  const effortOptions = provider === "codex" ? CODEX_EFFORT_OPTIONS : EFFORT_OPTIONS;

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
  const liveWork: WorkState | null = !busy
    ? null
    : status === "submitted"
      ? { kind: "starting" }
      : runningTool
        ? {
            kind: "tool",
            tool: runningTool.name,
            target: runningTool.target,
            elapsed,
            silentFor,
          }
        : thinking
          ? { kind: "thinking", elapsed }
          : { kind: "working", elapsed };

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

  // No focus() anywhere here — navigation and acceptance are driven entirely
  // by the textarea's own keydown, so the textarea never loses focus.
  const handleComposerKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
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
  // Deliberately NOT memoized: `messages` changes on essentially every SSE frame
  // of a live turn, so a memo would recompute anyway while adding a dependency
  // list to keep correct. The donor computed `groupParts` inline in its render
  // loop for the same reason.
  const transcriptItems: TranscriptItem[] = activeBucket
    ? [agentBucketItem(activeBucket, () => setActiveTab("main"))]
    : messages.map((m) => {
        // Main renders only this message's OWN parts — anything a subagent
        // produced lives in its own tab (see agentBuckets), not interleaved
        // here even though it rode in on the same SSE stream and the same
        // message's parts array.
        const mainParts = m.parts.filter((p) => parentOf(p) === undefined);
        return {
          kind: CONVERSATION_KINDS.turn,
          key: m.id,
          payload: {
            from: m.role,
            items: toTranscriptItems(groupParts(m.id, mainParts), {
              onRespond: respondPermission,
              agentSteps: (id) => agentBucketById.get(id)?.parts.length ?? 0,
              onSelectAgent: setActiveTab,
            }),
            pending:
              mainParts.length === 0 && m.role === "assistant" && busy ? (
                <Shimmer className="text-sm">
                  {thinking ? "Thinking…" : "Weaving…"}
                </Shimmer>
              ) : undefined,
          } satisfies TurnPayload,
        };
      });

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

  return (
    <>
      {/* The standalone-session chrome (back button + identity header + account/
          usage heartbeat bar) is suppressed for an embedded surface — the host
          page (the loom cockpit) already carries identity. See the `embedded`
          prop. */}
      {!embedded && (
        <PageHeader
          leading={
            <BackLink
              href={`/projects/${encodeURIComponent(project)}`}
              label={`Back to ${project}`}
            />
          }
          title={titleNode}
          description={<span className="font-mono text-xs">{project}</span>}
        />
      )}

      {/* Live heartbeat for this session — active account (editable pre-session,
          locked once one exists), session id once minted, elapsed while
          working, running cost + token counts. */}
      {!embedded && (
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-1.5">
        <Badge variant="outline" className="gap-1.5 font-mono text-xs">
          <UserRoundIcon className="size-3" />
          {activeAccount}
        </Badge>
        {sessionId && (
          <Badge variant="secondary" className="font-mono text-xs">
            {shortId(sessionId)}
          </Badge>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {liveWork && (
            <WorkingIndicator state={liveWork} className="max-w-[min(420px,60vw)]" />
          )}
          {/* The aggregate looms pill (replaces the persistent banner + the old
              "Planning loom" chip). Solo → state + short id; N → most-urgent
              rollup. Hover previews the per-loom overlay, click pins. */}
          <LoomsPill looms={pillLooms} />
          <UsagePill snap={usageSnap} />
          {/* Context-window occupancy after the latest turn, with a /context-
              style hover: real used/window fill + lifetime token split (per-
              category breakdown reserved — not instrumented yet). */}
          {context > 0 && (
            <ContextPill
              used={context}
              windowTokens={parseWindow(activeModel?.context)}
              messagesEst={estimateTranscriptTokens(messages)}
              lifetime={{
                input: tokens.input,
                output: tokens.output,
                cacheRead: tokens.cacheRead,
                cacheCreate: tokens.cacheCreate,
              }}
            />
          )}
          {/* Aggregate session spend, rendered in THIS session's cost language
              (story 4.1 / AC6). It used to be `provider !== "codex" &&
              <CostPill total={sessionCost} />` — a HIDE, on the correct
              observation that a ChatGPT-subscription account has no per-token
              billing so its USD figure is always $0.00. That reasoning is right
              about USD and is exactly why tokens are the substitute rather than
              nothing; lib/spend-readout.ts makes the unit a property of the
              projection. A Codex session now shows the token form instead of a
              blank. The CTX pill is unaffected — it is context-window
              occupancy, not spend, and it always rendered for both providers.

              THE CODEX FIGURE IS `tokens.input + tokens.output` — the lifetime
              billable pair, deliberately excluding the two cache fields, which
              are re-presentations of content this session already sent and
              would climb every turn on an idle transcript. Story 4.2's per-run
              anchor must be able to choose the same pair, and it can: they are
              the same two fields `UsageEntry` carries per row. */}
          <CostPill
            readout={spendReadout(provider, {
              usd: sessionCost,
              tokens: tokens.input + tokens.output,
            })}
          />
          {/* Minimize this session to the mini-dock — the dock's natural entry
              point. Only once a real, persisted session id exists to follow. */}
          {dock && sessionId && chatPersisted && (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
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
              <PictureInPicture2Icon />
            </Button>
          )}
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
        items={transcriptItems}
        kinds={SESSION_KINDS}
        // The donor's `isCurrentMessage`: the shell marks only the LAST
        // top-level item live, and the turn renderer derives per-child
        // `isTrailing` from there. On a subagent tab, "the spawn hasn't
        // produced a result yet" stands in for "currently streaming" — exactly
        // what the bucket's own `bucketLive` meant.
        live={activeBucket ? agentStatus(activeBucket.spawn) === "running" : busy}
        empty={emptyState}
        // Durable in-stream loom record (replaces the banner): a compact row
        // per lifecycle transition — started/parked/resumed/ready — carrying
        // the title, short id, and a god-view link. Scrolls away with
        // history; the live pill in the bar is the at-a-glance status.
        //
        // It rides `trailing` rather than the item list on purpose: the shell
        // marks the LAST top-level item live, so an item appended after the
        // streaming turn would silently steal its liveness and the trailing
        // tool group would stop auto-opening mid-turn.
        trailing={
          !activeBucket && loomEvents.length > 0 ? (
            <div className="mx-auto flex w-full max-w-7xl flex-col gap-2 pt-3">
              {loomEvents.map((r) => (
                <InlineLoomRow
                  key={r.id}
                  row={r}
                  onDismiss={() =>
                    setLoomEvents((prev) => prev.filter((x) => x.id !== r.id))
                  }
                />
              ))}
            </div>
          ) : undefined
        }
        rail={
          railAgents.length > 0 ? (
            <SubagentRail
              agents={railAgents}
              activeId={activeTab}
              onSelect={setActiveTab}
              collapsed={railCollapsed}
              onToggle={() => setRailCollapsed((v) => !v)}
              sessionLabel={title}
              mainNeedsAttention={mainNeedsAttention}
            />
          ) : undefined
        }
        composer={
          /* Composer matches the transcript's reading column — same mx-auto
              max-w-7xl the Message wrapper uses, so the input aligns with the
              messages instead of spanning the whole pane. */
          <div className="relative mx-auto w-full max-w-7xl px-4 pb-4">
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
            {messageQueue.length > 0 && (
              <div className="mb-2 space-y-1.5 rounded-xl border border-primary/25 bg-primary/[0.04] p-2">
                <div className="flex items-center justify-between px-1.5 pt-0.5">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    Queued · sends in order
                  </span>
                  <span className="rounded-full bg-primary/15 px-1.5 text-[10px] font-medium text-primary">
                    {messageQueue.length}
                  </span>
                </div>
                {messageQueue.map((m, i) => (
                  <QueueChip
                    key={m.id}
                    index={i + 1}
                    text={m.text}
                    editing={editingQueueId === m.id}
                    onEdit={() => setEditingQueueId(m.id)}
                    onCommit={(v) => {
                      setMessageQueue((q) => q.map((x) => (x.id === m.id ? { ...x, text: v } : x)));
                      setEditingQueueId(null);
                    }}
                    onRemove={() => setMessageQueue((q) => q.filter((x) => x.id !== m.id))}
                  />
                ))}
              </div>
            )}
            <PromptInput onSubmit={handleSubmit}>
              <PromptInputBody>
                <PromptInputTextarea
                  className="min-h-10"
                  placeholder={
                    busy
                      ? "Agent is working — Enter queues a message…"
                      : `Ask about ${project}… ("/" for commands)`
                  }
                  onKeyDown={handleComposerKeyDown}
                  onChange={() => setMenuDismissed(false)}
                />
              </PromptInputBody>
              <PromptInputFooter className="flex-wrap">
                <PromptInputTools className="flex-wrap">
                  {/* Agent selector — first in the bar, per spec: it's the thing
                      that determines what everything to its right even means.
                      Provider/account are choosable only pre-session (an existing
                      chat's resume transcript is tied to one account's config
                      dir — same rule the account picker enforced before this
                      bar existed), so once a turn has run we swap to a static,
                      non-interactive badge instead of hiding it outright — the
                      bar should still read as provider-aware after the lock. */}
                  {sessionId === null && !busy ? (
                    <Select value={provider} onValueChange={(v) => v && selectProvider(v as Provider)}>
                      <SelectTrigger className="h-8 w-[118px] text-xs" size="sm">
                        <SelectValue>
                          <span className="flex items-center gap-1.5">
                            <ProviderIcon provider={provider} />
                            {PROVIDER_LABEL[provider]}
                          </span>
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent className="w-[min(180px,calc(100vw-2rem))]">
                        {(["claude", "codex"] as const).map((p) => (
                          <SelectItem key={p} value={p} className="py-2">
                            <span className="flex items-center gap-1.5">
                              <ProviderIcon provider={p} />
                              <span className="font-medium">{PROVIDER_LABEL[p]}</span>
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <span className="flex h-8 items-center gap-1.5 rounded-md border border-input px-2.5 text-xs text-muted-foreground">
                      <ProviderIcon provider={provider} />
                      {PROVIDER_LABEL[provider]}
                    </span>
                  )}
                  {/* Secondary account picker — only when the selected provider
                      actually has more than one account to choose between; a
                      single-account provider is already fully resolved by the
                      agent selector above. */}
                  {sessionId === null && !busy && providerAccounts.length > 1 && (
                    <Select
                      value={activeAccount}
                      onValueChange={(v) => v && setActiveAccount(v)}
                    >
                      <SelectTrigger className="h-8 w-[140px] text-xs" size="sm">
                        <SelectValue>
                          <span className="flex items-center gap-1.5">
                            <UserRoundIcon className="size-3" />
                            {activeAccount}
                          </span>
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent className="w-[min(220px,calc(100vw-2rem))]">
                        {providerAccounts.map((a) => (
                          <SelectItem key={a.name} value={a.name}>
                            <div className="flex w-full min-w-0 items-center gap-1.5 whitespace-normal">
                              <span className="truncate">{a.name}</span>
                              {a.displayTier && (
                                <Badge variant="outline" className="ml-auto shrink-0 px-1 py-0 text-[10px]">
                                  {a.displayTier}
                                </Badge>
                              )}
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  {/* Permission (Claude) / approval (Codex) — same styled
                      label+description row idiom either way. Codex's now drives
                      an interactive approval preset (sandbox + approvalPolicy)
                      since the app-server can prompt mid-turn. */}
                  {provider === "codex" ? (
                    <Select
                      value={
                        CODEX_APPROVAL_PRESETS.find(
                          (p) => p.sandbox === sandbox && p.approvalPolicy === approvalPolicy,
                        )?.id ?? DEFAULT_CODEX_APPROVAL_ID
                      }
                      onValueChange={(v) => {
                        const preset = CODEX_APPROVAL_PRESETS.find((p) => p.id === v);
                        if (!preset) return;
                        setSandbox(preset.sandbox);
                        setApprovalPolicy(preset.approvalPolicy);
                      }}
                    >
                      <SelectTrigger className="h-8 w-[130px] text-xs" size="sm">
                        <SelectValue>
                          {CODEX_APPROVAL_PRESETS.find(
                            (p) => p.sandbox === sandbox && p.approvalPolicy === approvalPolicy,
                          )?.label ?? "Approval"}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent className="w-[min(260px,calc(100vw-2rem))]">
                        {CODEX_APPROVAL_PRESETS.map((p) => (
                          <SelectItem key={p.id} value={p.id} className="py-2">
                            <div className="flex w-full min-w-0 flex-col gap-0.5 whitespace-normal">
                              <span className="font-medium">{p.label}</span>
                              <span className="text-xs text-muted-foreground">{p.blurb}</span>
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    /* 1.2 — the Claude config trio (permission · model · effort)
                       collapses into one chip + settings popover. Provider and
                       account stay as their own pre-session controls above. */
                    <ComposerSettings
                      project={project}
                      open={settingsOpen}
                      onOpenChange={setSettingsOpen}
                      model={model}
                      setModel={setModel}
                      effort={effort}
                      setEffort={setEffort}
                      permissionMode={permissionMode}
                      setPermissionMode={setPermissionMode}
                      modelOptions={modelOptions}
                      effortOptions={effortOptions}
                      permissionOptions={PERMISSION_MODE_OPTIONS}
                    />
                  )}
                  {/* Codex keeps the explicit model + effort selects — its collapse
                      isn't part of the 1.2 redesign (the popover is Claude-shaped:
                      a Claude badge, Claude permission language). */}
                  {provider === "codex" && (
                    <>
                  <Select value={model} onValueChange={(v) => v && setModel(v)}>
                    <SelectTrigger className="h-8 w-[170px] text-xs" size="sm">
                      <SelectValue>
                        <span className="flex items-center gap-1.5">
                          {activeModel?.name ?? model}
                          {activeModel && (
                            <Badge variant="outline" className="px-1 py-0 text-[10px]">
                              {activeModel.context}
                            </Badge>
                          )}
                        </span>
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent className="w-[min(340px,calc(100vw-2rem))]">
                      {modelOptions.map((m) => (
                        <SelectItem key={m.id} value={m.id} className="py-2">
                          <div className="flex w-full min-w-0 flex-col gap-0.5 whitespace-normal">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-medium">{m.name}</span>
                              <Badge variant="outline" className="px-1 py-0 text-[10px]">
                                {m.context} ctx
                              </Badge>
                              <Badge variant="outline" className="px-1 py-0 text-[10px]">
                                {m.maxOutput} out
                              </Badge>
                              {m.inputPerMTok > 0 || m.outputPerMTok > 0 ? (
                                <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                                  ${m.inputPerMTok}/{m.outputPerMTok} MTok
                                </span>
                              ) : null}
                            </div>
                            <span className="text-xs text-muted-foreground">{m.blurb}</span>
                            {m.note && (
                              <span className="text-[10px] text-muted-foreground/70">{m.note}</span>
                            )}
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {/* "default" omits `effort` from the POST body entirely — the
                      model/SDK picks its own. Editable on every turn, like model
                      above (not locked to pre-session like the account picker
                      above): route.ts persists whatever was last sent, same as
                      model, and restores it on resume via initialChat.effort.
                      Option set switches with the provider — Codex's reasoning
                      effort tiers aren't identical to Claude's (no "max", has
                      "minimal"). */}
                  <Select value={effort} onValueChange={(v) => v && setEffort(v)}>
                    <SelectTrigger className="h-8 w-[110px] text-xs" size="sm">
                      <SelectValue>
                        {effort === "default"
                          ? "Effort"
                          : (effortOptions.find((e) => e.id === effort)?.label ?? effort)}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent className="w-[min(280px,calc(100vw-2rem))]">
                      <SelectItem value="default" className="py-2">
                        <div className="flex w-full min-w-0 flex-col gap-0.5 whitespace-normal">
                          <span className="font-medium">Default</span>
                          <span className="text-xs text-muted-foreground">
                            Let the model choose its own effort.
                          </span>
                        </div>
                      </SelectItem>
                      {effortOptions.map((e) => (
                        <SelectItem key={e.id} value={e.id} className="py-2">
                          <div className="flex w-full min-w-0 flex-col gap-0.5 whitespace-normal">
                            <span className="font-medium">{e.label}</span>
                            <span className="text-xs text-muted-foreground">{e.blurb}</span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                    </>
                  )}
                </PromptInputTools>
                {/* ml-auto/self-end: when the tools row wraps onto multiple lines
                    on a narrow composer, the submit button stays pinned to the
                    bottom-right instead of drifting to wherever justify-between
                    would otherwise place a lone wrapped item. */}
                <PromptInputSubmit
                  className="ml-auto shrink-0 self-end"
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
                        body: JSON.stringify(rid ? { runId: rid } : { sessionId }),
                      }).catch(() => {});
                    }
                    abortRef.current?.abort();
                  }}
                />
              </PromptInputFooter>
            </PromptInput>
          </div>
        }
      />
    </>
  );
}
