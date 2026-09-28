import { BotIcon, CircleDotIcon, FileCode2Icon, FileDiffIcon, FileIcon, GitPullRequestIcon, GlobeIcon, NotebookIcon, SquareTerminalIcon, TableIcon, TerminalIcon, type LucideIcon } from "lucide-react";
import type { BrowserProvider, BrowserTab } from "@telar/engine-client";
import { fileKind } from "@/features/files";
import { isPluginSurface, PLUGIN_SURFACES, pluginSurfaces, viewerAvailable, type PluginSurfaceId, type PluginPanelSource } from "@/features/plugins";
import type { PanelTabInstance, PanelTabParams } from "./tabs";

const SURFACES = [
  { id: "agents", label: "Agents", icon: BotIcon, blurb: "Sub-agents and the conversations working for this one" },
  { id: "processes", label: "Processes", icon: TerminalIcon, blurb: "Background shells, watch loops" },
  { id: "diff", label: "Diff", icon: FileDiffIcon, blurb: "What this session changed" },
  { id: "editor", label: "Editor", icon: FileCode2Icon, blurb: "Files, with the tree beside them" },
  { id: "issues", label: "Issues", icon: CircleDotIcon, blurb: "Open issues" },
  { id: "pulls", label: "Pull requests", icon: GitPullRequestIcon, blurb: "Open pull requests" },
  { id: "terminal", label: "Terminal", icon: SquareTerminalIcon, blurb: "Shells in this session's checkout, and what the project is running" },
] as const;

type SurfaceId = (typeof SURFACES)[number]["id"] | PluginSurfaceId;

type Surface = { id: SurfaceId; label: string; icon: LucideIcon; blurb: string };

const ALL_SURFACES: readonly Surface[] = [...SURFACES, ...PLUGIN_SURFACES];

export const NO_PLUGINS: readonly string[] = [];
export const NO_PANELS: readonly PluginPanelSource[] = [];

/** The surfaces a project offers: the core ones, with the enabled plugins' slotted in before the Terminal. */
export function surfacesFor(enabledPlugins: readonly string[], pluginPanels: readonly PluginPanelSource[] = NO_PANELS): Surface[] {
  const terminal = SURFACES.findIndex((surface) => surface.id === "terminal");
  return [...SURFACES.slice(0, terminal), ...pluginSurfaces(enabledPlugins, pluginPanels.length > 0), ...SURFACES.slice(terminal)];
}

/** File, issue and pull ids are requests to open something inside a surface, never tabs of their own. */
export type PanelTab = SurfaceId | `browser:${string}` | `file:${string}` | `notebook:${string}` | `table:${string}` | `pdf:${string}` | `issue:${number}` | `pull:${number}`;

export type PanelTabItem = PanelTabInstance<PanelTab>;

export type BrowserState = { provider: BrowserProvider; tabs: BrowserTab[] };

export type LivePage = Pick<BrowserTab, "id" | "title" | "url"> & { active?: boolean };

export type TabDescription = { label: string; icon: LucideIcon; blurb: string; missing?: boolean };

const BROWSER_PREFIX = "browser:";
const FILE_PREFIX = "file:";
const NOTEBOOK_PREFIX = "notebook:";
const TABLE_PREFIX = "table:";
const PDF_PREFIX = "pdf:";
const ISSUE_PREFIX = "issue:";
const PULL_PREFIX = "pull:";
const FILE_TAB_PREFIXES = [FILE_PREFIX, NOTEBOOK_PREFIX, TABLE_PREFIX, PDF_PREFIX] as const;

const MULTI_INSTANCE: ReadonlySet<string> = new Set<string>(["editor", "diff"]);

const LIVE_BROWSER_PAGE_ID = "__integrated__";
/** The desktop shell's one Browser tab: the native view draws its own per-page strip. */
export const LIVE_BROWSER_TAB: PanelTab = `${BROWSER_PREFIX}${LIVE_BROWSER_PAGE_ID}`;

const suffixed = (prefix: string) => (tab: string) => (tab.startsWith(prefix) ? tab.slice(prefix.length) : undefined);

export const notebookPanelPath = suffixed(NOTEBOOK_PREFIX);
export const tablePanelPath = suffixed(TABLE_PREFIX);
export const pdfPanelPath = suffixed(PDF_PREFIX);
export const filePanelPath = suffixed(FILE_PREFIX);
export const browserTabId = suffixed(BROWSER_PREFIX);

/** The path behind a file-shaped tab id, or nothing for a surface. A path may contain a colon. */
export function filePanelTabPath(value: string): string | undefined {
  const prefix = FILE_TAB_PREFIXES.find((entry) => value.startsWith(entry) && value.length > entry.length);
  return prefix === undefined ? undefined : value.slice(prefix.length);
}

