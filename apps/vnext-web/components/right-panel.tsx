"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import {
  BotIcon,
  ChevronRightIcon,
  CircleDotIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  FileIcon,
  GaugeIcon,
  GlobeIcon,
  Maximize2Icon,
  Minimize2Icon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  PanelsTopLeftIcon,
  PencilIcon,
  PlusIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react";
import type {
  BrowserProvider,
  BrowserSnapshot,
  BrowserTab,
  EngineEvent,
  FileChangeKind,
  Item,
  Task,
  TaskState,
  Turn,
  TurnState,
} from "@telar/engine-client";
import { createVNextApi } from "@/lib/vnext/client";
import { fileReference, pageReference, startReferenceDrag, taskReference } from "@/lib/drag-reference";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { PanelDivider, PanelEmpty, PanelRow, type PanelTone } from "@/components/ui/panel";
import { clampSidebarWidth, setSidebarWidth, useSidebarPrefs } from "@/lib/sidebar-width";
import {
  RIGHT_PANEL_DEFAULT_WIDTH,
  RIGHT_PANEL_MAIN_MIN_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
  RIGHT_PANEL_WIDTH_STORAGE_KEY,
} from "@/lib/right-panel-layout";
import { GitSurface } from "@/components/session/git-surface";
import { GitHubSurface } from "@/components/session/github-surface";
import { cn } from "@/lib/utils";

/** The panel reads the engine directly for the one thing the journal cannot
 *  carry: the browser's current pixels. Everything else on this surface is a
 *  fold over records the cockpit already has. */
const api = createVNextApi();

/**
 * THE RAIL — a permanent column, not an overlay.
 *
 * The frozen app's conversation shell has four slots — header, transcript,
 * composer, and RAIL — and the rail is a full-height column the surface fills:
 * sub-agent cards with live step counts, a `DONE` divider, its own footer. It
 * is part of the room. This was previously a Sheet that slid over the
 * conversation, which is a different thing entirely: an overlay is somewhere you
 * go, and a fan-out of five agents is something you need to be able to WATCH
 * while you read and type.
 *
 * Four surfaces, each backed by a record the engine emits. There is no Terminal
 * and no Editor tab because there is no contract to render for either, and no
 * page preview because `browser.state.changed` carries URLs and titles rather
 * than pixels. An empty surface NAMES what is missing instead of drawing a shape
 * that implies a feature.
 *
 * AGENTS IS THE DEFAULT TAB. A fan-out is the most interesting thing on the
 * screen while it happens, and the rail exists mainly so it has somewhere to be.
 */

/**
 * The surfaces that always exist, because each is a fold over the session
 * record itself. A browser PAGE is not one of these — see `PanelTab` below.
 */
const SURFACES = [
  { id: "agents", label: "Agents", icon: BotIcon, blurb: "Sub-agents and background work." },
  { id: "changes", label: "Changes", icon: PencilIcon, blurb: "Every file the conversation says it wrote." },
  /**
   * CHANGES AND GIT ARE NOT THE SAME SURFACE, and keeping both is the point.
   * Changes reads the JOURNAL — what the agent reported, with the patch its own
   * tool produced, including work it later undid. Git reads the DISK — what
   * actually differs from where the session started, including side effects
   * nobody narrated. The Git surface is where the two are joined.
   */
  { id: "git", label: "Git", icon: GitBranchIcon, blurb: "What the checkout has that its last commit does not." },
  /**
   * THE TWO NETWORK SURFACES, and the only two. Everything above folds records
   * the cockpit already holds; these go out to GitHub through the `gh` CLI, so
   * they never poll and they always say how old their answer is.
   */
  { id: "issues", label: "Issues", icon: CircleDotIcon, blurb: "Open issues. Drag one into the message." },
  { id: "pulls", label: "Pull requests", icon: GitPullRequestIcon, blurb: "Open pull requests, and this session's own." },
  { id: "usage", label: "Usage", icon: GaugeIcon, blurb: "Tokens this conversation has spent." },
] as const;

type SurfaceId = (typeof SURFACES)[number]["id"];

/**
 * A panel tab is either a fixed surface or ONE BROWSER PAGE.
 *
 * Pages used to be stacked inside a single "Browser" tab, which made the panel
 * disagree with every browser anyone has ever used: two open pages were one tab
 * containing a list, so switching between them was a click into a row rather
 * than a click on a tab, and neither page could be closed on its own. A page is
 * a tab — that is what a tab IS — so each one gets its own, keyed by the
 * engine's tab id.
 */
export type PanelTab = SurfaceId | `browser:${string}`;

