"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import {
  BotIcon,
  ChevronRightIcon,
  CircleDotIcon,
  FileDiffIcon,
  FolderTreeIcon,
  GitPullRequestIcon,
  FileIcon,
  GlobeIcon,
  LayersIcon,
  Maximize2Icon,
  Minimize2Icon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  PanelsTopLeftIcon,
  PlusIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react";
import type {
  BrowserProvider,
  BrowserSnapshot,
  BrowserTab,
  EngineEvent,
  Item,
  Task,
  TaskState,
  TurnState,
} from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import type { JournalTask } from "@/lib/engine/journal";
import { pageReference, startReferenceDrag, taskReference } from "@/lib/drag-reference";
import { TranscriptItem } from "@/components/transcript";
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
import { DiffSurface } from "@/components/session/diff-surface";
import { FilesSurface } from "@/components/session/files-surface";
import { FileViewSurface } from "@/components/session/file-view-surface";
import { ForgeDetailSurface } from "@/components/session/github-detail-surface";
import { GitHubSurface } from "@/components/session/github-surface";
import { cn } from "@/lib/utils";

/** The panel reads the engine directly for the one thing the journal cannot
 *  carry: the browser's current pixels. Everything else on this surface is a
 *  fold over records the cockpit already has. */
const api = createEngineApi();

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
  /**
   * DIFF AND FILES, WHICH USED TO BE CHANGES AND GIT — and the old pair was a
   * duplicate wearing two names. "Changes" folded the journal and "Git" read the
   * disk, but both drew a list of changed files with `+`/`−` counts and an
   * expandable patch, one click apart in the same strip. Meanwhile nothing in the
   * cockpit could show a file that had NOT changed, which is most of a repository.
   *
   * So: one tab for what moved, backed by the disk and annotated by the journal
   * (session/diff-surface.tsx), and one for what is there (session/files-surface.tsx).
   */
  { id: "diff", label: "Diff", icon: FileDiffIcon, blurb: "What this conversation changed, and what it did not mention." },
  { id: "files", label: "Files", icon: FolderTreeIcon, blurb: "The checkout, as a tree. Drag a file into the message." },
  /**
   * THE TWO NETWORK SURFACES, and the only two. Everything above folds records
   * the cockpit already holds; these go out to GitHub through the `gh` CLI, so
   * they never poll and they always say how old their answer is.
   */
  { id: "issues", label: "Issues", icon: CircleDotIcon, blurb: "Open issues. Drag one into the message." },
  { id: "pulls", label: "Pull requests", icon: GitPullRequestIcon, blurb: "Open pull requests, and this session's own." },
] as const;

type SurfaceId = (typeof SURFACES)[number]["id"];

/**
 * A panel tab is a fixed surface, ONE BROWSER PAGE, or ONE FILE.
 *
 * Pages used to be stacked inside a single "Browser" tab, which made the panel
 * disagree with every browser anyone has ever used: two open pages were one tab
 * containing a list, so switching between them was a click into a row rather
 * than a click on a tab, and neither page could be closed on its own. A page is
 * a tab — that is what a tab IS — so each one gets its own, keyed by the
 * engine's tab id.
 *
 * A FILE IS THE SAME KIND OF THING, and gets the same treatment. It is not a fold
 * over the session record; it is something a person opened from the tree and will
 * close when they are done with it. The alternative — a preview pane under the
 * tree — splits a 320px column into two unreadable halves (see
 * session/file-view-surface.tsx).
 */
export type PanelTab = SurfaceId | `browser:${string}` | `file:${string}` | `issue:${number}` | `pull:${number}`;

const BROWSER_PREFIX = "browser:";
const FILE_PREFIX = "file:";
const ISSUE_PREFIX = "issue:";
const PULL_PREFIX = "pull:";

export function browserPanelTab(tabId: string): PanelTab {
  return `${BROWSER_PREFIX}${tabId}`;
}

/** The engine tab id behind a panel tab, or undefined for anything else. */
export function browserTabId(tab: PanelTab): string | undefined {
  return tab.startsWith(BROWSER_PREFIX) ? tab.slice(BROWSER_PREFIX.length) : undefined;
}

export function filePanelTab(path: string): PanelTab {
  return `${FILE_PREFIX}${path}`;
}

