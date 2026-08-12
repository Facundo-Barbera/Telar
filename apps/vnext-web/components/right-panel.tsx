"use client";

import { useMemo, useState } from "react";
import { BotIcon, ChevronRightIcon, FileIcon, GaugeIcon, GlobeIcon, PanelRightIcon, PencilIcon, TerminalIcon } from "lucide-react";
import type { BrowserProvider, BrowserTab, EngineEvent, FileChangeKind, Item, Task, TaskState, Turn, TurnState } from "@telar/engine-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

/**
 * The session panel: four surfaces, each backed by a record the engine emits.
 *
 * There is no Terminal and no Editor tab because there is no contract to render
 * for either, and no page preview because `browser.state.changed` carries URLs
 * and titles rather than pixels. An empty surface NAMES what is missing instead
 * of drawing a shape that implies a feature.
 */

const TABS = [
  { id: "changes", label: "Changes", icon: PencilIcon },
  { id: "browser", label: "Browser", icon: GlobeIcon },
  { id: "agents", label: "Agents", icon: BotIcon },
  { id: "usage", label: "Usage", icon: GaugeIcon },
] as const;

export type PanelTab = (typeof TABS)[number]["id"];

// ── folds over the session record ──────────────────────────────────────────

/** One path, as the session last left it. */
export type ChangedFile = {
  path: string;
  kind: FileChangeKind;
  renamedFrom?: string;
  unifiedDiff?: string;
  linesAdded?: number;
  linesRemoved?: number;
  /** How many times the session touched this path. The row shows only the
   *  NEWEST change, so the count is the one honest signal that there were
   *  earlier ones. */
  edits: number;
};

export function changedFiles(items: readonly Item[]): ChangedFile[] {
  const byPath = new Map<string, { at: number; file: ChangedFile }>();
  for (const item of items) {
    if (item.detail.type !== "file_change") continue;
    // A declined change never ran and a failed one never landed. Listing either
    // would claim the session edited a file it did not.
    if (item.status === "declined" || item.status === "failed") continue;
    const change = item.detail.change;
    const at = item.completedAt ?? item.startedAt;
    const previous = byPath.get(change.path);
    const edits = (previous?.file.edits ?? 0) + 1;
    if (previous && previous.at > at) {
      previous.file.edits = edits;
      continue;
    }
    byPath.set(change.path, { at, file: { ...change, edits } });
  }
  return [...byPath.values()].sort((left, right) => right.at - left.at).map((entry) => entry.file);
}

export type BrowserState = { provider: BrowserProvider; tabs: BrowserTab[] };

/** The last `browser.state.changed` wins: the event carries the whole tab set
 *  rather than a delta, so folding it is a replace. */
export function latestBrowserState(events: readonly EngineEvent[]): BrowserState | undefined {
  let state: BrowserState | undefined;
  for (const event of events) {
    if (event.type === "browser.state.changed") state = { provider: event.provider, tabs: event.tabs };
  }
  return state;
}

export type SessionUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheCreate?: number;
  costUsd?: number;
  /** How many turns reported a figure, out of how many exist. An em dash means
   *  a figure is MISSING, and this is what lets the surface say so. */
  reported: number;
  turns: number;
};

export function sessionUsage(turns: readonly Turn[]): SessionUsage {
  const total = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  let reported = 0;
  let costUsd: number | undefined;
  for (const turn of turns) {
    if (!turn.usage) continue;
    reported += 1;
    total.input += turn.usage.tokens.input;
    total.output += turn.usage.tokens.output;
    total.cacheRead += turn.usage.tokens.cacheRead;
    total.cacheCreate += turn.usage.tokens.cacheCreate;
    if (typeof turn.usage.costUsd === "number") costUsd = (costUsd ?? 0) + turn.usage.costUsd;
  }
  return { ...(reported > 0 ? total : {}), costUsd, reported, turns: turns.length };
}

const LIVE_TASK_STATES = new Set<TaskState>(["pending", "running", "waiting"]);

export function isLiveTask(task: Task): boolean {
  return LIVE_TASK_STATES.has(task.state);
}

