"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import {
  BotIcon,
  ChevronRightIcon,
  CircleDotIcon,
  FlaskConicalIcon,
  SigmaIcon,
  NotebookIcon,
  TableIcon,
  FileCode2Icon,
  FileDiffIcon,
  GitPullRequestIcon,
  FileIcon,
  GlobeIcon,
  LayersIcon,
  Maximize2Icon,
  Minimize2Icon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  PanelsTopLeftIcon,
  PlayIcon,
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
import { DesktopBrowserSurface, desktopBrowserBridge } from "@/components/browser-live";
import type { JournalTask } from "@/lib/engine/journal";
import { browserPageReference, startReferenceDrag, taskReference } from "@/lib/drag-reference";
import { TranscriptItem } from "@/components/transcript";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { PanelDivider, PanelEmpty, PanelRow, type PanelTone } from "@/components/ui/panel";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useNativeViewOverlay } from "@/lib/native-view-overlay";
import { clampSidebarWidth, setSidebarWidth, useSidebarPrefs } from "@/lib/sidebar-width";
import {
  RIGHT_PANEL_DEFAULT_WIDTH,
  RIGHT_PANEL_MAIN_MIN_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
  RIGHT_PANEL_WIDTH_STORAGE_KEY,
} from "@/lib/right-panel-layout";
import { DiffSurface } from "@/components/session/diff-surface";
import { EditorSurface } from "@/components/session/editor-surface";
import { FileViewSurface } from "@/components/session/file-view-surface";
import { NotebookSurface } from "@/components/session/notebook-surface";
import { PdfSurface } from "@/components/session/pdf-surface";
import { TableSurface } from "@/components/session/table-surface";
import { DataSurface } from "@/components/session/data-surface";
import { LatexSurface } from "@/components/session/latex-surface";
import { RunPanel } from "@/components/run/run-panel";
import { ImageLightbox } from "@/components/session/image-lightbox";
import type { EditorState, OpenIntent } from "@/lib/editor-workspace";
import { fileKind } from "@/lib/file-kinds";
import { PANEL_TAB_MIME } from "@/lib/right-panel-tabs";
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
  { id: "agents", label: "Agents", icon: BotIcon, blurb: "Sub-agents and Warp runs" },
  /**
   * BACKGROUND WORK IS NOT A SUB-AGENT. A watch loop and a five-minute build
   * share a surface with nothing: an agent has a transcript and a conclusion, a
   * process has liveness and an owner who may want it gone. Filing both under
   * "Agents" made every background shell read as a delegate that never reports.
   * The split is `Task.kind`, which the engine already decides.
   */
  { id: "processes", label: "Processes", icon: TerminalIcon, blurb: "Background shells, watch loops" },
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
  { id: "diff", label: "Diff", icon: FileDiffIcon, blurb: "What this session changed" },
  /**
   * FILES IS GONE, SUPERSEDED BY EDITOR (EDITOR-001, #193).
   *
   * The tree it offered is the tree Editor already carries beside the files it
   * opens, so the two were one click apart showing the same thing — and picking
   * between them meant knowing that one could open a file and the other could
   * only list it. Browsing a checkout is unchanged: it happens in Editor, whose
   * tree still shows every file, changed or not.
   *
   * THE SURFACE ITSELF IS NOT DELETED — Editor mounts the same
   * `FilesSurface` component as its tree (session/editor-surface.tsx), which
   * is what makes this a removed CHOICE rather than removed functionality. A
   * session that saved `files` as its tab opens on Editor instead of on
   * nothing; see `migratePanelTab`.
   */
  /**
   * THE EDITOR, and the reason it is ONE tab.
   *
   * Every open file used to be a top-level tab of its own — `file:src/a.ts`
   * beside Diff and Issues — and that made browsing a repository destructive to
   * the arrangement: four files pushed the surfaces you were working with off
   * the end of the strip, and closing them one at a time was the only way back.
   * Files are not surfaces. They arrive by the dozen, they are the only thing
   * here you can have unsaved work in, and they want a strip of their own. So
   * they have one, inside this (session/editor-surface.tsx), and the panel's
   * strip goes back to holding the handful of surfaces it was built for.
   */
  { id: "editor", label: "Editor", icon: FileCode2Icon, blurb: "Files, with the tree beside them" },
  /**
   * THE TWO NETWORK SURFACES, and the only two. Everything above folds records
   * the cockpit already holds; these go out to GitHub through the `gh` CLI, so
   * they never poll and they always say how old their answer is.
   */
  { id: "issues", label: "Issues", icon: CircleDotIcon, blurb: "Open issues" },
  { id: "pulls", label: "Pull requests", icon: GitPullRequestIcon, blurb: "Open pull requests" },
  /**
   * THE DATA-SCIENCE SURFACE, present only on a project that opted in. ONE
   * tab, because plots, variables and the environment are three views of one
   * thing — the session's kernel — and three top-level tabs for it crowded a
   * strip that already holds files, issues and browser pages. Inside it a
   * browser-style sub-strip (session/data-surface.tsx) does the switching. It
   * stays in this list so a restored tab id validates; the panel filters it
   * out of the chooser and the empty state when `dataScience` is off.
   */
  { id: "data", label: "Data", icon: FlaskConicalIcon, blurb: "Plots, variables and the Python environment" },
  /**
   * THE LATEX SURFACE, the same deal as "data": present only on a project
   * that opted in, one tab (compile status, structured errors, the log tail —
   * session/latex-surface.tsx). The PDF itself is a FILE tab, not this
   * surface: the compile writes it beside its source and "Open PDF" routes
   * through `panelTabForPath` like any other file.
   */
  { id: "latex", label: "LaTeX", icon: SigmaIcon, blurb: "Compile status, errors and the log" },
  /**
   * THE RUN SURFACE, and it is the project's rather than this session's. A
   * project has ONE local deployment; every session looking at the project sees
   * the same one, which is why this tab is not gated on anything the session
   * opted into and why the panel inside it names the worktree the run came from.
   * Reading it from a session sitting on another branch is the normal case, not
   * the edge case (components/run/run-panel.tsx).
   */
  { id: "run", label: "Run", icon: PlayIcon, blurb: "The project's dev server, and how to start it" },
] as const;

type SurfaceId = (typeof SURFACES)[number]["id"];

/** Surfaces that exist only when the project opted into data science. */
const DS_SURFACES: ReadonlySet<string> = new Set(["data"]);

/** Surfaces that exist only when the project opted into LaTeX. */
const LATEX_SURFACES: ReadonlySet<string> = new Set(["latex"]);

/** The two tabs "data" replaced. A layout saved by the previous build names
 *  them; they restore as the one tab rather than vanishing. */
const LEGACY_DS_TABS: ReadonlySet<string> = new Set(["plots", "variables"]);