const BROWSER_PREFIX = "browser:";

export function browserPanelTab(tabId: string): PanelTab {
  return `${BROWSER_PREFIX}${tabId}`;
}

/** The engine tab id behind a panel tab, or undefined for a fixed surface. */
export function browserTabId(tab: PanelTab): string | undefined {
  return tab.startsWith(BROWSER_PREFIX) ? tab.slice(BROWSER_PREFIX.length) : undefined;
}

/** Anything shaped like a tab id this build understands — the validator for
 *  what comes back out of localStorage. A browser page whose id is no longer
 *  open is still KNOWN; the surface says so rather than the tab vanishing. */
export function isPanelTab(value: string): value is PanelTab {
  return value.startsWith(BROWSER_PREFIX) || SURFACES.some((surface) => surface.id === value);
}

/** A page's label: its title, else its host, else the raw URL. A tab reading
 *  `https://localhost:3000/a/b/c?d=e` is a tab you cannot tell from its
 *  neighbour. */
export function browserTabLabel(tab: Pick<BrowserTab, "title" | "url">): string {
  if (tab.title.trim()) return tab.title;
  try {
    return new URL(tab.url).host || tab.url;
  } catch {
    return tab.url || "Untitled page";
  }
}

/** What a tab wears in the strip, whichever kind it is. */
export function describePanelTab(
  tab: PanelTab,
  browser?: BrowserState,
): { label: string; icon: typeof BotIcon; blurb: string; missing?: boolean } {
  const pageId = browserTabId(tab);
  if (pageId === undefined) {
    const surface = SURFACES.find((entry) => entry.id === tab)!;
    return { label: surface.label, icon: surface.icon, blurb: surface.blurb };
  }
  const page = browser?.tabs.find((entry) => entry.id === pageId);
  if (!page) return { label: "Closed page", icon: GlobeIcon, blurb: "This page is no longer open.", missing: true };
  return { label: browserTabLabel(page), icon: GlobeIcon, blurb: page.url };
}

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
  /** How many turns reported a figure, out of how many exist. An em dash means
   *  a figure is MISSING, and this is what lets the surface say so. */
  reported: number;
  turns: number;
};

/** NO `costUsd` FOLD. `UsageSnapshot` still carries the provider's own price and
 *  nothing here reads it — see `UsageSurface` for why money left this cockpit. */
export function sessionUsage(turns: readonly Turn[]): SessionUsage {
  const total = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  let reported = 0;
  for (const turn of turns) {
    if (!turn.usage) continue;
    reported += 1;
    total.input += turn.usage.tokens.input;
    total.output += turn.usage.tokens.output;
    total.cacheRead += turn.usage.tokens.cacheRead;
    total.cacheCreate += turn.usage.tokens.cacheCreate;
  }
  return { ...(reported > 0 ? total : {}), reported, turns: turns.length };
}

const LIVE_TASK_STATES = new Set<TaskState>(["pending", "running", "waiting"]);

export function isLiveTask(task: Task): boolean {
  return LIVE_TASK_STATES.has(task.state);
}

/** The rail's one mapping from engine state to the five-colour vocabulary. */
export function taskTone(state: TaskState): PanelTone {
  if (state === "failed") return "danger";
  if (state === "waiting") return "attention";
  if (state === "running" || state === "pending") return "active";
  if (state === "completed") return "done";
  return "none";
}

// ── presentation ───────────────────────────────────────────────────────────

/** An absent figure is an em dash, never a zero — a session that reported
 *  nothing and a session that spent nothing are different facts. */
function figure(value: number | undefined): string {
  return value === undefined ? "—" : value.toLocaleString("en-US");
}


const CHANGE_KIND: Partial<Record<FileChangeKind, string>> = {
  create: "new",
  delete: "deleted",
  rename: "renamed",
};

