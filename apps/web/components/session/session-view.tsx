"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeftIcon,
  BotIcon,
  CheckIcon,
  ChevronRightIcon,
  FileTextIcon,
  FolderSearchIcon,
  GlobeIcon,
  ListTodoIcon,
  PencilIcon,
  PlayIcon,
  SearchIcon,
  ShieldAlertIcon,
  TerminalIcon,
  TriangleAlertIcon,
  UserRoundIcon,
  WrenchIcon,
} from "lucide-react";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { AgentTabsStrip, StatusDot, type AgentTab } from "@/components/session/agent-tabs";
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
import { PageHeader } from "@/components/common/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { fmtCost, shortId } from "@/lib/format";
import { DEFAULT_MODEL, MODELS, modelById } from "@/lib/models";
import { cn } from "@/lib/utils";

// Pulled from a spawn tool call's AgentInput (description/prompt/subagent_type/
// name/...) and stashed on that tool part so the tab strip and the B.3 chip
// both have a label without re-deriving it from raw input every render.
type AgentInfo = { type: string | null; description: string; name?: string };

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
    };
type StoreMessage = { role: "user" | "assistant"; parts: StorePart[] };

// Permission cards are live-stream-only artifacts (resolved by "permission_result"
// or the server's 120s timeout deny) — they never round-trip through the store,
// so StorePart above stays exactly as persisted. They also never carry a
// parentId: canUseTool gets no parent attribution from the SDK, so every
// permission card — regardless of which subagent's tool call triggered it —
// renders on the Main thread (a documented v1 limitation, not a bug).
type Part =
  | { type: "text"; text: string; done: boolean; parentId?: string }
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
    }
  | {
      type: "permission";
      id: string;
      toolName: string;
      input: Record<string, unknown>;
      rule: string;
      status: "pending" | "allowed" | "denied";
    };
type ChatMessage = { id: string; role: "user" | "assistant"; parts: Part[] };
type ToolPart = Extract<Part, { type: "tool" }>;
type Status = "ready" | "submitted" | "streaming" | "error";

// A part's parentId, normalized to `undefined` for the main thread (permission
// parts don't have the field at all — they're always main). Centralizing this
// lookup means every routing decision (grouping, streaming merge, bucketing)
// agrees on what "main thread" means.
const parentOf = (p: Part): string | undefined =>
  p.type === "permission" ? undefined : p.parentId;

// One spawned subagent's own transcript, reconstructed identically whether
// it's arriving live (SSE events tagged with `parent`) or reconstructed from
// persisted parts (tagged with `parentId`) — see agentBuckets below. `spawn`
// is the enriched tool part itself (id, agent info, and — once the subagent
// finishes — its output/isError), `parts` is everything that part spawned.
type AgentBucket = { id: string; spawn: ToolPart; parts: Part[] };

// Label priority per spec: an explicit run name, else the agent type, else a
// clipped slice of the free-form description — always something short enough
// for a tab. Array.from/codePoints mirrors stepPreview's astral-safe slicing.
function agentLabel(agent: AgentInfo): string {
  if (agent.name) return agent.name;
  if (agent.type) return agent.type;
  const codePoints = Array.from(agent.description.trim());
  return codePoints.length > 24 ? `${codePoints.slice(0, 24).join("")}…` : codePoints.join("");
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

type ProjectCommand = {
  name: string;
  description: string;
  kind: "command" | "skill";
};

export type InitialChat = {
  id: string;
  model: string;
  messages: StoreMessage[];
};

const refresh = () => window.dispatchEvent(new Event("telar:refresh"));

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
          },
    ),
  }));
}

// Best-effort salient preview of a tool call's input: the path/command a human
// actually cares about, or a capped JSON dump for anything else.
function permissionPreview(input: Record<string, unknown>): string {
  if (typeof input.file_path === "string") return input.file_path;
  if (typeof input.command === "string") return input.command;
  const json = JSON.stringify(input);
  return json.length > 200 ? `${json.slice(0, 200)}…` : json;
}