/** The four prefixes that used to mint a top-level tab per open file. */
const FILE_TAB_PREFIXES = ["file:", "notebook:", "table:", "pdf:"] as const;

/**
 * The path behind a file-shaped tab id, or nothing for a surface.
 *
 * THESE IDS ARE NOW A REQUEST, NOT A TAB. Everything that says "open this
 * file" — a chip in the conversation, the agent's display tool, the LaTeX
 * surface's compiled PDF, a row in the tree — still names it as
 * `file:`/`notebook:`/`table:`/`pdf:`, because that is the vocabulary those call
 * sites already speak. The cockpit reads the path back out of it and opens the
 * file in the Editor instead of minting a tab (see `showPanelTab`), which is
 * what let this change land without rewriting every gesture that opens a file.
 * A path may contain a colon, so this splits on the first separator only.
 */
export function filePanelTabPath(value: string): string | undefined {
  const prefix = FILE_TAB_PREFIXES.find((entry) => value.startsWith(entry) && value.length > entry.length);
  return prefix === undefined ? undefined : value.slice(prefix.length);
}

/** A tab id that names a FILE rather than a surface. */
export function isFilePanelTab(value: string): boolean {
  return filePanelTabPath(value) !== undefined;
}

/**
 * Whatever a previous build called this tab, in this build's vocabulary.
 *
 * EVERY OPEN FILE BECOMES THE EDITOR — one tab where there were four, deduped
 * by `readPanelTabs`. The files themselves are not lost with the tabs: they are
 * restored INTO the Editor by `editorFromLegacyTabs`, which reads the same
 * stored ids before this collapses them (see the cockpit's restore effect).
 */
export function migratePanelTab(value: string): string {
  if (LEGACY_DS_TABS.has(value)) return "data";
  // `files` was retired in favour of Editor (#193). A saved arrangement that
  // names it opens on Editor's tree rather than on nothing.
  if (value === "files") return "editor";
  return isFilePanelTab(value) ? "editor" : value;
}

function surfacesFor(dataScience: boolean, latex = false): typeof SURFACES[number][] {
  return SURFACES.filter((surface) => (dataScience || !DS_SURFACES.has(surface.id)) && (latex || !LATEX_SURFACES.has(surface.id)));
}

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
export type PanelTab =
  | SurfaceId
  | `browser:${string}`
  | `file:${string}`
  | `notebook:${string}`
  | `table:${string}`
  | `pdf:${string}`
  | `issue:${number}`
  | `pull:${number}`;

const BROWSER_PREFIX = "browser:";
const FILE_PREFIX = "file:";
const NOTEBOOK_PREFIX = "notebook:";
const TABLE_PREFIX = "table:";
const PDF_PREFIX = "pdf:";
const ISSUE_PREFIX = "issue:";
const PULL_PREFIX = "pull:";

/** A NOTEBOOK IS A FILE TAB WITH A DIFFERENT SURFACE — cells and a kernel
 *  instead of a textarea. Same for a table. The prefix carries the choice so
 *  the tab restores to the right surface without re-deciding from the path. */
export function notebookPanelTab(path: string): PanelTab {
  return `${NOTEBOOK_PREFIX}${path}`;
}
export function notebookPanelPath(tab: PanelTab): string | undefined {
  return tab.startsWith(NOTEBOOK_PREFIX) ? tab.slice(NOTEBOOK_PREFIX.length) : undefined;
}
export function tablePanelTab(path: string): PanelTab {
  return `${TABLE_PREFIX}${path}`;
}
export function tablePanelPath(tab: PanelTab): string | undefined {
  return tab.startsWith(TABLE_PREFIX) ? tab.slice(TABLE_PREFIX.length) : undefined;
}
export function pdfPanelTab(path: string): PanelTab {
  return `${PDF_PREFIX}${path}`;
}
export function pdfPanelPath(tab: PanelTab): string | undefined {
  return tab.startsWith(PDF_PREFIX) ? tab.slice(PDF_PREFIX.length) : undefined;
}

/** Which tab a path opens as: notebook, table, PDF or plain file — by file
 *  kind. The data-science pair is gated on the project's opt-in; the PDF
 *  viewer is NOT — a document renders wherever it is opened from (the tree,
 *  the agent's display tool, another feature's compiled output). */
export function panelTabForPath(path: string, dataScience: boolean): PanelTab {
  const viewer = fileKind(path).viewer;
  if (dataScience && viewer === "notebook") return notebookPanelTab(path);
  if (dataScience && viewer === "table") return tablePanelTab(path);
  if (viewer === "pdf") return pdfPanelTab(path);
  return filePanelTab(path);
}

export function browserPanelTab(tabId: string): PanelTab {
  return `${BROWSER_PREFIX}${tabId}`;
}

/**
 * THE SINGLE BROWSER TAB IN THE DESKTOP SHELL. In the shell the native
 * WebContentsView (DesktopBrowserSurface) draws its own per-page tab strip,
 * so turning every native page into a separate right-panel tab too would
 * stack two identical strips (the duplicated-tab-bars defect). On desktop the
 * panel holds ONE stable "Browser" tab and the native strip owns the pages;
 * the screenshot/remote clients (no native strip) keep one panel tab per page.
 * The id is fixed so it does not churn as the native active page changes.
 */
export const LIVE_BROWSER_PAGE_ID = "__integrated__";
export const LIVE_BROWSER_TAB: PanelTab = `${BROWSER_PREFIX}${LIVE_BROWSER_PAGE_ID}`;

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

/* An open file is no longer a panel tab, so "which files are open" is a
   question for the Editor's own state rather than for this strip — the tree
   inside Editor reads it from there (session/editor-surface.tsx). */

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
  (tab) => notebookPanelPath(tab) !== undefined,
  (tab) => tablePanelPath(tab) !== undefined,
  (tab) => pdfPanelPath(tab) !== undefined,
  (tab) => issuePanelNumber(tab) !== undefined,
  (tab) => pullPanelNumber(tab) !== undefined,
  (tab) => tab === "editor",
  (tab) => tab === "data",
  (tab) => tab === "latex",
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
  if (value.startsWith(NOTEBOOK_PREFIX)) return value.length > NOTEBOOK_PREFIX.length;
  if (value.startsWith(TABLE_PREFIX)) return value.length > TABLE_PREFIX.length;
  if (value.startsWith(PDF_PREFIX)) return value.length > PDF_PREFIX.length;
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
/** What the native browser reports right now — the shell's tabs, not the
 *  journal's. Only `id`, `title`, `url` and `active` are read. */
export type LivePage = Pick<BrowserTab, "id" | "title" | "url"> & { active?: boolean };