export function isFilePanelTab(value: string): boolean {
  return filePanelTabPath(value) !== undefined;
}

export function isRestorablePanelTab(value: string): value is PanelTab {
  return isPanelTab(value) && !isFilePanelTab(value) && issuePanelNumber(value) === undefined && pullPanelNumber(value) === undefined;
}

export function isMultiInstancePanelTab(kind: PanelTab): boolean {
  return MULTI_INSTANCE.has(kind) || kind === LIVE_BROWSER_TAB;
}

export function filePanelTab(path: string): PanelTab {
  return `${FILE_PREFIX}${path}`;
}

export function pdfPanelTab(path: string): PanelTab {
  return `${PDF_PREFIX}${path}`;
}

export function browserPanelTab(tabId: string): PanelTab {
  return `${BROWSER_PREFIX}${tabId}`;
}

export function issuePanelTab(number: number): PanelTab {
  return `${ISSUE_PREFIX}${number}`;
}

export function pullPanelTab(number: number): PanelTab {
  return `${PULL_PREFIX}${number}`;
}

/** A plugin's viewer only while that plugin is on; the PDF viewer is core. */
export function panelTabForPath(path: string, enabledPlugins: readonly string[]): PanelTab {
  const viewer = fileKind(path).viewer;
  if (!viewer || !viewerAvailable(viewer, enabledPlugins)) return filePanelTab(path);
  if (viewer === "notebook") return `${NOTEBOOK_PREFIX}${path}`;
  if (viewer === "table") return `${TABLE_PREFIX}${path}`;
  return pdfPanelTab(path);
}

/** The first Browser keeps the bare session id: that is the scope the engine drives when the agent browses. */
export function browserScopeKey(sessionId: string, instanceId: string): string {
  return instanceId === LIVE_BROWSER_TAB ? sessionId : `${sessionId}#${instanceId}`;
}

export function editorInstanceKey(panelKey: string, instanceId: string): string {
  return instanceId === "editor" ? panelKey : `${panelKey}#${instanceId}`;
}

function forgeNumber(tab: string, prefix: string): number | undefined {
  if (!tab.startsWith(prefix)) return undefined;
  const digits = tab.slice(prefix.length);
  if (!/^\d+$/.test(digits)) return undefined;
  const number = Number(digits);
  return number > 0 ? number : undefined;
}

export function issuePanelNumber(tab: string): number | undefined {
  return forgeNumber(tab, ISSUE_PREFIX);
}

export function pullPanelNumber(tab: string): number | undefined {
  return forgeNumber(tab, PULL_PREFIX);
}

/** Tabs whose surface renders `h-full` with its own chrome: a line above them costs their scroll, or a terminal's rows. */
export function ownsItsHeight(tab: PanelTab): boolean {
  return (
    browserTabId(tab) !== undefined ||
    filePanelPath(tab) !== undefined ||
    notebookPanelPath(tab) !== undefined ||
    tablePanelPath(tab) !== undefined ||
    pdfPanelPath(tab) !== undefined ||
    tab === "issues" ||
    tab === "pulls" ||
    tab === "editor" ||
    isPluginSurface(tab) ||
    tab === "terminal"
  );
}

/** Validates what comes back out of localStorage; a closed page or a deleted file is still a known tab. */
export function isPanelTab(value: string): value is PanelTab {
  if (value.startsWith(BROWSER_PREFIX)) return true;
  for (const prefix of FILE_TAB_PREFIXES) if (value.startsWith(prefix)) return value.length > prefix.length;
  if (value.startsWith(ISSUE_PREFIX)) return forgeNumber(value, ISSUE_PREFIX) !== undefined;
  if (value.startsWith(PULL_PREFIX)) return forgeNumber(value, PULL_PREFIX) !== undefined;
  return ALL_SURFACES.some((surface) => surface.id === value);
}

export function browserTabLabel(tab: Pick<BrowserTab, "title" | "url">): string {
  if (tab.title.trim()) return tab.title;
  try {
    return new URL(tab.url).host || tab.url;
  } catch {
    return tab.url || "Untitled page";
  }
}

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

