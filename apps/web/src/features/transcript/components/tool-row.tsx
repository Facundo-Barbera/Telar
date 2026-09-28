"use client";

import { createContext, useState } from "react";
import {
ChevronRightIcon,FileTextIcon,
GlobeIcon,PencilIcon,
SearchIcon,
TerminalIcon,WrenchIcon
} from "lucide-react";
import { isKnownPath, type Item } from "@telar/engine-client";
import { toolOutput, type JournalItem } from "@/platform/engine";
import { fileReference } from "@/lib/drag-reference";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Shimmer } from "@/components/ui/shimmer";
import { CODE_SURFACE_FRAME, CODE_SURFACE_LINES, CODE_SURFACE_TEXT, CodeSurface, CopyButton, foldLines } from "@/components/ui/code-surface";
import { Badge } from "@/components/ui/badge";
import { ROW } from "./transcript-fold";
import { cn } from "@/lib/utils";
import { actionLabel, failed, liveActionLabel, preview, running } from "../model";

/** Deliberately small and literal. The lane is meant to be uniform and boring:
 *  an icon per tool would turn a long turn into a sticker album. The icon says
 *  WHICH KIND of thing happened; the mono preview beside it says what. */
const TOOL_ICON: Partial<Record<Item["detail"]["type"], typeof WrenchIcon>> = {
  command_execution: TerminalIcon,
  file_read: FileTextIcon,
  file_change: PencilIcon,
  web_search: SearchIcon,
  browser_action: GlobeIcon,
  mcp_tool_call: WrenchIcon,
  dynamic_tool_call: WrenchIcon,
};

export type RowGestures = {
  /** Put text into the message being written — `insertIntoComposer` in the
   *  cockpit. A quote and a file reference both land through it. */
  onInsert?: (text: string) => void;
  /** Open a path in the Editor — the cockpit's own `showPanelTab`, which reads
   *  a file-shaped id and routes it there. */
  onOpenFile?: (path: string) => void;
  /** Open a path in a NEW Editor tab (#322), so a file the agent touched can be
   *  read beside whatever the Editor already holds. */
  onOpenFileInNewTab?: (path: string) => void;
};

export const WorkspaceContext = createContext<string | undefined>(undefined);

export function TranscriptWorkspace({ path, children }: { path?: string; children: React.ReactNode }) {
  return <WorkspaceContext.Provider value={path}>{children}</WorkspaceContext.Provider>;
}

/** The path a row is ABOUT, when it is about one — never the placeholder a
 *  call carries before its input has named the file. */
export function rowPath(item: JournalItem): string | undefined {
  const path = item.detail.type === "file_change" ? item.detail.change.path : item.detail.type === "file_read" ? item.detail.read.path : undefined;
  return path && isKnownPath(path) ? path : undefined;
}

/** A diff is SOURCE: read as written, never wrapped, cut at 24 lines like any
 *  other tool body — copy still writes the whole patch. */
function DiffBody({ diff }: { diff: string }) {
  const [expanded, setExpanded] = useState(false);
  const { shown, total } = expanded ? { shown: diff, total: diff.split("\n").length } : foldLines(diff);
  return (
    <div className={cn("relative pr-8", CODE_SURFACE_FRAME)}>
      <CopyButton text={diff} className="absolute top-1 right-1 z-10 bg-muted/60" />
      <pre className={cn("overflow-x-auto px-2.5 py-2", CODE_SURFACE_TEXT)}>
        {shown.split("\n").map((line, index) => {
          // `---`/`+++`/`@@` are the file header, not a removed and an added
          // line. Tested first, or every diff opens with one of each.
          const header = line.startsWith("---") || line.startsWith("+++") || line.startsWith("@@");
          return (
            <span
              key={index}
              className={cn(
                "block",
                header
                  ? "text-muted-foreground/70"
                  : line.startsWith("+")
                    ? "bg-success/10 text-success"
                    : line.startsWith("-")
                      ? "bg-destructive/10 text-destructive"
                      : "text-muted-foreground",
              )}
            >
              {line || " "}
            </span>
          );
        })}
      </pre>
      {total > CODE_SURFACE_LINES && (
        <button
          type="button"
          aria-expanded={expanded}
          className="flex w-full items-center border-t border-border/70 px-2.5 py-1 text-left text-2xs text-muted-foreground outline-none hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "Show less" : `Show all · ${total} lines`}
        </button>
      )}
    </div>
  );
}

