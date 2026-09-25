"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import dynamic from "next/dynamic";
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
  PlusIcon,
  SquareTerminalIcon,
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
  Turn,
  TurnState,
} from "@telar/engine-client";
import { diffTurns, type DiffTurn } from "@/lib/diff-turns";
import { diffTabParams, readDiffTab, type DiffTab } from "@/lib/diff-scope";
import { createEngineApi } from "@/lib/engine/client";
import { desktopBrowserBridge } from "@/lib/desktop-browser-bridge";
import type { JournalTask } from "@/lib/engine/journal";
import { browserPageReference, startReferenceDrag, taskReference, type TelarReference } from "@/lib/drag-reference";
import { TranscriptItem } from "@/components/transcript";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { KeyHint } from "@/components/ui/key-hint";
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
  defaultRightPanelWidth,
  RIGHT_PANEL_MAIN_MIN_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
  RIGHT_PANEL_WIDTH_STORAGE_KEY,
} from "@/lib/right-panel-layout";
import { RelatedConversations } from "@/components/session/related-conversations";
import { ReportCadence } from "@/components/session/report-cadence";
import type { EditorState, OpenIntent } from "@/lib/editor-workspace";
import { fileKind } from "@/lib/file-kinds";
import { PANEL_TAB_MIME, type PanelTabInstance, type PanelTabParams } from "@/lib/right-panel-tabs";
import { forgeParams, readForgeOpen, type ForgeOpen } from "@/lib/forge-workspace";
import { useCommandHandlers } from "@/lib/use-command-keys";
import { cn } from "@/lib/utils";

/**
 * ONE TAB IS OPEN; THE OTHER TWELVE SURFACES ARE NOT (#492).
 *
 * `PanelSurface` below is a ladder of `if`s over `tab.kind`, and exactly one arm
 * ever returns. Statically imported, every arm's module was in the chunk the
 * CONVERSATION route's first paint waited on — a Jupyter notebook renderer, a
 * LaTeX previewer, a PDF viewer, a data grid, a code editor and the desktop
 * browser, loaded in full to open a conversation whose panel is shut. The panel
 * even starts CLOSED, so on the common path none of it was drawn at all.
 *
 * NO `ssr: false`, THOUGH IT WOULD READ AS THE OBVIOUS CHOICE — which tab is
 * open comes out of localStorage, so the server renders none of these anyway,
 * and dropping SSR would save nothing it does not already save. It would cost
 * something real: `next/dynamic({ ssr: false })` renders permanently NOTHING
 * under this suite's environment (bun + happy-dom, outside a Next build), so a
 * surface declared that way is a surface no test can ever mount. Two annotate
 * tests proved it by going red on exactly that. The client chunk splits either
 * way — `ssr` decides where the component may render, not whether it is bundled
 * separately — so the testable spelling is simply the better one.
 *
 * A `Suspense` OF OUR OWN AROUND THE LADDER, because `dynamic()` with neither
 * `ssr: false` nor `loading` wraps its `React.lazy` in a Fragment and nothing
 * else (next/dist/shared/lib/lazy-dynamic/loadable.js). The first render of a
 * chunk not yet fetched then suspends up to the NEAREST boundary — which, for
 * this panel, was the route's `loading.tsx`. Opening the Editor for the first
 * time swapped the whole conversation for its skeleton and drew it again when
 * the chunk landed: what the owner saw as "a reload, only the first time" —
 * the second open finds the module cached and never suspends. The boundary
 * below keeps that wait inside the panel's body.
 *
 * THE BROWSER IS THE ONE THAT NEEDED MORE THAN THIS. Its module was reachable
 * by a second road — `desktopBrowserBridge()`, a `typeof window` check three
 * modules make — so the import above had to move to `lib/desktop-browser-bridge.ts`
 * before `dynamic` here could shift anything.
 */
const DesktopBrowserSurface = dynamic(() => import("@/components/browser-live").then((mod) => mod.DesktopBrowserSurface));
const DiffSurface = dynamic(() => import("@/components/session/diff-surface").then((mod) => mod.DiffSurface));
const EditorSurface = dynamic(() => import("@/components/session/editor-surface").then((mod) => mod.EditorSurface));
const FileViewSurface = dynamic(() => import("@/components/session/file-view-surface").then((mod) => mod.FileViewSurface));
const NotebookSurface = dynamic(() => import("@/components/session/notebook-surface").then((mod) => mod.NotebookSurface));
const PdfSurface = dynamic(() => import("@/components/session/pdf-surface").then((mod) => mod.PdfSurface));
const TableSurface = dynamic(() => import("@/components/session/table-surface").then((mod) => mod.TableSurface));
const DataSurface = dynamic(() => import("@/components/session/data-surface").then((mod) => mod.DataSurface));
const LatexSurface = dynamic(() => import("@/components/session/latex-surface").then((mod) => mod.LatexSurface));
const GitHubSurface = dynamic(() => import("@/components/session/github-surface").then((mod) => mod.GitHubSurface));
/** THE HEAVIEST ARM ON THE LADDER: xterm.js, its WebGL renderer and its image
 *  decoder. Nothing but this tab needs a terminal emulator in the bundle, and
 *  the panel starts closed — so `dynamic` here is worth more than on any of the
 *  surfaces above it. */
const TerminalSurface = dynamic(() => import("@/components/session/terminal-surface").then((mod) => mod.TerminalSurface));
/** Not a tab: an overlay over the whole panel, and only once an attachment is
 *  pressed — so it is never on screen on arrival either. */
