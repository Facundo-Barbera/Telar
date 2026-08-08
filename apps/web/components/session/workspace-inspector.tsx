"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ActivityIcon,
  BotIcon,
  ChevronRightIcon,
  ClipboardListIcon,
  FolderGit2Icon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  GitCompareArrowsIcon,
  GlobeIcon,
  PaperclipIcon,
  PlusIcon,
  WorkflowIcon,
} from "lucide-react";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import type { AttachmentRef } from "@/components/conversation";
import { attachmentUrl } from "@/lib/attachment-contract";
import type { RailAgent } from "@/components/session/subagent-rail";
import { orderRunsForPanel, type RunSnapshot } from "@/lib/ultra-runs";
import type { GitOverviewResponse } from "@/components/projects/git-tab-shared";
import { cachedJson } from "@/lib/client-json-cache";
import { refreshIncludes } from "@/lib/telar-refresh";
import { useRightPanelStore, type BrowserPanelTab } from "@/lib/right-panel-store";
import {
  RIGHT_PANEL_DEFAULT_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
  RIGHT_PANEL_WIDTH_STORAGE_KEY,
} from "@/lib/right-panel-layout";
import { clampSidebarWidth, useSidebarPrefs } from "@/lib/sidebar-width";
import { cn } from "@/lib/utils";
import {
  WorkspaceGitPaneContent,
  type WorkspaceGitPane,
} from "@/components/session/workspace-git-pane";

const NOOP_RESERVED_CHANGE: (reserved: boolean) => void = () => {};

function SectionHeading({ children, action }: {
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-center px-2 pb-1.5 pt-2 text-xs font-medium text-muted-foreground">
      <span>{children}</span>
      {action && <span className="ml-auto">{action}</span>}
    </div>
  );
}

// HOW MANY ROWS A SECTION SHOWS BEFORE IT STOPS.
//
// This popover is a GLANCE at the session's environment, and every list in it
// grows without limit — sub-agents, Ultra runs, attachments, browser tabs all
// accumulate for as long as the session lives. A busy evening put ten runs in
// the Ultras section alone, at which point the panel is a scroll rather than a
// glance and the things at the top are the OLDEST.
//
// Five is chosen to be smaller than any section is interesting: it is enough to
// see what is happening and few enough that the sections below stay on screen.
const SECTION_ROW_CAP = 5;

/** A section body that shows the first `SECTION_ROW_CAP` rows and hides the
 *  rest behind one toggle.
 *
 *  THE CALLER ORDERS, THIS ONLY CUTS. A cap over an arbitrary order can hide
 *  the one row that matters — a running Ultra beneath eight finished ones — so
 *  sorting belongs upstream where the domain is known, and this component takes
 *  no view on which rows deserve to survive. It cuts from the END, so whatever
 *  the caller put first is what stays.
 *
 *  The toggle is a row rather than a chevron on the heading: at this size a
 *  heading affordance is a coin-flip target, and the count is the useful part
 *  of the label ("7 more" says how much is hidden; a chevron says nothing). */
function CappedRows<T>({
  items,
  render,
  noun,
}: {
  items: readonly T[];
  render: (item: T) => ReactNode;
  /** Plural, lower-case — "runs", "sub-agents". Used only in the toggle. */
  noun: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const hidden = Math.max(0, items.length - SECTION_ROW_CAP);
  const shown = expanded ? items : items.slice(0, SECTION_ROW_CAP);
  return (
    <>
      <div className="space-y-0.5">{shown.map(render)}</div>
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="w-full rounded-md px-2 py-1 text-left text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {expanded ? `Show fewer ${noun}` : `${hidden} more ${noun}`}
        </button>
      )}
    </>
  );
}