// ── presentation ───────────────────────────────────────────────────────────

/** An absent figure is an em dash, never a zero — a session that reported
 *  nothing and a session that spent nothing are different facts. */
function figure(value: number | undefined): string {
  return value === undefined ? "—" : value.toLocaleString("en-US");
}

/** Same scaling as the transcript's per-turn price, so the two agree on sight. */
function money(usd: number): string {
  return `$${usd.toFixed(usd < 0.01 ? 4 : usd < 1 ? 3 : 2)}`;
}

const CHANGE_KIND: Partial<Record<FileChangeKind, string>> = {
  create: "new",
  delete: "deleted",
  rename: "renamed",
};

const BROWSER_PROVIDER: Record<BrowserProvider, string> = {
  headless: "the engine’s own headless Chromium",
  attached: "a client-provided webview",
  none: "no browser",
};

const TASK_STATE: Record<TaskState, string> = {
  pending: "Queued",
  running: "Running",
  waiting: "Waiting",
  completed: "Done",
  failed: "Failed",
  stopped: "Stopped",
};

const PANEL_ROW = "flex w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs";

function Empty({ icon: Icon, title, children }: { icon: typeof PencilIcon; title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-1.5 px-4 py-10 text-center">
      <Icon className="size-5 text-muted-foreground/60" />
      <p className="text-sm font-medium">{title}</p>
      <p className="max-w-64 text-xs text-muted-foreground">{children}</p>
    </div>
  );
}

/**
 * A unified diff, tinted by line. The transcript carries its own copy; one
 * shared `<Diff>` is worth extracting the next time both files are open.
 */