function PermissionCard({
  part,
  onRespond,
}: {
  part: Extract<Part, { type: "permission" }>;
  onRespond: (id: string, behavior: "allow" | "deny", always: boolean) => void;
}) {
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
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => onRespond(part.id, "allow", false)}
          >
            Allow once
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            className="h-auto flex-col items-start gap-0 py-1"
            onClick={() => onRespond(part.id, "allow", true)}
          >
            <span>Always allow</span>
            <span className="font-mono text-[9px] font-normal text-muted-foreground">
              {part.rule}
            </span>
          </Button>
          <Button
            type="button"
            size="xs"
            variant="destructive"
            onClick={() => onRespond(part.id, "deny", false)}
          >
            Deny
          </Button>
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

// One rendered chunk of an assistant message's parts: standalone text,
// standalone permission card (always interactive, so it always breaks a
// tool-step group), or a run of consecutive tool parts collapsed into one
// group. Keys are stable across re-renders — the group key doubles as the
// identity used to remember a user's manual expand/collapse override.
type RenderItem =
  | { kind: "text"; key: string; part: Extract<Part, { type: "text" }> }
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
    } else {
      items.push({ kind: "permission", key: `${messageId}:${idx}`, part });
    }
  });
  return items;
}

// Primary-arg preview for a step row: the argument a human actually cares
// about, one line, short enough to sit inline next to the tool name.
function stepPreview(input?: Record<string, unknown>): string | null {
  if (!input) return null;
  const value =
    (typeof input.command === "string" && input.command) ||
    (typeof input.file_path === "string" && input.file_path) ||
    (typeof input.pattern === "string" && input.pattern) ||
    (typeof input.path === "string" && input.path) ||
    Object.values(input).find((v): v is string => typeof v === "string") ||
    null;
  if (!value) return null;
  const oneLine = value.replace(/\s+/g, " ").trim();
  // Array.from splits on code points, not UTF-16 code units — plain
  // .slice(0, 80) can cut an astral character (e.g. an emoji) in half and
  // render a broken glyph right at the truncation boundary.
  const codePoints = Array.from(oneLine);
  return codePoints.length > 80 ? `${codePoints.slice(0, 80).join("")}…` : oneLine;
}

// Claude Code's own icon-per-tool set; anything unrecognized (MCP tools,
// future built-ins) falls back to the generic wrench.
const TOOL_ICONS: Record<string, typeof WrenchIcon> = {
  Bash: TerminalIcon,
  Read: FileTextIcon,
  Write: FileTextIcon,
  Edit: PencilIcon,
  Grep: SearchIcon,
  Glob: FolderSearchIcon,
  WebFetch: GlobeIcon,
  WebSearch: GlobeIcon,
  TodoWrite: ListTodoIcon,
};