function InspectorRow({
  icon: Icon,
  label,
  detail,
  tone,
  onClick,
}: {
  icon: typeof ActivityIcon;
  label: string;
  detail?: ReactNode;
  tone?: "default" | "live" | "attention";
  onClick?: () => void;
}) {
  const content = (
    <>
      <Icon
        className={cn(
          "size-4 shrink-0",
          tone === "attention"
            ? "text-destructive"
            : tone === "live"
              ? "text-primary"
              : "text-muted-foreground",
        )}
      />
      <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
      {detail && (
        <span className="min-w-0 max-w-[52%] truncate text-xs text-muted-foreground">
          {detail}
        </span>
      )}
      {onClick && <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/60" />}
    </>
  );

  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-9 w-full items-center gap-2.5 rounded-xl px-2.5 text-left transition-colors hover:bg-muted/70"
    >
      {content}
    </button>
  ) : (
    <div className="flex min-h-9 items-center gap-2.5 rounded-xl px-2.5">{content}</div>
  );
}

/**
 * One attached file, as a row with a hover PREVIEW.
 *
 * The preview is the reason this is not just another `InspectorRow`: the whole
 * point of surfacing attachments in the pinned summary is answering "what did I
 * give it?" without scrolling the transcript, and for an image that question is
 * answered by looking rather than by reading a filename. Non-images get the row
 * and no card — there is nothing to show, and an empty popover is worse than
 * none.
 *
 * A missing thumbnail (the bytes died with an archive) degrades to the plain
 * row, so the section stays honest without probing anything up front.
 */
function AttachmentRow({ item }: { item: AttachmentRef }) {
  const [missing, setMissing] = useState(false);
  const isImage = item.mediaType.startsWith("image/") && !missing;

  const row = (
    <div className="flex min-h-9 items-center gap-2.5 rounded-xl px-2.5">
      <PaperclipIcon className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-sm">{item.name}</span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {missing ? "gone" : formatBytes(item.size)}
      </span>
    </div>
  );

  if (!isImage) return row;

  return (
    <HoverCard>
      <HoverCardTrigger render={<div className="cursor-default">{row}</div>} />
      <HoverCardContent align="end" className="w-auto max-w-80 p-1.5" side="left">
        {/* eslint-disable-next-line @next/next/no-img-element -- user-uploaded
            bytes of unknown dimensions, served by this app and possibly gone. */}
        <img
          alt={item.name}
          className="max-h-64 w-auto rounded-md object-contain"
          onError={() => setMissing(true)}
          src={attachmentUrl(item.id)}
        />
      </HoverCardContent>
    </HoverCard>
  );
}

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return kb < 1024 ? `${Math.round(kb)} KB` : `${(kb / 1024).toFixed(1)} MB`;
};

function agentTone(status: RailAgent["status"]): "default" | "live" | "attention" {
  if (status === "error") return "attention";
  if (status === "running") return "live";
  return "default";
}

// The Subagents twin of `orderRunsForPanel` (issue #48): live rows first so the
// cap below never hides a running agent behind a page of finished ones. Same
// rules as the Ultras rule, for the same reasons — `running` is the only live
// state (`error` is terminal and sinks with `done`; the counts stay honest),
// and the partition is stable so a row only moves when its own status changes.
function orderAgentsForPanel(agents: readonly RailAgent[]): RailAgent[] {
  const live: RailAgent[] = [];
  const finished: RailAgent[] = [];
  for (const agent of agents) (agent.status === "running" ? live : finished).push(agent);
  return [...live, ...finished];
}

