"use client";

/**
 * The LIVE browser surface — the desktop shell's native `WebContentsView`
 * glued under this panel, with the chrome a real browser has: tab strip, URL
 * bar, back/forward/reload, and the §6 controller badge.
 *
 * ONLY IN THE SHELL. The web build served to a phone or another machine has
 * no native view to glue, so `desktopBrowserBridge()` answers undefined there
 * and the right panel keeps its screenshot-polling surface. That fallback is
 * a feature, not a leftover — it is how remote clients watch the same
 * session.
 *
 * THE VIEWPORT-SYNC HOOK IS THE FROZEN COCKPIT'S, ported from
 * `apps/web_old/lib/use-controlled-browser.ts` with its hard-won fixes kept:
 * the zero-area latch (a panel that mounts mid-animation measures 0×0, and a
 * visibility asserted then was spent on nothing) and the 360 ms transition
 * follow (ResizeObserver does not report an ancestor's flex animation).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { ArrowLeftIcon, ArrowRightIcon, HandIcon, PlusIcon, RotateCwIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type DesktopBrowserTab = {
  index: number;
  id: string;
  title: string;
  url: string;
  active: boolean;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
};

export type DesktopBrowserPanelState = {
  scopeKey: string;
  controller?: "agent" | "human" | "idle";
  tabs: DesktopBrowserTab[];
};

export type DesktopBrowserBridge = {
  getState(scopeKey: string): Promise<DesktopBrowserPanelState>;
  action(scopeKey: string, action: Record<string, unknown>): Promise<DesktopBrowserPanelState>;
  setBounds(scopeKey: string, bounds: { x: number; y: number; width: number; height: number }): Promise<void>;
  setVisible(scopeKey: string, visible: boolean): Promise<void>;
  handBack(scopeKey: string): Promise<DesktopBrowserPanelState>;
  onState(listener: (state: DesktopBrowserPanelState) => void): () => void;
};

/** The shell's bridge, or undefined outside the desktop app. */
export function desktopBrowserBridge(): DesktopBrowserBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { telarDesktop?: { browser?: DesktopBrowserBridge } }).telarDesktop?.browser;
}

function useDesktopBrowserViewport(bridge: DesktopBrowserBridge, scopeKey: string, hostRef: RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let frame = 0;
    let transitionFrame = 0;
    let disposed = false;
    let visibilityRequested = false;
    const applyBounds = async () => {
      const rect = host.getBoundingClientRect();
      await bridge.setBounds(scopeKey, { x: rect.left, y: rect.top, width: rect.width, height: rect.height });
      if (disposed) return;
      // The zero-area latch — see the header comment.
      if (rect.width === 0 || rect.height === 0) {
        visibilityRequested = false;
        return;
      }
      if (visibilityRequested) return;
      visibilityRequested = true;
      await bridge.setVisible(scopeKey, true);
    };
    const sync = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => void applyBounds());
    };
    const observer = new ResizeObserver(sync);
    observer.observe(host);
    window.addEventListener("resize", sync);
    window.addEventListener("scroll", sync, true);
    const transitionDeadline = performance.now() + 360;
    const followTransition = () => {
      void applyBounds();
      if (performance.now() < transitionDeadline) transitionFrame = window.requestAnimationFrame(followTransition);
    };
    followTransition();
    return () => {
      disposed = true;
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(transitionFrame);
      observer.disconnect();
      window.removeEventListener("resize", sync);
      window.removeEventListener("scroll", sync, true);
      void bridge.setVisible(scopeKey, false);
    };
  }, [bridge, hostRef, scopeKey]);
}

/** The address a human sees: the page's URL, or empty on the blank tab. */
export function addressValue(url: string | undefined): string {
  return !url || url === "about:blank" ? "" : url;
}