export function describePanelTab(
  tab: PanelTab,
  browser?: BrowserState,
  live?: readonly LivePage[],
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
  const notebookPath = notebookPanelPath(tab);
  if (notebookPath !== undefined) return { label: notebookPath.slice(notebookPath.lastIndexOf("/") + 1), icon: NotebookIcon, blurb: notebookPath };
  const tablePath = tablePanelPath(tab);
  if (tablePath !== undefined) return { label: tablePath.slice(tablePath.lastIndexOf("/") + 1), icon: TableIcon, blurb: tablePath };
  const pdfPath = pdfPanelPath(tab);
  if (pdfPath !== undefined) return { label: pdfPath.slice(pdfPath.lastIndexOf("/") + 1), icon: FileIcon, blurb: pdfPath };
  const issueNumber = issuePanelNumber(tab);
  if (issueNumber !== undefined) return { label: `#${issueNumber}`, icon: CircleDotIcon, blurb: `Issue #${issueNumber}` };
  const pullNumber = pullPanelNumber(tab);
  if (pullNumber !== undefined) return { label: `#${pullNumber}`, icon: GitPullRequestIcon, blurb: `Pull request #${pullNumber}` };
  const pageId = browserTabId(tab);
  if (pageId === undefined) {
    const surface = SURFACES.find((entry) => entry.id === tab)!;
    return { label: surface.label, icon: surface.icon, blurb: surface.blurb };
  }
  // The desktop shell's single browser tab: the native strip names the pages.
  if (pageId === LIVE_BROWSER_PAGE_ID) return { label: "Browser", icon: GlobeIcon, blurb: "Integrated browser" };
  /**
   * THE LIVE PAGE WINS. In the shell the surface under this tab is the native
   * browser, which shows whichever of ITS tabs is active — so the label must
   * come from there when it can. The journal's `browser.state.changed` is
   * history and lags (or, with a worker-owned browser, never names the native
   * tab at all), which is how a tab read "Closed page" over a live Example
   * Domain. Match by id first; failing that, the native view's active tab is
   * literally what is on screen.
   */
  const livePage = live?.find((entry) => entry.id === pageId) ?? (live && live.length > 0 ? (live.find((entry) => entry.active) ?? live[0]) : undefined);
  if (livePage) return { label: browserTabLabel(livePage), icon: GlobeIcon, blurb: livePage.url };
  const page = browser?.tabs.find((entry) => entry.id === pageId);
  if (!page) return { label: "Closed page", icon: GlobeIcon, blurb: "This page is no longer open.", missing: true };
  return { label: browserTabLabel(page), icon: GlobeIcon, blurb: page.url };
}

/** The shell's live tab list for this session, or nothing outside the shell.
 *  Subscribed rather than polled: the manager pushes on every change. */
function useLivePages(sessionId: string | undefined): LivePage[] | undefined {
  const bridge = desktopBrowserBridge();
  const [result, setResult] = useState<{ scopeKey: string; pages: LivePage[] }>();
  useEffect(() => {
    if (!bridge || !sessionId) return;
    let cancelled = false;
    const take = (state: { scopeKey: string; tabs: LivePage[] }) => {
      if (!cancelled && state.scopeKey === sessionId) setResult({ scopeKey: sessionId, pages: state.tabs });
    };
    const first = window.setTimeout(() => void bridge.getState(sessionId).then(take, () => undefined), 0);
    const unsubscribe = bridge.onState(take);
    return () => {
      cancelled = true;
      window.clearTimeout(first);
      unsubscribe();
    };
  }, [bridge, sessionId]);
  return bridge && result && result.scopeKey === sessionId ? result.pages : undefined;
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

/**
 * The outcome of pressing "open a browser", so the press is never silent.
 * `pending` while the engine is asked; `error` carries the engine's own words.
 */
export type BrowserStartState = { status: "idle" } | { status: "pending" } | { status: "error"; message: string };

/** Fold an engine answer to a start into what the button should say next. A
 *  running browser with no tab is the failure the desktop branch used to hide:
 *  it is named here rather than left looking like "still starting". */
export function describeBrowserStart(snapshot: Pick<BrowserSnapshot, "tabs" | "error" | "running">): BrowserStartState {
  if (snapshot.error) return { status: "error", message: snapshot.error };
  if (snapshot.tabs.length === 0) {
    return { status: "error", message: snapshot.running ? "The browser started but opened no page." : "The browser did not start." };
  }
  return { status: "idle" };
}

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
function BrowserPageSurface({ pageId, state, sessionId, projectId }: { pageId: string; state?: BrowserState; sessionId?: string; projectId?: string }) {
  /**
   * IN THE SHELL, THE BROWSER IS REAL. The desktop bridge means a native
   * WebContentsView can be glued under this panel — tab strip, URL bar, the
   * page itself, clickable by the human while the agent drives (the shared
   * browser-v2 plan). The screenshot poll stays as the whole surface for
   * every client WITHOUT a native view: a phone, a remote cockpit. Split
   * into two components because the fallback owns hooks the live surface
   * must not conditionally skip.
   */
  const bridge = desktopBrowserBridge();
  if (bridge && sessionId) {
    return <DesktopBrowserSurface key={sessionId} bridge={bridge} sessionId={sessionId} {...(projectId ? { projectId } : {})} />;
  }
  return <BrowserScreenshotSurface pageId={pageId} {...(state ? { state } : {})} {...(sessionId ? { sessionId } : {})} />;
}

function BrowserScreenshotSurface({ pageId, state, sessionId }: { pageId: string; state?: BrowserState; sessionId?: string }) {
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
        The engine closed it, or the session ended.
      </PanelEmpty>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        draggable
        onDragStart={(event) => startReferenceDrag(event.dataTransfer, browserPageReference({ title: page.title, url: page.url }))}
        title="Drag into the message to reference this page"
        className="flex shrink-0 cursor-grab items-center gap-2 border-b border-border px-3 py-2 active:cursor-grabbing"
      >
        <GlobeIcon className={cn("size-3.5 shrink-0", page.loading ? "text-primary" : "text-muted-foreground")} />
        <span className="min-w-0 flex-1 truncate font-mono text-[0.6875rem] text-muted-foreground" title={page.url}>
          {page.url || "about:blank"}
        </span>
        {live && !snapshot?.screenshot && <Spinner className="size-3 shrink-0 text-muted-foreground" />}
        {page.loading && <Badge variant="outline" className="shrink-0 px-1 py-0 text-[0.5625rem] font-normal">loading</Badge>}
        {page.active && <Badge variant="secondary" className="shrink-0 px-1 py-0 text-[0.5625rem] font-normal">active</Badge>}
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
                ? "Only the page with focus can be photographed."
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
            {task.role && task.title && <span className="truncate text-[0.625rem] text-muted-foreground">{task.role}</span>}
          </span>
          {steps.length > 0 && (
            <span className="shrink-0 text-[0.625rem] text-muted-foreground">
              {steps.length} step{steps.length === 1 ? "" : "s"}
            </span>
          )}
          {tokens !== undefined && <span className="shrink-0 font-mono text-[0.625rem] text-muted-foreground tabular-nums">{figure(tokens)}</span>}
          <span className={cn("shrink-0 font-mono text-[0.625rem]", task.state === "failed" ? "text-destructive" : "text-muted-foreground")}>
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
            <p className={cn("pt-1 text-[0.6875rem] whitespace-pre-wrap", task.failure ? "text-destructive" : "text-muted-foreground")}>{body}</p>
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

/**
 * The roster, split for the two task surfaces.
 *
 * THE KIND SPLIT HAPPENS AFTER THE WARP FOLD, never before. A Warp run's own
 * row is a `background` task whose children are `agent` tasks — splitting on
 * kind first would file the run under Processes and strand its agents on the
 * Agents surface as an orphaned group. A run belongs with its agents, so groups
 * stay whole on the Agents side and only LOOSE tasks are divided.
 *
 * `kind !== "background"` rather than `=== "agent"`, matching the contract's
 * own denylist posture: anything the engine did not recognise as background is
 * presumed to be an agent (protocol/tasks.ts).
 */
export type RosterSplit = { groups: WarpGroup[]; agents: JournalTask[]; processes: JournalTask[] };

export function splitRoster(tasks: readonly JournalTask[]): RosterSplit {
  const { groups, loose } = groupWarps(tasks);
  return {
    groups,
    agents: loose.filter((task) => task.kind !== "background"),
    processes: loose.filter((task) => task.kind === "background"),
  };
}

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
            <span className="truncate text-[0.625rem] text-muted-foreground">
              {/* COUNTED, NOT SUMMARISED. "12 agents" while eight are still
                  queued reads as twelve running; the split is the progress. */}
              {agents.length} agent{agents.length === 1 ? "" : "s"}
              {live > 0 ? ` · ${live} running` : ""}
              {done > 0 ? ` · ${done} done` : ""}
              {failed > 0 ? ` · ${failed} failed` : ""}
            </span>
          </span>
          {tokens > 0 && <span className="shrink-0 font-mono text-[0.625rem] text-muted-foreground tabular-nums">{figure(tokens)}</span>}
          <span className={cn("shrink-0 font-mono text-[0.625rem]", state === "failed" ? "text-destructive" : "text-muted-foreground")}>
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
          {group.run?.failure && <p className="px-4 py-2 text-[0.6875rem] text-destructive">{group.run.failure}</p>}
        </div>
      )}
    </div>
  );
}

