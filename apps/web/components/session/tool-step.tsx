"use client";

// Shared, session-agnostic tool-step presentation: the collapsible tool row
// (icon + name + salient preview + click-to-expand input/output), its to-do
// checklist special-case, and the primary-arg preview helper. Extracted from
// session-view.tsx so BOTH the session chat AND the loom agent-view transcript
// render tool calls identically (docs/loom-model.md §V.3). Pure presentational
// — every component is keyed on a plain ToolPart with expand state lifted to
// the caller (open/onToggle), so there is no session- or loom-specific state
// inside. NOTHING here imports from @telar/core, so it is safe for any client.

import {
  CheckIcon,
  ChevronRightIcon,
  CircleIcon,
  FileTextIcon,
  FolderSearchIcon,
  GlobeIcon,
  ListTodoIcon,
  Loader2Icon,
  PencilIcon,
  SearchIcon,
  TerminalIcon,
  TriangleAlertIcon,
  WrenchIcon,
} from "lucide-react";
import { createElement } from "react";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// Pulled from a spawn tool call's AgentInput (description/prompt/subagent_type/
// name/...) and stashed on that tool part so the tab strip and the B.3 chip
// both have a label without re-deriving it from raw input every render.
export type AgentInfo = { type: string | null; description: string; name?: string };

// The canonical shape a tool step renders from — id/input/output/isError all
// optional so an old persisted chat (name-only tool parts) and a loom event
// that carried no `input` on an old event both still render, never crash.
export type ToolPart = {
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
  autoDenied?: boolean;
};