export function DesktopBrowserSurface({ bridge, sessionId }: { bridge: DesktopBrowserBridge; sessionId: string }) {
  const [state, setState] = useState<DesktopBrowserPanelState>();
  const [draft, setDraft] = useState<string>();
  const hostRef = useRef<HTMLDivElement>(null);
  const activeTab = state?.tabs.find((tab) => tab.active);
  const controller = state?.controller ?? "idle";

  const refresh = useCallback(async () => {
    try {
      setState(await bridge.getState(sessionId));
    } catch {
      // The shell mid-reload must not take the panel down with it.
    }
  }, [bridge, sessionId]);

  useEffect(() => {
    void refresh();
    // The manager pushes on every change; the interval is the belt to that
    // suspender (a push lost during a renderer reload).
    const timer = window.setInterval(() => void refresh(), 2_000);
    const unsubscribe = bridge.onState((next) => {
      if (next.scopeKey === sessionId) setState(next);
    });
    return () => {
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [bridge, refresh, sessionId]);

  useDesktopBrowserViewport(bridge, sessionId, hostRef);

  const act = useCallback(
    async (action: Record<string, unknown>) => {
      try {
        setState(await bridge.action(sessionId, action));
      } catch {
        void refresh();
      }
    },
    [bridge, refresh, sessionId],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ── tab strip ─────────────────────────────────────────────────── */}
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-2 py-1" role="tablist" aria-label="Browser tabs">
        {(state?.tabs ?? []).map((tab) => (
          <div
            key={tab.id}
            className={cn(
              "flex min-w-0 max-w-44 items-center gap-1 rounded-md px-2 py-1",
              tab.active ? "bg-muted" : "hover:bg-muted/50",
            )}
          >
            <button
              type="button"
              role="tab"
              aria-selected={tab.active}
              className="min-w-0 flex-1 truncate text-left text-xs"
              title={tab.url}
              onClick={() => void act({ action: "select", index: tab.index })}
            >
              {tab.title || "New tab"}
            </button>
            <button
              type="button"
              aria-label={`Close ${tab.title || "tab"}`}
              className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={(event) => {
                event.stopPropagation();
                void act({ action: "close", index: tab.index });
              }}
            >
              <XIcon className="size-3" />
            </button>
          </div>
        ))}
        <button
          type="button"
          aria-label="New tab"
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() => void act({ action: "new" })}
        >
          <PlusIcon className="size-3.5" />
        </button>
      </div>

      {/* ── address row ───────────────────────────────────────────────── */}
      <form
        className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          const next = (draft ?? addressValue(activeTab?.url)).trim();
          if (!next) return;
          setDraft(undefined);
          void act({ action: (state?.tabs.length ?? 0) > 0 ? "navigate" : "new", url: next });
        }}
      >
        <button type="button" aria-label="Go back" disabled={!activeTab?.canGoBack} className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40" onClick={() => void act({ action: "back" })}>
          <ArrowLeftIcon className="size-3.5" />
        </button>
        <button type="button" aria-label="Go forward" disabled={!activeTab?.canGoForward} className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40" onClick={() => void act({ action: "forward" })}>
          <ArrowRightIcon className="size-3.5" />
        </button>
        <button type="button" aria-label="Reload" className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => void act({ action: "reload" })}>
          <RotateCwIcon className="size-3.5" />
        </button>
        <input
          aria-label="Address"
          placeholder="Type an address"
          spellCheck={false}
          className="h-6 min-w-0 flex-1 rounded-md border border-transparent bg-muted/60 px-2 font-mono text-[0.6875rem] outline-none focus:border-ring"
          // Uncontrolled-until-touched: the URL keeps updating under an
          // untouched field, and a draft survives navigation until submitted.
          value={draft ?? addressValue(activeTab?.url)}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => setDraft(undefined)}
        />
        {/* ── the §6 badge: whose hands are on the wheel ─────────────── */}
        {controller === "human" ? (
          <span className="flex shrink-0 items-center gap-1.5">
            <span className="flex items-center gap-1 rounded-md bg-warning/15 px-1.5 py-0.5 text-[0.625rem] font-medium text-warning">
              <HandIcon className="size-3" /> You have the browser
            </span>
            <Button size="sm" className="h-6 px-2 text-[0.6875rem]" onClick={() => void bridge.handBack(sessionId).then(setState)}>
              Hand back
            </Button>
          </span>
        ) : controller === "agent" ? (
          <span className="shrink-0 rounded-md bg-primary/10 px-1.5 py-0.5 text-[0.625rem] font-medium text-primary">
            Agent is browsing
          </span>
        ) : null}
      </form>

      {/* ── the native viewport is glued to this element's rect ───────── */}
      <div ref={hostRef} className="min-h-0 flex-1 bg-muted/20" aria-label="Live browser viewport">
        {(state?.tabs.length ?? 0) === 0 && (
          <div className="flex h-full items-center justify-center p-6 text-center text-xs text-muted-foreground">
            Type an address above, or ask the agent to open a page.
          </div>
        )}
      </div>
    </div>
  );
}
