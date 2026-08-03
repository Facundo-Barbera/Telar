"use client";

import {
  useCallback,
  useEffect,
  useRef,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import dynamic from "next/dynamic";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  Maximize2Icon,
  Minimize2Icon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRightPanelStore } from "@/lib/right-panel-store";
import {
  clampSidebarWidth,
  setSidebarWidth,
  useSidebarPrefs,
} from "@/lib/sidebar-width";
import {
  RIGHT_PANEL_DEFAULT_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
  RIGHT_PANEL_WIDTH_STORAGE_KEY,
} from "@/lib/right-panel-layout";
import { PanelEmptyState } from "./panel-empty-state";
import { TabStrip } from "./tab-strip";

// The dock starts collapsed. Keep its two substantial work surfaces in their
// own chunks so a first session render only hydrates the lightweight control.
const GitTab = dynamic(() =>
  import("@/components/projects/git-tab").then((module) => module.GitTab),
);
const BrowserSurface = dynamic(() =>
  import("./browser-surface").then((module) => module.BrowserSurface),
);

export const RIGHT_PANEL_VISIBLE_CLASS = "flex";
const RIGHT_PANEL_MAIN_MIN_WIDTH = 480;

type RightPanelDrag = {
  pointerId: number;
  startWidth: number;
  startX: number;
  width: number;
  raf: number | null;
  pendingWidth: number;
};

function RightPanelResizeHandle({ panelRef }: {
  panelRef: RefObject<HTMLElement | null>;
}) {
  const dragRef = useRef<RightPanelDrag | null>(null);

  const maxWidth = useCallback(() => {
    if (!window.matchMedia("(min-width: 1180px)").matches) {
      return Math.max(RIGHT_PANEL_MIN_WIDTH, window.innerWidth - 48);
    }
    const panel = panelRef.current;
    const available = panel?.parentElement?.getBoundingClientRect().width ?? window.innerWidth;
    return Math.max(RIGHT_PANEL_MIN_WIDTH, available - RIGHT_PANEL_MAIN_MIN_WIDTH);
  }, [panelRef]);

  const paint = useCallback((drag: RightPanelDrag) => {
    const width = clampSidebarWidth(
      drag.pendingWidth,
      RIGHT_PANEL_MIN_WIDTH,
      maxWidth(),
    );
    drag.width = width;
    panelRef.current?.style.setProperty("--right-panel-width", `${width}px`);
  }, [maxWidth, panelRef]);

  const finish = useCallback((pointerId: number) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== pointerId) return;
    if (drag.raf !== null) window.cancelAnimationFrame(drag.raf);
    paint(drag);
    dragRef.current = null;
    setSidebarWidth(RIGHT_PANEL_WIDTH_STORAGE_KEY, drag.width);
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
  }, [paint]);

  useEffect(() => () => {
    const drag = dragRef.current;
    if (drag?.raf != null) window.cancelAnimationFrame(drag.raf);
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
  }, []);

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
        dragRef.current = {
          pointerId: event.pointerId,
          startWidth: width,
          startX: event.clientX,
          width,
          raf: null,
          pendingWidth: width,
        };
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
        if (!panelRef.current || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) {
          return;
        }
        event.preventDefault();
        const delta = event.key === "ArrowLeft" ? 16 : -16;
        const width = clampSidebarWidth(
          panelRef.current.getBoundingClientRect().width + delta,
          RIGHT_PANEL_MIN_WIDTH,
          maxWidth(),
        );
        panelRef.current.style.setProperty("--right-panel-width", `${width}px`);
        setSidebarWidth(RIGHT_PANEL_WIDTH_STORAGE_KEY, width);
      }}
    >
      <span className="h-10 w-px rounded-full bg-border/60 transition-colors group-hover/resize:bg-foreground/40 group-focus-visible/resize:bg-ring" />
    </button>
  );
}

/** Header-owned trigger for the closed panel. Keeping this as a small store
 * subscriber avoids making the large SessionView rerender when panel state
 * changes, while placing the icon in normal toolbar layout. */
export function RightPanelTrigger({ scopeKey }: { scopeKey: string }) {
  const panel = useRightPanelStore(scopeKey);
  if (panel.session.open) return null;

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      onClick={() => panel.setOpen(true)}
      aria-label="Open right panel"
      title="Open right panel"
      className="shrink-0 text-muted-foreground hover:text-foreground"
    >
      <PanelRightOpenIcon className="size-4" />
    </Button>
  );
}