export function WorkspaceInspector({
  project,
  scopeKey,
  open = false,
  onOpenChange = () => {},
  onReservedChange = () => {},
  agents,
  workflows,
  attachments = [],
  needsAttention,
  onSelectAgent,
  onSelectWorkflow,
}: {
  project: string;
  scopeKey: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onReservedChange?: (reserved: boolean) => void;
  agents: readonly RailAgent[];
  workflows: readonly RunSnapshot[];
  /** Everything the human has attached to THIS session, newest first. Derived
   *  from the transcript by the adapter — this component stores nothing. */
  attachments?: readonly AttachmentRef[];
  needsAttention: boolean;
  onSelectAgent: (id: string) => void;
  onSelectWorkflow: (id: string) => void;
}) {
  const panel = useRightPanelStore(scopeKey);
  const reduceMotion = useReducedMotion();
  const widthPrefs = useSidebarPrefs(RIGHT_PANEL_WIDTH_STORAGE_KEY);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<{
    right: number;
    top: number;
    width: number;
    maxHeight?: number;
  }>({ right: 16, top: 48, width: 320 });
  const [wideLayout, setWideLayout] = useState(false);
  const [git, setGit] = useState<GitOverviewResponse | null>(null);
  const [gitPane, setGitPane] = useState<WorkspaceGitPane | null>(null);
  const notifyOpenChange =
    typeof onOpenChange === "function"
      ? onOpenChange
      : NOOP_RESERVED_CHANGE;
  const loadGit = useCallback((force = false) => {
    const url = `/api/projects/${encodeURIComponent(project)}/git`;
    void cachedJson<GitOverviewResponse>(url, { maxAgeMs: 15_000, force })
      .then((body) => setGit(body?.header ? body : null))
      .catch(() => setGit(null));
  }, [project]);

  useEffect(() => {
    if (!open) return;
    loadGit();
    const onRefresh = (event: Event) => {
      if (refreshIncludes(event, "git")) loadGit(true);
    };
    window.addEventListener("telar:refresh", onRefresh);
    return () => window.removeEventListener("telar:refresh", onRefresh);
  }, [loadGit, open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setGitPane(null);
        notifyOpenChange(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [notifyOpenChange, open]);

  const browserTabs = panel.session.tabs.filter(
    (tab): tab is BrowserPanelTab => tab.kind === "browser",
  );
  const activityRunning =
    agents.some((agent) => agent.status === "running") ||
    workflows.some((run) => run.state === "running");
  const branch = git?.header.branch ?? "Current checkout";
  const dirtyFiles = git?.header.dirtyFiles ?? 0;
  const panelWidth = clampSidebarWidth(
    widthPrefs.width ?? RIGHT_PANEL_DEFAULT_WIDTH,
    RIGHT_PANEL_MIN_WIDTH,
    Number.POSITIVE_INFINITY,
  );
  const reserved = open && !panel.session.open && !panel.session.fullscreen;
  const sidebarMode = reserved && wideLayout;
  // Fast Refresh can briefly preserve a caller from the previous component
  // signature while swapping this module. Treat that transient value as an
  // omitted callback instead of throwing: one render-time exception forces a
  // full Next reload, and every open session tab then retries its RSC document.
  const notifyReservedChange =
    typeof onReservedChange === "function"
      ? onReservedChange
      : NOOP_RESERVED_CHANGE;

  useLayoutEffect(() => {
    const query = window.matchMedia("(min-width: 1180px)");
    const sync = () => setWideLayout(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    notifyReservedChange(sidebarMode);
    return () => notifyReservedChange(false);
  }, [notifyReservedChange, sidebarMode]);

  useLayoutEffect(() => {
    if (!open) return;
    let settleTimer: number | null = null;
    let settleFrame: number | null = null;
    const measure = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      if (sidebarMode) {
        const top = rect.bottom + 8;
        setAnchor({
          right: 12,
          top,
          width: Math.min(320, viewportWidth),
          maxHeight: Math.max(0, window.innerHeight - top - 12),
        });
        return;
      }
      const compactPanel =
        panel.session.open &&
        !panel.session.fullscreen &&
        !window.matchMedia("(min-width: 1180px)").matches;
      let right = compactPanel
        ? Math.min(panelWidth, viewportWidth - 48) + 8
        : Math.max(8, viewportWidth - rect.right);
      let available = viewportWidth - right - 16;

      // On genuinely small windows, preserve a usable inspector instead of
      // squeezing it into the few pixels left beside the overlay drawer.
      if (available < 280) {
        right = 8;
        available = viewportWidth - 16;
      }

      setAnchor({
        right,
        top: rect.bottom + 8,
        width: Math.min(320, available),
      });
    };

    measure();
    // Closing the dock is animated. The store flips to `open: false` before
    // AnimatePresence removes the dock from layout, so the immediate measure
    // still sees the trigger at its old x-position. Measure once on the next
    // frame and once after the dock's 220ms exit has settled; this is event-
    // driven and creates no idle observer/polling loop.
    settleFrame = window.requestAnimationFrame(measure);
    settleTimer = window.setTimeout(measure, 260);
    window.addEventListener("resize", measure);
    const observer = new ResizeObserver(measure);
    if (triggerRef.current) observer.observe(triggerRef.current);
    return () => {
      if (settleFrame !== null) window.cancelAnimationFrame(settleFrame);
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [open, panel.session.fullscreen, panel.session.open, panelWidth, sidebarMode]);

  const setInspectorOpen = (nextOpen: boolean) => {
    if (!nextOpen) setGitPane(null);
    notifyOpenChange(nextOpen);
  };

  // Selecting a run or agent from the pinned summary hands off to the
  // Activity dock rather than stacking on top of it: opening a run is a
  // "go there" action, not a "keep this open too" one. Without the close
  // here, one click leaves the popover, the Activity tab AND the run/agent
  // detail all on screen at once — see issue #13.
  const openActivity = (select: () => void) => {
    select();
    panel.openActivity();
    setInspectorOpen(false);
  };

  return (
    <div className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        aria-label={open ? "Close pinned summary" : "Open pinned summary"}
        aria-expanded={open}
        title="Pinned summary"
        onClick={() => setInspectorOpen(!open)}
        className={cn(
          "relative flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
          open && "bg-muted text-foreground",
        )}
      >
        <ClipboardListIcon className="size-4" />
        {(needsAttention || activityRunning) && (
          <span
            aria-hidden="true"
            className={cn(
              "absolute right-0.5 top-0.5 size-2 rounded-full ring-2 ring-background",
              needsAttention ? "bg-destructive" : "bg-primary",
            )}
          />
        )}
      </button>
      {typeof document !== "undefined" && createPortal(
        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              key="workspace-inspector"
              role="dialog"
              aria-label="Pinned summary"
              data-presentation={sidebarMode ? "sidebar" : "floating"}
              style={{ right: anchor.right, top: anchor.top, width: anchor.width }}
              initial={sidebarMode && !reduceMotion ? { opacity: 0, x: 28 } : false}
              animate={{ opacity: 1, x: 0 }}
              exit={sidebarMode && !reduceMotion ? { opacity: 0, x: 28 } : undefined}
              transition={{
                duration: reduceMotion ? 0 : 0.28,
                ease: [0.22, 1, 0.36, 1],
              }}
              className="fixed z-[70] overflow-hidden rounded-3xl border border-border bg-popover text-popover-foreground shadow-2xl"
            >
              <div
                style={sidebarMode ? { maxHeight: anchor.maxHeight } : undefined}
                className={cn(
                  "overflow-y-auto p-2.5",
                  !sidebarMode && "max-h-[min(44rem,calc(100vh-6rem))]",
                )}
              >
          {gitPane ? (
            <WorkspaceGitPaneContent
              pane={gitPane}
              project={project}
              overview={git}
              onBack={() => setGitPane(null)}
            />
          ) : <>
          <SectionHeading
            action={
              <button
                type="button"
                onClick={panel.openGit}
                aria-label="Open Git surface"
                title="Open Git surface"
                className="flex size-6 items-center justify-center rounded-lg transition-colors hover:bg-muted hover:text-foreground"
              >
                <PlusIcon className="size-3.5" />
              </button>
            }
          >
            Workspace · {project}
          </SectionHeading>
          <div className="space-y-0.5">
            <InspectorRow
              icon={FolderGit2Icon}
              label="Changes"
              detail={dirtyFiles > 0 ? `${dirtyFiles} changed` : "Clean"}
              onClick={() => setGitPane("changes")}
            />
            <InspectorRow
              icon={GitBranchIcon}
              label={branch}
              detail={git && (git.header.ahead > 0 || git.header.behind > 0)
                ? `↑${git.header.ahead} ↓${git.header.behind}`
                : undefined}
              onClick={() => setGitPane("branch")}
            />
            <InspectorRow
              icon={GitCommitHorizontalIcon}
              label="Commit or push"
              onClick={() => setGitPane("commit")}
            />
            <InspectorRow
              icon={GitCompareArrowsIcon}
              label="Compare branch"
              onClick={() => setGitPane("compare")}
            />
          </div>

          {agents.length > 0 && (
            <>
              <div className="my-2 h-px bg-border/70" />
              <SectionHeading>Subagents</SectionHeading>
              {/* ORDERED BEFORE IT IS CUT — see `orderAgentsForPanel`. */}
              <CappedRows
                items={orderAgentsForPanel(agents)}
                noun="sub-agents"
                render={(agent) => (
                  <InspectorRow
                    key={agent.id}
                    icon={BotIcon}
                    label={agent.label}
                    detail={agent.status === "running" ? "Running" : agent.status === "error" ? "Needs attention" : "Done"}
                    tone={agentTone(agent.status)}
                    onClick={() => openActivity(() => onSelectAgent(agent.id))}
                  />
                )}
              />
            </>
          )}

          {workflows.length > 0 && (
            <>
              <SectionHeading>Ultras</SectionHeading>
              {/* ORDERED BEFORE IT IS CUT. `CappedRows` slices from the end, so
                  without this a live run could be the eleventh row and get
                  hidden behind the toggle while eight finished ones stayed
                  visible — the exact inversion the cap exists to prevent. */}
              <CappedRows
                items={orderRunsForPanel(workflows)}
                noun="runs"
                render={(run) => (
                  <InspectorRow
                    key={run.runId}
                    icon={WorkflowIcon}
                    label={run.name}
                    detail={run.state}
                    tone={run.state === "running" ? "live" : "default"}
                    onClick={() => openActivity(() => onSelectWorkflow(run.runId))}
                  />
                )}
              />
            </>
          )}

          {attachments.length > 0 && (
            <>
              <div className="my-2 h-px bg-border/70" />
              <SectionHeading>Context</SectionHeading>
              {/* NEWEST FIRST FEEDS THE CUT (issue #48). This list was the one
                  bare `.map` in the file — every image ever attached rendered
                  forever, at full row weight. The adapter hands attachments
                  newest-first, so the cap keeps what the session touched most
                  recently and the stale tail is what collapses behind the
                  toggle. No new ordering here: capping an oldest-first list
                  would pin the five stalest rows on a "now" surface. */}
              <CappedRows
                items={attachments}
                noun="attachments"
                render={(item) => <AttachmentRow item={item} key={item.id} />}
              />
            </>
          )}

          {browserTabs.length > 0 && (
            <>
              <div className="my-2 h-px bg-border/70" />
              <SectionHeading
                action={
                  <button
                    type="button"
                    onClick={() => panel.openBrowser()}
                    aria-label="Open browser tab"
                    title="Open browser tab"
                    className="flex size-6 items-center justify-center rounded-lg transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <PlusIcon className="size-3.5" />
                  </button>
                }
              >
                Browser
              </SectionHeading>
              <div className="space-y-0.5">
                {browserTabs.map((tab) => (
                  <InspectorRow
                    key={tab.id}
                    icon={GlobeIcon}
                    label={tab.title}
                    detail={tab.url}
                    onClick={() => panel.activate(tab.id)}
                  />
                ))}
              </div>
            </>
          )}
          </>}
              </div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );
}
