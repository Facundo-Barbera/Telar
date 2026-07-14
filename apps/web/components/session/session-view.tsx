"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import Link from "next/link";
import {
  ArrowLeftIcon,
  BellIcon,
  BotIcon,
  CheckIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  PencilIcon,
  PictureInPicture2Icon,
  ShieldAlertIcon,
  TriangleAlertIcon,
  UserRoundIcon,
  WorkflowIcon,
  XIcon,
} from "lucide-react";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { StatusDot, type AgentTab } from "@/components/session/agent-tabs";
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
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputProvider,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputController,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import { Shimmer } from "@/components/ai-elements/shimmer";
import {
  ToolStepRow,
  stepPreview,
  type AgentInfo,
  type ToolPart,
} from "@/components/session/tool-step";
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
import { fmtCost, fmtTokens, shortId } from "@/lib/format";
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
import { useAccounts } from "@/lib/use-accounts";
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

// AgentInfo / ToolPart now live in components/session/tool-step.tsx (shared
// with the loom agent-view transcript); imported above.

// The transcript shape the store persists (see lib/store.ts). Text parts stream
// with a `done` flag on the client; persisted parts are always finished. Tool
// parts carry id/input/output/isError as optional so every old persisted chat
// (name-only tool parts) still loads without a migration. `parentId`/`agent`
// are newer still and equally optional for the same reason: an old chat's
// parts simply lack them, which reads as "main thread, not a spawn" — exactly
// the right default.
type StorePart =
  | { type: "text"; text: string; parentId?: string }
  | {
      type: "tool";
      name: string;
      id?: string;
      input?: Record<string, unknown>;
      output?: string;
      isError?: boolean;
      interrupted?: boolean;
      parentId?: string;
      agent?: AgentInfo;
      taskStatus?: "completed" | "failed" | "stopped";
      // Set when auto/acceptEdits mode hard-blocked this call without an
      // interactive prompt (route.ts's "permission_denied" handling).
      autoDenied?: boolean;
    };
type StoreMessage = { role: "user" | "assistant"; parts: StorePart[] };

// Permission cards are live-stream-only artifacts (resolved by "permission_result"
// or the server's 120s timeout deny) — they never round-trip through the store,
// so StorePart above stays exactly as persisted. They also never carry a
// parentId: canUseTool gets no parent attribution from the SDK, so every
// permission card — regardless of which subagent's tool call triggered it —
// renders on the Main thread (a documented v1 limitation, not a bug).
//
// "thinking" parts are the same kind of live-only artifact: the server emits
// "thinking"/"thinking_delta" purely as SSE (see route.ts's stream_event
// handling), never persisting narration text into a store Part, so there's
// nothing to seed on reload — a thinking block only ever exists while its
// turn is actually streaming.
type Part =
  | { type: "text"; text: string; done: boolean; parentId?: string }
  | { type: "thinking"; text: string; done: boolean; parentId?: string }
  | ToolPart
  | {
      type: "permission";
      id: string;
      toolName: string;
      input: Record<string, unknown>;
      rule: string;
      // Narrow -> broad rule choices offered for this call (ruleOptionsFor,
      // server-side) — the user, not a heuristic, picks how wide an "Always
      // allow" persists. `rule` above is always one of these (the default,
      // prefix, option).
      ruleOptions: Array<{ rule: string; label: string }>;
      status: "pending" | "allowed" | "denied";
    };
type ChatMessage = { id: string; role: "user" | "assistant"; parts: Part[] };
type Status = "ready" | "submitted" | "streaming" | "error";

// Exported: apps/web/lib/gallery-fixtures (kept dev design-review surface) uses
// this shape directly. Type-only export, zero logic change.
export type PermissionPart = Extract<Part, { type: "permission" }>;

// A part's parentId, normalized to `undefined` for the main thread (permission
// parts don't have the field at all — they're always main). Centralizing this
// lookup means every routing decision (grouping, streaming merge, bucketing)
// agrees on what "main thread" means.
const parentOf = (p: Part): string | undefined =>
  p.type === "permission" ? undefined : p.parentId;

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