/** The workspace-relative path behind a panel tab, or undefined for anything
 *  else. A path may contain a colon, so this splits on the FIRST one only. */
export function filePanelPath(tab: PanelTab): string | undefined {
  return tab.startsWith(FILE_PREFIX) ? tab.slice(FILE_PREFIX.length) : undefined;
}

/** Every open file, as plain paths — what the tree marks as already open. */
export function openFilePaths(tabs: readonly PanelTab[]): string[] {
  return tabs.map(filePanelPath).filter((path): path is string => path !== undefined);
}

/**
 * ONE ISSUE OR ONE PULL REQUEST IS ALSO A TAB, and for the third time the same
 * argument: you opened it, several can be open, each closes on its own, and the
 * arrangement survives a reload. The alternative — a drill-down inside the list
 * surface with a back button — would make reading two issues at once impossible
 * and would put a navigation stack inside a panel that already has tabs.
 */
export function issuePanelTab(number: number): PanelTab {
  return `${ISSUE_PREFIX}${number}`;
}

export function pullPanelTab(number: number): PanelTab {
  return `${PULL_PREFIX}${number}`;
}

/** The number behind an `issue:`/`pull:` tab, or undefined for anything else.
 *  Parsed strictly: `issue:12abc` is not a tab this build understands, and
 *  restoring it would open a surface that can only ask gh a question with no
 *  answer. */
function forgeNumber(tab: PanelTab, prefix: string): number | undefined {
  if (!tab.startsWith(prefix)) return undefined;
  const digits = tab.slice(prefix.length);
  if (!/^\d+$/.test(digits)) return undefined;
  const number = Number(digits);
  return number > 0 ? number : undefined;
}

export function issuePanelNumber(tab: PanelTab): number | undefined {
  return forgeNumber(tab, ISSUE_PREFIX);
}

export function pullPanelNumber(tab: PanelTab): number | undefined {
  return forgeNumber(tab, PULL_PREFIX);
}

/**
 * The tabs whose surface fills the panel itself.
 *
 * Each of these renders `h-full` with its own header and its own scroller, so the
 * panel must put NOTHING above them — a single line of chrome pushes the bottom of
 * an `h-full` child past the bottom of the box, and what it takes with it is the
 * scroll. Found the hard way: an issue's comments were unreachable because one
 * ten-pixel status line was sitting above them.
 */
const OWNS_ITS_HEIGHT: ((tab: PanelTab) => boolean)[] = [
  (tab) => browserTabId(tab) !== undefined,
  (tab) => filePanelPath(tab) !== undefined,
  (tab) => issuePanelNumber(tab) !== undefined,
  (tab) => pullPanelNumber(tab) !== undefined,
  (tab) => tab === "files",
];

/** Which numbers are already open, so a list row can say so instead of opening a
 *  second tab for the same issue. The same courtesy the file tree does. */
export function openForgeNumbers(tabs: readonly PanelTab[], kind: "issue" | "pull"): number[] {
  const read = kind === "issue" ? issuePanelNumber : pullPanelNumber;
  return tabs.map(read).filter((number): number is number => number !== undefined);
}

/** Anything shaped like a tab id this build understands — the validator for
 *  what comes back out of localStorage. A browser page whose id is no longer
 *  open is still KNOWN; the surface says so rather than the tab vanishing. A
 *  file that has since been deleted is the same: its tab reports that. */