// Primary-arg preview for a step row: the argument a human actually cares
// about, one line, short enough to sit inline next to the tool name.
export function stepPreview(input?: Record<string, unknown>): string | null {
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
export const TOOL_ICONS: Record<string, typeof WrenchIcon> = {
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

const TOOL_ACTIONS: Record<string, string> = {
  Bash: "Ran command",
  Read: "Read file",
  Write: "Created file",
  Edit: "Edited file",
  Grep: "Searched text",
  Glob: "Found files",
  WebFetch: "Fetched page",
  WebSearch: "Searched web",
  browser_click: "Clicked",
  browser_hover: "Moved over",
  browser_type: "Typed into",
  browser_fill_form: "Filled form",
  browser_press_key: "Pressed key",
  browser_navigate: "Opened page",
  browser_navigate_back: "Went back",
  browser_snapshot: "Inspected page",
  browser_take_screenshot: "Captured page",
  browser_console_messages: "Checked console",
  browser_network_requests: "Checked network",
  browser_tabs: "Updated browser tabs",
  browser_list_tabs: "Checked browser tabs",
};

function canonicalToolName(name: string) {
  return name.split("__").at(-1) ?? name;
}

export function toolActionLabel(name: string) {
  const canonical = canonicalToolName(name);
  return TOOL_ACTIONS[canonical] ?? canonical.replaceAll("_", " ");
}

/**
 * The compact "what happened here" tally, in FIRST-APPEARANCE order:
 * `Ran command ×12 · Read file ×4 · Edited file ×2`.
 *
 * Shared by the collapsed tool group and the settled-turn fold so the two
 * summaries cannot drift into describing the same work two different ways —
 * they are the same sentence at two scales, and a reader learns it once.
 * First-appearance beats frequency order because it preserves the shape of the
 * turn: what the agent reached for first stays first.
 */
export function toolTallyLabel(parts: readonly ToolPart[]): string {
  const tally: Array<[string, number]> = [];
  const indexByName = new Map<string, number>();
  for (const p of parts) {
    const i = indexByName.get(p.name);
    if (i === undefined) {
      indexByName.set(p.name, tally.length);
      tally.push([p.name, 1]);
    } else {
      tally[i][1] += 1;
    }
  }
  return tally
    .map(([name, count]) => `${toolActionLabel(name)}${count > 1 ? ` ×${count}` : ""}`)
    .join(" · ");
}

function toolIcon(name: string) {
  const canonical = canonicalToolName(name);
  if (canonical.startsWith("browser_")) return GlobeIcon;
  return TOOL_ICONS[canonical] ?? WrenchIcon;
}

type TodoState = "pending" | "in_progress" | "completed";

// Normalizes both providers' to-do payloads into one shape: Claude's TodoWrite
// ({ todos: [{content, status, activeForm}] }) and Codex's todo_list
// ({ items: [{text, completed}] }, surfaced by codex-run as a TodoWrite tool).
export function normalizeTodos(
  input?: Record<string, unknown>,
): { label: string; state: TodoState }[] | null {
  if (!input) return null;
  if (Array.isArray(input.todos)) {
    return input.todos.map((t) => {
      const o = (t ?? {}) as Record<string, unknown>;
      const state = (o.status as TodoState) ?? "pending";
      const label =
        state === "in_progress" && typeof o.activeForm === "string"
          ? o.activeForm
          : String(o.content ?? "");
      return { label, state };
    });
  }
  if (Array.isArray(input.items)) {
    return input.items.map((t) => {
      const o = (t ?? {}) as Record<string, unknown>;
      return {
        label: String(o.text ?? ""),
        state: (o.completed ? "completed" : "pending") as TodoState,
      };
    });
  }
  return null;
}

// A to-do list rendered as a checklist rather than a raw JSON tool step —
// shared by Claude and Codex. Always visible (not behind the tool-row
// disclosure) since the point of a to-do list is to be glanceable.
function TodoBlock({
  todos,
  isError,
}: {
  todos: { label: string; state: TodoState }[];
  isError?: boolean;
}) {
  const done = todos.filter((t) => t.state === "completed").length;
  return (
    <div className={cn("rounded-md px-1.5 py-1", isError && "bg-destructive/10")}>
      <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <ListTodoIcon className="size-3.5" />
        To-dos
        <span className="font-mono text-[10px] text-muted-foreground/70">
          {done}/{todos.length}
        </span>
      </div>
      <ul className="space-y-0.5">
        {todos.map((t, i) => (
          <li key={i} className="flex items-start gap-1.5 text-xs leading-relaxed">
            <span className="mt-[3px] shrink-0">
              {t.state === "completed" ? (
                <CheckIcon className="size-3 text-primary" />
              ) : t.state === "in_progress" ? (
                <Loader2Icon className="size-3 animate-spin text-amber-500" />
              ) : (
                <CircleIcon className="size-3 text-muted-foreground/40" />
              )}
            </span>
            <span
              className={cn(
                t.state === "completed" && "text-muted-foreground line-through",
                t.state === "in_progress" && "font-medium text-foreground",
                t.state === "pending" && "text-muted-foreground",
              )}
            >
              {t.label}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// A single step's collapsed row + click-to-expand detail panel. Old persisted
// parts / old loom events have neither input nor output — the row still
// renders, just with no preview and nothing to expand (never crashes on the
// missing fields). `open` is lifted to the parent (keyed by tool id) rather
// than local state: ToolStepGroup unmounts these rows whenever the group
// itself collapses, and local state would be silently discarded on that
// unmount.
export function ToolStepRow({
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
  // A to-do write renders as a live checklist, not a collapsible JSON step.
  const todos = part.name === "TodoWrite" ? normalizeTodos(part.input) : null;
  if (todos && todos.length > 0) return <TodoBlock todos={todos} isError={part.isError} />;

  const hasDetail = part.input !== undefined || part.output !== undefined;
  const action = toolActionLabel(part.name);
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
            {preview ? `${action} · ${preview}` : action}
          </Shimmer>
        ) : (
          <>
            {createElement(toolIcon(part.name), {
              className: cn(
                "size-3.5 shrink-0",
                part.isError ? "text-destructive" : "text-muted-foreground",
              ),
            })}
            <span className={cn("shrink-0", part.isError && "text-destructive")}>
              {action}
            </span>
            {preview && (
              <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
                {preview}
              </span>
            )}
            {part.autoDenied && (
              <Badge variant="destructive" className="shrink-0 px-1 py-0 text-[9px]">
                auto-denied
              </Badge>
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
        <div className="ml-3 flex flex-col gap-2 border-l border-border/70 py-1 pl-3 pr-1.5 text-[11px]">
          <div className="font-medium text-muted-foreground">Input</div>
          <pre className="max-h-60 overflow-x-auto overflow-y-auto font-mono whitespace-pre-wrap break-words text-muted-foreground">
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
          <div className="font-medium text-muted-foreground">Result</div>
          <pre
            className={cn(
              "max-h-60 overflow-x-auto overflow-y-auto font-mono whitespace-pre-wrap break-words",
              part.isError
                ? "text-destructive"
                : "text-muted-foreground",
            )}
          >
            {interrupted ? "(interrupted before finishing)" : part.output || "(no output)"}
          </pre>
        </div>
      )}
    </div>
  );
}