// One spawned subagent's own transcript, reconstructed identically whether
// it's arriving live (SSE events tagged with `parent`) or reconstructed from
// persisted parts (tagged with `parentId`) — see agentBuckets below. `spawn`
// is the enriched tool part itself (id, agent info, and — once the subagent
// finishes — its output/isError), `parts` is everything that part spawned.
type AgentBucket = { id: string; spawn: ToolPart; parts: Part[] };

// Label priority per spec: an explicit run name, else a clipped slice of the
// free-form description, else the agent type, else a generic fallback. The
// description comes before the type because the type is shared across every
// spawn of the same subagent — several concurrent "general-purpose" spawns
// would otherwise all render the identical, useless tab label — while the
// description is supplied fresh per spawn and is what actually distinguishes
// them. Array.from/codePoints mirrors stepPreview's astral-safe slicing.
function agentLabel(agent: AgentInfo): string {
  if (agent.name) return agent.name;
  const description = agent.description.trim();
  if (description) {
    const codePoints = Array.from(description);
    return codePoints.length > 24 ? `${codePoints.slice(0, 24).join("")}…` : codePoints.join("");
  }
  if (agent.type) return agent.type;
  return "subagent";
}

function agentStatus(spawn: ToolPart): AgentTab["status"] {
  // taskStatus (from the SDK's task_notification, route.ts) is the
  // authoritative completion signal for a backgrounded subagent and takes
  // priority when present. Subagents run in the background by default, so
  // spawn.output/isError below reflect only the near-instant "launched" ack
  // — NOT the subagent's real result — and would otherwise flip this tab to
  // "done" while the subagent is still actually working. Absent taskStatus
  // (a synchronous subagent, or an SDK build that never sends it) falls
  // through to the old output-based read.
  if (spawn.taskStatus) {
    return spawn.taskStatus === "completed" ? "done" : "error";
  }
  if (spawn.output === undefined) {
    // A spawn that never got its tool_result because the whole turn ended
    // abnormally (Stop clicked, mid-turn error, dropped connection — see
    // route.ts's teardown) is not "still running": the turn is over, and
    // `running`'s shimmer would otherwise animate forever for a dead tab.
    // AgentTab's status vocabulary is only three states (spec), so this
    // folds into the destructive tint rather than adding a fourth.
    return spawn.interrupted ? "error" : "running";
  }
  return spawn.isError ? "error" : "done";
}

// Newer Claude Code builds run subagents asynchronously: the spawn tool
// call's tool_result lands almost instantly and is just an internal launch
// acknowledgement ("Async agent launched successfully", plus bookkeeping —
// agentId/output_file/"Do NOT Read or tail" — meant for the orchestrating
// agent, not a human). It is NOT the subagent's real result. The subagent's
// actual output already streams into its own tab as ordinary assistant
// messages (bucket.parts), so rendering this ack text in the "Result" block
// would just leak Claude's internal plumbing into the UI. Matched on the
// literal launch phrase, or (in case wording drifts) the "internal
// metadata" + "agentId" combination that's specific to this ack and not
// something a genuine subagent result would ever contain together.
function isAsyncLaunchAck(text: string): boolean {
  if (text.includes("Async agent launched successfully")) return true;
  return text.includes("internal metadata") && text.includes("agentId");
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
  // top of these, but without seeding from the persisted chat record a
  // reload of an existing session would show $0.00 / 0 tokens despite the
  // store already holding the true accumulated totals (see the sessionCost
  // useState below).
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
  role?: "planner" | "steerer";
};

const refresh = () => window.dispatchEvent(new Event("telar:refresh"));

// Reads an SSE stream frame-by-frame: accumulate decoded chunks, split on the
// blank-line record separator, parse each record's `event:`/`data:` lines, and
// hand (event, payload) to `onEvent`. Shared by the POST send() path and the
// §1b reconnect subscriber; resolves when the reader is exhausted.
async function consumeSSE(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onEvent: (event: string, payload: any) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      let event = "";
      let data = "";
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        if (line.startsWith("data: ")) data = line.slice(6);
      }
      if (!event || !data) continue;
      const payload = JSON.parse(data);
      onEvent(event, payload);
    }
  }
}

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

// Best-effort salient preview of a tool call's input: the path/command a human
// actually cares about, or a capped JSON dump for anything else.
function permissionPreview(input: Record<string, unknown>): string {
  if (typeof input.file_path === "string") return input.file_path;
  if (typeof input.command === "string") return input.command;
  const json = JSON.stringify(input);
  return json.length > 200 ? `${json.slice(0, 200)}…` : json;
}