export function isPanelTab(value: string): value is PanelTab {
  if (value.startsWith(BROWSER_PREFIX)) return true;
  // A bare `file:` names nothing, and would restore as a tab that can only fail.
  if (value.startsWith(FILE_PREFIX)) return value.length > FILE_PREFIX.length;
  // `issue:` and `pull:` must carry a number, because the surface behind them
  // asks gh for exactly that number.
  if (value.startsWith(ISSUE_PREFIX) || value.startsWith(PULL_PREFIX)) {
    return forgeNumber(value as PanelTab, value.startsWith(ISSUE_PREFIX) ? ISSUE_PREFIX : PULL_PREFIX) !== undefined;
  }
  return SURFACES.some((surface) => surface.id === value);
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
  // A FILE WEARS ITS BASENAME. `apps/web/components/right-panel.tsx` in a
  // 44px-wide tab is `apps/vnex…`, which names nothing; the full path is the
  // tooltip and the surface's own header.
  const path = filePanelPath(tab);
  if (path !== undefined) return { label: path.split("/").at(-1) || path, icon: FileIcon, blurb: path };
  /**
   * AN ISSUE WEARS ITS NUMBER, not its title.
   *
   * `#82` is the shortest thing that identifies it and the thing a person says
   * out loud; a truncated title in a 44px tab (`Navigation fr…`) is longer, less
   * recognisable, and would have to be fetched before the tab could be drawn — so
   * a restored tab would have no label until the network answered.
   */
  const issueNumber = issuePanelNumber(tab);
  if (issueNumber !== undefined) return { label: `#${issueNumber}`, icon: CircleDotIcon, blurb: `Issue #${issueNumber}` };
  const pullNumber = pullPanelNumber(tab);
  if (pullNumber !== undefined) return { label: `#${pullNumber}`, icon: GitPullRequestIcon, blurb: `Pull request #${pullNumber}` };
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

/**
 * WHAT THE TRANSCRIPT SAYS THIS SESSION WROTE: path → how many times.
 *
 * A MAP, NOT A LIST OF ROWS. This used to build a full `ChangedFile` — kind,
 * patch, line counts, sort order — because the journal had a surface of its own
 * to render. It does not any more: Changes and Git were the same list twice, so
 * there is one Diff surface and git is its witness (see session/diff-surface.tsx).
 * What survives is the half of the reconciliation only the journal can supply, and
 * the count is the one fact git genuinely cannot state — a file rewritten four
 * times has the same net diff as a file written once.
 */
export function journalWrites(items: readonly Item[]): Map<string, number> {
  const writes = new Map<string, number>();
  for (const item of items) {
    if (item.detail.type !== "file_change") continue;
    // A declined change never ran and a failed one never landed. Counting either
    // would claim the session edited a file it did not.
    if (item.status === "declined" || item.status === "failed") continue;
    const path = item.detail.change.path;
    writes.set(path, (writes.get(path) ?? 0) + 1);
  }
  return writes;
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

const LIVE_TASK_STATES = new Set<TaskState>(["pending", "running", "waiting"]);

/**
 * WHICH SUB-AGENT TO OPEN ON, AND HOW MANY TIMES IT HAS BEEN ASKED FOR.
 *
 * The count is not decoration: without it, pressing the same chip after
 * collapsing its row would be a press that does nothing, because nothing about
 * the request would have changed.
 */
export type TaskFocus = { id: string; nonce: number };

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

/**
 * ONE SUB-AGENT, AND ITS OWN TRANSCRIPT.
 *
 * THIS IS WHERE THE STEPS LIVE, now that the conversation carries a chip rather
 * than a lane. Reading it was the missing half of moving them out: a row that
 * expands to a paragraph of result told you what the agent concluded and nothing
 * about how, so "what did it actually run" had no home at all.
 *
 * OPEN BY DEFAULT WHEN IT IS THE ONE YOU CAME FOR. Pressing a chip in the
 * transcript names a task; arriving to find it closed among five others would
 * make the gesture a navigation that lands you next to the answer.
 */
function TaskRow({ task, focused }: { task: JournalTask; focused?: boolean }) {
  const body = task.failure ?? task.resultText;
  const steps = task.items ?? [];
  const detail = steps.length > 0 || Boolean(body);
  /**
   * OPEN BECAUSE OF HOW YOU ARRIVED, decided once at mount rather than synced
   * from a prop. A repeat press produces a fresh `key` (see `AgentsSurface`), so
   * this row is a new one every time a chip asks for it — which is what lets a
   * reader collapse a focused row and press the same chip again to reopen it.
   */
  const [open, setOpen] = useState(Boolean(focused));
  const anchor = useRef<HTMLDivElement>(null);
  const tokens = task.usage ? task.usage.tokens.input + task.usage.tokens.output : undefined;
  const RowIcon = task.kind === "background" ? TerminalIcon : BotIcon;

  useEffect(() => {
    if (focused) anchor.current?.scrollIntoView({ block: "nearest" });
  }, [focused]);

  return (
    <div
      ref={anchor}
      draggable
      onDragStart={(event) =>
        startReferenceDrag(event.dataTransfer, taskReference({ id: task.id, ...(task.title ? { title: task.title } : {}), state: task.state }))
      }
    >
      <PanelRow tone={taskTone(task.state)} className="p-0 pl-0">
        <button
          type="button"
          className={cn("flex w-full min-w-0 items-center gap-1.5 py-2 pr-3 pl-4 text-left text-xs", detail && "hover:bg-muted/60")}
          disabled={!detail}
          aria-expanded={detail ? open : undefined}
          onClick={() => setOpen((current) => !current)}
        >
          <RowIcon className={cn("size-3.5 shrink-0", task.state === "failed" ? "text-destructive" : "text-muted-foreground")} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate">{task.title ?? task.role ?? "Sub-agent"}</span>
            {task.role && task.title && <span className="truncate text-[10px] text-muted-foreground">{task.role}</span>}
          </span>
          {steps.length > 0 && (
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {steps.length} step{steps.length === 1 ? "" : "s"}
            </span>
          )}
          {tokens !== undefined && <span className="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">{figure(tokens)}</span>}
          <span className={cn("shrink-0 font-mono text-[10px]", task.state === "failed" ? "text-destructive" : "text-muted-foreground")}>
            {TASK_STATE[task.state]}
          </span>
          {detail && <ChevronRightIcon className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />}
        </button>
      </PanelRow>
      {open && detail && (
        <div className="flex flex-col gap-0.5 px-4 pb-2 text-xs">
          {steps.map((item) => (
            <TranscriptItem key={item.id} item={item} />
          ))}
          {body && (
            <p className={cn("pt-1 text-[11px] whitespace-pre-wrap", task.failure ? "text-destructive" : "text-muted-foreground")}>{body}</p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A WARP RUN AND ITS AGENTS, folded out of the one task stream.
 *
 * NOT A SECOND RAIL. The frozen cockpit needed a whole separate surface for an
 * Ultra run plus a third for ordinary sub-agents, because the legacy harness
 * kept its runs in its own storage. Here a run is a `background` task and its
 * agents are `agent` tasks carrying `warp` linkage, so this is a GROUPING of
 * rows the pane already receives — which is what makes it impossible for the
 * progress tree and the roster to disagree.
 */
type WarpPhaseGroup = { key: string; title?: string; index: number; agents: JournalTask[] };
type WarpGroup = { runId: string; name: string; run?: JournalTask; phases: WarpPhaseGroup[] };

/** Split the roster into warp runs and everything else, preserving order. */
export function groupWarps(tasks: readonly JournalTask[]): { groups: WarpGroup[]; loose: JournalTask[] } {
  const groups = new Map<string, WarpGroup>();
  const loose: JournalTask[] = [];

  for (const task of tasks) {
    const linkage = task.warp;
    if (!linkage) {
      loose.push(task);
      continue;
    }
    const group = groups.get(linkage.warpRunId) ?? { runId: linkage.warpRunId, name: linkage.warpName, phases: [] };
    groups.set(linkage.warpRunId, group);
    // The run's own row points its linkage at ITSELF, which is how a run stays
    // identifiable once its children have aged out of retention.
    if (task.id === linkage.warpRunId) {
      group.run = task;
      continue;
    }
    /**
     * PHASES ARE KEYED BY TITLE, not by index. A script may open a phase the
     * `meta` never declared — `phase("Improvised")` is legal — and those rows
     * carry a title with no index at all. Keying on the index would collapse
     * every improvised phase into one unnamed bucket.
     */
    const key = linkage.phaseTitle ?? "";
    let phase = group.phases.find((candidate) => candidate.key === key);
    if (!phase) {
      // Declared phases sort by their declared position; an improvised one has
      // no position and sorts after, in the order it first appeared.
      phase = { key, index: linkage.phaseIndex ?? Number.MAX_SAFE_INTEGER, agents: [], ...(linkage.phaseTitle ? { title: linkage.phaseTitle } : {}) };
      group.phases.push(phase);
    }
    phase.agents.push(task);
  }

  for (const group of groups.values()) {
    group.phases.sort((a, b) => a.index - b.index);
    // Within a phase, the order the script asked for them in — which is the
    // order a reader watched them queue.
    for (const phase of group.phases) {
      phase.agents.sort((a, b) => (a.warp?.agentIndex ?? 0) - (b.warp?.agentIndex ?? 0));
    }
  }
  return { groups: [...groups.values()], loose };
}

const warpAgents = (group: WarpGroup): JournalTask[] => group.phases.flatMap((phase) => phase.agents);

function WarpGroupRow({ group, focused }: { group: WarpGroup; focused?: TaskFocus }) {
  const agents = warpAgents(group);
  const live = agents.filter(isLiveTask).length;
  const done = agents.filter((task) => task.state === "completed").length;
  const failed = agents.filter((task) => task.state === "failed").length;
  const state = group.run?.state ?? (live > 0 ? "running" : "completed");
  /**
   * OPEN WHILE IT IS WORKING, and open when a chip asked for something inside
   * it — a gesture that lands on a collapsed group is a gesture that appears to
   * do nothing. A settled run collapses, because the interesting thing about a
   * finished fan-out is its result, not its twelve rows.
   *
   * DECIDED ONCE AT MOUNT, never synced from a prop, which is the same trick
   * `TaskRow` uses one level down: `AgentsSurface` puts the focus nonce in this
   * group's KEY, so a chip pointing inside it mounts a fresh group that opens on
   * its own. Syncing it in an effect instead would cascade a render — and would
   * also fight a reader who deliberately collapsed a group that still holds the
   * focused row.
   */
  const [open, setOpen] = useState(live > 0 || (focused !== undefined && agents.some((task) => task.id === focused.id)));

  const tokens = agents.reduce((sum, task) => sum + (task.usage ? task.usage.tokens.input + task.usage.tokens.output : 0), 0);

  return (
    <div>
      <PanelRow tone={taskTone(state)} className="p-0 pl-0">
        <button
          type="button"
          className="flex w-full min-w-0 items-center gap-1.5 py-2 pr-3 pl-4 text-left text-xs hover:bg-muted/60"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          <LayersIcon className={cn("size-3.5 shrink-0", failed > 0 ? "text-destructive" : "text-muted-foreground")} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate">{group.name}</span>
            <span className="truncate text-[10px] text-muted-foreground">
              {/* COUNTED, NOT SUMMARISED. "12 agents" while eight are still
                  queued reads as twelve running; the split is the progress. */}
              {agents.length} agent{agents.length === 1 ? "" : "s"}
              {live > 0 ? ` · ${live} running` : ""}
              {done > 0 ? ` · ${done} done` : ""}
              {failed > 0 ? ` · ${failed} failed` : ""}
            </span>
          </span>
          {tokens > 0 && <span className="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">{figure(tokens)}</span>}
          <span className={cn("shrink-0 font-mono text-[10px]", state === "failed" ? "text-destructive" : "text-muted-foreground")}>
            {TASK_STATE[state]}
          </span>
          <ChevronRightIcon className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        </button>
      </PanelRow>
      {open && (
        <div className="border-border/60 border-l pl-1">
          {group.phases.map((phase) => (
            <div key={phase.key}>
              {/* An unnamed group is not labelled: a script that opened no phase
                  has one bucket, and "—" above it is noise. */}
              {phase.title && <PanelDivider label={phase.title} />}
              {phase.agents.map((task) =>
                focused?.id === task.id ? (
                  <TaskRow key={`${task.id}:${focused.nonce}`} task={task} focused />
                ) : (
                  <TaskRow key={task.id} task={task} />
                ),
              )}
            </div>
          ))}
          {group.run?.failure && <p className="px-4 py-2 text-[11px] text-destructive">{group.run.failure}</p>}
        </div>
      )}
    </div>
  );
}

function AgentsSurface({ tasks, focused }: { tasks: readonly JournalTask[]; focused?: TaskFocus }) {
  const { groups, loose } = useMemo(() => groupWarps(tasks), [tasks]);
  if (tasks.length === 0) {
    return (
      <PanelEmpty icon={<BotIcon />} title="Sub-agents appear here as they work">
        A task carries its own title, state and result. Background work — a watch loop, a long shell — is listed the same way and
        can outlive the turn that started it. A Warp run is one row holding its own agents.
      </PanelEmpty>
    );
  }
  const live = loose.filter(isLiveTask);
  const finished = loose.filter((task) => !isLiveTask(task));
  /** THE NONCE IS IN THE KEY, which is what makes pressing the same chip twice
   *  do something the second time: a new key is a new row, opened and scrolled
   *  to on its own mount. */
  const row = (task: JournalTask) =>
    focused?.id === task.id ? (
      <TaskRow key={`${task.id}:${focused.nonce}`} task={task} focused />
    ) : (
      <TaskRow key={task.id} task={task} />
    );
  return (
    <div className="flex flex-col">
      {/* RUNS FIRST, whatever their state. A fan-out is the largest thing on
          this surface and burying a finished one under twelve loose rows makes
          the roster read as though nothing was organised at all. */}
      {groups.map((group) => {
        // THE NONCE IS IN THE KEY here for the same reason it is on a task row:
        // a fresh key is a fresh group, opened on its own mount, so pressing the
        // same chip after collapsing the group opens it again.
        const holdsFocus = focused !== undefined && warpAgents(group).some((task) => task.id === focused.id);
        return (
          <WarpGroupRow
            key={holdsFocus ? `${group.runId}:${focused.nonce}` : group.runId}
            group={group}
            {...(focused ? { focused } : {})}
          />
        );
      })}
      {groups.length > 0 && loose.length > 0 && <PanelDivider label="other work" />}
      {live.map(row)}
      {finished.length > 0 && live.length > 0 && <PanelDivider label={`done · ${finished.length}`} />}
      {finished.map(row)}
    </div>
  );
}

export function PanelSurface({
  tab,
  writes,
  tasks,
  focusedTask,
  browser,
  sessionId,
  sessionTitle,
  projectId,
  branch,
  openPaths,
  openIssueNumbers,
  openPullNumbers,
  onOpenTab,
  active,
}: {
  tab: PanelTab;
  /** What the journal says was written, path → count. The Diff surface's half of
   *  the reconciliation — see `journalWrites`. */
  writes: ReadonlyMap<string, number>;
  tasks: readonly JournalTask[];
  /** The sub-agent a transcript chip just asked for. */
  focusedTask?: TaskFocus;
  browser?: BrowserState;
  /** Absent on a session that does not exist yet. Every surface that needs a
   *  checkout falls back to the project's own, which is the same directory until
   *  the session cuts a worktree. */
  sessionId?: string;
  /** The default commit message. Derived from the first message, which is the
   *  best one-line summary of what was asked for that anybody has. */
  sessionTitle?: string;
  /** The GitHub surfaces are PROJECT-scoped: issues belong to the repository,
   *  not to one conversation about it. */
  projectId?: string;
  /** The session's own branch, so its pull request can be marked as its own. */
  branch?: string;
  /** Files already open as tabs, so the tree can mark them. */
  openPaths?: readonly string[];
  /** Issues and pull requests already open as tabs, for the same reason. */
  openIssueNumbers?: readonly number[];
  openPullNumbers?: readonly number[];
  /** The tree opens a file by opening a TAB, which the panel owns. */
  onOpenTab: (tab: PanelTab) => void;
  active?: TurnState;
}) {
  const filePath = filePanelPath(tab);
  if (filePath !== undefined)
    return (
      <FileViewSurface
        path={filePath}
        {...(sessionId ? { sessionId } : {})}
        {...(projectId ? { projectId } : {})}
        {...(active ? { active } : {})}
      />
    );
  const issueNumber = issuePanelNumber(tab);
  if (issueNumber !== undefined)
    return <ForgeDetailSurface kind="issue" number={issueNumber} {...(projectId ? { projectId } : {})} />;
  const pullNumber = pullPanelNumber(tab);
  if (pullNumber !== undefined)
    return <ForgeDetailSurface kind="pull" number={pullNumber} {...(projectId ? { projectId } : {})} {...(branch ? { branch } : {})} />;
  const pageId = browserTabId(tab);
  if (pageId !== undefined)
    return <BrowserPageSurface pageId={pageId} {...(browser ? { state: browser } : {})} {...(sessionId ? { sessionId } : {})} />;
  if (tab === "diff")
    return (
      <DiffSurface
        {...(sessionId ? { sessionId } : {})}
        {...(projectId ? { projectId } : {})}
        reported={writes}
        suggestion={sessionTitle?.trim() || "Session work"}
        {...(active ? { active } : {})}
      />
    );
  if (tab === "files")
    return (
      <FilesSurface
        {...(sessionId ? { sessionId } : {})}
        {...(projectId ? { projectId } : {})}
        {...(openPaths ? { openPaths } : {})}
        onOpenFile={(path) => onOpenTab(filePanelTab(path))}
        {...(active ? { active } : {})}
      />
    );
  if (tab === "issues" || tab === "pulls")
    return (
      <GitHubSurface
        kind={tab}
        {...(projectId ? { projectId } : {})}
        {...(branch ? { branch } : {})}
        onOpen={(number) => onOpenTab(tab === "issues" ? issuePanelTab(number) : pullPanelTab(number))}
        openNumbers={tab === "issues" ? openIssueNumbers : openPullNumbers}
      />
    );
  if (tab === "agents") return <AgentsSurface tasks={tasks} {...(focusedTask ? { focused: focusedTask } : {})} />;
  // Every tab kind is handled above. This used to be the Usage surface's arm;
  // as a fallthrough it would render some OTHER pane for an unknown tab id, so
  // an unknown tab now renders nothing rather than the wrong thing.
  return null;
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
export function RightPanelResizeHandle({
  panelRef,
  storageKey = RIGHT_PANEL_WIDTH_STORAGE_KEY,
}: {
  panelRef: RefObject<HTMLElement | null>;
  /**
   * WHICH PANEL'S WIDTH THIS REMEMBERS. Defaulted so every existing caller is
   * unchanged, and parameterised because the Spool's panel is a different panel
   * — sharing one key would make widening a packet resize the cockpit's diff.
   */
  storageKey?: string;
}) {
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
      setSidebarWidth(storageKey, drag.width);
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    },
    [paint, storageKey],
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
        setSidebarWidth(storageKey, width);
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
export function RightPanel({
  active,
  sessionId,
  sessionTitle,
  projectId,
  branch,
  items = [],
  tasks = [],
  focusedTask,
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
  tasks?: readonly JournalTask[];
  /** The sub-agent a transcript chip just asked for. Owned by the cockpit
   *  because the chip that names one lives over there. */
  focusedTask?: TaskFocus;
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
  const writes = useMemo(() => journalWrites(items), [items]);
  const browser = useMemo(() => latestBrowserState(events), [events]);
  const openPaths = useMemo(() => openFilePaths(tabs), [tabs]);
  const openIssueNumbers = useMemo(() => openForgeNumbers(tabs, "issue"), [tabs]);
  const openPullNumbers = useMemo(() => openForgeNumbers(tabs, "pull"), [tabs]);
  /**
   * A WARP RUN IS A CONTAINER, NOT A WORKER, so it is not counted as one:
   * a four-agent fan-out would otherwise read as five running.
   *
   * IT IS STILL COUNTED AS A FAILURE, and the asymmetry is deliberate. A live
   * run's work is its live agents, so counting both double-counts — but a run
   * can fail with every one of its agents completed, when the SCRIPT threw
   * between stages. That failure has no other row to appear on, and a failure
   * nothing flags is the worse of the two errors.
   */
  const isWarpRun = (task: Task): boolean => task.warp?.warpRunId === task.id;
  const running = tasks.filter((task) => isLiveTask(task) && !isWarpRun(task)).length;
  const failed = tasks.filter((task) => task.state === "failed").length;
  /**
   * NO COUNT ON DIFF, deliberately. The badge used to carry the journal's file
   * count, and the surface now lists git's — which is a different, larger number
   * (it includes what nobody narrated). A badge that disagrees with the length of
   * the list underneath it is worse than no badge: it teaches the reader that one
   * of the two is lying, without saying which.
   */
  const counts: Partial<Record<PanelTab, number>> = { agents: tasks.length };
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
                saying what the RECORD below is currently doing. A page, a file,
                the file tree and one issue or pull request are not the record —
                they are things on disk, in a browser and on GitHub — so the word
                would be describing something else. It also has to be absent for
                any surface that fills the panel itself: these tabs own their own
                header and scroller, and a line above them pushes an `h-full`
                child past the bottom of the box. */}
            {active && OWNS_ITS_HEIGHT.every((holds) => !holds(tab)) && (
              <p className="px-4 pt-2 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground/60">{active}</p>
            )}
            <PanelSurface
              tab={tab}
              writes={writes}
              tasks={tasks}
              {...(focusedTask ? { focusedTask } : {})}
              openPaths={openPaths}
              openIssueNumbers={openIssueNumbers}
              openPullNumbers={openPullNumbers}
              onOpenTab={onOpenTab}
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