function AgentsSurface({ tasks, focused }: { tasks: readonly JournalTask[]; focused?: TaskFocus }) {
  const { groups, agents: loose } = useMemo(() => splitRoster(tasks), [tasks]);
  if (groups.length === 0 && loose.length === 0) {
    return (
      <PanelEmpty icon={<BotIcon />} title="Sub-agents appear here as they work">
        Background work lives on the Processes tab.
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

/**
 * Background work, in the same row vocabulary as the agents — a process still
 * has steps, a result and a state, so `TaskRow` renders it unchanged. What
 * differs is the framing: this list can OUTLIVE the turn that started it, and
 * the empty state says who can put something here.
 */
function ProcessesSurface({ tasks, focused }: { tasks: readonly JournalTask[]; focused?: TaskFocus }) {
  const { processes } = useMemo(() => splitRoster(tasks), [tasks]);
  if (processes.length === 0) {
    return (
      <PanelEmpty icon={<TerminalIcon />} title="Background work appears here">
        Anything the agent leaves running. Codex sessions never file anything here: that provider reports every child as an agent.
      </PanelEmpty>
    );
  }
  const live = processes.filter(isLiveTask);
  const finished = processes.filter((task) => !isLiveTask(task));
  const row = (task: JournalTask) =>
    focused?.id === task.id ? (
      <TaskRow key={`${task.id}:${focused.nonce}`} task={task} focused />
    ) : (
      <TaskRow key={task.id} task={task} />
    );
  return (
    <div className="flex flex-col">
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
  openIssueNumbers,
  openPullNumbers,
  onOpenTab,
  onInsertReference,
  active,
  dataScience,
  onOpenImage,
  editor,
  onEditorChange,
  hostId,
  visible = true,
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
  /** Issues and pull requests already open as tabs, so a list row can say so. */
  openIssueNumbers?: readonly number[];
  openPullNumbers?: readonly number[];
  /**
   * The tree opens a file by naming it, which the cockpit routes — a surface
   * tab opens as a tab; a file-shaped id opens in the Editor. `intent` says how
   * deliberate the gesture was, and is ignored for anything but a file.
   */
  onOpenTab: (tab: PanelTab, intent?: OpenIntent) => void;
  /**
   * Put a reference into the message being written — the same text a row's own
   * DRAG already carries (`lib/drag-reference.ts`), reached with a gesture that
   * does not require aiming at the composer. The cockpit owns the draft, so it
   * owns this; absent (a canvas with no composer) simply hides the item.
   */
  onInsertReference?: (text: string) => void;
  active?: TurnState;
  /** The project opted into data science: .ipynb opens as cells, CSV as a grid. */
  dataScience?: boolean;
  onOpenImage?: (attachmentId: string) => void;
  /** The Editor's open files. Owned by the cockpit for the same reason the
   *  panel's own tabs are: it persists them, and it is where "open this file"
   *  gestures from the conversation land. */
  editor?: EditorState;
  onEditorChange?: (next: (current: EditorState) => EditorState) => void;
  /** WHICH MAC this session is on. The Editor pins its engine client and keys
   *  its unsaved-text stash with it — see session/file-view-surface.tsx. */
  hostId?: string;
  /**
   * Is the panel actually on screen? The shell keeps it mounted at zero width
   * through the close animation, so a surface that polls must be able to stop
   * without being unmounted — and resume when it comes back.
   */
  visible?: boolean;
}) {
  /**
   * THE FILE ARMS ARE A FALLBACK NOW, not a route anybody takes. A file opens
   * in the Editor: the cockpit reads the path out of a file-shaped id and hands
   * it there (`showPanelTab`), and a layout persisted by an older build has its
   * file ids collapsed into the Editor tab on restore (`migratePanelTab`). They
   * stay because they are still correct, and a tab that somehow arrives here
   * should draw its file rather than nothing.
   */
  const notebookPath = notebookPanelPath(tab);
  if (notebookPath !== undefined)
    return <NotebookSurface path={notebookPath} {...(sessionId ? { sessionId } : {})} {...(active ? { active } : {})} {...(onOpenImage ? { onOpenImage } : {})} />;
  const tablePath = tablePanelPath(tab);
  if (tablePath !== undefined) return <TableSurface path={tablePath} {...(sessionId ? { sessionId } : {})} {...(active ? { active } : {})} />;
  const pdfPath = pdfPanelPath(tab);
  if (pdfPath !== undefined)
    return <PdfSurface path={pdfPath} {...(sessionId ? { sessionId } : {})} {...(projectId ? { projectId } : {})} {...(active ? { active } : {})} />;
  if (tab === "editor")
    return editor && onEditorChange ? (
      /**
       * KEYED BY THE CHECKOUT. Moving between sessions replaces the Editor
       * rather than re-rendering it, so nothing it holds per file — the saving
       * dots, a half-confirmed close, where each file was scrolled to — can be
       * read as belonging to the session you just arrived in. The unsaved text
       * itself is not in here to lose (lib/editor-drafts.ts keys it by the same
       * scope and outlives every one of these mounts).
       */
      <EditorSurface
        key={`${hostId ?? "local"}:${sessionId ?? projectId ?? "none"}`}
        state={editor}
        onState={onEditorChange}
        {...(sessionId ? { sessionId } : {})}
        {...(projectId ? { projectId } : {})}
        {...(hostId ? { hostId } : {})}
        {...(active ? { active } : {})}
        dataScience={dataScience === true}
        {...(onOpenImage ? { onOpenImage } : {})}
      />
    ) : null;
  if (tab === "data") return <DataSurface {...(sessionId ? { sessionId } : {})} {...(projectId ? { projectId } : {})} {...(active ? { active } : {})} {...(onOpenImage ? { onOpenImage } : {})} />;
  if (tab === "latex")
    return <LatexSurface {...(sessionId ? { sessionId } : {})} {...(active ? { active } : {})} onOpenFile={(path) => onOpenTab(panelTabForPath(path, dataScience === true))} />;
  /**
   * KEYED BY HOST AND SESSION. The surface polls and holds a cursor into one
   * run's output, so a move must not carry that cursor across — and session ids
   * are per-Mac, so the session alone would reuse one host's panel for
   * another's. The host is in the props too (components/run/run-panel.tsx).
   */
  if (tab === "run")
    return sessionId ? <RunPanel key={`${hostId ?? "local"}:${sessionId}`} sessionId={sessionId} {...(hostId ? { hostId } : {})} visible={visible} /> : null;
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
    return <BrowserPageSurface pageId={pageId} {...(browser ? { state: browser } : {})} {...(sessionId ? { sessionId } : {})} {...(projectId ? { projectId } : {})} />;
  if (tab === "diff")
    return (
      <DiffSurface
        {...(sessionId ? { sessionId } : {})}
        {...(projectId ? { projectId } : {})}
        reported={writes}
        suggestion={sessionTitle?.trim() || "Session work"}
        {...(active ? { active } : {})}
        // Derived from `onOpenTab`, exactly as LatexSurface's is above — a
        // changed file opens through the ONE route into the Editor rather than
        // a second one cut for this menu.
        onOpenFile={(path) => onOpenTab(panelTabForPath(path, dataScience === true))}
        {...(onInsertReference ? { onInsertReference } : {})}
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
  if (tab === "processes") return <ProcessesSurface tasks={tasks} {...(focusedTask ? { focused: focusedTask } : {})} />;
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
function PanelEmptyState({
  onOpen,
  browser,
  onOpenBrowser,
  browserStart = { status: "idle" },
  dataScience = false,
  latex = false,
}: {
  onOpen: (tab: PanelTab) => void;
  dataScience?: boolean;
  latex?: boolean;
  browser?: BrowserState;
  /** Absent when the engine cannot start a browser here — the affordance
   *  hides rather than offering a launch that would land beside the worker's
   *  own browser (see BrowserSnapshot.canStart). */
  onOpenBrowser?: () => void;
  browserStart?: BrowserStartState;
}) {
  const pages = browser?.tabs ?? [];
  const starting = browserStart.status === "pending";
  return (
    <div className="flex h-full flex-col justify-center p-4">
      <div className="mx-auto w-full max-w-sm">
        <PanelsTopLeftIcon className="mx-auto size-7 text-muted-foreground/40" />
        <h2 className="mt-3 text-center font-heading text-sm font-medium">Open a surface</h2>
        <p className="mt-1 text-center text-xs leading-relaxed text-muted-foreground">Choose what to keep beside the conversation.</p>
        <div className="mt-4 flex flex-col gap-1">
          {surfacesFor(dataScience, latex).map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              onClick={() => onOpen(candidate.id)}
              className="flex items-center gap-2.5 rounded-lg border border-border px-2.5 py-2 text-left transition-colors hover:bg-muted/60"
            >
              <candidate.icon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium text-foreground">{candidate.label}</span>
                <span className="block truncate text-[0.6875rem] text-muted-foreground">{candidate.blurb}</span>
              </span>
            </button>
          ))}
        </div>
        {/* Launch, not navigate: pages the agent already opened are listed
            below; this row exists for the session where nobody has browsed
            yet and a human wants to. */}
        {onOpenBrowser && pages.length === 0 && (
          <>
            <button
              type="button"
              onClick={onOpenBrowser}
              disabled={starting}
              aria-busy={starting}
              className="mt-1 flex w-full items-center gap-2.5 rounded-lg border border-dashed border-border px-2.5 py-2 text-left transition-colors hover:bg-muted/60 disabled:cursor-progress disabled:hover:bg-transparent"
            >
              {starting ? <Spinner className="size-4 shrink-0 text-muted-foreground" /> : <GlobeIcon className="size-4 shrink-0 text-muted-foreground" />}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium text-foreground">{starting ? "Starting the browser…" : "Open a browser"}</span>
                <span className="block truncate text-[0.6875rem] text-muted-foreground">
                  {browserStart.status === "error" ? "Try again" : "Start this session’s browser"}
                </span>
              </span>
            </button>
            {/* The engine's own words, under the button that asked. A silent
                press is the one outcome nobody can tell from "still starting". */}
            {browserStart.status === "error" && (
              <p role="alert" className="mt-1.5 px-1 text-[0.6875rem] leading-relaxed text-destructive">
                {browserStart.message}
              </p>
            )}
          </>
        )}
        {/* ON DESKTOP the native strip owns the pages, so this is ONE "Browser"
            row; on screenshot/remote clients (no native strip) it is one row
            per page, which is how those clients switch pages at all. */}
        {pages.length > 0 && desktopBrowserBridge() && (
          <>
            <p className="mt-5 text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">Browser</p>
            <div className="mt-1.5 flex flex-col gap-1">
              <button
                type="button"
                onClick={() => onOpen(LIVE_BROWSER_TAB)}
                className="flex items-center gap-2.5 rounded-lg border border-border px-2.5 py-2 text-left transition-colors hover:bg-muted/60"
              >
                <GlobeIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium text-foreground">Browser</span>
                  <span className="block truncate font-mono text-[0.625rem] text-muted-foreground">{pages.length} open page{pages.length === 1 ? "" : "s"}</span>
                </span>
              </button>
            </div>
          </>
        )}
        {pages.length > 0 && !desktopBrowserBridge() && (
          <>
            <p className="mt-5 text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">Open pages</p>
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
                    <span className="block truncate font-mono text-[0.625rem] text-muted-foreground">{page.url}</span>
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
 * THE TAB BAR MATCHES THE MASTHEAD'S HEIGHT (40px, `h-10 py-0` — the rail
 * header and page header are the same) on purpose. The two sit
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
  onOpenBrowser,
  browserStart = { status: "idle" },
  events = [],
  tabs,
  tab,
  onTabChange,
  onOpenTab,
  onInsertReference,
  onCloseTab,
  onMoveTab,
  onClose,
  open = true,
  dataScience = false,
  latex = false,
  editor,
  onEditorChange,
  hostId,
}: {
  active?: TurnState;
  /** The project opted into data science — shows Plots and Variables, and
   *  opens .ipynb and CSV files in their own surfaces. */
  dataScience?: boolean;
  /** The project opted into LaTeX — shows the compile surface. */
  latex?: boolean;
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
  /** Launch the session's browser by hand. Absent when the engine cannot
   *  start one here, and the affordances hide with it. */
  onOpenBrowser?: () => void;
  /** What the last press of that launch is doing — pending, or why it failed. */
  browserStart?: BrowserStartState;
  events?: readonly EngineEvent[];
  /** Owned by the cockpit, not by the panel: the pinned summary's rows and the
   *  composer's foot are "go there" gestures, and they have to be able to say
   *  WHERE — which means opening a tab that may not be open yet. */
  tabs: readonly PanelTab[];
  tab?: PanelTab;
  onTabChange: (tab: PanelTab) => void;
  onOpenTab: (tab: PanelTab, intent?: OpenIntent) => void;
  /** Put a reference into the message being written — see `PanelSurface`. */
  onInsertReference?: (text: string) => void;
  onCloseTab: (tab: PanelTab) => void;
  /** Reorder the strip — `toIndex` is the place in the strip WITHOUT the moved
   *  tab, which is what `movePanelTab` takes. Absent leaves the tabs draggable
   *  but inert, which is what a caller that does not persist a strip wants. */
  onMoveTab?: (tab: PanelTab, toIndex: number) => void;
  onClose: () => void;
  /** The Editor's open files — see `PanelSurface`. */
  editor?: EditorState;
  onEditorChange?: (next: (current: EditorState) => EditorState) => void;
  /** Which Mac this cockpit is about. */
  hostId?: string;
  /**
   * OPEN/CLOSE ANIMATION. Kept mounted by the cockpit during the close so the
   * shell can animate OUT (its WIDTH, from the panel width to 0, and back).
   * The native browser view has no CSS layer to fade, so it is not faded — the
   * viewport hook (browser-live.tsx) tracks the animating width each frame via
   * its ResizeObserver + transition-follow, and its zero-area latch hides the
   * native view as the width reaches 0 and reveals it at the settled bounds.
   * `motion-reduce` drops the transition (the width snaps); the cockpit still
   * unmounts after the same delay, so reduced motion lands in the right state.
   */
  open?: boolean;
}) {
  const [fullscreen, setFullscreen] = useState(false);
  const [surfaceChooserOpen, setSurfaceChooserOpen] = useState(false);
  /**
   * WHICH TAB'S CONTEXT MENU IS OPEN, or nothing — the strip's menus are
   * CONTROLLED for the same reason the chooser is: the native browser view
   * sits above this DOM, and `useNativeViewOverlay` needs a boolean to take it
   * down by. One piece of state for the whole strip rather than one per chip,
   * because at most one context menu is ever open.
   */
  const [menuTab, setMenuTab] = useState<PanelTab>();
  // The native browser view is composited above this DOM; drop it while the
  // chooser or a tab's menu is open so the menu is the thing on top. No-op on
  // the web build.
  useNativeViewOverlay(surfaceChooserOpen);
  useNativeViewOverlay(menuTab !== undefined);
  /** The tab being carried, and the edge of the tab it is over. Held by the
   *  strip rather than by a tab, because a drop lands on a DIFFERENT tab than
   *  the one that started the drag. */
  const [draggingTab, setDraggingTab] = useState<PanelTab | null>(null);
  const [tabInsert, setTabInsert] = useState<{ id: PanelTab; side: "before" | "after" } | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const prefs = useSidebarPrefs(RIGHT_PANEL_WIDTH_STORAGE_KEY);
  const width = prefs.width ?? RIGHT_PANEL_DEFAULT_WIDTH;
  const writes = useMemo(() => journalWrites(items), [items]);
  const browser = useMemo(() => latestBrowserState(events), [events]);
  const livePages = useLivePages(sessionId);
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
  const roster = useMemo(() => splitRoster(tasks), [tasks]);
  /** Starting a browser is offered only when there is none to open a tab for. */
  const canStartBrowser = Boolean(onOpenBrowser) && (browser?.tabs.length ?? 0) === 0;
  /** A plot opened large, from any surface that shows one. */
  const [lightbox, setLightbox] = useState<string>();
  const agentSide = [...roster.groups.flatMap(warpAgents), ...roster.agents];
  const running = agentSide.filter(isLiveTask).length;
  const failed = agentSide.filter((task) => task.state === "failed").length +
    roster.groups.filter((group) => group.run?.state === "failed").length;
  const processesRunning = roster.processes.filter(isLiveTask).length;
  const processesFailed = roster.processes.filter((task) => task.state === "failed").length;
  /**
   * NO COUNT ON DIFF, deliberately. The badge used to carry the journal's file
   * count, and the surface now lists git's — which is a different, larger number
   * (it includes what nobody narrated). A badge that disagrees with the length of
   * the list underneath it is worse than no badge: it teaches the reader that one
   * of the two is lying, without saying which.
   */
  const counts: Partial<Record<PanelTab, number>> = {
    // A run counts as ONE — its agents are inside it, and a badge that counted
    // both would say thirteen where the surface shows one group and no rows.
    agents: roster.groups.length + roster.agents.length,
    processes: roster.processes.length,
  };
  /** Everything openable that is not already open — fixed surfaces first, then
   *  one entry per browser page the engine currently reports. */
  const openable: { id: PanelTab; label: string; icon: typeof BotIcon }[] = [
    ...surfacesFor(dataScience, latex).filter((surface) => !tabs.includes(surface.id)).map((surface) => ({
      id: surface.id as PanelTab,
      label: surface.label,
      icon: surface.icon,
    })),
    // On desktop the native strip owns the pages: offer ONE "Browser" entry.
    ...(desktopBrowserBridge()
      ? (browser?.tabs?.length ?? 0) > 0 && !tabs.includes(LIVE_BROWSER_TAB)
        ? [{ id: LIVE_BROWSER_TAB, label: "Browser", icon: GlobeIcon }]
        : []
      : (browser?.tabs ?? [])
          .filter((page) => !tabs.includes(browserPanelTab(page.id)))
          .map((page) => ({ id: browserPanelTab(page.id), label: browserTabLabel(page), icon: GlobeIcon }))),
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
      // The mark the row's other card reads through `:has()` to drop its
      // outline while this one fills the window. An attribute rather than
      // lifted state: it is presentational, and hoisting it would re-render the
      // cockpit on a toggle that only moves one edge.
      {...(fullscreen ? { "data-panel-fullscreen": "" } : {})}
      // ALWAYS SET, fullscreen included: leaving fullscreen transitions
      // from 100% back to this value, and a variable that appears on the
      // same frame the class changes has nothing to animate from.
      style={{ "--right-panel-width": `${width}px` } as CSSProperties}
      className={cn(
        // `app-ground`: transparent in the shell's translucent mode, so the
        // panel shares the body's one wash instead of stacking a second.
        // Its own card (see the cockpit's `data-surfaces`), wearing the rail's
        // surface recipe: `bg-sidebar` + hairline ring. NOT `app-ground` — a
        // card must paint, or under translucency it dissolves into the wash.
        // The gutter is the separation, so the old `border-l` divider goes.
        // NOT `overflow-hidden` here — the resize handle hangs half outside
        // this box, into the gutter; the body below clips its own corners.
        "relative flex shrink-0 flex-col md:rounded-xl md:bg-sidebar md:shadow-sm md:ring-1 md:ring-sidebar-border",
        // The open/close animation: WIDTH (and opacity) over 200ms, dropped
        // under reduced motion. `overflow-hidden` while collapsing so the body
        // does not spill during the squeeze.
        "transition-[width,opacity] duration-200 ease-[cubic-bezier(.22,1,.36,1)] motion-reduce:transition-none",
        // WIDTH ORDER MATTERS. `!open` comes FIRST so a close collapses from
        // fullscreen ("Fill window") too. No `min-w` on the OPEN state: the
        // stored width is already clamped to RIGHT_PANEL_MIN_WIDTH (384px) and
        // the panel is `shrink-0`, so the floor is carried by the width value —
        // a `min-w-80` here would clamp the opening transition to 320px on the
        // first frame and make it jump instead of growing from 0.
        !open
          ? "w-0 min-w-0 overflow-hidden opacity-0 pointer-events-none"
          : fullscreen
            ? // FILL THE WINDOW MEANS THE WHOLE ROW, not half of it. The
              // conversation card beside this is `flex-1` too, so `flex-1`
              // here only ever split the row with it (measured: the browser
              // took half, the chat the other half). A fixed 100% width on a
              // `shrink-0` panel leaves the conversation (min-w-0, overflow
              // hidden) nothing to grow into, so it collapses to 0 without
              // unmounting; the negative margin eats the row's gap so the
              // panel lands exactly on the row's edges. Width still animates
              // (px ↔ % interpolate), and `!open` above still closes from here.
              "w-full max-w-none md:-ml-2"
            : "w-(--right-panel-width) max-w-[calc(100%-24rem)]",
      )}
    >
      {!fullscreen && <RightPanelResizeHandle panelRef={panelRef} />}

      {/* FULLSCREEN MAKES THIS BAR THE TITLEBAR: it replaces the masthead as the
          window's top-left, so it takes the shared band height as well as the
          inset. `h-10` is 2.5rem — right for the split panel, but it only
          matched the band by coincidence at a 16px interface size, and at 14px
          it was 35px tall with its centre 2.5px above the lights'. Split and
          mobile keep `h-10`: neither is the window's edge. */}
      <div
        className={cn(
          "flex h-10 shrink-0 items-center gap-1 border-b border-border px-2 py-0",
          fullscreen && "pl-[max(8px,calc(var(--titlebar-inset)+var(--app-island-inset)))] md:h-[var(--titlebar-band-height)]",
        )}
      >
        <div role="tablist" aria-label="Right panel tabs" className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
          {tabs.map((id) => {
            const on = id === tab;
            const { label, icon: Icon, missing } = describePanelTab(id, browser, livePages);
            const count = counts[id];
            return (
              <span
                key={id}
                /*
                  THE CHIP IS THE HANDLE, AND NOTHING INSIDE IT IS. The buttons
                  are the click targets and a <button> does not drag by default;
                  the context menu's trigger is a CHILD of this element, never
                  this element — a grab and a right-press on one node is the
                  race the session row and the project header both avoid the
                  same way.

                  THE INSERT MARK IS AN INSET SHADOW, not a border: a border
                  appearing on drag-over would widen the tab on the frame it
                  appears and shove the rest of the strip sideways under the
                  pointer.
                */
                draggable
                onDragStart={(event: React.DragEvent) => {
                  event.dataTransfer.setData(PANEL_TAB_MIME, id);
                  event.dataTransfer.effectAllowed = "move";
                  setDraggingTab(id);
                }}
                onDragEnd={() => {
                  setDraggingTab(null);
                  setTabInsert(null);
                }}
                onDragOver={(event: React.DragEvent) => {
                  if (!event.dataTransfer.types.includes(PANEL_TAB_MIME) || draggingTab === id) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  // A strip runs across, so the halves are left and right.
                  const rect = event.currentTarget.getBoundingClientRect();
                  const side: "before" | "after" = event.clientX < rect.left + rect.width / 2 ? "before" : "after";
                  setTabInsert((current) => (current?.id === id && current.side === side ? current : { id, side }));
                }}
                onDragLeave={() => setTabInsert((current) => (current?.id === id ? null : current))}
                onDrop={(event: React.DragEvent) => {
                  if (!event.dataTransfer.types.includes(PANEL_TAB_MIME)) return;
                  event.preventDefault();
                  const dragged = (event.dataTransfer.getData(PANEL_TAB_MIME) || draggingTab) as PanelTab | null;
                  const side = tabInsert?.id === id ? tabInsert.side : "after";
                  setDraggingTab(null);
                  setTabInsert(null);
                  if (!dragged || dragged === id || !tabs.includes(dragged)) return;
                  // Measured in the strip WITHOUT the carried tab, which is the
                  // index `movePanelTab` takes — see its own note on why.
                  const rest = tabs.filter((entry) => entry !== dragged);
                  onMoveTab?.(dragged, rest.indexOf(id) + (side === "after" ? 1 : 0));
                }}
                className={cn(
                  // The layout classes live on the trigger below, not here —
                  // see its own note. This wrapper keeps the chip's box, and
                  // adds only what says "this is a handle".
                  "group/tab relative flex h-7 min-w-0 max-w-44 shrink-0 cursor-grab rounded-md text-xs transition-colors active:cursor-grabbing",
                  on ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                  // A page the engine has since closed still has a tab, because
                  // you opened it and only you should close it — but it should
                  // not look live.
                  missing && "opacity-60",
                  draggingTab === id && "opacity-40",
                  tabInsert?.id === id && tabInsert.side === "before" && "shadow-[inset_2px_0_0_0_var(--color-primary)]",
                  tabInsert?.id === id && tabInsert.side === "after" && "shadow-[inset_-2px_0_0_0_var(--color-primary)]",
                )}
              >
                {/**
                 * THE TAB'S OWN MENU. Four verbs, and every one of them fires
                 * a callback this strip already has: `onCloseTab` is the ×
                 * button's, `setFullscreen` is the corner glyph's.
                 *
                 * CLOSE OTHERS AND CLOSE ALL ARE LOOPS over that same
                 * `onCloseTab`, not a reducer of their own. `closeOtherPanelTabs`
                 * (lib/right-panel-tabs.ts) would be the neater call, and it
                 * would need a new prop from the cockpit that owns this state —
                 * which this pass deliberately does not touch. Looping the
                 * existing callback keeps ONE close path either way, and
                 * `closePanelTab` already moves focus to the neighbour on each
                 * step, so the tab you kept is the one left active.
                 *
                 * REORDER IS NOT A MENU ROW, because it is a drag: the chip
                 * around this trigger is the handle (see its comment), so
                 * "move left"/"move right" would be a second way to say what
                 * the pointer already says directly.
                 *
                 * CONTROLLED, like the chooser beside it, because the desktop
                 * shell composites a native browser view above this DOM and
                 * `useNativeViewOverlay` needs a boolean to take it down by —
                 * an uncontrolled menu would open behind the page.
                 *
                 * THE TRIGGER IS THE CHIP'S FLEX ROW, PADDING AND ALL, rather
                 * than a `contents` box: `contents` paints nothing and is never
                 * an event target, so a right-press in the chip's own `px-1.5`
                 * would have gone to the strip behind it (the bug a screenshot
                 * caught in `project-group.tsx`). The layout classes moved off
                 * the wrapper onto the trigger, so the chip looks the same and
                 * has exactly one hit area.
                 */}
                <ContextMenu open={menuTab === id} onOpenChange={(next: boolean) => setMenuTab(next ? id : undefined)}>
                  <ContextMenuTrigger render={<span className="flex min-w-0 flex-1 items-center px-1.5" />}>
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
                            "ml-auto inline-flex min-w-4 shrink-0 items-center justify-center rounded-full px-1 font-mono text-[0.5625rem] leading-4",
                            (id === "agents" ? failed : id === "processes" ? processesFailed : 0) > 0
                              ? "bg-destructive/15 text-destructive"
                              : (id === "agents" ? running : id === "processes" ? processesRunning : 0) > 0
                                ? "bg-primary/15 text-primary"
                                : "bg-muted-foreground/15 text-muted-foreground",
                          )}
                          title={
                            id === "agents" && running > 0
                              ? `${running} running`
                              : id === "processes" && processesRunning > 0
                                ? `${processesRunning} running`
                                : undefined
                          }
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
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem onClick={() => onCloseTab(id)}>Close</ContextMenuItem>
                    <ContextMenuItem onClick={() => tabs.filter((other) => other !== id).forEach((other) => onCloseTab(other))}>
                      Close others
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => tabs.forEach((other) => onCloseTab(other))}>Close all</ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem onClick={() => setFullscreen((current) => !current)}>
                      {fullscreen ? "Exit fullscreen" : "Fill the window"}
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              </span>
            );
          })}
          {/* THE "+" IS A MENU AGAIN. It was one until ece446e8, which turned
              it into a bar under the strip because the native browser view is
              composited above the DOM and hid the portal. `useNativeViewOverlay`
              takes that view down while the menu is open, so a list is a list
              again — and the strip stops jumping every time you open it. */}
          {(openable.length > 0 || canStartBrowser) && (
            <DropdownMenu open={surfaceChooserOpen} onOpenChange={setSurfaceChooserOpen}>
              <DropdownMenuTrigger
                render={
                  <button type="button" aria-label="Open a surface" title="Open a surface"
                    className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground data-popup-open:bg-muted data-popup-open:text-foreground">
                    <PlusIcon className="size-4" />
                  </button>
                }
              />
              <DropdownMenuContent align="start" sideOffset={6} className="w-48">
                {openable.map((candidate) => (
                  <DropdownMenuItem key={candidate.id} onClick={() => onOpenTab(candidate.id)}>
                    <candidate.icon className="size-3.5" />
                    <span className="min-w-0 flex-1 truncate">{candidate.label}</span>
                  </DropdownMenuItem>
                ))}
                {/* Last, and only when there is no browser yet to open a tab
                    for: starting one is a different act from opening a surface
                    that already exists. */}
                {canStartBrowser && (
                  <DropdownMenuItem disabled={browserStart.status === "pending"} onClick={() => onOpenBrowser?.()}>
                    <GlobeIcon className="size-3.5" />
                    <span className="min-w-0 flex-1 truncate">{browserStart.status === "pending" ? "Starting the browser…" : "Open a browser"}</span>
                  </DropdownMenuItem>
                )}
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
        className="min-h-0 flex-1 overflow-y-auto md:rounded-b-xl"
      >
        {tab && (sessionId || browserTabId(tab) === undefined) ? (
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
              <p className="px-4 pt-2 font-mono text-[0.625rem] uppercase tracking-[0.08em] text-muted-foreground/60">{active}</p>
            )}
            <PanelSurface
              tab={tab}
              writes={writes}
              tasks={tasks}
              {...(focusedTask ? { focusedTask } : {})}
              openIssueNumbers={openIssueNumbers}
              openPullNumbers={openPullNumbers}
              onOpenTab={onOpenTab}
              {...(onInsertReference ? { onInsertReference } : {})}
              {...(browser ? { browser } : {})}
              {...(sessionId ? { sessionId } : {})}
              {...(sessionTitle ? { sessionTitle } : {})}
              {...(projectId ? { projectId } : {})}
              {...(branch ? { branch } : {})}
              {...(active ? { active } : {})}
              dataScience={dataScience}
              onOpenImage={setLightbox}
              {...(editor ? { editor } : {})}
              {...(onEditorChange ? { onEditorChange } : {})}
              {...(hostId ? { hostId } : {})}
              visible={open}
            />
            {sessionId && <ImageLightbox sessionId={sessionId} {...(lightbox ? { attachmentId: lightbox } : {})} onClose={() => setLightbox(undefined)} />}
          </>
        ) : (
          <PanelEmptyState onOpen={onOpenTab} browserStart={browserStart} dataScience={dataScience} latex={latex} {...(browser ? { browser } : {})} {...(onOpenBrowser ? { onOpenBrowser } : {})} />
        )}
      </div>
    </aside>
  );
}