function Diff({ diff }: { diff: string }) {
  return (
    <pre className="max-h-72 overflow-auto rounded-md bg-muted/40 p-2 font-mono text-[10px] leading-relaxed">
      {diff.split("\n").map((line, index) => {
        const header = line.startsWith("---") || line.startsWith("+++") || line.startsWith("@@");
        return (
          <span
            key={index}
            className={cn(
              "block whitespace-pre-wrap break-words",
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
  );
}

function FileRow({ file }: { file: ChangedFile }) {
  const [open, setOpen] = useState(false);
  const cut = file.path.lastIndexOf("/");
  const kind = CHANGE_KIND[file.kind];

  return (
    <div>
      <button
        type="button"
        className={cn(PANEL_ROW, file.unifiedDiff && "hover:bg-muted/60")}
        disabled={!file.unifiedDiff}
        aria-expanded={file.unifiedDiff ? open : undefined}
        onClick={() => setOpen((current) => !current)}
        title={file.path}
      >
        <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
          {cut > -1 && <span className="text-muted-foreground">{file.path.slice(0, cut + 1)}</span>}
          <span className="text-foreground">{file.path.slice(cut + 1)}</span>
        </span>
        {kind && (
          <Badge variant="outline" className="shrink-0 px-1 py-0 text-[9px] font-normal">
            {kind}
          </Badge>
        )}
        {file.edits > 1 && (
          <Badge variant="outline" className="shrink-0 px-1 py-0 text-[9px] font-normal">
            ×{file.edits}
          </Badge>
        )}
        <span className="shrink-0 font-mono text-[10px] tabular-nums">
          {file.linesAdded ? <span className="text-success">+{file.linesAdded}</span> : null}
          {file.linesAdded && file.linesRemoved ? " " : null}
          {/* U+2212, not a hyphen: same width as the plus, which is the whole
              reason the column lines up. */}
          {file.linesRemoved ? <span className="text-destructive">−{file.linesRemoved}</span> : null}
        </span>
        {file.unifiedDiff && (
          <ChevronRightIcon className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        )}
      </button>
      {open && file.unifiedDiff && <Diff diff={file.unifiedDiff} />}
      {open && file.renamedFrom && <p className="px-1.5 py-1 text-[11px] text-muted-foreground">Renamed from {file.renamedFrom}</p>}
    </div>
  );
}

function ChangesSurface({ files }: { files: readonly ChangedFile[] }) {
  if (files.length === 0) {
    return (
      <Empty icon={PencilIcon} title="No file changes yet">
        Every file this session writes, edits, renames or deletes lands here with its diff.
      </Empty>
    );
  }
  return (
    <div className="flex flex-col gap-0.5">
      {files.map((file) => (
        <FileRow key={file.path} file={file} />
      ))}
    </div>
  );
}

function BrowserSurface({ state }: { state?: BrowserState }) {
  if (!state || state.tabs.length === 0) {
    return (
      <Empty icon={GlobeIcon} title="This session has not browsed">
        When the engine opens a page it reports the tab on the journal. Nothing has been opened here yet.
      </Empty>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        {state.tabs.map((tab) => (
          <div key={tab.id} className={cn(PANEL_ROW, tab.active && "bg-muted/50")}>
            <GlobeIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">{tab.title || "Untitled"}</span>
              <span className="truncate font-mono text-[10px] text-muted-foreground">{tab.url}</span>
            </span>
            {tab.loading && (
              <Badge variant="outline" className="shrink-0 px-1 py-0 text-[9px] font-normal">
                loading
              </Badge>
            )}
            {tab.active && (
              <Badge variant="secondary" className="shrink-0 px-1 py-0 text-[9px] font-normal">
                active
              </Badge>
            )}
          </div>
        ))}
      </div>
      <p className="px-1.5 text-[11px] text-muted-foreground">
        Served by {BROWSER_PROVIDER[state.provider]}. The engine reports each tab’s URL, title and loading state — there is no
        screenshot and no webview, so this list is the whole of what it can show.
      </p>
    </div>
  );
}

function TaskRow({ task }: { task: Task }) {
  const live = isLiveTask(task);
  const body = task.failure ?? task.resultText;
  const [open, setOpen] = useState(false);
  const tokens = task.usage ? task.usage.tokens.input + task.usage.tokens.output : undefined;
  const RowIcon = task.kind === "background" ? TerminalIcon : BotIcon;

  return (
    <div className={cn("rounded-md", task.state === "failed" && "bg-destructive/10")}>
      <button
        type="button"
        className={cn(PANEL_ROW, body && "hover:bg-muted/60")}
        disabled={!body}
        aria-expanded={body ? open : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <RowIcon className={cn("size-3.5 shrink-0", task.state === "failed" ? "text-destructive" : "text-muted-foreground")} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">{task.title ?? task.role ?? "Sub-agent"}</span>
          {task.role && task.title && <span className="truncate text-[10px] text-muted-foreground">{task.role}</span>}
        </span>
        {tokens !== undefined && <span className="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">{figure(tokens)}</span>}
        <Badge
          variant={task.state === "failed" ? "destructive" : live ? "default" : "outline"}
          className="shrink-0 px-1 py-0 text-[9px] font-normal"
        >
          {TASK_STATE[task.state]}
        </Badge>
        {body && <ChevronRightIcon className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />}
      </button>
      {open && body && (
        <p className={cn("px-1.5 pb-1.5 text-[11px] whitespace-pre-wrap", task.failure ? "text-destructive" : "text-muted-foreground")}>
          {body}
        </p>
      )}
    </div>
  );
}

function AgentsSurface({ tasks }: { tasks: readonly Task[] }) {
  const live = tasks.filter(isLiveTask);
  const finished = tasks.filter((task) => !isLiveTask(task));
  if (tasks.length === 0) {
    return (
      <Empty icon={BotIcon} title="Sub-agents appear here as they work">
        A task carries its own title, state and result. Background work — a watch loop, a long shell — is listed the same way and
        can outlive the turn that started it.
      </Empty>
    );
  }
  return (
    <div className="flex flex-col gap-0.5">
      {live.map((task) => (
        <TaskRow key={task.id} task={task} />
      ))}
      {finished.length > 0 && live.length > 0 && (
        <div className="flex items-center gap-2 py-1">
          <span className="h-px flex-1 bg-border" />
          <span className="font-mono text-[9px] text-muted-foreground">finished</span>
          <span className="h-px flex-1 bg-border" />
        </div>
      )}
      {finished.map((task) => (
        <TaskRow key={task.id} task={task} />
      ))}
    </div>
  );
}

function UsageSurface({ usage }: { usage: SessionUsage }) {
  const rows: Array<[string, string]> = [
    ["Input", figure(usage.input)],
    ["Output", figure(usage.output)],
    ["Cache read", figure(usage.cacheRead)],
    ["Cache write", figure(usage.cacheCreate)],
    ["Cost", usage.costUsd === undefined ? "—" : money(usage.costUsd)],
  ];
  return (
    <div className="flex flex-col gap-3">
      <dl className="flex flex-col gap-1">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-2 px-1.5 text-xs">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="font-mono tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="px-1.5 text-[11px] text-muted-foreground">
        {usage.reported === 0
          ? "No turn has reported usage yet. Every figure above is missing, not zero."
          : `Totalled across ${usage.reported} of ${usage.turns} turns. A turn the provider gave no figures for contributes nothing rather than a zero.`}
        {usage.reported > 0 && usage.costUsd === undefined && " This provider reported tokens but no price."}
      </p>
    </div>
  );
}

export function VNextPanelSurface({
  tab,
  files,
  tasks,
  turns,
  events,
}: {
  tab: PanelTab;
  files: readonly ChangedFile[];
  tasks: readonly Task[];
  turns: readonly Turn[];
  events: readonly EngineEvent[];
}) {
  const browser = useMemo(() => latestBrowserState(events), [events]);
  const usage = useMemo(() => sessionUsage(turns), [turns]);
  if (tab === "changes") return <ChangesSurface files={files} />;
  if (tab === "browser") return <BrowserSurface state={browser} />;
  if (tab === "agents") return <AgentsSurface tasks={tasks} />;
  return <UsageSurface usage={usage} />;
}

export function VNextRightPanel({
  projectId,
  sessionId,
  active,
  items = [],
  tasks = [],
  turns = [],
  events = [],
}: {
  projectId: string;
  sessionId: string;
  active?: TurnState;
  items?: readonly Item[];
  tasks?: readonly Task[];
  turns?: readonly Turn[];
  events?: readonly EngineEvent[];
}) {
  const [tab, setTab] = useState<PanelTab>("changes");
  const files = useMemo(() => changedFiles(items), [items]);
  const running = tasks.filter(isLiveTask).length;
  const counts: Partial<Record<PanelTab, number>> = { changes: files.length, agents: running };

  return (
    <Sheet>
      <SheetTrigger
        render={
          <Button variant="ghost" size="icon-sm" aria-label="Open session panel">
            <PanelRightIcon className="size-4" />
          </Button>
        }
      />
      <SheetContent side="right" className="w-[26rem] gap-0 sm:max-w-[26rem]">
        <SheetHeader className="pb-2">
          <SheetTitle>Session panel</SheetTitle>
          {/* Which session these four surfaces describe. Every tab is a fold
              over ONE session's journal, and nothing else on screen says which. */}
          <SheetDescription className="truncate font-mono text-[10px]" title={`${projectId}/${sessionId}`}>
            {projectId} / {sessionId}
            {active && ` · ${active}`}
          </SheetDescription>
        </SheetHeader>
        <Tabs value={tab} onValueChange={(next) => setTab(next as PanelTab)} className="min-h-0 flex-1 gap-0 px-4 pb-4">
          <TabsList variant="line" className="w-full border-b border-border">
            {TABS.map((candidate) => (
              <TabsTrigger key={candidate.id} value={candidate.id} className="gap-1">
                <candidate.icon />
                {candidate.label}
                {counts[candidate.id] ? (
                  <span className="rounded-full bg-muted px-1 font-mono text-[9px] tabular-nums">{counts[candidate.id]}</span>
                ) : null}
              </TabsTrigger>
            ))}
          </TabsList>
          {TABS.map((candidate) => (
            <TabsContent key={candidate.id} value={candidate.id} className="min-h-0 overflow-y-auto pt-3">
              <VNextPanelSurface tab={candidate.id} files={files} tasks={tasks} turns={turns} events={events} />
            </TabsContent>
          ))}
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}