// A single step's collapsed row + click-to-expand detail panel. Old persisted
// parts have neither input nor output — the row still renders, just with no
// preview and nothing to expand (never crashes on the missing fields).
// `open` is lifted to the parent (keyed by tool id) rather than local state:
// ToolStepGroup unmounts these rows whenever the group itself collapses (e.g.
// the group stops being the live trailing item once the turn's closing text
// arrives), and local state would be silently discarded on that unmount.
function ToolStepRow({
  part,
  running,
  open,
  onToggle,
}: {
  part: ToolPart;
  running: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const hasDetail = part.input !== undefined || part.output !== undefined;
  const Icon = TOOL_ICONS[part.name] ?? WrenchIcon;
  const preview = stepPreview(part.input);

  // interrupted is only meaningful while there's genuinely no result — once
  // isError/output resolve for real, those take precedence over a stale flag.
  const interrupted = part.interrupted === true && part.output === undefined;

  return (
    <div
      className={cn(
        "rounded-md",
        part.isError ? "bg-destructive/10" : interrupted && "bg-muted/60",
      )}
    >
      <button
        type="button"
        disabled={!hasDetail}
        onClick={onToggle}
        className={cn(
          "flex w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left",
          hasDetail && "hover:bg-muted/60",
        )}
      >
        {running ? (
          <Shimmer as="span" className="min-w-0 flex-1 truncate text-left text-xs">
            {preview ? `${part.name} · ${preview}` : part.name}
          </Shimmer>
        ) : (
          <>
            <Icon
              className={cn(
                "size-3.5 shrink-0",
                part.isError ? "text-destructive" : "text-muted-foreground",
              )}
            />
            <span className={cn("shrink-0 font-medium", part.isError && "text-destructive")}>
              {part.name}
            </span>
            {preview && (
              <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
                {preview}
              </span>
            )}
            {interrupted && !part.isError && (
              <span className="shrink-0 text-[10px] text-muted-foreground/70">
                (interrupted)
              </span>
            )}
          </>
        )}
        {hasDetail && (
          <ChevronRightIcon
            className={cn(
              "ml-auto size-3 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
        )}
      </button>
      {open && hasDetail && (
        <div className="flex flex-col gap-1.5 px-1.5 pb-1.5">
          <pre className="max-h-60 overflow-x-auto overflow-y-auto rounded-md bg-background/60 p-2 font-mono text-[11px] whitespace-pre-wrap break-words text-muted-foreground ring-1 ring-border">
            {part.name === "Bash" && typeof part.input?.command === "string"
              ? part.input.command
              : JSON.stringify(part.input ?? {}, null, 2)}
          </pre>
          {part.isError && (
            <div className="flex items-center gap-1 text-[11px] font-medium text-destructive">
              <TriangleAlertIcon className="size-3" />
              Error
            </div>
          )}
          {interrupted && !part.isError && (
            <div className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
              <TriangleAlertIcon className="size-3" />
              Interrupted — no result
            </div>
          )}
          <pre
            className={cn(
              "max-h-60 overflow-x-auto overflow-y-auto rounded-md p-2 font-mono text-[11px] whitespace-pre-wrap break-words ring-1 ring-border",
              part.isError
                ? "bg-destructive/10 text-destructive"
                : "bg-background/60 text-muted-foreground",
            )}
          >
            {interrupted ? "(interrupted before finishing)" : part.output || "(no output)"}
          </pre>
        </div>
      )}
    </div>
  );
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
        "flex w-full flex-col gap-0.5 rounded-lg border bg-muted/20 text-xs",
        hasError && "border-destructive/40",
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-left hover:bg-muted/40"
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
// locked and shown read-only in the heartbeat bar. Tools stay read-only
// (Read / Grep / Glob) — sessions explore and prepare, runs do the writing.
export function SessionView(props: {
  project: string;
  account: string;
  accounts: Array<{ name: string; displayTier?: string }>;
  initialChat?: InitialChat;
  initialTitle?: string;
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
}: {
  project: string;
  account: string;
  accounts: Array<{ name: string; displayTier?: string }>;
  initialChat?: InitialChat;
  initialTitle?: string;
}) {
  const router = useRouter();
  const textInput = usePromptInputController().textInput;

  // Seed once from the server-resolved transcript. Later prop changes are
  // ignored on purpose: when a fresh session is minted mid-stream we rewrite
  // the URL to its new id, which re-renders this page with initialChat still
  // undefined — re-seeding would tear the live stream down.
  const [sessionId, setSessionId] = useState<string | null>(
    initialChat?.id ?? null,
  );
  const [messages, setMessages] = useState<ChatMessage[]>(() =>
    seedMessages(initialChat),
  );
  // The header title lives here so a freshly-minted session shows its derived
  // thread title immediately — the server can't re-title mid-stream (getChat is
  // undefined until the first turn persists, long after the URL is rewritten).
  const [title, setTitle] = useState(initialTitle ?? "New session");
  const [model, setModel] = useState(initialChat?.model ?? DEFAULT_MODEL);
  // The caller already resolves the effective account (chat.account for an
  // existing session, the manifest default for a fresh one — contract #5:
  // resume transcripts live under the account's config dir, so an existing
  // chat must never drift to a since-changed manifest default). We just seed
  // from it once and lock further edits once a session exists (below).
  const [activeAccount, setActiveAccount] = useState(account);
  const [status, setStatus] = useState<Status>("ready");
  const [thinking, setThinking] = useState(false);
  const [sessionCost, setSessionCost] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const nextId = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

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

  const busy = status === "submitted" || status === "streaming";

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
    const t = setInterval(
      () => setElapsed(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
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
    (id: string, behavior: "allow" | "deny", always: boolean) => {
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
        body: JSON.stringify({ id, behavior, always }),
      }).catch(() => {
        // Fire-and-forget: the SSE event / server timeout still resolves this.
      });
    },
    [],
  );

  const send = useCallback(
    async (text: string) => {
      const userId = `m${nextId.current++}`;
      const asstId = `m${nextId.current++}`;
      // Fresh session (no id yet): the first user message names the thread,
      // mirroring the title the store derives on save.
      if (!sessionId) setTitle(text.slice(0, 60));
      setMessages((ms) => [
        ...ms,
        { id: userId, role: "user", parts: [{ type: "text", text, done: true }] },
        { id: asstId, role: "assistant", parts: [] },
      ]);
      setStatus("submitted");
      setThinking(false);

      const abort = new AbortController();
      abortRef.current = abort;

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: text,
            sessionId,
            model,
            project,
            account: activeAccount,
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
        const decoder = new TextDecoder();
        let buffer = "";
        // Set by the "error" case below instead of throwing there — throwing
        // mid-loop would unwind out of the read loop and skip the server's
        // trailing "saved"/"done" events (still sent from its finally block
        // after a mid-turn error). We keep reading to the natural end of the
        // stream and only surface the error once it actually closes.
        let streamErrorMessage: string | null = null;

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
                  window.history.replaceState(
                    null,
                    "",
                    `/projects/${encodeURIComponent(project)}/sessions/${payload.sessionId}`,
                  );
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
              case "thinking":
                // Carries an optional `parent` too, but stays a single
                // turn-wide flag on purpose: it only ever drives the busy
                // wording in the heartbeat bar / empty-message placeholder,
                // and contract #5 keys busy/elapsed to the whole turn
                // regardless of which tab is active. There's also no
                // explicit "stopped thinking" event to attribute the *end* of
                // a thinking span per parent — it's only ever inferred from
                // the next delta/text/tool, so per-parent precision here
                // would be partial at best. A subagent's own empty-tab
                // placeholder (see renderAgentBucket) already renders its own
                // static "Spinning up…" instead of reading this flag.
                setThinking(true);
                break;
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
                  const idx = m.parts.findLastIndex((p) => parentOf(p) === parent);
                  const last = idx >= 0 ? m.parts[idx] : undefined;
                  if (last?.type === "text" && !last.done) {
                    const parts = [...m.parts];
                    parts[idx] = { ...last, text: last.text + payload.text };
                    return { ...m, parts };
                  }
                  return {
                    ...m,
                    parts: [...m.parts, { type: "text", text: payload.text, done: false, parentId: parent }],
                  };
                });
                break;
              }
              case "text": {
                const parent: string | undefined = payload.parent ?? undefined;
                setStatus("streaming");
                setThinking(false);
                patch(asstId, (m) => {
                  const idx = m.parts.findLastIndex((p) => parentOf(p) === parent);
                  const last = idx >= 0 ? m.parts[idx] : undefined;
                  if (last?.type === "text" && !last.done) {
                    const parts = [...m.parts];
                    parts[idx] = { type: "text", text: payload.text, done: true, parentId: parent };
                    return { ...m, parts };
                  }
                  return {
                    ...m,
                    parts: [...m.parts, { type: "text", text: payload.text, done: true, parentId: parent }],
                  };
                });
                break;
              }
              case "tool": {
                const parent: string | undefined = payload.parent ?? undefined;
                setStatus("streaming");
                setThinking(false);
                patch(asstId, (m) => ({
                  ...m,
                  parts: [
                    ...m.parts,
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
                }));
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
              case "done":
                setSessionCost((c) => c + (payload.costUsd ?? 0));
                refresh();
                break;
              case "saved":
                refresh();
                break;
              case "error":
                streamErrorMessage = payload.message;
                break;
            }
          }
        }
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
      }
    },
    [sessionId, model, project, activeAccount, router],
  );

  const handleSubmit = (message: PromptInputMessage) => {
    const text = message.text.trim();
    if (!text || busy) return;
    void send(text);
  };

  const activeModel = modelById(model);

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

  // Tab strip data — derived straight from agentBuckets, never stored on its
  // own (contract #5). Order follows first appearance so a tab never jumps
  // around later as its own spawn's status changes.
  const agentTabs: AgentTab[] = useMemo(
    () =>
      agentBuckets.map((b) => ({
        id: b.id,
        label: agentLabel(b.spawn.agent ?? { type: null, description: "" }),
        status: agentStatus(b.spawn),
      })),
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
    return (
      <div className="flex w-full flex-col gap-3 text-sm">
        <div className="flex flex-col gap-1 border-b pb-3 text-xs">
          <div className="flex flex-wrap items-center gap-1.5 font-medium text-foreground">
            <BotIcon className="size-3.5 text-muted-foreground" />
            {agent.type ?? "subagent"}
            {agent.name && agent.name !== agent.type && (
              <Badge variant="outline" className="px-1 py-0 text-[10px]">
                {agent.name}
              </Badge>
            )}
          </div>
          {agent.description && <p className="text-muted-foreground">{agent.description}</p>}
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

        {bucket.spawn.output !== undefined && (
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
        )}
      </div>
    );
  }

  return (
    <>
      <PageHeader
        leading={
          <BackLink
            href={`/projects/${encodeURIComponent(project)}`}
            label={`Back to ${project}`}
          />
        }
        title={title}
        description={<span className="font-mono text-xs">{project}</span>}
      />

      {/* Live heartbeat for this session — active account (editable pre-session,
          locked once one exists), session id once minted, elapsed while
          working, running cost. */}
      <div className="flex shrink-0 items-center gap-2 border-b px-4 py-1.5">
        <Badge variant="outline" className="gap-1.5 font-mono text-xs">
          <UserRoundIcon className="size-3" />
          {activeAccount}
        </Badge>
        {sessionId && (
          <Badge variant="secondary" className="font-mono text-xs">
            {shortId(sessionId)}
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-2">
          {busy && (
            <Shimmer className="text-xs">
              {`${status === "submitted" ? "starting" : thinking ? "thinking" : "working"} · ${elapsed}s`}
            </Shimmer>
          )}
          <Badge variant="outline" className="font-mono text-xs">
            {fmtCost(sessionCost)}
          </Badge>
        </div>
      </div>

      {/* Main tab always present; a tab for a spawn appears the instant its
          tool-call part arrives (live) or is reconstructed from persisted
          parts (load) — see agentBuckets. Scrolls horizontally on overflow,
          never wraps into the conversation below it. */}
      <AgentTabsStrip
        tabs={agentTabs}
        activeId={activeTab}
        onSelect={setActiveTab}
        mainNeedsAttention={mainNeedsAttention}
        availableAgents={availableAgents ?? undefined}
      />

      <Conversation className="flex-1">
        <ConversationContent className="mx-auto w-full max-w-3xl">
          {activeBucket ? (
            renderAgentBucket(activeBucket)
          ) : messages.length === 0 ? (
            <ConversationEmptyState
              title="Read the workspace"
              description="This session explores the repo with Read · Grep · Glob to plan a change. When you're ready to write, start a run."
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
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="relative mx-auto w-full max-w-3xl px-4 pb-4">
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
        <PromptInput onSubmit={handleSubmit}>
          <PromptInputBody>
            <PromptInputTextarea
              placeholder={`Ask about ${project}… ("/" for commands)`}
              onKeyDown={handleComposerKeyDown}
              onChange={() => setMenuDismissed(false)}
            />
          </PromptInputBody>
          <PromptInputFooter>
            <PromptInputTools>
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
                  {MODELS.map((m) => (
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
                          <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                            ${m.inputPerMTok}/{m.outputPerMTok} MTok
                          </span>
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
              {sessionId === null && !busy && (
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
                    {accounts.map((a) => (
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
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  router.push(`/runs?new=1&project=${encodeURIComponent(project)}`)
                }
              >
                <PlayIcon />
                Start run
              </Button>
            </PromptInputTools>
            <PromptInputSubmit
              status={status === "ready" ? undefined : status}
              onStop={() => abortRef.current?.abort()}
            />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </>
  );
}