export function ToolRow({ item, onInsert, onOpenFile, onOpenFileInNewTab }: { item: JournalItem } & RowGestures) {
  const [open, setOpen] = useState(false);
  const change = item.detail.type === "file_change" ? item.detail.change : undefined;
  const output = toolOutput(item);
  const body = change?.unifiedDiff ?? output;
  const label = running(item) ? liveActionLabel(item) : actionLabel(item);
  const isError = failed(item);
  const RowIcon = TOOL_ICON[item.detail.type] ?? WrenchIcon;
  const command = item.detail.type === "command_execution" ? item.detail.command.command : undefined;
  const path = rowPath(item);
  // A row about nothing copyable gets no menu at all, rather than an empty
  // popup that opens and offers you the choice of nothing.
  const hasMenu = Boolean(command || body || path);
  // Nothing readable about the input: the row is the verb, once, rather than
  // the verb followed by an empty mono slot.
  const argument = preview(item);

  const row = (
    <div className={cn("rounded-md", isError && "bg-destructive/10")}>
      <button
        type="button"
        className={cn(ROW, body && "hover:bg-muted/60")}
        disabled={!body}
        aria-expanded={body ? open : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        {running(item) ? (
          <Shimmer as="span" className="min-w-0 flex-1 truncate text-left text-xs">
            {argument ? `${label} · ${argument}` : `${label}…`}
          </Shimmer>
        ) : (
          <>
            <RowIcon className={cn("size-3.5 shrink-0", isError ? "text-destructive" : "text-muted-foreground")} />
            <span className={cn("shrink-0", isError && "text-destructive")}>{label}</span>
            {argument && <span className="min-w-0 truncate font-mono text-2xs text-muted-foreground">{argument}</span>}
          </>
        )}
        {change && (change.linesAdded || change.linesRemoved) ? (
          <span className="shrink-0 font-mono text-3xs">
            {change.linesAdded ? <span className="text-success">+{change.linesAdded}</span> : null}
            {change.linesAdded && change.linesRemoved ? " " : null}
            {change.linesRemoved ? <span className="text-destructive">−{change.linesRemoved}</span> : null}
          </span>
        ) : null}
        {change?.diffTruncated && (
          <Badge variant="outline" className="shrink-0 px-1 py-0 text-4xs font-normal text-warning" title="Only the beginning of this patch was recorded">
            patch cut short
          </Badge>
        )}
        {item.status === "declined" && (
          <Badge variant="destructive" className="shrink-0 px-1 py-0 text-4xs">
            declined
          </Badge>
        )}
        {body && (
          <ChevronRightIcon
            className={cn("ml-auto size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
          />
        )}
      </button>
      {open && body && (
        <div className="ml-3 flex flex-col gap-2 border-l border-border/70 py-1 pr-1.5 pl-3">
          {change?.unifiedDiff ? <DiffBody diff={change.unifiedDiff} /> : <CodeSurface text={output ?? ""} wrap />}
        </div>
      )}
    </div>
  );
  if (!hasMenu) return row;

  return (
    <ContextMenu>
      <ContextMenuTrigger>{row}</ContextMenuTrigger>
      <ContextMenuContent className="w-auto">
        {command && <ContextMenuItem onClick={() => void navigator.clipboard.writeText(command)}>Copy command</ContextMenuItem>}
        {body && (
          <ContextMenuItem onClick={() => void navigator.clipboard.writeText(body)}>
            {change?.unifiedDiff ? "Copy patch" : "Copy output"}
          </ContextMenuItem>
        )}
        {path && (command || body) && <ContextMenuSeparator />}
        {path && onOpenFile && <ContextMenuItem onClick={() => onOpenFile(path)}>Open file in the Editor</ContextMenuItem>}
        {/* …or in an Editor of its own, so this file can be read beside the one
            already open rather than replacing it (#322). */}
        {path && onOpenFileInNewTab && (
          <ContextMenuItem onClick={() => onOpenFileInNewTab(path)}>Open in a new panel tab</ContextMenuItem>
        )}
        {path && <ContextMenuItem onClick={() => void navigator.clipboard.writeText(path)}>Copy path</ContextMenuItem>}
        {path && onInsert && <ContextMenuItem onClick={() => onInsert(fileReference(path).text)}>Insert as reference</ContextMenuItem>}
      </ContextMenuContent>
    </ContextMenu>
  );
}