const ImageLightbox = dynamic(() => import("@/components/session/image-lightbox").then((mod) => mod.ImageLightbox));

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
  /**
   * "AND THE CONVERSATIONS WORKING FOR THIS ONE" IS NOT PADDING — issue #381.
   * The rail used to state that relationship by drawing a delegate indented
   * under its coordinator, which read as a sub-agent of it. It is not one, and
   * a person looking for where their delegated work went now has one place to
   * look. The blurb names it because a chooser card is the only thing that
   * tells a reader a surface holds something before they open it.
   */
  { id: "agents", label: "Agents", icon: BotIcon, blurb: "Sub-agents and the conversations working for this one" },
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
   *
   * EACH HOLDS ITS OWN DETAILS (#693), in a sub-strip like the Editor's files.
   * One issue used to be a top-level tab of its own, and the argument against
   * that is the one written above for files: issues arrive by the dozen, so a
   * morning's triage pushed the surfaces you had arranged off the end of the
   * strip. They are still TWO tabs and not one — that collapse was considered
   * and deferred, because they hold separate filter state and "issues open
   * beside pull requests" is an ordinary arrangement, not a duplicate.
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
   * THE TERMINAL, and it is a real one — a pseudo-terminal in the Electron main
   * process (docs/terminal-host.md), not a log pane with a prompt drawn on it.
   * `test -t 1` answers yes in here, which is the whole difference: a pipe
   * cannot run vim, cannot draw a progress bar and cannot run the person's own
   * shell startup.
   *
   * AND THE PROJECT'S DEPLOYMENT IS IN HERE TOO (#890). There was a RUN tab
   * beside this one, with its own emulator drawing the same kind of bytes with
   * the same `ptyByteWriter`, so "the thing that is running" had two homes.
   * A run is a terminal the desktop holds, exactly as a shell is; what differs
   * is that it belongs to the PROJECT rather than to whoever opened it. That is
   * a property of one chip, not a reason for a second surface — so a run is a
   * chip in this strip, with its recipe's glyph and a state dot, and the Run
   * HEADER CONTROL stays where it was: it is the launcher, not a surface.
   *
   * MULTI-INSTANCE, unlike every other tab on this list, and for the Editor's
   * reason rather than a new one: a terminal is not a fold over a record that a
   * second copy would duplicate. It holds the shell YOU started, in the
   * directory you left it in, with your history — so a second one is a second
   * thing, not a second view.
   *
   * NOT "PROCESSES". That tab folds the engine's background tasks — things an
   * agent started, with liveness and an owner. This is a shell you type into.
   */
  { id: "terminal", label: "Terminal", icon: SquareTerminalIcon, blurb: "Shells in this session's checkout, and what the project is running" },
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
 *
 * AND EVERY OPEN ISSUE BECOMES THE ISSUES SURFACE (#693), on the same terms:
 * `issue:675` and `issue:9` both name `issues`, `readPanelTabs` leaves one tab
 * where there were two, and the NUMBERS are read out first by
 * `forgeFromLegacyTabs` and seeded as that surface's open set. Without that
 * second half this rename would quietly close every issue anybody had open —
 * the exact thing moving them inside the list is meant to stop happening.
 */
export function migratePanelTab(value: string): string {
  if (LEGACY_DS_TABS.has(value)) return "data";
  // `files` was retired in favour of Editor (#193). A saved arrangement that
  // names it opens on Editor's tree rather than on nothing.
  if (value === "files") return "editor";
  /**
   * AND `run` WAS RETIRED INTO THE TERMINAL (#890) — a run is a chip in that
   * tab's strip now, not a surface of its own.
   *
   * THE RENAME IS THE WHOLE MIGRATION, AND IT IS NOT DOING IT ALONE. Pointing
   * the id at `terminal` is what stops a saved Run tab restoring as a blank
   * pane; what folds it INTO the Terminal somebody also had open — params and
   * all, so their shells are not orphaned — is `collapseTerminalTabs`, which
   * #889 already built for exactly this shape and which the cockpit already
   * runs on every restore. The CHIP is not seeded here either: the surface
   * reads `/run/status` once on mount and gives the project's live run a chip,
   * which is the same path a run started by an agent takes.
   */
  if (value === "run") return "terminal";
  if (issuePanelNumber(value as PanelTab) !== undefined) return "issues";
  if (pullPanelNumber(value as PanelTab) !== undefined) return "pulls";
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
 *
 * THE FILE AND FORGE SHAPES BELOW ARE REQUESTS, NOT TABS, and have been since
 * the Editor (#193) and #693 respectively. They stay in this union because the
 * gestures that open a file or an issue still NAME one this way, from a dozen
 * call sites; `showPanelTab` reads the subject back out and opens it inside the
 * surface that holds it. `migratePanelTab` is what stops one ever reaching the
 * strip, including out of a layout saved before either change.
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

/**
 * ONE OPEN TAB — a KIND plus the params that make it this one (#322).
 *
 * `PanelTab` above is the kind; this is what the strip actually holds. The
 * distinction only matters for the three surfaces you can want two of.
 */
export type PanelTabItem = PanelTabInstance<PanelTab>;

/**
 * THE SURFACES YOU CAN HAVE MORE THAN ONE OF, and why only these three.
 *
 * Every other tab here is a fold over one record — the session's agents, its
 * processes, the project's issues, the project's one dev server — so a second
 * copy would show exactly what the first one shows, which is the argument tabs
 * were singletons on in the first place. These three stopped being folds: an
 * Editor holds the files YOU opened, a Browser holds the pages you navigated to
 * (in its own native scope — see `browserScopeKey`), and a Diff is a review you
 * can want two of when comparing one part of a change against another.
 *
 * ISSUES AND PULL REQUESTS ARE FOLDS AND STAY SINGLETONS, even though each now
 * holds its own open details (#693). A second Issues tab would show the same
 * project's same list — the detail sub-strip inside it is the thing you wanted
 * two of, and it already holds as many as you open. That is the Editor's
 * arrangement exactly: the surface is one, its contents are many.
 *
 * A FILE, AN ISSUE AND A BROWSER PAGE ARE NOT ON THIS LIST either. A page
 * carries its subject in the kind, so two of them are two kinds; a file and an
 * issue are not kinds at all any more, but content inside a surface.
 *
 * A TERMINAL WAS THE FOURTH AND IS NOT ANY MORE (#198). It was added on the
 * Editor's argument — two of them are two shells — and that was the right want
 * with the wrong home: three shells wrote "Terminal", "Terminal", "Terminal"
 * across this strip and pushed Diff and Issues off the edge. The Editor's OTHER
 * half is the answer, the one Issues and Pull requests already take: the surface
 * is one, its contents are many. A Terminal now carries its own strip of shells
 * (lib/terminal-workspace.ts), which is what every terminal emulator ever
 * written does, and what the Browser does one level down from here.
 */
const MULTI_INSTANCE: ReadonlySet<string> = new Set<string>(["editor", "diff"]);

export function isMultiInstancePanelTab(kind: PanelTab): boolean {
  return MULTI_INSTANCE.has(kind) || kind === LIVE_BROWSER_TAB;
}

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

/**
 * WHICH NATIVE BROWSER A BROWSER TAB DRIVES.
 *
 * The shell keys everything about a browser — its pages, its profile binding,
 * its bounds — on an opaque `scopeKey` (apps/desktop/browser-manager.js), and
 * the renderer has always handed it the session id. A second Browser tab needs
 * a second native browser, so it needs a second key, and the instance id is the
 * only thing that distinguishes the two.
 *
 * THE FIRST INSTANCE KEEPS THE BARE SESSION ID, which is not a nicety: that is
 * the scope the ENGINE drives when the agent browses, the one `openBrowser`
 * binds and the one every persisted native tab was filed under. A suffix on it
 * would hand the agent's browser to nobody and orphan the pages already open in
 * it. `nextPanelTabId` gives the first instance of a kind the kind as its id,
 * so "the first one" is exactly `id === LIVE_BROWSER_TAB`.
 */
export function browserScopeKey(sessionId: string, instanceId: string): string {
  return instanceId === LIVE_BROWSER_TAB ? sessionId : `${sessionId}#${instanceId}`;
}

/**
 * WHERE ONE EDITOR INSTANCE'S OPEN FILES ARE KEPT — the same argument as
 * `browserScopeKey`, one layer up: the first Editor keeps the bare panel key it
 * has always used, so nobody's open files move on upgrade, and a second Editor
 * gets its own drawer in the same store (lib/editor-workspace.ts).
 */
export function editorInstanceKey(panelKey: string, instanceId: string): string {
  return instanceId === "editor" ? panelKey : `${panelKey}#${instanceId}`;
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

/* An open file is no longer a panel tab, so "which files are open" is a
   question for the Editor's own state rather than for this strip — the tree
   inside Editor reads it from there (session/editor-surface.tsx). */

/**
 * ONE ISSUE OR ONE PULL REQUEST IS A REQUEST, NOT A TAB (#693) — the same turn
 * `file:` took when files moved into the Editor, and for the same reason.
 *
 * It WAS a tab, on the argument that you opened it, several can be open, and
 * each closes on its own. All three are still true; what was wrong was the
 * STRIP they were true in. Issues arrive by the dozen, so five of them pushed
 * Diff and Browser off the end of a strip built to hold a handful of surfaces —
 * and the answer the Editor already found is a sub-strip one level down, not a
 * narrower top-level strip. So these ids still name "open issue #675", because
 * that is the vocabulary the call sites speak — a conversation chip
 * (session/prompt-text.tsx), a GitHub link in a message (the cockpit's
 * `onConversationClick`), a saved layout from before this change. The cockpit
 * reads the number back out and opens it INSIDE the Issues surface
 * (`showPanelTab`), which is what let this land without rewriting every gesture.
 *
 * NOT A DRILL-DOWN WITH A BACK BUTTON, which is the shape this used to argue
 * against: the list stays a chip in the sub-strip beside the details, so two
 * issues are still two chips and the way back is not a navigation stack.
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
  /* THE TWO GITHUB SURFACES OWN THEIR HEIGHT NOW (#693). They used to be plain
     lists the panel scrolled; each holds a detail sub-strip and, behind it, a
     thread with its own scroller and a merge footer pinned under it. That is an
     `h-full` child, and one line of chrome above an `h-full` child pushes its
     bottom past the bottom of the box — which is exactly how an issue's comments
     became unreachable the first time. */
  (tab) => tab === "issues",
  (tab) => tab === "pulls",
  (tab) => tab === "editor",
  (tab) => tab === "data",
  (tab) => tab === "latex",
  /* A TERMINAL IS THE STRICTEST CASE ON THIS LIST. The others lose a scroll to a
     line of chrome above them; this one loses ROWS — the fit addon measures the
     box it was given, so every pixel the panel spends above it is a line the
     shell is told it does not have, and `clear` then leaves the bottom of the
     screen unreachable. */
  (tab) => tab === "terminal",
];

/* WHICH NUMBERS ARE ALREADY OPEN is no longer a question about the STRIP (#693).
   A detail opens inside its list, so the list surface holds its own open set and
   marks its own rows from it — see session/github-surface.tsx. */

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

/**
 * WHAT TELLS TWO TABS OF ONE KIND APART, in the few characters a tab has.
 *
 * Read out of `params`, which is where the instance's identity lives — the file
 * an Editor is on, the page a Browser is showing, the filter a Diff is under.
 * A basename and a host rather than the path and the URL: a tab is 44px wide at
 * its narrowest, and `apps/web/components/right-panel.tsx` truncates to
 * something that names nothing while `right-panel.tsx` still reads.
 *
 * NOTHING TO SAY IS NOT A FAILURE. Two Editors with no file open are two empty
 * Editors, and "Editor · " would be worse than "Editor" twice — the caller
 * drops the suffix rather than drawing a separator with nothing after it.
 */
export function panelTabSuffix(params: PanelTabParams): string | undefined {
  const path = params.path;
  if (path) return path.slice(path.lastIndexOf("/") + 1) || path;
  const url = params.url;
  if (url) {
    try {
      return new URL(url).host || url;
    } catch {
      return url;
    }
  }
  return params.filter || undefined;
}

/**
 * A TAB IN THE STRIP: its kind's label, and — only when a sibling of the same
 * kind is open — the suffix that says which one it is.
 *
 * THE SUFFIX APPEARS ON BOTH OR NEITHER. A single Editor is "Editor", because
 * naming the file you are looking at, in a tab, above a surface whose own
 * header already names it, is a word of chrome buying nothing. The moment there
 * are two, the label is the only thing distinguishing them, so both take it.
 */
export function describePanelTabInstance(
  tab: PanelTabItem,
  options: { browser?: BrowserState; live?: readonly LivePage[]; duplicate?: boolean } = {},
): { label: string; icon: typeof BotIcon; blurb: string; missing?: boolean } {
  const described = describePanelTab(tab.kind, options.browser, options.live);
  if (!options.duplicate) return described;
  const suffix = panelTabSuffix(tab.params) ?? (tab.kind === LIVE_BROWSER_TAB ? livePageSuffix(options.live) : undefined);
  if (!suffix) return described;
  return { ...described, label: `${described.label} · ${suffix}`, blurb: `${described.blurb} — ${suffix}` };
}

/** A live native browser names its own page; the host is what fits in a tab. */
function livePageSuffix(live?: readonly LivePage[]): string | undefined {
  const page = live?.find((entry) => entry.active) ?? live?.[0];
  if (!page) return undefined;
  try {
    return new URL(page.url).host || browserTabLabel(page);
  } catch {
    return browserTabLabel(page);
  }
}

/**
 * The shell's live tab lists, PER BROWSER SCOPE, or nothing outside the shell.
 * Subscribed rather than polled: the manager pushes on every change.
 *
 * A MAP NOW THAT A SESSION CAN HOLD TWO BROWSERS (#322). Each Browser tab
 * drives its own native scope (`browserScopeKey`), and the strip has to name
 * each of them from what that scope is actually showing — one shared list would
 * label both tabs with whichever browser reported last. The keys are stamped on
 * the state so a session switch cannot leave the previous session's pages
 * labelling this one's tabs.
 */
function useLivePages(scopeKeys: readonly string[]): ReadonlyMap<string, LivePage[]> | undefined {
  const bridge = desktopBrowserBridge();
  /** Joined, because a fresh array literal every render would re-run the effect
   *  on every render; the content is what changed or did not. A newline is the
   *  separator because a scope key is a session id and a tab id, and neither
   *  can contain one. */
  const keys = scopeKeys.join("\n");
  const [result, setResult] = useState<{ keys: string; pages: ReadonlyMap<string, LivePage[]> }>();
  useEffect(() => {
    const wanted = keys ? keys.split("\n") : [];
    if (!bridge || wanted.length === 0) return;
    let cancelled = false;
    const take = (state: { scopeKey: string; tabs: LivePage[] }) => {
      if (cancelled || !wanted.includes(state.scopeKey)) return;
      setResult((current) => {
        const pages = new Map(current?.keys === keys ? current.pages : []);
        pages.set(state.scopeKey, state.tabs);
        return { keys, pages };
      });
    };
    const first = window.setTimeout(() => {
      for (const key of wanted) void bridge.getState(key).then(take, () => undefined);
    }, 0);
    const unsubscribe = bridge.onState(take);
    return () => {
      cancelled = true;
      window.clearTimeout(first);
      unsubscribe();
    };
  }, [bridge, keys]);
  return bridge && result?.keys === keys ? result.pages : undefined;
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
 *
 * THE KEY IS WHATEVER THE TOOL WROTE DOWN, which is usually an absolute path and
 * is not what git calls the same file. Re-keying happens where the checkout is
 * known — `reconcileReview` has the diff's `workspacePath`, and this fold has
 * only items (#350).
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

/**
 * HAS THE AGENT DRIVEN THE SESSION'S BROWSER since this panel mounted, past
 * the last event already acted on?
 *
 * `browser.state.changed` is journalled after an agent's browser call that
 * moved something (apps/engine/src/browser/socket.ts), so a fresh one with
 * pages in it is "the agent has pages", which is when the panel's Browser tab
 * must exist. One with no pages is not a reason to show an empty browser.
 *
 * `since` IS THE `display_open` GUARD. The journal replays from zero on every
 * load, and without it every reload would put back a Browser tab the person
 * closed last week. `after` keeps one event from acting twice as the array
 * grows behind it — and returns where the caller should resume.
 */
export function agentBrowserActivity(events: readonly EngineEvent[], since: number, after: number): { acted: boolean; through: number } {
  let acted = false;
  let through = after;
  for (const event of events) {
    if (event.type !== "browser.state.changed" || event.at < since || event.id <= after) continue;
    through = Math.max(through, event.id);
    if (event.tabs.length > 0) acted = true;
  }
  return { acted, through };
}

/**
 * THE NATIVE SCOPE TO DESTROY WHEN A PANEL TAB CLOSES, or undefined when the
 * tab is not a desktop Browser. Closing the Browser tab used to only take it
 * off the strip, and the pages behind it — the agent's included — kept
 * running with nothing on screen. Every Browser instance releases its own
 * scope: the first is the bare session id the agent drives
 * (`browserScopeKey`), a second one would otherwise leak the same way.
 */
export function browserScopeToRelease(sessionId: string, tab: PanelTabInstance | undefined): string | undefined {
  return tab?.kind === LIVE_BROWSER_TAB ? browserScopeKey(sessionId, tab.id) : undefined;
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
function BrowserPageSurface({
  pageId,
  state,
  sessionId,
  projectId,
  scopeKey,
  onEnded,
  onAttach,
}: {
  pageId: string;
  state?: BrowserState;
  sessionId?: string;
  projectId?: string;
  /** Which native browser this tab drives — see `browserScopeKey`. Absent on
   *  the screenshot clients, which have no native view to scope. */
  scopeKey?: string;
  /** The native browser's last tab closed (#383). Nothing for the screenshot
   *  fallback, which is a view of a browser it does not own. */
  onEnded?: () => void;
  /** The camera's destination (#474) — the composer's attachment list and its
   *  draft. Only the LIVE surface takes it: the screenshot fallback is a poll
   *  of a browser on another machine, with no shell capture to hand over. */
  onAttach?: (files: readonly File[], caption?: string) => void;
}) {
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
  const scope = scopeKey ?? sessionId;
  if (bridge && scope) {
    // KEYED BY THE SCOPE, not the session: two Browser tabs in one session are
    // two native browsers, and sharing a key would make React reuse one
    // instance's bounds, tab list and profile binding for the other.
    return (
      <DesktopBrowserSurface
        key={scope}
        bridge={bridge}
        scopeKey={scope}
        {...(projectId ? { projectId } : {})}
        {...(onEnded ? { onEnded } : {})}
        {...(onAttach ? { onAttach } : {})}
      />
    );
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
        <span className="min-w-0 flex-1 truncate font-mono text-2xs text-muted-foreground" title={page.url}>
          {page.url || "about:blank"}
        </span>
        {live && !snapshot?.screenshot && <Spinner className="size-3 shrink-0 text-muted-foreground" />}
        {page.loading && <Badge variant="outline" className="shrink-0 px-1 py-0 text-4xs font-normal">loading</Badge>}
        {page.active && <Badge variant="secondary" className="shrink-0 px-1 py-0 text-4xs font-normal">active</Badge>}
      </div>
      {snapshot?.screenshot ? (
        <div className="min-h-0 flex-1 overflow-auto bg-muted/40 p-2">
          {/* eslint-disable-next-line @next/next/no-img-element -- a data URL polled from the engine; there is nothing for next/image to optimise */}
          <img
            src={snapshot.screenshot}
            alt={`Screenshot of ${browserTabLabel(page)}`}
            className="w-full rounded-md border border-border shadow-1"
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
            {task.role && task.title && <span className="truncate text-3xs text-muted-foreground">{task.role}</span>}
          </span>
          {steps.length > 0 && (
            <span className="shrink-0 text-3xs text-muted-foreground">
              {steps.length} step{steps.length === 1 ? "" : "s"}
            </span>
          )}
          {tokens !== undefined && <span className="shrink-0 font-mono text-3xs text-muted-foreground tabular-nums">{figure(tokens)}</span>}
          <span className={cn("shrink-0 font-mono text-3xs", task.state === "failed" ? "text-destructive" : "text-muted-foreground")}>
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
            <p className={cn("pt-1 text-2xs whitespace-pre-wrap", task.failure ? "text-destructive" : "text-muted-foreground")}>{body}</p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The roster, split for the two task surfaces.
 *
 * THERE IS NO FOLD IN FRONT OF THIS SPLIT ANY MORE. It used to group Warp runs
 * first and divide only what was left, because a run's own row was `background`
 * while its children were `agent` rows — splitting on kind first would have
 * filed the run under Processes and stranded its agents. #877 retired Warp, and
 * with it the one thing on this surface that was a container rather than a
 * worker. Every task here now belongs to exactly one side.
 *
 * `kind !== "background"` rather than `=== "agent"`, matching the contract's
 * own denylist posture: anything the engine did not recognise as background is
 * presumed to be an agent (protocol/tasks.ts).
 */
export type RosterSplit = { agents: JournalTask[]; processes: JournalTask[] };

export function splitRoster(tasks: readonly JournalTask[]): RosterSplit {
  return {
    agents: tasks.filter((task) => task.kind !== "background"),
    processes: tasks.filter((task) => task.kind === "background"),
  };
}

/**
 * THE ROSTER, AND WHO ELSE IS ON IT — issue #381.
 *
 * Two kinds of worker share this surface and they are not the same kind of
 * thing. A SUB-AGENT is a task inside this session's own turn: it has a step
 * count, a conclusion, and no existence afterwards. A DELEGATED CONVERSATION is
 * a peer — its own transcript, its own worktree, its own life once the errand
 * ends. The rail used to blur that by drawing the second as a child row of the
 * conversation that asked it for something, which is exactly the reading the
 * owner objected to.
 *
 * SO THEY ARE BOTH HERE AND THEY ARE APART. Sub-agents keep the surface's top,
 * because a fan-out in flight is the thing that moves; the conversations sit
 * below their own headings, where a row has room to say which errand, how it
 * went and when (`session/related-conversations.tsx`).
 */
function AgentsSurface({
  tasks,
  focused,
  sessionId,
  hostId,
  visible = true,
}: {
  tasks: readonly JournalTask[];
  focused?: TaskFocus;
  sessionId?: string;
  hostId?: string;
  visible?: boolean;
}) {
  const { agents: loose } = useMemo(() => splitRoster(tasks), [tasks]);
  /**
   * THE CADENCE INTRODUCES THE RELATIONSHIP REGION — issue #723, and the owner's
   * own choice of home for it. How often this conversation is told about its
   * peers is a property of the relationships listed underneath, so it sits
   * directly above them rather than in the composer or the header.
   *
   * ALWAYS, NOT ONLY WHEN A PEER EXISTS. A window is what you set BEFORE
   * dispatching several peers — a control that appeared once they were already
   * talking would arrive exactly one decision too late.
   */
  const related = (
    <>
      <ReportCadence
        {...(sessionId ? { sessionId } : {})}
        {...(hostId ? { hostId } : {})}
        visible={visible}
      />
      <RelatedConversations
        {...(sessionId ? { sessionId } : {})}
        {...(hostId ? { hostId } : {})}
        visible={visible}
      />
    </>
  );
  if (loose.length === 0) {
    // NO EMPTY STATE OF ITS OWN WHEN SOMETHING IS RELATED. "Sub-agents appear
    // here as they work" above a list of four conversations that are working
    // would be the surface contradicting its own contents.
    return (
      <div className="flex flex-col">
        <PanelEmpty icon={<BotIcon />} title="Sub-agents appear here as they work">
          Background work lives on the Processes tab.
        </PanelEmpty>
        {related}
      </div>
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
      {live.map(row)}
      {finished.length > 0 && live.length > 0 && <PanelDivider label={`done · ${finished.length}`} />}
      {finished.map(row)}
      {related}
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
  diffTurnList,
  tasks,
  focusedTask,
  browser,
  events = [],
  sessionId,
  sessionTitle,
  projectId,
  branch,
  onOpenTab,
  onOpenNewTab,
  onOpenFileInNewTab,
  onInsertReference,
  onAttach,
  onTabParams,
  onCloseSelf,
  active,
  dataScience,
  onOpenImage,
  editor,
  onEditorChange,
  hostId,
  visible = true,
}: {
  /** The INSTANCE — its kind chooses the surface, its id keys anything that
   *  must not be shared with another tab of the same kind. */
  tab: PanelTabItem;
  /** What the journal says was written, path → count. The Diff surface's half of
   *  the reconciliation — see `journalWrites`. */
  writes: ReadonlyMap<string, number>;
  /** The turns that reported writing something, newest first — the Diff's
   *  `turn` scope (#694). A fold over the same journal `writes` comes from,
   *  kept separate because it carries the PATCHES and that is a different
   *  amount of memory to hand every surface. */
  diffTurnList?: readonly DiffTurn[];
  tasks: readonly JournalTask[];
  /** The sub-agent a transcript chip just asked for. */
  focusedTask?: TaskFocus;
  browser?: BrowserState;
  /** The session's journal, for the surfaces that fold a live fact out of it
   *  rather than asking for it — the Data tab's kernel state (#356), the way
   *  `browser` above is already a fold of the same list. */
  events?: readonly EngineEvent[];
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
  /**
   * The tree opens a file by naming it, which the cockpit routes — a surface
   * tab opens as a tab; a file-shaped id opens in the Editor. `intent` says how
   * deliberate the gesture was, and is ignored for anything but a file.
   */
  onOpenTab: (tab: PanelTab, intent?: OpenIntent) => void;
  /**
   * Open a file in a NEW Editor tab (#322) — offered by the tree's row menu and
   * a file's own body menu. Absent simply hides the item, which is what a
   * caller with no second Editor to give wants.
   */
  onOpenFileInNewTab?: (path: string) => void;
  /**
   * Open ANOTHER instance of a multi-instance kind, with params — the "+"
   * chooser's verb, reached from inside a surface. A Diff row uses it to review
   * its own path in a second Diff (#335).
   */
  onOpenNewTab?: (tab: PanelTab, params?: PanelTabParams) => void;
  /**
   * Put a reference into the message being written — the same text a row's own
   * DRAG already carries (`lib/drag-reference.ts`), reached with a gesture that
   * does not require aiming at the composer. The cockpit owns the draft, so it
   * owns this; absent (a canvas with no composer) simply hides the item.
   */
  onInsertReference?: (text: string) => void;
  /**
   * ATTACH FILES to the message being written, with an optional one-line
   * caption inserted into the draft beside them (#474).
   *
   * The browser's camera is the caller: a screenshot is an attachment, and a
   * picture of a page needs the page's address said in words or the agent
   * cannot go look at it. The cockpit owns the draft AND the attachment list,
   * so it owns this — absent (a canvas with no composer) simply hides the
   * camera, rather than offering one that captures into nowhere.
   */
  onAttach?: (files: readonly File[], caption?: string) => void;
  /**
   * Rewrite THIS instance's params — what a surface calls when the thing that
   * identifies it changes, so the strip's label follows (#335). Bound to the
   * active tab's id by the caller, exactly as `onEditorChange` is: a surface
   * must not be able to name another tab.
   */
  onTabParams?: (params: PanelTabParams) => void;
  /**
   * CLOSE THIS INSTANCE'S TAB — bound to its own id by the caller, exactly as
   * `onTabParams` is, so a surface can end itself and no other.
   *
   * One surface asks for it: the live browser, whose last native tab closing
   * ends the browser the tab exists to show (#383). Absent simply means nobody
   * can close this tab from inside it.
   */
  onCloseSelf?: () => void;
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
  const kind = tab.kind;
  const notebookPath = notebookPanelPath(kind);
  if (notebookPath !== undefined)
    return <NotebookSurface path={notebookPath} {...(sessionId ? { sessionId } : {})} {...(active ? { active } : {})} {...(onOpenImage ? { onOpenImage } : {})} />;
  const tablePath = tablePanelPath(kind);
  if (tablePath !== undefined) return <TableSurface path={tablePath} {...(sessionId ? { sessionId } : {})} {...(active ? { active } : {})} />;
  const pdfPath = pdfPanelPath(kind);
  if (pdfPath !== undefined)
    return <PdfSurface path={pdfPath} {...(sessionId ? { sessionId } : {})} {...(projectId ? { projectId } : {})} {...(active ? { active } : {})} />;
  if (kind === "editor")
    return editor && onEditorChange ? (
      /**
       * KEYED BY THE CHECKOUT AND THE INSTANCE. Moving between sessions
       * replaces the Editor rather than re-rendering it, so nothing it holds
       * per file — the saving dots, a half-confirmed close, where each file was
       * scrolled to — can be read as belonging to the session you just arrived
       * in. The instance id joins it for the same reason one level down: two
       * Editor tabs are two Editors, and a shared key would have React carry
       * one's half-confirmed close into the other. The unsaved text itself is
       * not in here to lose (lib/editor-drafts.ts keys it by the same scope and
       * outlives every one of these mounts).
       */
      <EditorSurface
        key={`${hostId ?? "local"}:${sessionId ?? projectId ?? "none"}:${tab.id}`}
        state={editor}
        onState={onEditorChange}
        {...(sessionId ? { sessionId } : {})}
        {...(projectId ? { projectId } : {})}
        {...(hostId ? { hostId } : {})}
        {...(active ? { active } : {})}
        dataScience={dataScience === true}
        {...(onOpenImage ? { onOpenImage } : {})}
        // THE TREE'S ROW MENU OFFERS THE REFERENCE TOO. It always could — the
        // row builds the same `fileReference` its own drag carries — but this
        // prop was never handed down, so the one place a person BROWSES for a
        // file to mention was the one place that could not mention it (#357).
        // Unwrapped to the text the cockpit's draft takes, exactly as the Diff
        // surface's rows below already are.
        {...(onInsertReference ? { onInsertReference: (reference: TelarReference) => onInsertReference(reference.text) } : {})}
        {...(onOpenFileInNewTab ? { onOpenInNewPanelTab: onOpenFileInNewTab } : {})}
      />
    ) : null;
  if (kind === "data")
    return (
      <DataSurface
        {...(sessionId ? { sessionId } : {})}
        {...(projectId ? { projectId } : {})}
        {...(active ? { active } : {})}
        // The kernel announces every transition on the journal; the pill folds
        // them rather than asking once and believing the answer all turn (#356).
        events={events}
        {...(onOpenImage ? { onOpenImage } : {})}
      />
    );
  if (kind === "latex")
    return <LatexSurface {...(sessionId ? { sessionId } : {})} {...(active ? { active } : {})} onOpenFile={(path) => onOpenTab(panelTabForPath(path, dataScience === true))} />;
  /**
   * KEYED BY THE INSTANCE AND THE CHECKOUT, like the Editor above and for a
   * harder reason: what this holds is not scroll position but LIVE SHELLS. A
   * shared key would have React reuse one tab's emulators for another's PTYs,
   * so the bytes of one terminal would arrive in the other's screen.
   *
   * THE WHOLE INNER STRIP round-trips through the tab's own params — the same
   * trip the Diff's filter and the Editor's open file make — which is what lets
   * a remounted panel re-adopt every running shell instead of stranding them.
   */
  if (kind === "terminal")
    return (
      <TerminalSurface
        key={`${hostId ?? "local"}:${sessionId ?? projectId ?? "none"}:${tab.id}`}
        {...(sessionId ? { sessionId } : {})}
        {...(projectId ? { projectId } : {})}
        // The run chips in the strip read a HOST-SCOPED door (#890), and
        // session ids are per-host: an unpinned client could come back
        // describing another Mac's deployment rather than failing.
        {...(hostId ? { hostId } : {})}
        params={tab.params}
        {...(onTabParams ? { onParams: onTabParams } : {})}
        {...(onCloseSelf ? { onCloseSelf } : {})}
        visible={visible}
      />
    );
  const filePath = filePanelPath(kind);
  if (filePath !== undefined)
    return (
      <FileViewSurface
        path={filePath}
        {...(sessionId ? { sessionId } : {})}
        {...(projectId ? { projectId } : {})}
        {...(active ? { active } : {})}
      />
    );
  const pageId = browserTabId(kind);
  if (pageId !== undefined)
    return (
      <BrowserPageSurface
        pageId={pageId}
        {...(browser ? { state: browser } : {})}
        {...(sessionId ? { sessionId, scopeKey: browserScopeKey(sessionId, tab.id) } : {})}
        {...(projectId ? { projectId } : {})}
        {...(onCloseSelf ? { onEnded: onCloseSelf } : {})}
        {...(onAttach ? { onAttach } : {})}
      />
    );
  if (kind === "diff")
    return (
      <DiffSurface
        {...(sessionId ? { sessionId } : {})}
        {...(projectId ? { projectId } : {})}
        reported={writes}
        suggestion={sessionTitle?.trim() || "Session work"}
        {...(active ? { active } : {})}
        // THIS instance, whole — the scope it is looking at, the base and turn
        // it remembers, and its filter — read from and written back to the
        // tab's own params, the same round trip the Editor's open file makes.
        // That is what lets `panelTabSuffix` name the tab "Diff · apps/web/"
        // and what makes two windows on one session keep their own scope.
        //
        // ONE OBJECT IN AND ONE OBJECT OUT, because `setPanelTabParams` is a
        // REPLACE: a handler writing `{ filter }` would erase the scope and one
        // writing `{ scope }` would erase the filter. `diffTabParams` writes no
        // key for a default, so an untouched tab persists exactly as it did.
        tab={readDiffTab(tab.params)}
        {...(onTabParams ? { onTabChange: (next: DiffTab) => onTabParams(diffTabParams(next)) } : {})}
        {...(diffTurnList ? { turns: diffTurnList } : {})}
        // Derived from `onOpenTab`, exactly as LatexSurface's is above — a
        // changed file opens through the ONE route into the Editor rather than
        // a second one cut for this menu.
        onOpenFile={(path) => onOpenTab(panelTabForPath(path, dataScience === true))}
        // ...and the row's own path in a second Diff, through the same verb the
        // "+" chooser presses for another instance.
        {...(onOpenNewTab ? { onOpenInNewPanelTab: (path: string) => onOpenNewTab("diff", { filter: path }) } : {})}
        {...(onInsertReference ? { onInsertReference } : {})}
      />
    );
  if (kind === "issues" || kind === "pulls")
    return (
      <GitHubSurface
        kind={kind}
        {...(projectId ? { projectId } : {})}
        {...(branch ? { branch } : {})}
        // THIS instance's open details, read from and written back to the tab's
        // own params — the same round trip the Diff's filter and the Editor's
        // active file make. That is what persists the sub-strip across a reload
        // and what keeps two windows on one session independent of each other.
        open={readForgeOpen(tab.params)}
        {...(onTabParams ? { onOpenChange: (next: ForgeOpen) => onTabParams(forgeParams(next)) } : {})}
        // The two an issue row's session action needs (#695): which Mac the
        // canvas it opens belongs to, and the live composer for the one case
        // where this panel is already on that canvas.
        {...(hostId ? { hostId } : {})}
        {...(onInsertReference ? { onInsertReference } : {})}
        /**
         * THE ISSUE↔PR LINK'S JUMP (#790), through the door that already exists.
         *
         * `issuePanelTab`/`pullPanelTab` is the SAME id a GitHub link in a message
         * and a layout saved before #693 both hand to `onOpenTab`, and the cockpit's
         * `showPanelTab` reads the number back out and opens it inside the matching
         * list surface. So the jump from an issue to its closing pull request costs
         * nothing but the mapping on this line — no second route, and no way for the
         * two paths to disagree about where `pull:786` lands.
         */
        onOpenForge={(one, number) => onOpenTab(one === "issue" ? issuePanelTab(number) : pullPanelTab(number))}
      />
    );
  if (kind === "agents")
    return (
      <AgentsSurface
        tasks={tasks}
        {...(focusedTask ? { focused: focusedTask } : {})}
        {...(sessionId ? { sessionId } : {})}
        {...(hostId ? { hostId } : {})}
        visible={visible}
      />
    );
  if (kind === "processes") return <ProcessesSurface tasks={tasks} {...(focusedTask ? { focused: focusedTask } : {})} />;
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
 * TWO COLUMNS ONCE THERE IS ROOM FOR TWO — issue #382, the owner: "it's getting
 * a bit busier". Ten full-width rows is a column you scroll rather than a menu
 * you read, and the panel opens at 480px with most of that width spent on the
 * empty half of a truncated blurb.
 *
 * A CONTAINER QUERY, NEVER A VIEWPORT ONE, and that distinction is the whole
 * history of this layout. It was `sm:grid-cols-2` once: `sm:` fires on a wide
 * WINDOW even when this panel is 240px, so three-word blurbs wrapped one word
 * per line inside 90px columns, and the fix at the time was to give up on
 * columns entirely. `@container` is the thing that was missing — the panel can
 * now ask how wide IT is, so the second column appears exactly when it fits and
 * a dragged-narrow panel still gets the single column the rows were written for.
 *
 * ROW-MAJOR, which is `grid` doing nothing special: the cards keep the order
 * they are declared in, reading left to right. A column-major fill would put
 * Agents beside Issues and make the list impossible to scan against the strip.
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
    /* NAMED `@container/panel-empty`, not a bare `@container`: a bare one
       answers for whichever ancestor is nearest, and this box sits inside a
       panel whose surfaces are free to open containers of their own. */
    <div className="@container/panel-empty flex h-full flex-col justify-center p-4">
      {/* The cap grows with the columns. `max-w-sm` is one readable column; two
          columns inside it would be 180px each, which is narrower than the rows
          this replaced and would truncate every blurb to a word. */}
      <div className="mx-auto w-full max-w-sm @[420px]/panel-empty:max-w-2xl">
        <PanelsTopLeftIcon className="mx-auto size-7 text-muted-foreground/40" />
        <h2 className="mt-3 text-center font-heading text-sm font-medium">Open a surface</h2>
        <p className="mt-1 text-center text-xs leading-relaxed text-muted-foreground">Choose what to keep beside the conversation.</p>
        <div className="mt-4 grid grid-cols-1 gap-1 @[420px]/panel-empty:grid-cols-2">
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
                <span className="block truncate text-2xs text-muted-foreground">{candidate.blurb}</span>
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
                <span className="block truncate text-2xs text-muted-foreground">
                  {browserStart.status === "error" ? "Try again" : "Start this session’s browser"}
                </span>
              </span>
            </button>
            {/* The engine's own words, under the button that asked. A silent
                press is the one outcome nobody can tell from "still starting". */}
            {browserStart.status === "error" && (
              <p role="alert" className="mt-1.5 px-1 text-2xs leading-relaxed text-destructive">
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
            <p className="mt-5 text-2xs font-medium uppercase tracking-wide text-muted-foreground">Browser</p>
            <div className="mt-1.5 flex flex-col gap-1">
              <button
                type="button"
                onClick={() => onOpen(LIVE_BROWSER_TAB)}
                className="flex items-center gap-2.5 rounded-lg border border-border px-2.5 py-2 text-left transition-colors hover:bg-muted/60"
              >
                <GlobeIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium text-foreground">Browser</span>
                  <span className="block truncate font-mono text-3xs text-muted-foreground">{pages.length} open page{pages.length === 1 ? "" : "s"}</span>
                </span>
              </button>
            </div>
          </>
        )}
        {pages.length > 0 && !desktopBrowserBridge() && (
          <>
            <p className="mt-5 text-2xs font-medium uppercase tracking-wide text-muted-foreground">Open pages</p>
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
                    <span className="block truncate font-mono text-3xs text-muted-foreground">{page.url}</span>
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
   * unchanged, and parameterised because a second panel is a different panel —
   * sharing one key would make widening one resize the other.
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
      // THE NATIVE LAYER IS NOT IN THIS LAYOUT. A `WebContentsView` is
      // composited above the DOM, so the integrated browser's view only moves
      // when someone publishes new bounds — and a ResizeObserver delivers that
      // a frame or more after this paint, which reads as the view lagging the
      // handle. Announcing the paint synchronously lets the host republish in
      // the SAME frame; the observer stays the self-heal.
      window.dispatchEvent(new Event("telar:panel-resized"));
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

  // NO GRIP — issue #905, so all three resize handles agree. The cockpit rail
  // and the Settings one draw nothing; a pill here would be the only seam left
  // on screen, and it sits in the same kind of gap between two islands.
  return (
    <button
      type="button"
      aria-label="Resize right panel"
      title="Drag to resize right panel"
      className="absolute inset-y-0 -left-2 z-20 block w-4 cursor-col-resize touch-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
    />
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
  turns = [],
  tasks = [],
  focusedTask,
  onOpenBrowser,
  browserStart = { status: "idle" },
  events = [],
  tabs,
  tab,
  onTabChange,
  onOpenTab,
  onOpenNewTab,
  onOpenFileInNewTab,
  onInsertReference,
  onAttach,
  onCloseTab,
  onMoveTab,
  onClose,
  onTabParams,
  open = true,
  dataScience = false,
  latex = false,
  editors,
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
  /** The session's turns, for the Diff's `turn` scope: the journal says WHICH
   *  run wrote a file, and these say what that run was asked to do (#694). */
  turns?: readonly Turn[];
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
  tabs: readonly PanelTabItem[];
  /** The ACTIVE INSTANCE's id, not its kind — two Editors are two tabs. */
  tab?: string;
  onTabChange: (id: string) => void;
  /** Open a surface, or focus the one of that kind already open — every "go
   *  there" gesture in the cockpit. */
  onOpenTab: (tab: PanelTab, intent?: OpenIntent) => void;
  /** Open ANOTHER instance of a multi-instance kind, with the params that make
   *  it a different one. Absent leaves the "+" chooser offering each kind once,
   *  which is what a caller with no per-instance state to give them wants. */
  onOpenNewTab?: (tab: PanelTab, params?: PanelTabParams) => void;
  /** Open a file in a NEW Editor tab — see `PanelSurface`. */
  onOpenFileInNewTab?: (path: string) => void;
  /** Put a reference into the message being written — see `PanelSurface`. */
  onInsertReference?: (text: string) => void;
  /** Attach files to the message being written — see `PanelSurface`. */
  onAttach?: (files: readonly File[], caption?: string) => void;
  /** Rewrite one instance's params, so a surface can keep its own tab's label
   *  true — see `PanelSurface`. By id, like `onEditorChange`. */
  onTabParams?: (id: string, params: PanelTabParams) => void;
  onCloseTab: (id: string) => void;
  /** Reorder the strip — `toIndex` is the place in the strip WITHOUT the moved
   *  tab, which is what `movePanelTab` takes. Absent leaves the tabs draggable
   *  but inert, which is what a caller that does not persist a strip wants. */
  onMoveTab?: (id: string, toIndex: number) => void;
  onClose: () => void;
  /** Each Editor instance's open files, by tab id — see `PanelSurface`. */
  editors?: Readonly<Record<string, EditorState>>;
  onEditorChange?: (id: string, next: (current: EditorState) => EditorState) => void;
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
   * "FILL THE WINDOW" IS THE ONE COMMAND THIS PANEL OWNS (#367) — the corner
   * glyph and the context-menu row already share `setFullscreen`, and the chord
   * is the third gesture on the same state rather than a fourth idea about it.
   *
   * BOUND ONLY WHILE THE PANEL IS OPEN. A chord that put a closed panel into
   * fullscreen would fill the window with a surface nobody asked for; with
   * nothing bound the key does nothing, which is the honest answer.
   */
  useCommandHandlers(open ? { "panel-fullscreen": () => setFullscreen((current) => !current) } : {}, [open]);
  /**
   * WHAT THE PRESS ON THE "+" MEANT, decided while the button is down.
   *
   * A menu trigger toggles from `mousedown`, but the primitive defers the
   * state change to a `requestAnimationFrame` (floating-ui's `useClick`, to
   * let focus land before the popup opens). A frame that never arrives — an
   * occluded or throttled renderer, which the shell's composited native
   * browser view is very good at producing — therefore swallows the press
   * entirely, which is #349: the pointer did nothing while the keyboard, whose
   * path opens synchronously from `click`, still worked.
   *
   * So the decision is made here, on the event this component can see, and
   * applied on `click`. The menu is CONTROLLED — this panel owns the boolean
   * already — so when the deferred frame DID run, it has set exactly this
   * value and the write is a no-op. `undefined` means no mouse press is in
   * flight: a keyboard activation has no `mousedown`, and must be left to the
   * primitive rather than repaired against a stale decision.
   */
  const chooserPress = useRef<boolean>(undefined);
  /**
   * WHICH TAB'S CONTEXT MENU IS OPEN, or nothing — the strip's menus are
   * CONTROLLED for the same reason the chooser is: the native browser view
   * sits above this DOM, and `useNativeViewOverlay` needs a boolean to take it
   * down by. One piece of state for the whole strip rather than one per chip,
   * because at most one context menu is ever open.
   */
  const [menuTab, setMenuTab] = useState<string>();
  // The native browser view is composited above this DOM; drop it while the
  // chooser or a tab's menu is open so the menu is the thing on top. No-op on
  // the web build.
  useNativeViewOverlay(surfaceChooserOpen);
  useNativeViewOverlay(menuTab !== undefined);
  /** The tab being carried, and the edge of the tab it is over — instance ids.
   *  Held by the strip rather than by a tab, because a drop lands on a
   *  DIFFERENT tab than the one that started the drag. */
  const [draggingTab, setDraggingTab] = useState<string | null>(null);
  const [tabInsert, setTabInsert] = useState<{ id: string; side: "before" | "after" } | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const prefs = useSidebarPrefs(RIGHT_PANEL_WIDTH_STORAGE_KEY);
  // A stored width is the person's own answer and always wins; this is only
  // what to open at when there is none — see `defaultRightPanelWidth`.
  const width = prefs.width ?? defaultRightPanelWidth(tabs);
  const writes = useMemo(() => journalWrites(items), [items]);
  /** The same journal, folded the other way — by RUN rather than by path, and
   *  carrying each turn's own reported patches (#694). Memoised beside
   *  `writes` because both are folds of one list that changes on every item. */
  const diffTurnList = useMemo(() => diffTurns(items, turns), [items, turns]);
  const browser = useMemo(() => latestBrowserState(events), [events]);
  /** One native scope per open Browser tab, so the strip can name each of them
   *  from what that browser is actually showing. */
  const browserScopes = useMemo(
    () => (sessionId ? tabs.filter((entry) => browserTabId(entry.kind) !== undefined).map((entry) => browserScopeKey(sessionId, entry.id)) : []),
    [sessionId, tabs],
  );
  const livePages = useLivePages(browserScopes);
  /** The instance the panel is showing, resolved once. */
  const activeTab = useMemo(() => tabs.find((entry) => entry.id === tab), [tabs, tab]);
  /** Which kinds the strip holds more than one of — what decides whether a tab
   *  wears its params as a suffix. */
  const duplicated = useMemo(() => {
    const counted = new Map<string, number>();
    for (const entry of tabs) counted.set(entry.kind, (counted.get(entry.kind) ?? 0) + 1);
    return new Set([...counted].filter(([, count]) => count > 1).map(([kind]) => kind));
  }, [tabs]);
  /**
   * EVERY ROW ON THIS SURFACE IS A WORKER, so each is counted exactly once.
   *
   * It was not always: a Warp run's own row was a CONTAINER, and a four-agent
   * fan-out would have read as five running until it was excluded from the live
   * count and kept in the failed one. #877 retired Warp, and the asymmetry that
   * justified went with it.
   */
  const roster = useMemo(() => splitRoster(tasks), [tasks]);
  /** Starting a browser is offered only when there is none to open a tab for. */
  const canStartBrowser = Boolean(onOpenBrowser) && (browser?.tabs.length ?? 0) === 0;
  /** A plot opened large, from any surface that shows one. */
  const [lightbox, setLightbox] = useState<string>();
  /**
   * THE TERMINAL TABS THAT HAVE BEEN LOOKED AT, in the order they first were
   * (#909). Mounted from then on, hidden when they are not the tab on screen —
   * the body below says why.
   *
   * "HAVE BEEN LOOKED AT" AND NOT "EXIST". A restored layout can carry a
   * Terminal tab nobody has opened in this window, and mounting that one would
   * adopt — or, when the host no longer holds those PTYs, SPAWN — a shell per
   * tab on every page load, for a surface nobody asked to see.
   *
   * ADJUSTED DURING RENDER rather than in an effect, which is React's own
   * answer for state derived from props, and the only one available here: a
   * newly-opened Terminal has to be in this list on the FIRST render that shows
   * it, or it would render from the branch below and then move into this one —
   * and moving between two positions in the tree is an unmount and a remount,
   * which is the exact thing being fixed. (A ref would be read during render;
   * a `setState` in an effect cascades a render. Both are refused here.)
   */
  const [keptTerminals, setKeptTerminals] = useState<readonly string[]>([]);
  const liveTerminals = keptTerminals.filter((id) => tabs.some((entry) => entry.id === id && entry.kind === "terminal"));
  const wantedTerminals =
    activeTab?.kind === "terminal" && !liveTerminals.includes(activeTab.id) ? [...liveTerminals, activeTab.id] : liveTerminals;
  // Compared by value: a closed tab dropped and a new one added in one update
  // are the same LENGTH and a different list, and a panel that missed that
  // would keep a dead id and forget a live one.
  if (wantedTerminals.length !== keptTerminals.length || wantedTerminals.some((id, at) => keptTerminals[at] !== id)) setKeptTerminals(wantedTerminals);
  const agentSide = roster.agents;
  const running = agentSide.filter(isLiveTask).length;
  const failed = agentSide.filter((task) => task.state === "failed").length;
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
    // One row, one count. The surface holds no container rows, so the badge and
    // the list underneath it cannot disagree.
    agents: roster.agents.length,
    processes: roster.processes.length,
  };
  const holdsKind = (kind: PanelTab) => tabs.some((entry) => entry.kind === kind);
  /** A kind already open is worth offering again only when a second one is a
   *  different thing AND this caller can mint it. */
  const offersAnother = (kind: PanelTab) => isMultiInstancePanelTab(kind) && onOpenNewTab !== undefined;
  /**
   * WHAT THE "+" OFFERS.
   *
   * A SINGLETON DISAPPEARS ONCE IT IS OPEN, because pressing it again could
   * only focus the tab already in the strip beside the button. A MULTI-INSTANCE
   * KIND STAYS, and pressing it opens another one — that is the whole of #322
   * at the chooser: "Editor" is not a place, it is a thing you can have two of.
   * `another` says which of the two a press means, so the row can say so too.
   */
  const openable: { id: PanelTab; label: string; icon: typeof BotIcon; another: boolean }[] = [
    ...surfacesFor(dataScience, latex)
      .filter((surface) => !holdsKind(surface.id) || offersAnother(surface.id))
      .map((surface) => ({
        id: surface.id as PanelTab,
        label: surface.label,
        icon: surface.icon,
        another: holdsKind(surface.id),
      })),
    // On desktop the native strip owns the pages: offer ONE "Browser" entry —
    // which, once one is open, opens a SECOND browser in its own native scope.
    ...(desktopBrowserBridge()
      ? (browser?.tabs?.length ?? 0) > 0 && (!holdsKind(LIVE_BROWSER_TAB) || offersAnother(LIVE_BROWSER_TAB))
        ? [{ id: LIVE_BROWSER_TAB, label: "Browser", icon: GlobeIcon, another: holdsKind(LIVE_BROWSER_TAB) }]
        : []
      : (browser?.tabs ?? [])
          .filter((page) => !holdsKind(browserPanelTab(page.id)))
          .map((page) => ({ id: browserPanelTab(page.id), label: browserTabLabel(page), icon: GlobeIcon, another: false }))),
  ];

  /**
   * ONE INSTANCE'S SURFACE, WITH EVERY CALLBACK BOUND TO THAT INSTANCE.
   *
   * WHY IT IS A FUNCTION AND NOT TWO COPIES OF THE JSX. A kept Terminal renders
   * from one place in the body below and everything else from another, and the
   * bindings are the part that must not drift between them: `onTabParams` and
   * `onCloseSelf` name a tab, and a hidden Terminal writing the ACTIVE tab's
   * params — which is what a copy that kept saying `activeTab.id` would do —
   * would move another surface's shells onto it.
   *
   * `showing` is whether this is the tab on screen, which is a different fact
   * from the panel being open. A mounted-but-hidden Terminal is neither
   * measured, focused, nor polled: `visible` is what every pane inside it
   * consults to decide that.
   */
  const panelSurface = (entry: PanelTabItem, showing: boolean) => (
    <PanelSurface
      tab={entry}
      writes={writes}
      diffTurnList={diffTurnList}
      tasks={tasks}
      {...(focusedTask ? { focusedTask } : {})}
      onOpenTab={onOpenTab}
      {...(onOpenNewTab ? { onOpenNewTab } : {})}
      {...(onOpenFileInNewTab ? { onOpenFileInNewTab } : {})}
      {...(onInsertReference ? { onInsertReference } : {})}
      {...(onAttach ? { onAttach } : {})}
      // Bound to THIS instance, exactly as `onEditorChange` below is — a
      // surface changes its own tab's params and no other's.
      {...(onTabParams ? { onTabParams: (params: PanelTabParams) => onTabParams(entry.id, params) } : {})}
      // Same binding-to-this-instance rule: the surface ends its OWN tab. It is
      // the strip's own × callback, so the focus move and the persistence are
      // the ones every other close already gets.
      onCloseSelf={() => onCloseTab(entry.id)}
      {...(browser ? { browser } : {})}
      events={events}
      {...(sessionId ? { sessionId } : {})}
      {...(sessionTitle ? { sessionTitle } : {})}
      {...(projectId ? { projectId } : {})}
      {...(branch ? { branch } : {})}
      {...(active ? { active } : {})}
      dataScience={dataScience}
      onOpenImage={setLightbox}
      // THIS instance's files, and a change handler bound to it — two Editors
      // must not write into one state.
      {...(editors?.[entry.id] ? { editor: editors[entry.id] } : {})}
      {...(onEditorChange ? { onEditorChange: (next: (current: EditorState) => EditorState) => onEditorChange(entry.id, next) } : {})}
      {...(hostId ? { hostId } : {})}
      visible={open && showing}
    />
  );

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
        "relative flex shrink-0 flex-col md:rounded-xl md:bg-sidebar md:shadow-1 md:ring-1 md:ring-sidebar-border",
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
          {tabs.map((entry) => {
            const id = entry.id;
            const on = id === tab;
            const live = sessionId ? livePages?.get(browserScopeKey(sessionId, id)) : undefined;
            const { label, icon: Icon, missing } = describePanelTabInstance(entry, {
              ...(browser ? { browser } : {}),
              ...(live ? { live } : {}),
              duplicate: duplicated.has(entry.kind),
            });
            const count = counts[entry.kind];
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
                  const dragged = event.dataTransfer.getData(PANEL_TAB_MIME) || draggingTab;
                  const side = tabInsert?.id === id ? tabInsert.side : "after";
                  setDraggingTab(null);
                  setTabInsert(null);
                  if (!dragged || dragged === id || !tabs.some((other) => other.id === dragged)) return;
                  // Measured in the strip WITHOUT the carried tab, which is the
                  // index `movePanelTab` takes — see its own note on why.
                  const rest = tabs.filter((other) => other.id !== dragged);
                  onMoveTab?.(dragged, rest.findIndex((other) => other.id === id) + (side === "after" ? 1 : 0));
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
                            "ml-auto inline-flex min-w-4 shrink-0 items-center justify-center rounded-full px-1 font-mono text-4xs leading-4",
                            (entry.kind === "agents" ? failed : entry.kind === "processes" ? processesFailed : 0) > 0
                              ? "bg-destructive/15 text-destructive"
                              : (entry.kind === "agents" ? running : entry.kind === "processes" ? processesRunning : 0) > 0
                                ? "bg-primary/15 text-primary"
                                : "bg-muted-foreground/15 text-muted-foreground",
                          )}
                          title={
                            entry.kind === "agents" && running > 0
                              ? `${running} running`
                              : entry.kind === "processes" && processesRunning > 0
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
                    <ContextMenuItem onClick={() => tabs.filter((other) => other.id !== id).forEach((other) => onCloseTab(other.id))}>
                      Close others
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => tabs.forEach((other) => onCloseTab(other.id))}>Close all</ContextMenuItem>
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
                // See `chooserPress`: the press decides, the release applies,
                // and neither waits for a frame. Merged with the primitive's
                // own handlers rather than replacing them, so its keyboard and
                // focus behaviour is untouched.
                onMouseDown={() => {
                  chooserPress.current = !surfaceChooserOpen;
                }}
                onClick={() => {
                  const wanted = chooserPress.current;
                  chooserPress.current = undefined;
                  if (wanted !== undefined) setSurfaceChooserOpen(wanted);
                }}
                render={
                  <button type="button" aria-label="Open a surface" title="Open a surface"
                    className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground data-popup-open:bg-muted data-popup-open:text-foreground">
                    <PlusIcon className="size-4" />
                  </button>
                }
              />
              <DropdownMenuContent align="start" sideOffset={6} className="w-48">
                {openable.map((candidate) => (
                  /* A kind already in the strip can only be here because it is
                     one you can have two of, so the row says "New Editor" and
                     opens one rather than focusing what is already open —
                     which is what the tab beside the button already does. */
                  <DropdownMenuItem
                    key={candidate.id}
                    onClick={() => (candidate.another && onOpenNewTab ? onOpenNewTab(candidate.id) : onOpenTab(candidate.id))}
                  >
                    <candidate.icon className="size-3.5" />
                    <span className="min-w-0 flex-1 truncate">{candidate.another && onOpenNewTab ? `New ${candidate.label}` : candidate.label}</span>
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
          {/*
            THE STRIP'S OWN CHORDS, WHILE ⌘ IS HELD — issue #401.

            ⌘⌥← and ⌘⌥→ step the tabs, and they belong to the STRIP rather than
            to any one tab: putting a cap on every chip would say "this tab is
            ⌘⌥→", which is not what the key does. So the pair sits at the bar's
            trailing end, next to the two controls that DO carry a chord of
            their own — and only while there is more than one tab to step
            between, because a lone tab makes both keys a no-op.
          */}
          {tabs.length > 1 && (
            <span className="mr-1 flex items-center gap-0.5">
              <KeyHint command="panel-previous-tab" />
              <KeyHint command="panel-next-tab" />
            </span>
          )}
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
          {/* `toggle-panel` is what this button does from the keyboard — the
              same verb, so the cap rides the control rather than the strip. */}
          <KeyHint command="toggle-panel" />
        </div>
      </div>

      <div
        {...(tab ? { id: `right-panel-${tab}`, role: "tabpanel" } : {})}
        className="min-h-0 flex-1 overflow-y-auto md:rounded-b-xl"
      >
        {/**
         * A TERMINAL YOU HAVE OPENED STAYS MOUNTED BEHIND WHATEVER YOU LOOK AT
         * NEXT — issue #909, and the multiplier that turned its other two
         * causes into a freeze on every glance.
         *
         * Only the active tab used to render here, so a switch away UNMOUNTED
         * the whole Terminal surface and coming back built it again from
         * nothing: a fresh `Terminal` per shell, each with a new WebGL context
         * and glyph atlas, the bridge re-adopted, and the run's whole byte
         * window replayed into an empty buffer. The strip inside already keeps
         * its own panes mounted-and-hidden for exactly this reason (see
         * terminal-surface.tsx) — that rule just stopped at the surface's own
         * boundary.
         *
         * `display:none` KEEPS THE GL CONTEXT. Only `visibility` and a detach
         * from the document lose one, and the addon survives even that
         * (`onContextLoss` falls back to the DOM renderer). What a reveal does
         * produce is one ResizeObserver notification, which is now coalesced to
         * a frame rather than fitting per signal.
         *
         * ONLY THE TERMINAL. Every other surface keeps the lifecycle it has:
         * what justifies the memory here is a LIVE PROCESS on the other end and
         * a buffer nothing else can rebuild.
         */}
        {wantedTerminals.map((id) => {
          const entry = tabs.find((candidate) => candidate.id === id);
          if (!entry) return null;
          const showing = entry.id === activeTab?.id;
          return (
            /* `hidden` is `display:none`, the same statement the panes inside
               make — and the same reason: a hidden emulator must be out of the
               tab order, not merely invisible. */
            <div key={entry.id} className={cn("h-full", !showing && "hidden")}>
              <Suspense fallback={null}>{panelSurface(entry, showing)}</Suspense>
            </div>
          );
        })}
        {activeTab && wantedTerminals.includes(activeTab.id) ? null : activeTab && (sessionId || browserTabId(activeTab.kind) === undefined) ? (
          /* The boundary the first chunk fetch stops at — see the `dynamic`
             block at the top of this file. An empty fallback: the chunk comes
             off the same origin the page did, and a spinner that resolves in
             the next frame is a flash, not feedback. */
          <Suspense fallback={null}>
            {/* The active turn's state, in the machine's register: one word
                saying what the RECORD below is currently doing. A page, a file,
                the file tree and one issue or pull request are not the record —
                they are things on disk, in a browser and on GitHub — so the word
                would be describing something else. It also has to be absent for
                any surface that fills the panel itself: these tabs own their own
                header and scroller, and a line above them pushes an `h-full`
                child past the bottom of the box. */}
            {active && OWNS_ITS_HEIGHT.every((holds) => !holds(activeTab.kind)) && (
              <p className="px-4 pt-2 font-mono text-3xs uppercase tracking-[0.08em] text-muted-foreground/60">{active}</p>
            )}
            {panelSurface(activeTab, true)}
          </Suspense>
        ) : (
          <PanelEmptyState onOpen={onOpenTab} browserStart={browserStart} dataScience={dataScience} latex={latex} {...(browser ? { browser } : {})} {...(onOpenBrowser ? { onOpenBrowser } : {})} />
        )}
        {/* OUTSIDE THE BRANCHES ABOVE, because a kept Terminal renders in one
            of them and the lightbox belongs to neither surface — it is the
            panel's own overlay, on the same condition it always had: a session,
            and something open to have opened an image from. */}
        {activeTab && sessionId && (
          <Suspense fallback={null}>
            <ImageLightbox sessionId={sessionId} {...(lightbox ? { attachmentId: lightbox } : {})} onClose={() => setLightbox(undefined)} />
          </Suspense>
        )}
      </div>
    </aside>
  );
}