const CHANGE_TONE: Partial<Record<FileChangeKind, PanelTone>> = {
  create: "done",
  delete: "danger",
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

/** A unified diff, tinted by line. The transcript carries its own copy; one
 *  shared `<Diff>` is worth extracting the next time both files are open. */
function Diff({ diff }: { diff: string }) {
  return (
    <pre className="mx-3 mb-2 max-h-72 overflow-auto rounded-md bg-muted/40 p-2 font-mono text-[10px] leading-relaxed">
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
    /* DRAGGABLE ON THE WRAPPER, NOT THE BUTTON. A draggable <button> fights its
       own click on every browser that has ever shipped; the wrapper carries the
       gesture and the button keeps the press. */
    <div draggable onDragStart={(event) => startReferenceDrag(event.dataTransfer, fileReference(file.path))}>
      <PanelRow tone={CHANGE_TONE[file.kind] ?? "none"} className="p-0 pl-0">
        <button
          type="button"
          className={cn("flex w-full min-w-0 items-center gap-1.5 py-2 pr-3 pl-4 text-left text-xs", file.unifiedDiff && "hover:bg-muted/60")}
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
      </PanelRow>
      {open && file.unifiedDiff && <Diff diff={file.unifiedDiff} />}
      {open && file.renamedFrom && <p className="px-4 pb-2 text-[11px] text-muted-foreground">Renamed from {file.renamedFrom}</p>}
    </div>
  );
}

function ChangesSurface({ files }: { files: readonly ChangedFile[] }) {
  if (files.length === 0) {
    return (
      <PanelEmpty icon={<PencilIcon />} title="No file changes yet">
        Every file this session writes, edits, renames or deletes lands here with its diff.
      </PanelEmpty>
    );
  }
  return (
    <div className="flex flex-col">
      {files.map((file) => (
        <FileRow key={file.path} file={file} />
      ))}
    </div>
  );
}

/**
 * ONE PAGE, with the chrome row a browser has and nothing it does not.
 *
 * The address row is the real shape — a page's identity is its URL, and putting
 * it at the top is what makes this read as a browser tab rather than as a card
 * about a browser tab. What is deliberately ABSENT is the viewport: the engine
 * reports each tab's url, title and loading state on the journal and no pixels,
 * so there is nothing to paint below. Drawing a grey rectangle where a page
 * would go would imply a webview that does not exist.
 */
/**
 * How often an open browser tab asks the engine what it is looking at.
 *
 * A SCREENSHOT IS A ROUND TRIP THROUGH CHROMIUM, so this is not a frame rate
 * and must not pretend to be one. Three seconds is fast enough to watch an
 * agent work and slow enough that watching costs less than the work does. It
 * only runs while a browser tab is the visible one.
 */
const BROWSER_POLL_MS = 3_000;

/**
 * The session's browser, WITH PIXELS.
 *
 * WHY THIS IS A POLL AND NOT AN EVENT. `browser.state.changed` is journalled
 * because tabs are history; a screenshot is neither history nor small — one per
 * navigation would dominate the event log inside an hour, and the only one
 * anybody wants is the current one. So the live view is a read, taken while
 * somebody is looking, and nothing is stored.
 *
 * THE PICTURE IS OF THE ACTIVE TAB, WHICH IS NOT ALWAYS THIS ONE. Playwright
 * screenshots the page that has focus, so a background tab shows its address and
 * says the picture belongs elsewhere rather than showing a different page's
 * pixels under this page's title.
 */
function BrowserPageSurface({ pageId, state, sessionId }: { pageId: string; state?: BrowserState; sessionId?: string }) {
  const page = state?.tabs.find((tab) => tab.id === pageId);
  const [snapshot, setSnapshot] = useState<BrowserSnapshot>();
  const live = Boolean(page?.active) && Boolean(sessionId);

  useEffect(() => {
    if (!live || !sessionId) return;
    let cancelled = false;
    const read = async () => {
      try {
        const next = await api.browserState(sessionId, { screenshot: true });
        if (!cancelled) setSnapshot(next.browser);
      } catch {
        // A browser that cannot be described must not break the panel around
        // it: the address row above is still true.
      }
    };
    // No `pending` flag: "waiting" is exactly "live with no snapshot yet", and
    // a second piece of state for it would be one more thing to keep true.
    void read();
    const timer = window.setInterval(() => void read(), BROWSER_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [live, sessionId]);

  if (!page) {
    return (
      <PanelEmpty icon={<GlobeIcon />} title="This page is no longer open">
        The engine closed it, or the session ended. Close this tab when you are done with it.
      </PanelEmpty>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        draggable
        onDragStart={(event) => startReferenceDrag(event.dataTransfer, pageReference({ title: page.title, url: page.url }))}
        title="Drag into the message to reference this page"
        className="flex shrink-0 cursor-grab items-center gap-2 border-b border-border px-3 py-2 active:cursor-grabbing"
      >
        <GlobeIcon className={cn("size-3.5 shrink-0", page.loading ? "text-primary" : "text-muted-foreground")} />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" title={page.url}>
          {page.url || "about:blank"}
        </span>
        {live && !snapshot?.screenshot && <Spinner className="size-3 shrink-0 text-muted-foreground" />}
        {page.loading && <Badge variant="outline" className="shrink-0 px-1 py-0 text-[9px] font-normal">loading</Badge>}
        {page.active && <Badge variant="secondary" className="shrink-0 px-1 py-0 text-[9px] font-normal">active</Badge>}
      </div>
      {snapshot?.screenshot ? (
        <div className="min-h-0 flex-1 overflow-auto bg-muted/40 p-2">
          {/* eslint-disable-next-line @next/next/no-img-element -- a data URL polled from the engine; there is nothing for next/image to optimise */}
          <img
            src={snapshot.screenshot}
            alt={`Screenshot of ${browserTabLabel(page)}`}
            className="w-full rounded-md border border-border shadow-sm"
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <div className="max-w-sm text-center">
            <GlobeIcon className="mx-auto size-8 text-muted-foreground/40" />
            <p className="mt-4 text-sm font-medium">{browserTabLabel(page)}</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {!page.active
                ? "The engine photographs whichever page has focus. This one is in the background, so its address is all there is to show until the agent brings it forward."
                : snapshot?.error
                  ? snapshot.error
                  : snapshot && !snapshot.running
                    ? `The ${BROWSER_PROVIDER[state?.provider ?? "none"]} is no longer running. This page is what it had open when it stopped.`
                    : `Waiting on the first frame from ${BROWSER_PROVIDER[state?.provider ?? "none"]}.`}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function TaskRow({ task }: { task: Task }) {
  const body = task.failure ?? task.resultText;
  const [open, setOpen] = useState(false);
  const tokens = task.usage ? task.usage.tokens.input + task.usage.tokens.output : undefined;
  const RowIcon = task.kind === "background" ? TerminalIcon : BotIcon;

  return (
    <div
      draggable
      onDragStart={(event) =>
        startReferenceDrag(event.dataTransfer, taskReference({ id: task.id, ...(task.title ? { title: task.title } : {}), state: task.state }))
      }
    >
      <PanelRow tone={taskTone(task.state)} className="p-0 pl-0">
        <button
          type="button"
          className={cn("flex w-full min-w-0 items-center gap-1.5 py-2 pr-3 pl-4 text-left text-xs", body && "hover:bg-muted/60")}
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
          <span className={cn("shrink-0 font-mono text-[10px]", task.state === "failed" ? "text-destructive" : "text-muted-foreground")}>
            {TASK_STATE[task.state]}
          </span>
          {body && <ChevronRightIcon className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />}
        </button>
      </PanelRow>
      {open && body && (
        <p className={cn("px-4 pb-2 text-[11px] whitespace-pre-wrap", task.failure ? "text-destructive" : "text-muted-foreground")}>{body}</p>
      )}
    </div>
  );
}

function AgentsSurface({ tasks }: { tasks: readonly Task[] }) {
  const live = tasks.filter(isLiveTask);
  const finished = tasks.filter((task) => !isLiveTask(task));
  if (tasks.length === 0) {
    return (
      <PanelEmpty icon={<BotIcon />} title="Sub-agents appear here as they work">
        A task carries its own title, state and result. Background work — a watch loop, a long shell — is listed the same way and
        can outlive the turn that started it.
      </PanelEmpty>
    );
  }
  return (
    <div className="flex flex-col">
      {live.map((task) => (
        <TaskRow key={task.id} task={task} />
      ))}
      {finished.length > 0 && live.length > 0 && <PanelDivider label={`done · ${finished.length}`} />}
      {finished.map((task) => (
        <TaskRow key={task.id} task={task} />
      ))}
    </div>
  );
}

/**
 * TOKENS, AND NO PRICE. The engine still carries the provider's `costUsd` and
 * this surface deliberately does not read it: only some providers report one, a
 * subscription seat has no per-turn price to report, and the total that results
 * is a number a human cannot act on. Tokens are reported by everything, are
 * what actually runs out, and are the same unit the context gauge speaks.
 */
function UsageSurface({ usage }: { usage: SessionUsage }) {
  const total =
    usage.input === undefined
      ? undefined
      : usage.input + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheCreate ?? 0);
  const rows: Array<[string, string]> = [
    ["Input", figure(usage.input)],
    ["Output", figure(usage.output)],
    ["Cache read", figure(usage.cacheRead)],
    ["Cache write", figure(usage.cacheCreate)],
    ["Total", figure(total)],
  ];
  return (
    <div className="flex flex-col">
      <dl className="flex flex-col">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-2 px-4 py-1.5 text-xs">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="font-mono tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="px-4 py-2 text-[11px] text-muted-foreground">
        {usage.reported === 0
          ? "No turn has reported usage yet. Every figure above is missing, not zero."
          : `Totalled across ${usage.reported} of ${usage.turns} turns. A turn the provider gave no figures for contributes nothing rather than a zero.`}
      </p>
    </div>
  );
}

export function VNextPanelSurface({
  tab,
  files,
  tasks,
  turns,
  browser,
  sessionId,
  sessionTitle,
  projectId,
  branch,
  active,
}: {
  tab: PanelTab;
  files: readonly ChangedFile[];
  tasks: readonly Task[];
  turns: readonly Turn[];
  browser?: BrowserState;
  /** Absent on a session that does not exist yet, which is also a session with
   *  no browser and no repository diff — both surfaces have nothing to poll. */
  sessionId?: string;
  /** The default commit message. Derived from the first message, which is the
   *  best one-line summary of what was asked for that anybody has. */
  sessionTitle?: string;
  /** The GitHub surfaces are PROJECT-scoped: issues belong to the repository,
   *  not to one conversation about it. */
  projectId?: string;
  /** The session's own branch, so its pull request can be marked as its own. */
  branch?: string;
  active?: TurnState;
}) {
  const usage = useMemo(() => sessionUsage(turns), [turns]);
  // The journal's half of the reconciliation, as plain paths.
  const reportedPaths = useMemo(() => files.map((file) => file.path), [files]);
  const pageId = browserTabId(tab);
  if (pageId !== undefined)
    return <BrowserPageSurface pageId={pageId} {...(browser ? { state: browser } : {})} {...(sessionId ? { sessionId } : {})} />;
  if (tab === "changes") return <ChangesSurface files={files} />;
  if (tab === "git")
    return (
      <GitSurface
        {...(sessionId ? { sessionId } : {})}
        {...(projectId ? { projectId } : {})}
        reportedPaths={reportedPaths}
        suggestion={sessionTitle?.trim() || "Session work"}
        {...(active ? { active } : {})}
      />
    );
  if (tab === "issues" || tab === "pulls")
    return <GitHubSurface kind={tab} {...(projectId ? { projectId } : {})} {...(branch ? { branch } : {})} />;
  if (tab === "agents") return <AgentsSurface tasks={tasks} />;
  return <UsageSurface usage={usage} />;
}

/**
 * What the panel shows before you have chosen anything, ported from the donor's
 * `panel-empty-state.tsx`.
 *
 * A card per surface, saying what it holds. This IS the opening gesture — the
 * panel does not pre-open a tab, so the empty state is not a gap to apologise
 * for but the menu itself.
 */
/**
 * ROWS, NOT A CARD GRID.
 *
 * This was a `sm:grid-cols-2` grid of square cards, and `sm:` is a VIEWPORT
 * query — it fires on a wide window even when this panel is 240px, which is how
 * three-word blurbs ended up wrapping one word per line inside 90px columns. A
 * panel cannot use viewport breakpoints to decide its own layout; it does not
 * know how wide it is.
 *
 * A full-width row per surface sidesteps the question entirely: icon, label and
 * one line of description on a single line that truncates, at any width the
 * panel can be dragged to.
 */
function PanelEmptyState({ onOpen, browser }: { onOpen: (tab: PanelTab) => void; browser?: BrowserState }) {
  const pages = browser?.tabs ?? [];
  return (
    <div className="flex h-full flex-col justify-center p-4">
      <div className="mx-auto w-full max-w-sm">
        <PanelsTopLeftIcon className="mx-auto size-7 text-muted-foreground/40" />
        <h2 className="mt-3 text-center font-heading text-sm font-medium">Open a surface</h2>
        <p className="mt-1 text-center text-xs leading-relaxed text-muted-foreground">Choose what to keep beside the conversation.</p>
        <div className="mt-4 flex flex-col gap-1">
          {SURFACES.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              onClick={() => onOpen(candidate.id)}
              className="flex items-center gap-2.5 rounded-lg border border-border px-2.5 py-2 text-left transition-colors hover:bg-muted/60"
            >
              <candidate.icon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium text-foreground">{candidate.label}</span>
                <span className="block truncate text-[11px] text-muted-foreground">{candidate.blurb}</span>
              </span>
            </button>
          ))}
        </div>
        {/* ONE ROW PER PAGE, not one row for "Browser". Opening a page opens
            that page's tab, which is the whole point of the change. */}
        {pages.length > 0 && (
          <>
            <p className="mt-5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Open pages</p>
            <div className="mt-1.5 flex flex-col gap-1">
              {pages.map((page) => (
                <button
                  key={page.id}
                  type="button"
                  onClick={() => onOpen(browserPanelTab(page.id))}
                  className="flex items-center gap-2.5 rounded-lg border border-border px-2.5 py-2 text-left transition-colors hover:bg-muted/60"
                >
                  <GlobeIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium text-foreground">{browserTabLabel(page)}</span>
                    <span className="block truncate font-mono text-[10px] text-muted-foreground">{page.url}</span>
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** The masthead control that opens the panel. Lives in the header rather than on
 *  the panel itself, so the affordance is in the same place whether the panel is
 *  open or shut — and it fades out rather than vanishing, because a control that
 *  disappears takes its neighbours' positions with it. */
export function RailToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <div className="shrink-0 overflow-hidden transition-[width,opacity] duration-200 ease-[cubic-bezier(.22,1,.36,1)] motion-reduce:transition-none" style={{ width: open ? 0 : 32, opacity: open ? 0 : 1 }}>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Open right panel"
        title="Open right panel"
        tabIndex={open ? -1 : 0}
        onClick={onToggle}
        className="shrink-0 text-muted-foreground hover:text-foreground"
      >
        <PanelRightOpenIcon className="size-4" />
      </Button>
    </div>
  );
}

type RightPanelDrag = {
  pointerId: number;
  startWidth: number;
  startX: number;
  width: number;
  raf: number | null;
  pendingWidth: number;
};

/**
 * The panel's left edge, as a drag target.
 *
 * Deltas are INVERTED — the panel grows leftwards, so a pointer moving left must
 * widen it. Painting goes straight to the element's inline style through a rAF
 * rather than through React state: a controlled width would re-render the whole
 * panel, and its surfaces, on every pointer move.
 */
function RightPanelResizeHandle({ panelRef }: { panelRef: RefObject<HTMLElement | null> }) {
  const dragRef = useRef<RightPanelDrag | null>(null);

  /** The panel may grow until the conversation hits its own floor — the point of
   *  an inline panel is that both columns stay usable. */
  const maxWidth = useCallback(() => {
    const available = panelRef.current?.parentElement?.getBoundingClientRect().width ?? window.innerWidth;
    return Math.max(RIGHT_PANEL_MIN_WIDTH, available - RIGHT_PANEL_MAIN_MIN_WIDTH);
  }, [panelRef]);

  const paint = useCallback(
    (drag: RightPanelDrag) => {
      const width = clampSidebarWidth(drag.pendingWidth, RIGHT_PANEL_MIN_WIDTH, maxWidth());
      drag.width = width;
      panelRef.current?.style.setProperty("--right-panel-width", `${width}px`);
    },
    [maxWidth, panelRef],
  );

  const finish = useCallback(
    (pointerId: number) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== pointerId) return;
      if (drag.raf !== null) window.cancelAnimationFrame(drag.raf);
      paint(drag);
      dragRef.current = null;
      setSidebarWidth(RIGHT_PANEL_WIDTH_STORAGE_KEY, drag.width);
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    },
    [paint],
  );

  useEffect(
    () => () => {
      const drag = dragRef.current;
      if (drag?.raf != null) window.cancelAnimationFrame(drag.raf);
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    },
    [],
  );

  return (
    <button
      type="button"
      aria-label="Resize right panel"
      title="Drag to resize right panel"
      className="group/resize absolute inset-y-0 -left-2 z-20 flex w-4 cursor-col-resize touch-none items-center justify-center"
      onPointerDown={(event) => {
        if (event.button !== 0 || !panelRef.current) return;
        event.preventDefault();
        event.stopPropagation();
        const width = panelRef.current.getBoundingClientRect().width;
        dragRef.current = { pointerId: event.pointerId, startWidth: width, startX: event.clientX, width, raf: null, pendingWidth: width };
        event.currentTarget.setPointerCapture(event.pointerId);
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        drag.pendingWidth = drag.startWidth + drag.startX - event.clientX;
        if (drag.raf !== null) return;
        drag.raf = window.requestAnimationFrame(() => {
          const current = dragRef.current;
          if (!current) return;
          current.raf = null;
          paint(current);
        });
      }}
      onPointerUp={(event) => finish(event.pointerId)}
      onPointerCancel={(event) => finish(event.pointerId)}
      onKeyDown={(event) => {
        if (!panelRef.current || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
        event.preventDefault();
        const delta = event.key === "ArrowLeft" ? 16 : -16;
        const width = clampSidebarWidth(panelRef.current.getBoundingClientRect().width + delta, RIGHT_PANEL_MIN_WIDTH, maxWidth());
        panelRef.current.style.setProperty("--right-panel-width", `${width}px`);
        setSidebarWidth(RIGHT_PANEL_WIDTH_STORAGE_KEY, width);
      }}
    >
      <span className="h-10 w-px rounded-full bg-border/60 transition-colors group-hover/resize:bg-foreground/40 group-focus-visible/resize:bg-ring" />
    </button>
  );
}

/**
 * THE PANEL SHELL.
 *
 * ONE CONTINUOUS SURFACE, not a card inside a panel inside a window. It used to
 * be a floating rounded tab-strip above a rounded, bordered, shadowed card on a
 * tinted ground — three nested containers, each with its own edge, to show one
 * list. That is what made it read as something dropped ON the app instead of
 * part of it. Now the panel IS the surface: a flat tab bar flush with the top, a
 * body that runs edge to edge, and a single hairline on the left as the only
 * thing separating it from the conversation.
 *
 * THE TAB BAR MATCHES THE MASTHEAD'S HEIGHT (`min-h-11`) on purpose. The two sit
 * side by side at the top of the window, and a few pixels of disagreement there
 * is the difference between two panes of one app and two apps in one window.
 */
export function VNextRightPanel({
  active,
  sessionId,
  sessionTitle,
  projectId,
  branch,
  items = [],
  tasks = [],
  turns = [],
  events = [],
  tabs,
  tab,
  onTabChange,
  onOpenTab,
  onCloseTab,
  onClose,
}: {
  active?: TurnState;
  /** Absent until the first message creates the session. The browser and git
   *  surfaces are the two that need it — everything else folds records the
   *  cockpit already holds. */
  sessionId?: string;
  /** The default commit message on the git surface. */
  sessionTitle?: string;
  /** GitHub is project-scoped; the branch marks this session's own pull request. */
  projectId?: string;
  branch?: string;
  items?: readonly Item[];
  tasks?: readonly Task[];
  turns?: readonly Turn[];
  events?: readonly EngineEvent[];
  /** Owned by the cockpit, not by the panel: the pinned summary's rows and the
   *  composer's foot are "go there" gestures, and they have to be able to say
   *  WHERE — which means opening a tab that may not be open yet. */
  tabs: readonly PanelTab[];
  tab?: PanelTab;
  onTabChange: (tab: PanelTab) => void;
  onOpenTab: (tab: PanelTab) => void;
  onCloseTab: (tab: PanelTab) => void;
  onClose: () => void;
}) {
  const [fullscreen, setFullscreen] = useState(false);
  const panelRef = useRef<HTMLElement | null>(null);
  const prefs = useSidebarPrefs(RIGHT_PANEL_WIDTH_STORAGE_KEY);
  const width = prefs.width ?? RIGHT_PANEL_DEFAULT_WIDTH;
  const files = useMemo(() => changedFiles(items), [items]);
  const browser = useMemo(() => latestBrowserState(events), [events]);
  const running = tasks.filter(isLiveTask).length;
  const failed = tasks.filter((task) => task.state === "failed").length;
  const counts: Partial<Record<PanelTab, number>> = { changes: files.length, agents: tasks.length };
  /** Everything openable that is not already open — fixed surfaces first, then
   *  one entry per browser page the engine currently reports. */
  const openable: { id: PanelTab; label: string; icon: typeof BotIcon }[] = [
    ...SURFACES.filter((surface) => !tabs.includes(surface.id)).map((surface) => ({
      id: surface.id as PanelTab,
      label: surface.label,
      icon: surface.icon,
    })),
    ...(browser?.tabs ?? [])
      .filter((page) => !tabs.includes(browserPanelTab(page.id)))
      .map((page) => ({ id: browserPanelTab(page.id), label: browserTabLabel(page), icon: GlobeIcon })),
  ];

  return (
    /**
     * ALWAYS AN INLINE COLUMN — never an overlay.
     *
     * The donor made this a drawer that floated over the conversation below
     * 1180px, and that is the wrong trade for what this panel is FOR: you open
     * it to watch a fan-out or read a diff WHILE the conversation is still
     * there. A sheet that covers the transcript makes watching and working
     * mutually exclusive. As a flex sibling it takes real width instead, so the
     * transcript, the composer and the masthead all narrow to make room.
     *
     * `min-w-0` matters on a flex child that owns a horizontal scroller: without
     * it a wide diff sets the panel's min-content width and the panel refuses to
     * shrink, squeezing the conversation instead of scrolling itself.
     */
    <aside
      ref={panelRef}
      aria-label="Right panel"
      style={fullscreen ? undefined : ({ "--right-panel-width": `${width}px` } as CSSProperties)}
      className={cn(
        "relative flex shrink-0 flex-col border-l border-border bg-background",
        // `min-w-80` is a FLOOR, not a preference. Below ~320px this stops being
        // a panel and becomes a column of truncation — the tab strip alone eats
        // it. Better to squeeze the conversation, which can scroll, than to keep
        // a panel that cannot show anything. `max-w` shares its number with the
        // drag clamp so the two cannot disagree (lib/right-panel-layout.ts).
        fullscreen ? "min-w-0 flex-1" : "w-(--right-panel-width) min-w-80 max-w-[calc(100%-24rem)]",
      )}
    >
      {!fullscreen && <RightPanelResizeHandle panelRef={panelRef} />}

      <div className="flex min-h-11 shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
        <div role="tablist" aria-label="Right panel tabs" className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
          {tabs.map((id) => {
            const on = id === tab;
            const { label, icon: Icon, missing } = describePanelTab(id, browser);
            const count = counts[id];
            return (
              <span
                key={id}
                className={cn(
                  "group/tab relative flex h-7 min-w-0 max-w-44 shrink-0 items-center rounded-md px-1.5 text-xs transition-colors",
                  on ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                  // A page the engine has since closed still has a tab, because
                  // you opened it and only you should close it — but it should
                  // not look live.
                  missing && "opacity-60",
                )}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={on}
                  aria-controls={`right-panel-${id}`}
                  onClick={() => onTabChange(id)}
                  // Middle-click closes, the way a browser tab does.
                  onAuxClick={(event) => {
                    if (event.button === 1) {
                      event.preventDefault();
                      onCloseTab(id);
                    }
                  }}
                  title={label}
                  className="flex min-w-0 flex-1 items-center gap-1.5 outline-none"
                >
                  <Icon className="size-3.5 shrink-0" />
                  <span className="truncate">{label}</span>
                  {count ? (
                    <span
                      className={cn(
                        "ml-auto inline-flex min-w-4 shrink-0 items-center justify-center rounded-full px-1 font-mono text-[9px] leading-4",
                        id === "agents" && failed > 0
                          ? "bg-destructive/15 text-destructive"
                          : id === "agents" && running > 0
                            ? "bg-primary/15 text-primary"
                            : "bg-muted-foreground/15 text-muted-foreground",
                      )}
                      title={id === "agents" && running > 0 ? `${running} running` : undefined}
                    >
                      {count}
                    </span>
                  ) : null}
                </button>
                <button
                  type="button"
                  aria-label={`Close ${label}`}
                  onClick={() => onCloseTab(id)}
                  className={cn(
                    "ml-1 rounded p-0.5 text-muted-foreground transition-opacity hover:bg-background hover:text-foreground focus-visible:opacity-100",
                    on ? "opacity-70" : "opacity-0 group-hover/tab:opacity-70",
                  )}
                >
                  <XIcon className="size-3" />
                </button>
              </span>
            );
          })}
          {openable.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button
                    type="button"
                    aria-label="Open a surface"
                    title="Open a surface"
                    className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  />
                }
              >
                <PlusIcon className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56">
                {openable.map((candidate) => (
                  <DropdownMenuItem key={candidate.id} onClick={() => onOpenTab(candidate.id)}>
                    <candidate.icon />
                    <span className="truncate">{candidate.label}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            aria-label={fullscreen ? "Exit fullscreen" : "Fill the window"}
            title={fullscreen ? "Exit fullscreen" : "Fill the window"}
            onClick={() => setFullscreen((current) => !current)}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {fullscreen ? <Minimize2Icon className="size-4" /> : <Maximize2Icon className="size-4" />}
          </button>
          <button
            type="button"
            aria-label="Close right panel"
            title="Close right panel"
            onClick={onClose}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <PanelRightCloseIcon className="size-4" />
          </button>
        </div>
      </div>

      <div
        {...(tab ? { id: `right-panel-${tab}`, role: "tabpanel" } : {})}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {tab ? (
          <>
            {/* The active turn's state, in the machine's register: one word
                saying what the record below is currently doing. */}
            {active && browserTabId(tab) === undefined && (
              <p className="px-4 pt-2 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground/60">{active}</p>
            )}
            <VNextPanelSurface
              tab={tab}
              files={files}
              tasks={tasks}
              turns={turns}
              {...(browser ? { browser } : {})}
              {...(sessionId ? { sessionId } : {})}
              {...(sessionTitle ? { sessionTitle } : {})}
              {...(projectId ? { projectId } : {})}
              {...(branch ? { branch } : {})}
              {...(active ? { active } : {})}
            />
          </>
        ) : (
          <PanelEmptyState onOpen={onOpenTab} {...(browser ? { browser } : {})} />
        )}
      </div>
    </aside>
  );
}