// Exported: apps/web/lib/gallery-fixtures (kept dev design-review surface)
// renders this in isolation. Zero logic/JSX change.
export function PermissionCard({
  part,
  onRespond,
}: {
  part: Extract<Part, { type: "permission" }>;
  onRespond: (id: string, behavior: "allow" | "deny", always: boolean, rule?: string) => void;
}) {
  // The user picks how broad an "Always allow" is — never a heuristic. Plain
  // click on "Always allow" uses the default (prefix) option, `part.rule`;
  // the caret reveals the other offered options (narrower exact match, and
  // — unless the command is dangerous — a broader command-wide rule) as a
  // tiny inline list, not a new overlay/select (no programmatic .focus()
  // anywhere here — WebKit 26.x).
  const [showOptions, setShowOptions] = useState(false);
  const otherOptions = part.ruleOptions.filter((o) => o.rule !== part.rule);

  return (
    <div className="flex w-full flex-col gap-2 rounded-lg border bg-muted/40 p-3 text-xs">
      <div className="flex items-center gap-1.5 font-medium">
        <ShieldAlertIcon className="size-3.5 text-muted-foreground" />
        {part.toolName}
      </div>
      <div className="overflow-x-auto rounded-md bg-background/60 px-2 py-1 font-mono text-[11px] text-muted-foreground">
        <span className="whitespace-pre-wrap break-all">
          {permissionPreview(part.input)}
        </span>
      </div>
      <div className="text-[10px] text-muted-foreground">
        rule <span className="font-mono text-foreground/80">{part.rule}</span>
      </div>
      {part.status === "pending" ? (
        <div className="flex flex-col gap-1.5 pt-0.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => onRespond(part.id, "allow", false)}
            >
              Allow once
            </Button>
            <div className="flex items-stretch overflow-hidden rounded-md border">
              <Button
                type="button"
                size="xs"
                variant="outline"
                className="h-auto flex-col items-start gap-0 rounded-none border-0 py-1"
                onClick={() => onRespond(part.id, "allow", true)}
              >
                <span>Always allow</span>
                <span className="font-mono text-[9px] font-normal text-muted-foreground">
                  {part.rule}
                </span>
              </Button>
              {otherOptions.length > 0 && (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  className="rounded-none border-0 border-l px-1"
                  aria-label={showOptions ? "Hide other rule choices" : "More rule choices"}
                  onClick={() => setShowOptions((s) => !s)}
                >
                  <ChevronRightIcon
                    className={cn("size-3 transition-transform", showOptions && "rotate-90")}
                  />
                </Button>
              )}
            </div>
            <Button
              type="button"
              size="xs"
              variant="destructive"
              onClick={() => onRespond(part.id, "deny", false)}
            >
              Deny
            </Button>
          </div>
          {showOptions && otherOptions.length > 0 && (
            <div className="flex flex-col gap-1 rounded-md border bg-background/40 p-1.5">
              {otherOptions.map((o) => (
                <Button
                  key={o.rule}
                  type="button"
                  size="xs"
                  variant="ghost"
                  className="h-auto w-fit flex-col items-start gap-0 px-1.5 py-1"
                  onClick={() => onRespond(part.id, "allow", true, o.rule)}
                >
                  <span>{o.label}</span>
                  <span className="font-mono text-[9px] font-normal text-muted-foreground">
                    {o.rule}
                  </span>
                </Button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <Badge
          variant={part.status === "allowed" ? "secondary" : "destructive"}
          className="w-fit text-[10px]"
        >
          {part.status === "allowed" ? "Allowed" : "Denied"}
        </Badge>
      )}
    </div>
  );
}

// Interleaved narration, rendered live-only (see the Part union comment —
// there's no persisted counterpart). While the block is still streaming
// (`!part.done`) it's a growing muted italic block, matching the shimmer's
// "something is happening" register without competing with real answer
// text. Once the block ends it collapses to a single "✻ Thought" row,
// click to expand — same disclosure idiom as ToolStepRow, just without a
// chevron rotate on the live (never-collapsed) state. No fade-from-zero
// keyframes anywhere here (WebKit 26.x) — only a transform transition on
// the chevron, same as every other expand/collapse row in this file.
function ThinkingRow({
  part,
  open,
  onToggle,
}: {
  part: Extract<Part, { type: "thinking" }>;
  open: boolean;
  onToggle: () => void;
}) {
  // Suppression rule (1.3): whitespace-only content renders NOTHING, so an empty
  // "✻ Thought" collapsible is structurally impossible — this is the durable fix
  // for the reload case where the server persists no thinking text.
  if (!part.text.trim()) return null;

  if (!part.done) {
    // Live stream: a growing muted italic block with a ✻ + shimmering "Thinking"
    // header and a blinking caret — the "something is happening" register.
    return (
      <div className="rounded-md border border-dashed bg-muted/10 px-2.5 py-2">
        <div className="mb-1 flex items-center gap-1.5">
          <span aria-hidden className="text-xs">
            ✻
          </span>
          <Shimmer as="span" className="text-[11px] font-medium">
            Thinking
          </Shimmer>
        </div>
        <p className="text-xs italic leading-relaxed whitespace-pre-wrap text-muted-foreground">
          {part.text}
          <span className="ml-0.5 inline-block h-3 w-[2px] translate-y-0.5 animate-pulse bg-muted-foreground/70 align-middle" />
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-md">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs text-muted-foreground hover:bg-muted/60"
      >
        <span aria-hidden className="shrink-0">✻</span>
        <span className="min-w-0 flex-1 truncate italic">Thought</span>
        <ChevronRightIcon
          className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")}
        />
      </button>
      {open && (
        <p className="mx-1.5 mb-1.5 rounded-md bg-muted/10 p-2 text-[11px] whitespace-pre-wrap italic text-muted-foreground">
          {part.text}
        </p>
      )}
    </div>
  );
}

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

// One rendered chunk of an assistant message's parts: standalone text,
// standalone permission card (always interactive, so it always breaks a
// tool-step group), or a run of consecutive tool parts collapsed into one
// group. Keys are stable across re-renders — the group key doubles as the
// identity used to remember a user's manual expand/collapse override.
type RenderItem =
  | { kind: "text"; key: string; part: Extract<Part, { type: "text" }> }
  | { kind: "thinking"; key: string; part: Extract<Part, { type: "thinking" }> }
  | { kind: "permission"; key: string; part: Extract<Part, { type: "permission" }> }
  | { kind: "tools"; key: string; parts: ToolPart[] };

function groupParts(messageId: string, parts: Part[]): RenderItem[] {
  const items: RenderItem[] = [];
  parts.forEach((part, idx) => {
    if (part.type === "tool") {
      const last = items[items.length - 1];
      if (last?.kind === "tools") {
        last.parts.push(part);
      } else {
        // A tool_use id is unique for the life of the id, but old persisted
        // parts predate the id field — fall back to a message-scoped index,
        // stable because parts only ever get appended to, never reordered.
        items.push({ kind: "tools", key: part.id ?? `${messageId}:${idx}`, parts: [part] });
      }
    } else if (part.type === "text") {
      items.push({ kind: "text", key: `${messageId}:${idx}`, part });
    } else if (part.type === "thinking") {
      items.push({ kind: "thinking", key: `${messageId}:${idx}`, part });
    } else {
      items.push({ kind: "permission", key: `${messageId}:${idx}`, part });
    }
  });
  return items;
}

// A spawn step's row inside the main thread's B.3 groups — an "agent chip"
// rather than a generic tool row. Clicking it only switches the active tab
// (state, not focus/scroll): the raw input/output detail a normal tool row
// would expand inline lives in the subagent's own tab instead, so there's
// nothing to expand here.
function AgentStepRow({
  part,
  stepCount,
  onSelect,
}: {
  part: ToolPart & { agent: AgentInfo };
  stepCount: number;
  onSelect: () => void;
}) {
  const status = agentStatus(part);
  const label = agentLabel(part.agent);
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-muted/60",
        status === "error" && "bg-destructive/10",
      )}
    >
      <BotIcon
        className={cn("size-3.5 shrink-0", status === "error" ? "text-destructive" : "text-muted-foreground")}
      />
      {status === "running" ? (
        <Shimmer as="span" className="min-w-0 flex-1 truncate text-left text-xs">
          {label}
        </Shimmer>
      ) : (
        <span className={cn("min-w-0 flex-1 truncate font-medium", status === "error" && "text-destructive")}>
          {label}
        </span>
      )}
      <span className="shrink-0 text-[10px] text-muted-foreground">
        {stepCount} step{stepCount === 1 ? "" : "s"}
      </span>
      <StatusDot status={status} />
      <ChevronRightIcon className="ml-0.5 size-3 shrink-0 text-muted-foreground" />
    </button>
  );
}

// The group header: step count + compact tool tally, e.g.
// "16 steps · Bash ×12 · Read ×2 · Glob ×2" — order follows first appearance.
// `agentSteps`/`onSelectAgent` are only ever passed for main-thread groups —
// a subagent's own tab renders its nested tool calls with plain ToolStepRows,
// since v1 doesn't track sub-subagents (see AgentBucket).
function ToolStepGroup({
  toolParts,
  open,
  onToggle,
  live,
  rowOpen,
  onToggleRow,
  agentSteps,
  onSelectAgent,
}: {
  toolParts: ToolPart[];
  open: boolean;
  onToggle: () => void;
  live: boolean;
  rowOpen: (key: string) => boolean;
  onToggleRow: (key: string) => void;
  agentSteps?: (id: string) => number;
  onSelectAgent?: (id: string) => void;
}) {
  const tally: Array<[string, number]> = [];
  const indexByName = new Map<string, number>();
  for (const p of toolParts) {
    const i = indexByName.get(p.name);
    if (i === undefined) {
      indexByName.set(p.name, tally.length);
      tally.push([p.name, 1]);
    } else {
      tally[i][1] += 1;
    }
  }
  // Surfaced even while collapsed — otherwise a group that just finished
  // showing a failing/cancelled step visually disappears the instant the
  // turn ends and the group auto-collapses back to its default.
  const hasError = toolParts.some((p) => p.isError);
  const hasInterrupted =
    !hasError && toolParts.some((p) => p.interrupted && p.output === undefined);

  return (
    <div
      className={cn(
        "flex flex-col gap-0.5 rounded-lg border bg-muted/20 text-xs",
        // Collapsed groups hug their label (a short "1 step · Bash ×1" in a
        // full-width bar reads as empty/heavy); only expand to full width when
        // open, so the rows inside have room.
        open ? "w-full" : "w-fit",
        hasError && "border-destructive/40",
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-lg px-2 py-1 text-left hover:bg-muted/40"
      >
        <ChevronRightIcon
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        {(hasError || hasInterrupted) && (
          <TriangleAlertIcon
            className={cn(
              "size-3 shrink-0",
              hasError ? "text-destructive" : "text-muted-foreground",
            )}
          />
        )}
        <span className={cn("shrink-0", hasError ? "text-destructive" : "text-muted-foreground")}>
          {toolParts.length} step{toolParts.length === 1 ? "" : "s"}
        </span>
        <span className="shrink-0 text-muted-foreground/50">·</span>
        <span className="min-w-0 truncate font-mono text-muted-foreground">
          {tally.map(([name, count]) => `${name} ×${count}`).join(" · ")}
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-0.5 px-1.5 pb-1.5">
          {toolParts.map((p, i) => {
            const rowKey = p.id ?? String(i);
            if (p.agent && p.id && onSelectAgent) {
              return (
                <AgentStepRow
                  key={rowKey}
                  part={p as ToolPart & { agent: AgentInfo }}
                  stepCount={agentSteps?.(p.id) ?? 0}
                  onSelect={() => onSelectAgent(p.id!)}
                />
              );
            }
            return (
              <ToolStepRow
                key={rowKey}
                part={p}
                running={live && p.output === undefined && !p.isError}
                open={rowOpen(rowKey)}
                onToggle={() => onToggleRow(rowKey)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
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
  // Seeded from the persisted chat record (reload) — live "done" events add
  // on top. Without this seed, reloading an existing session would show
  // $0.00 / 0 tokens despite the store already holding the true accumulated
  // totals (the bug this seed fixes).
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
  // Synthetic "[watcher] …" turns waiting for the composer to go idle before
  // they dispatch through send() (never mid-turn — the busy guard forbids it).
  const [injectionQueue, setInjectionQueue] = useState<
    { id: string; text: string }[]
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

  // Manual expand/collapse for tool-step groups, keyed by group id (see
  // groupParts). Absent means "use the automatic default": collapsed once a
  // turn is finished, expanded for the trailing group of a message that's
  // still streaming.
  const [groupOverrides, setGroupOverrides] = useState<Record<string, boolean>>({});
  // Per-row expand state within a tool-step group, keyed by `${group key}:${tool
  // id}` — lifted here (rather than local state in ToolStepRow) so it survives
  // the row unmounting when its group auto-collapses (see ToolStepGroup).
  const [rowOverrides, setRowOverrides] = useState<Record<string, boolean>>({});
  // Expand/collapse for a finished ("✻ Thought") thinking row, keyed by its
  // own part key — same lift-to-parent reasoning as rowOverrides above.
  const [thinkingOpen, setThinkingOpen] = useState<Record<string, boolean>>({});
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
  // treatment or a tab of its own; see AgentBucket and renderAgentBucket
  // (which doesn't pass onSelectAgent/agentSteps into its ToolStepGroup).
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
                  // cockpit. (An escalation session is ephemeral and reattaches
                  // only via an explicit re-click, so it has no seed to restore.)
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
                setSessionCost((c) => c + (payload.costUsd ?? 0));
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
    void send(next.text);
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
    if (sdkSlashCommands === null) return projectCommands;
    const known = new Set(sdkSlashCommands);
    return projectCommands.filter((c) => known.has(c.name));
  }, [projectCommands, sdkSlashCommands]);

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
    (filteredCommands.length > 0 || projectCommands.length === 0);

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

  // A subagent's own tab: same rendering path as Main (groupParts → text /
  // ToolStepGroup), just over the bucket's parts instead of a message's, plus
  // a header (agent type + spawn description) and the spawn's own tool_result
  // rendered at the end as the run's result. `live` here mirrors Main's
  // `isCurrentMessage && isTrailing` — "the spawn hasn't produced a result
  // yet" stands in for "this is the message currently being streamed into".
  function renderAgentBucket(bucket: AgentBucket) {
    const agent = bucket.spawn.agent ?? { type: null, description: "" };
    const status = agentStatus(bucket.spawn);
    const bucketLive = status === "running";
    const items = groupParts(bucket.id, bucket.parts);
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
    return (
      // Same reading column as the main transcript's <Message> wrapper, so a
      // subagent tab lines up with Main instead of spanning the whole pane.
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-3 text-sm">
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

        {/* Empty-while-starting is designed, not blank: the tab exists the
            instant the spawn tool call arrives, often before the subagent has
            produced anything yet. A zero-parts "error" bucket (interrupted or
            failed before it ever forwarded any activity) gets its own
            destructive-tinted message too — otherwise it's indistinguishable
            from a run that simply, genuinely finished with nothing to show,
            and the tab strip's small status dot is the only hint anything
            went wrong. */}
        {bucket.parts.length === 0 &&
          (bucketLive ? (
            <Shimmer className="text-sm">Spinning up…</Shimmer>
          ) : status === "error" ? (
            <p className="flex items-center gap-1.5 text-sm text-destructive">
              <TriangleAlertIcon className="size-3.5 shrink-0" />
              {bucket.spawn.interrupted && bucket.spawn.output === undefined
                ? "Interrupted before this subagent produced any output."
                : "This subagent's run failed before producing any output."}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              No subagent activity was recorded for this run.
            </p>
          ))}

        {items.map((item, i) => {
          if (item.kind === "text") {
            return <MessageResponse key={item.key}>{item.part.text}</MessageResponse>;
          }
          if (item.kind === "permission") {
            // Unreachable in practice — permission parts never carry a
            // parentId (see the Part union comment) — kept only so this
            // mirrors Main's exhaustive RenderItem switch exactly.
            return null;
          }
          if (item.kind === "thinking") {
            return (
              <ThinkingRow
                key={item.key}
                part={item.part}
                open={thinkingOpen[item.key] ?? false}
                onToggle={() =>
                  setThinkingOpen((prev) => ({ ...prev, [item.key]: !prev[item.key] }))
                }
              />
            );
          }
          const isTrailing = items.slice(i + 1).every((it) => it.kind === "permission");
          const live = bucketLive && isTrailing;
          const open = groupOverrides[item.key] ?? live;
          return (
            <ToolStepGroup
              key={item.key}
              toolParts={item.parts}
              open={open}
              live={live}
              onToggle={() => setGroupOverrides((prev) => ({ ...prev, [item.key]: !open }))}
              rowOpen={(key) => rowOverrides[`${item.key}:${key}`] ?? false}
              onToggleRow={(key) =>
                setRowOverrides((prev) => {
                  const k = `${item.key}:${key}`;
                  return { ...prev, [k]: !(prev[k] ?? false) };
                })
              }
            />
          );
        })}

        {bucket.spawn.output !== undefined &&
          (isAsyncLaunchAck(bucket.spawn.output) ? (
            // The spawn's tool_result is just the async launch ack, not the
            // subagent's real result (see isAsyncLaunchAck) — the subagent's
            // actual output already rendered above via bucket.parts. Swap
            // the raw metadata dump for a one-line status instead of hiding
            // it outright, so the bucket doesn't end on an unexplained cliff.
            <p className="text-xs text-muted-foreground">
              {bucketLive ? "Running…" : status === "error" ? "Failed" : "Completed"}
            </p>
          ) : (
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
          ))}
      </div>
    );
  }

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
          {/* Aggregate session cost with a hover breakdown (real grand total;
              per-sub-agent split reserved — spend isn't attributed yet). */}
          <CostPill total={sessionCost} />
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

      {/* The conversation column with the sub-agents RAIL docked on its right
          (replaces the old top tab strip). The rail lists spawns as rich cards —
          running up top with a live activity line, failures pinned in
          destructive, completions folded into a compact "Done" section — with a
          pinned Main anchor always one click back. It only appears once at least
          one sub-agent has spawned. The composer below stays full-width. */}
      <div className="flex min-h-0 flex-1">
      <Conversation className="min-w-0 flex-1">
        {/* Full-width transcript (explicit user request — no inner padding):
            no max-w-3xl/mx-auto centering, no horizontal padding. Vertical
            padding (py-4) and the scroll behavior are unchanged. Individual
            code blocks / tool detail panels still scroll horizontally within
            themselves (overflow-x-auto — see ToolStepRow), never the page. */}
        <ConversationContent className="px-4">
          {activeBucket ? (
            <div className="mx-auto flex w-full max-w-7xl flex-col gap-3">
              {/* Breadcrumb: names the sub-agent you're viewing and makes the
                  exit unmistakable — the "Main" crumb, the highlighted Main
                  anchor in the rail, and Escape all return. */}
              <SubagentBanner
                label={agentLabel(activeBucket.spawn.agent ?? { type: null, description: "" })}
                status={agentStatus(activeBucket.spawn)}
                onBack={() => setActiveTab("main")}
              />
              {renderAgentBucket(activeBucket)}
            </div>
          ) : messages.length === 0 && planner && !sessionId ? (
            // Agent-first greeting (feature #34): a templated assistant
            // bubble — same Message/MessageContent/MessageResponse
            // primitives the real transcript below uses, so it reads exactly
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
            // reviewing, mirroring the in-flight empty-assistant render below so
            // the hand-off to the streaming proposal is seamless. It never shows
            // static copy the human is expected to answer.
            <Message from="assistant">
              <MessageContent>
                <Shimmer className="text-sm">Reviewing the blocked context…</Shimmer>
              </MessageContent>
            </Message>
          ) : messages.length === 0 ? (
            <ConversationEmptyState
              title={initialRole === "planner" ? "Plan a loom" : "Work in this repo"}
              description={
                initialRole === "planner"
                  ? "Describe what you want built. Once the spec is ready, say “make this real” and this session commits the bundle and starts the loom."
                  : "Ask about the code, plan a change, or make edits directly. Reads run freely; writes and commands ask for your approval — or go automatically in Auto mode."
              }
            />
          ) : (
            messages.map((m) => {
              // The trailing tool-step group of the message currently being
              // streamed into defaults open; every other group (finished
              // turns, or a group a later text/permission part moved past)
              // defaults collapsed. A manual toggle in groupOverrides always
              // wins over this default.
              const isCurrentMessage =
                busy && m.id === messages[messages.length - 1]?.id;
              // Main renders only this message's OWN parts — anything a
              // subagent produced lives in its own tab (see agentBuckets), not
              // interleaved here even though it rode in on the same SSE
              // stream and the same message's parts array.
              const mainParts = m.parts.filter((p) => parentOf(p) === undefined);
              const items = groupParts(m.id, mainParts);
              return (
                <Message from={m.role} key={m.id}>
                  <MessageContent>
                    {mainParts.length === 0 && m.role === "assistant" && busy && (
                      <Shimmer className="text-sm">
                        {thinking ? "Thinking…" : "Weaving…"}
                      </Shimmer>
                    )}
                    {items.map((item, i) => {
                      if (item.kind === "text") {
                        return (
                          <MessageResponse key={item.key}>{item.part.text}</MessageResponse>
                        );
                      }
                      if (item.kind === "permission") {
                        return (
                          <PermissionCard
                            key={item.key}
                            part={item.part}
                            onRespond={respondPermission}
                          />
                        );
                      }
                      if (item.kind === "thinking") {
                        return (
                          <ThinkingRow
                            key={item.key}
                            part={item.part}
                            open={thinkingOpen[item.key] ?? false}
                            onToggle={() =>
                              setThinkingOpen((prev) => ({ ...prev, [item.key]: !prev[item.key] }))
                            }
                          />
                        );
                      }
                      // A pending/just-resolved permission card is not a new
                      // unit of finished work — it's the same blocked tool
                      // call waiting on the user, so a trailing run of
                      // permission items doesn't end this group's liveness.
                      const isTrailing = items
                        .slice(i + 1)
                        .every((it) => it.kind === "permission");
                      const live = isCurrentMessage && isTrailing;
                      const open = groupOverrides[item.key] ?? live;
                      return (
                        <ToolStepGroup
                          key={item.key}
                          toolParts={item.parts}
                          open={open}
                          live={live}
                          onToggle={() =>
                            setGroupOverrides((prev) => ({ ...prev, [item.key]: !open }))
                          }
                          rowOpen={(key) => rowOverrides[`${item.key}:${key}`] ?? false}
                          onToggleRow={(key) =>
                            setRowOverrides((prev) => {
                              const k = `${item.key}:${key}`;
                              return { ...prev, [k]: !(prev[k] ?? false) };
                            })
                          }
                          agentSteps={(id) => agentBucketById.get(id)?.parts.length ?? 0}
                          onSelectAgent={setActiveTab}
                        />
                      );
                    })}
                  </MessageContent>
                </Message>
              );
            })
          )}
          {/* Durable in-stream loom record (replaces the banner): a compact row
              per lifecycle transition — started/parked/resumed/ready — carrying
              the title, short id, and a god-view link. Scrolls away with
              history; the live pill in the bar is the at-a-glance status. */}
          {!activeBucket && loomEvents.length > 0 && (
            <div className="mx-auto flex w-full max-w-7xl flex-col gap-2 pt-3">
              {loomEvents.map((r) => (
                <InlineLoomRow key={r.id} row={r} />
              ))}
            </div>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      {railAgents.length > 0 && (
        <SubagentRail
          agents={railAgents}
          activeId={activeTab}
          onSelect={setActiveTab}
          collapsed={railCollapsed}
          onToggle={() => setRailCollapsed((v) => !v)}
          sessionLabel={title}
          mainNeedsAttention={mainNeedsAttention}
        />
      )}
      </div>

      {/* Composer matches the transcript's reading column — same mx-auto
          max-w-7xl the Message wrapper uses, so the input aligns with the
          messages instead of spanning the whole pane. */}
      <div className="relative mx-auto w-full max-w-7xl px-4 pb-4">
        {slashMenuOpen && (
          <div className="absolute inset-x-4 bottom-full z-10 mb-2 max-h-64 overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10">
            {filteredCommands.length === 0 ? (
              <p className="px-2 py-1.5 text-[11px] text-muted-foreground">
                No commands — add .claude/commands/*.md or skills to this repo.
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
                // stops it (§A.4) — then close the local reader.
                const rid = runIdRef.current;
                if (rid) {
                  void fetch("/api/chat/stop", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ runId: rid }),
                  }).catch(() => {});
                }
                abortRef.current?.abort();
              }}
            />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </>
  );
}