export function describePanelTab(tab: PanelTab, browser?: BrowserState, live?: readonly LivePage[]): TabDescription {
  const path = filePanelPath(tab);
  if (path !== undefined) return { label: path.split("/").at(-1) || path, icon: FileIcon, blurb: path };
  const notebookPath = notebookPanelPath(tab);
  if (notebookPath !== undefined) return { label: basename(notebookPath), icon: NotebookIcon, blurb: notebookPath };
  const tablePath = tablePanelPath(tab);
  if (tablePath !== undefined) return { label: basename(tablePath), icon: TableIcon, blurb: tablePath };
  const pdfPath = pdfPanelPath(tab);
  if (pdfPath !== undefined) return { label: basename(pdfPath), icon: FileIcon, blurb: pdfPath };
  const issueNumber = issuePanelNumber(tab);
  if (issueNumber !== undefined) return { label: `#${issueNumber}`, icon: CircleDotIcon, blurb: `Issue #${issueNumber}` };
  const pullNumber = pullPanelNumber(tab);
  if (pullNumber !== undefined) return { label: `#${pullNumber}`, icon: GitPullRequestIcon, blurb: `Pull request #${pullNumber}` };
  const pageId = browserTabId(tab);
  if (pageId === undefined) {
    const surface = ALL_SURFACES.find((entry) => entry.id === tab)!;
    return { label: surface.label, icon: surface.icon, blurb: surface.blurb };
  }
  if (pageId === LIVE_BROWSER_PAGE_ID) return { label: "Browser", icon: GlobeIcon, blurb: "Integrated browser" };
  // The native browser's own list wins over the journal's, which lags or never names the native tab.
  const livePage = live?.find((entry) => entry.id === pageId) ?? (live && live.length > 0 ? (live.find((entry) => entry.active) ?? live[0]) : undefined);
  if (livePage) return { label: browserTabLabel(livePage), icon: GlobeIcon, blurb: livePage.url };
  const page = browser?.tabs.find((entry) => entry.id === pageId);
  if (!page) return { label: "Closed page", icon: GlobeIcon, blurb: "This page is no longer open.", missing: true };
  return { label: browserTabLabel(page), icon: GlobeIcon, blurb: page.url };
}

/** What tells two tabs of one kind apart: a basename, a host, or a filter. */
export function panelTabSuffix(params: PanelTabParams): string | undefined {
  const path = params.path;
  if (path) return basename(path) || path;
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

function livePageSuffix(live?: readonly LivePage[]): string | undefined {
  const page = live?.find((entry) => entry.active) ?? live?.[0];
  if (!page) return undefined;
  try {
    return new URL(page.url).host || browserTabLabel(page);
  } catch {
    return browserTabLabel(page);
  }
}

/** The suffix appears only while a sibling of the same kind is open (`duplicate`). */
export function describePanelTabInstance(
  tab: PanelTabItem,
  options: { browser?: BrowserState; live?: readonly LivePage[]; duplicate?: boolean } = {},
): TabDescription {
  const described = describePanelTab(tab.kind, options.browser, options.live);
  if (!options.duplicate) return described;
  const suffix = panelTabSuffix(tab.params) ?? (tab.kind === LIVE_BROWSER_TAB ? livePageSuffix(options.live) : undefined);
  if (!suffix) return described;
  return { ...described, label: `${described.label} · ${suffix}`, blurb: `${described.blurb} — ${suffix}` };
}

export type OpenableSurface = { id: PanelTab; label: string; icon: LucideIcon; another: boolean };

/** What the "+" offers: a singleton disappears once open; a multi-instance kind stays and opens another. */
export function openableSurfaces(
  tabs: readonly PanelTabItem[],
  { enabledPlugins, pluginPanels, browser, desktop, canOpenNew }: { enabledPlugins: readonly string[]; pluginPanels: readonly PluginPanelSource[]; browser: BrowserState | undefined; desktop: boolean; canOpenNew: boolean },
): OpenableSurface[] {
  const holdsKind = (kind: PanelTab) => tabs.some((entry) => entry.kind === kind);
  const offersAnother = (kind: PanelTab) => isMultiInstancePanelTab(kind) && canOpenNew;
  const pages = browser?.tabs ?? [];
  const browsers: OpenableSurface[] = desktop
    ? pages.length > 0 && (!holdsKind(LIVE_BROWSER_TAB) || offersAnother(LIVE_BROWSER_TAB))
      ? [{ id: LIVE_BROWSER_TAB, label: "Browser", icon: GlobeIcon, another: holdsKind(LIVE_BROWSER_TAB) }]
      : []
    : pages
        .filter((page) => !holdsKind(browserPanelTab(page.id)))
        .map((page) => ({ id: browserPanelTab(page.id), label: browserTabLabel(page), icon: GlobeIcon, another: false }));
  return [
    ...surfacesFor(enabledPlugins, pluginPanels)
      .filter((surface) => !holdsKind(surface.id) || offersAnother(surface.id))
      .map((surface) => ({ id: surface.id as PanelTab, label: surface.label, icon: surface.icon, another: holdsKind(surface.id) })),
    ...browsers,
  ];
}
