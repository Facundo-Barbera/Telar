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
  PlusIcon,
  WorkflowIcon,
} from "lucide-react";
import type { RailAgent } from "@/components/session/subagent-rail";
import type { RunSnapshot } from "@/lib/ultra-runs";
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

function agentTone(status: RailAgent["status"]): "default" | "live" | "attention" {
  if (status === "error") return "attention";
  if (status === "running") return "live";
  return "default";
}

export function WorkspaceInspector({
  project,
  scopeKey,
  open = false,
  onOpenChange = () => {},
  onReservedChange = () => {},
  agents,
  workflows,
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
  needsAttention: boolean;
  onSelectAgent: (id: string) => void;
  onSelectWorkflow: (id: string) => void;
}) {
  const panel = useRightPanelStore(scopeKey);
  const widthPrefs = useSidebarPrefs(RIGHT_PANEL_WIDTH_STORAGE_KEY);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState({ right: 16, top: 48, width: 320 });
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
  // Fast Refresh can briefly preserve a caller from the previous component
  // signature while swapping this module. Treat that transient value as an
  // omitted callback instead of throwing: one render-time exception forces a
  // full Next reload, and every open session tab then retries its RSC document.
  const notifyReservedChange =
    typeof onReservedChange === "function"
      ? onReservedChange
      : NOOP_RESERVED_CHANGE;

  useEffect(() => {
    notifyReservedChange(reserved);
    return () => notifyReservedChange(false);
  }, [notifyReservedChange, reserved]);

  useLayoutEffect(() => {
    if (!open) return;
    let settleTimer: number | null = null;
    let settleFrame: number | null = null;
    const measure = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
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
  }, [open, panel.session.fullscreen, panel.session.open, panelWidth]);

  const openActivity = (select: () => void) => {
    select();
    panel.openActivity();
  };

  const setInspectorOpen = (nextOpen: boolean) => {
    if (!nextOpen) setGitPane(null);
    notifyOpenChange(nextOpen);
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
      {open && typeof document !== "undefined" && createPortal(
        <div
          role="dialog"
          aria-label="Pinned summary"
          style={anchor}
          className="fixed z-[70] overflow-hidden rounded-3xl border border-border bg-popover text-popover-foreground shadow-2xl"
        >
          <div className="max-h-[min(44rem,calc(100vh-6rem))] overflow-y-auto p-2.5">
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
              <div className="space-y-0.5">
                {agents.map((agent) => (
                  <InspectorRow
                    key={agent.id}
                    icon={BotIcon}
                    label={agent.label}
                    detail={agent.status === "running" ? "Running" : agent.status === "error" ? "Needs attention" : "Done"}
                    tone={agentTone(agent.status)}
                    onClick={() => openActivity(() => onSelectAgent(agent.id))}
                  />
                ))}
              </div>
            </>
          )}

          {workflows.length > 0 && (
            <>
              <SectionHeading>Ultras</SectionHeading>
              <div className="space-y-0.5">
                {workflows.map((run) => (
                  <InspectorRow
                    key={run.runId}
                    icon={WorkflowIcon}
                    label={run.name}
                    detail={run.state}
                    tone={run.state === "running" ? "live" : "default"}
                    onClick={() => openActivity(() => onSelectWorkflow(run.runId))}
                  />
                ))}
              </div>
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
        </div>,
        document.body,
      )}
    </div>
  );
}