export function RightPanel({
  project,
  scopeKey,
  activity,
  activityCount,
  activityRunning,
  activityAttention,
}: {
  project: string;
  scopeKey: string;
  activity: ReactNode;
  activityCount: number;
  activityRunning: number;
  activityAttention?: boolean;
}) {
  const panel = useRightPanelStore(scopeKey);
  const reduceMotion = useReducedMotion();
  const panelRef = useRef<HTMLElement>(null);
  const widthPrefs = useSidebarPrefs(RIGHT_PANEL_WIDTH_STORAGE_KEY);
  const activeTab = panel.session.tabs.find((tab) => tab.id === panel.session.activeTabId);
  const fullscreen = panel.session.fullscreen;
  const preferredWidth = clampSidebarWidth(
    widthPrefs.width ?? RIGHT_PANEL_DEFAULT_WIDTH,
    RIGHT_PANEL_MIN_WIDTH,
    Number.POSITIVE_INFINITY,
  );

  return (
    <AnimatePresence initial={false}>
      {panel.session.open ? (
        <motion.aside
          ref={panelRef}
          aria-label="Right panel"
          data-responsive-mode={fullscreen ? "workspace-fullscreen" : "drawer-below-1180"}
          style={fullscreen
            ? undefined
            : ({ "--right-panel-width": `${preferredWidth}px` } as CSSProperties)}
          initial={reduceMotion ? false : { opacity: 0, x: 28 }}
          animate={{ opacity: 1, x: 0 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: 28 }}
          transition={{ duration: reduceMotion ? 0 : 0.22, ease: [0.22, 1, 0.36, 1] }}
          className={
            fullscreen
              ? `${RIGHT_PANEL_VISIBLE_CLASS} absolute inset-0 z-40 w-full max-w-none flex-col bg-muted/10`
              : `${RIGHT_PANEL_VISIBLE_CLASS} absolute inset-y-0 right-0 z-30 w-(--right-panel-width) max-w-[calc(100vw-3rem)] flex-col bg-muted/10 shadow-2xl min-[1180px]:relative min-[1180px]:inset-auto min-[1180px]:z-auto min-[1180px]:min-w-96 min-[1180px]:max-w-[calc(100%_-_30rem)] min-[1180px]:shrink-0 min-[1180px]:shadow-none`
          }
        >
          {!fullscreen && <RightPanelResizeHandle panelRef={panelRef} />}
          <TabStrip
            tabs={panel.session.tabs}
            activeTabId={panel.session.activeTabId}
            onActivate={panel.activate}
            onClose={panel.close}
            onCloseOthers={panel.closeOthers}
            onCloseRight={panel.closeRight}
            onOpenActivity={panel.openActivity}
            onOpenGit={panel.openGit}
            onOpenBrowser={() => panel.openBrowser()}
            activityCount={activityCount}
            activityRunning={activityRunning}
            activityAttention={activityAttention}
            trailing={
              <div className="flex shrink-0 gap-1">
                <button
                  type="button"
                  onClick={() => panel.setFullscreen(!fullscreen)}
                  aria-label={fullscreen ? "Exit fullscreen panel" : "Open panel fullscreen"}
                  title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
                  className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  {fullscreen ? (
                    <Minimize2Icon className="size-4" />
                  ) : (
                    <Maximize2Icon className="size-4" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => panel.setOpen(false)}
                  aria-label="Collapse right panel"
                  title="Collapse right panel"
                  className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <PanelRightCloseIcon className="size-4" />
                </button>
              </div>
            }
          />
          <div className="mx-2 mb-2 mt-2 min-h-0 flex-1 overflow-hidden rounded-2xl border border-border bg-background shadow-sm">
            {!activeTab ? (
              <PanelEmptyState
                onOpenActivity={panel.openActivity}
                onOpenGit={panel.openGit}
                onOpenBrowser={() => panel.openBrowser()}
              />
            ) : activeTab.kind === "activity" ? (
              activity
            ) : activeTab.kind === "git" ? (
              <GitTab name={project} />
            ) : (
              <BrowserSurface
                key={activeTab.id}
                title={activeTab.title}
                url={activeTab.url}
                onNavigate={(url) => panel.navigateBrowser(activeTab.id, url)}
              />
            )}
          </div>
        </motion.aside>
      ) : null}
    </AnimatePresence>
  );
}
