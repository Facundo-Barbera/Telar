"use client";

/**
 * The LIVE browser surface — the desktop shell's native `WebContentsView`
 * glued under this panel, with the chrome a real browser has: tab strip, URL
 * bar, back/forward/reload, and a quiet "agent acting" mark while the agent
 * is driving the tab you are looking at.
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
import { ArrowLeftIcon, ArrowRightIcon, CheckIcon, CodeXmlIcon, KeyRoundIcon, Loader2Icon, MoonIcon, PlusIcon, RotateCwIcon, ScalingIcon, TriangleAlertIcon, UserRoundIcon, XIcon } from "lucide-react";
import { BrowserPrivacyBanner, type DesktopPrivacyState } from "@/components/browser-privacy-banner";
import { BrowserStartPage } from "@/components/browser-start-page";
import {
  describePermissionDenial,
  SitePermissionPrompt,
  SitePermissionsPopover,
  SiteSecurityIcon,
  type PermissionAnswer,
} from "@/components/browser-permission-prompt";
import {
  describePermissionKinds,
  siteLabel,
  type PermissionPrompt,
  type SitePermissionKind,
  type SitePermissionRecord,
  type SitePermissionsBridge,
} from "@/lib/desktop-site-permissions";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { describeViewport, fitViewport, parseViewportInput, resizeByDrag, resizeByKey, stageOf, VIEWPORT_PRESETS, VIEWPORT_RAIL, type ResizeDirection, type ViewportMode, type ViewportPresetKey } from "@/lib/browser-viewport";
import { browserPageReference, startReferenceDrag } from "@/lib/drag-reference";
import { onNativeViewOverlay, useNativeViewOverlay } from "@/lib/native-view-overlay";
import { useCommandHandlers } from "@/lib/use-command-keys";
import { makeScopeGuard } from "@/lib/scope-guard";
import { hostFromPathname, LOCAL_HOST_ID } from "@/lib/hosts/client";
import { IdentityIcon } from "@/lib/telar-icons";
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
  /** Advisory, per tab: who touched it most recently — "human" while a human
   *  is interacting, "agent" while an agent call runs on it. Nothing to hand
   *  back; it decays on its own. */
  controller?: "agent" | "human" | "idle";
  openedBy?: "agent" | "human";
  /** The tab the AGENT's calls land in, which is independent of `active` —
   *  the one you are looking at. Marked in the strip so "where is it working"
   *  is answerable without opening its tab and losing your own place. */
  agentFocus?: boolean;
  favicon?: string | null;
  /** Remembered (restored from the shell's inventory, or hibernated) with no
   *  live page yet — the first look at it loads the page. */
  sleeping?: boolean;
  /** Chromium DevTools are open on THIS tab, in their own detached window
   *  (#423). Owned per tab and closed with it, so the strip is where you find
   *  out which page a stray DevTools window belongs to. */
  devtools?: boolean;
  /** The tab's own intrinsic viewport, which preset it is (if any), and
   *  whether it is fixed or follows the panel. */
  viewport?: { width: number; height: number; preset: ViewportPresetKey | null; mode?: ViewportMode };
  /** WHICH IDENTITY this tab is signed into. A tab opened before the session's
   *  profile was switched keeps its own — it is not silently re-pointed — and
   *  the strip says so rather than letting it look like the current one. */
  profileId?: string | null;
};

/**
 * A NAMED BROWSER IDENTITY — cookies, storage and extension state that several
 * projects may share, or that one project keeps to itself. `account` is what a
 * person SAID the profile is for; nothing verifies a login against it.
 */
export type DesktopBrowserProfile = {
  id: string;
  label: string;
  account?: string;
  partition: string;
  /** The marks a person put on it — a glyph from the app's closed set and one of
   *  eight identity hues. What the toolbar draws INSTEAD of the name, because a
   *  toolbar has room for one glyph and not for "Client review (staging)". */
  icon?: string;
  color?: string;
  isDefault?: boolean;
  /** The project keys assigned to this profile — how sharing is made visible. */
  projects?: string[];
};

/** The credential boundary, as the shell reports it (private-interaction.js).
 *  Declared beside the bar that draws it so the two cannot drift. */
export type { DesktopPrivacyState } from "@/components/browser-privacy-banner";

/** How the active tab is presented inside the panel's bounds: its intrinsic
 *  size, the presentation scale, and the native rect (window coordinates)
 *  the view occupies — what the device frame is drawn around. */
export type DesktopBrowserPresentation = {
  width: number;
  height: number;
  scale: number;
  rect: { x: number; y: number; width: number; height: number };
};

export type DesktopBrowserPanelState = {
  scopeKey: string;
  controller?: "agent" | "human" | "idle";
  tabs: DesktopBrowserTab[];
  privacy?: DesktopPrivacyState;
  presentation?: DesktopBrowserPresentation | null;
  /** The identity this session's NEXT tab opens in, and every identity it
   *  could be switched to. Null before the profile binding lands. */
  profile?: DesktopBrowserProfile | null;
  profiles?: DesktopBrowserProfile[];
  /** The project key this session declared — what "use for this project"
   *  assigns. Null for a session with no project. */
  profileKey?: string | null;
  /**
   * THIS BROWSER JUST ENDED — its last tab closed (#383).
   *
   * An EVENT, present on exactly one push and never on a `getState` read: a
   * scope with no tabs is otherwise indistinguishable from one that has not
   * opened its first page, so a condition here would close a panel that had
   * only just been opened.
   */
  ended?: boolean;
};

/** The password-manager extension's status (extension-host.js). */
export type DesktopExtensionStatus = {
  id?: string;
  name?: string;
  /** The partition this status belongs to, so the panel keeps only its own
   *  project's host and ignores another project's pushes. */
  partition?: string;
  /** The official 1Password icon as a data URL, read by the shell from the
   *  verified extension. Absent → the toolbar keeps its key-glyph fallback. */
  icon?: string;
  phase: "idle" | "installing" | "loading" | "ready" | "failed" | "unavailable";
  version?: string;
  error?: string;
  /** Observed, not assumed: the extension's own uncaught worker errors and
   *  the native host's lifecycle. `ready` alone does not mean it works. */
  health?: {
    /** Fixed classification code → count. Never raw extension text. */
    workerErrors: Record<string, number>;
    /** APP-LEVEL helper availability — not a per-profile "connected" claim.
     *  `helpers` is the count of live 1Password browser-helper processes. */
    native: { state: "not attempted" | "available" | "unavailable"; helpers: number; lastExitCode?: number | null; hint?: string };
  };
  privacy?: DesktopPrivacyState;
};

/** One short sentence of the extension's real health for the toolbar. */
export function describeExtensionHealth(extension: DesktopExtensionStatus): { tone: "ok" | "warn" | "error"; text: string } {
  if (extension.phase === "failed") return { tone: "error", text: extension.error ?? "failed" };
  // Map the pre-ready phases to words a person can read — never the raw enum
  // ("idle"/"installing"/"loading" would surface verbatim otherwise).
  if (extension.phase !== "ready") {
    const text = extension.phase === "installing" ? "Installing 1Password…" : extension.phase === "loading" ? "Loading 1Password…" : "1Password starting…";
    return { tone: "warn", text };
  }
  const native = extension.health?.native;
  const errorCount = Object.values(extension.health?.workerErrors ?? {}).reduce((sum, n) => sum + n, 0);
  // Helper AVAILABILITY is app-level; actual pairing is confirmed in the
  // 1Password UI, so the words stay honest ("available", not "connected",
  // and never "finish pairing" — pairing is the extension's to report).
  if (native?.state === "unavailable") {
    // A helper that started and then exited is NOT "not seen yet" — say it stopped.
    if (native.lastExitCode === 1) return { tone: "error", text: native.hint ?? "1Password app helper unavailable — check this browser is added under 1Password → Settings → Browser." };
    return { tone: "error", text: `1Password app helper stopped unexpectedly${native.lastExitCode != null ? ` (exit ${native.lastExitCode})` : ""}.` };
  }
  if (errorCount) return { tone: "warn", text: `Extension reported ${errorCount} error${errorCount === 1 ? "" : "s"} (${Object.keys(extension.health!.workerErrors).join(", ")})` };
  if (native?.state === "available") return { tone: "ok", text: "1Password app helper available." };
  // "not attempted": the helper genuinely has not run yet.
  return { tone: "warn", text: "Loaded; 1Password app helper not seen yet." };
}

export type DesktopBrowserBridge = {
  getState(scopeKey: string): Promise<DesktopBrowserPanelState>;
  action(scopeKey: string, action: Record<string, unknown>): Promise<DesktopBrowserPanelState>;
  setBounds(scopeKey: string, bounds: { x: number; y: number; width: number; height: number }): Promise<void>;
  setVisible(scopeKey: string, visible: boolean): Promise<void>;
  onState(listener: (state: DesktopBrowserPanelState) => void): () => void;
  /** Bind this session's browser scope to its project profile (per-project
   *  cookies). Idempotent; the engine does the same before agent turns. */
  bindProfile?(scopeKey: string, profileKey: string): Promise<{ scopeKey: string; profileKey: string; partition: string; profileId?: string; label?: string }>;
  /**
   * NAMED PROFILES. Create and rename identities, choose the global default,
   * assign this session's project, and switch which identity the session's NEXT
   * tab opens in. There is no delete: a profile record is the only name a live
   * cookie jar has, so removing one would strand or destroy an identity
   * somebody is still signed into.
   */
  createProfile?(input: { label: string; account?: string; scopeKey?: string; assignProject?: boolean }): Promise<{ profiles: DesktopBrowserProfile[]; active: DesktopBrowserProfile }>;
  updateProfile?(input: { profileId: string; label?: string; account?: string; icon?: string | null; color?: string | null }): Promise<{ profiles: DesktopBrowserProfile[] }>;
  setDefaultProfile?(profileId: string): Promise<{ profiles: DesktopBrowserProfile[] }>;
  assignProjectProfile?(input: { scopeKey: string; profileId: string | null }): Promise<{ profiles: DesktopBrowserProfile[] }>;
  setScopeProfile?(scopeKey: string, profileId: string): Promise<{ profileId: string; partition: string }>;
  extensionStatus?(scopeKey: string): Promise<DesktopExtensionStatus>;
  openExtensionPopup?(scopeKey: string, anchorRect: { x: number; y: number; width: number; height: number }): Promise<DesktopExtensionStatus>;
  /** End the private window. Plain: the shell re-probes the holding page and
   *  refuses unless it answers clean. `force`: the person is asserting the
   *  sign-in is over on a page that will not answer at all (#480). Optional
   *  because an older shell does not have it — the bar then draws no buttons
   *  rather than one that throws. */
  resumeFromPrivate?(options?: { force?: boolean }): Promise<DesktopPrivacyState>;
  /**
   * Hand a page to the user's DEFAULT browser. Optional because an older shell
   * does not have it, and the tab menu hides the row rather than offering one
   * that throws. http/https only, decided in the main process — the renderer
   * never reaches `shell.openExternal` and never gets to say what may.
   */
  openExternal?(url: string): Promise<{ ok: boolean; error?: string }>;
  /** The EXPLICIT login-offer fallback (AUTH-001): open the shell's trusted
   *  offer window about this session's current page — for a sign-in Telar
   *  never saw, or an automatic offer that was dismissed. Opening only asks;
   *  the answer happens inside the shell's own window, never here. */
  offerLoginMemory?(scopeKey: string): Promise<{ ok: boolean; error?: string }>;
  onExtension?(listener: (status: DesktopExtensionStatus) => void): () => void;
  /**
   * SITE PERMISSIONS (#422) — camera, microphone, notifications, location,
   * clipboard and screen share. Every method is optional: an older shell installs
   * no permission handlers at all, and this panel then draws no lock icon rather
   * than a control that throws.
   *
   * The shape lives in `lib/desktop-site-permissions.ts`, which Settings reads
   * too; it is spread in here so a caller of THIS bridge sees one object, the
   * way `telarDesktop.browser` actually is.
   */
} & SitePermissionsBridge;

/**
 * A TAB'S OWN MENU, and it reads like every browser's because it is the same
 * object — Reload, Duplicate, Copy URL, Open in system browser, Close, Close
 * others. Every item names THIS tab by index, so a right-click on a background
 * tab never drags your view to it (the shell's `reload` learned an index for
 * exactly that; close and select already had one).
 *
 * DUPLICATE AND OPEN-IN-SYSTEM-BROWSER ARE THE SHELL'S. The renderer can
 * neither mint a native tab nor reach the OS, and the second one is gated in
 * the main process to http and https — the renderer never gets to say what may
 * leave. `openExternal` is optional on the bridge, so an older shell hides the
 * row rather than offering one that throws.
 *
 * CLOSE OTHERS WALKS DOWN, and that is not a style choice: closing a tab
 * renumbers everything above it, so ascending would close the wrong tabs from
 * the second one on. Descending leaves every index it has not reached yet
 * exactly where it was.
 *
 * CONTROLLED, AND IT TAKES THE NATIVE VIEW DOWN WHILE IT IS OPEN — the rule
 * `lib/native-view-overlay.ts` states for every menu in this panel. The shell
 * composites a `WebContentsView` ABOVE this renderer's DOM, so a portal menu
 * over the browser is drawn over by the page; hiding the view while the menu
 * is open is what makes it visible at all. Per-tab state rather than the
 * strip's one `openOverlay`, because each tab owns its own menu and two cannot
 * be open at once anyway — the hook counts claims, so one closing as another
 * opens never reveals the page under the second.
 */
function TabMenu({
  tab,
  tabs,
  onAct,
  onOpenExternal,
  className,
  children,
}: {
  tab: DesktopBrowserTab;
  tabs: readonly DesktopBrowserTab[];
  onAct: (action: Record<string, unknown>) => Promise<void>;
  onOpenExternal?: (url: string) => Promise<{ ok: boolean; error?: string }>;
  /** The trigger IS the tab, not a box around it — the drag stays on the
   *  wrapper outside, so a right-click can never be confused with one. Same
   *  shape the Spool's board card uses. */
  className?: string;
  children: React.ReactNode;
}) {
  const web = /^https?:\/\//i.test(tab.url);
  const [menuOpen, setMenuOpen] = useState(false);
  useNativeViewOverlay(menuOpen);
  return (
    <ContextMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <ContextMenuTrigger {...(className ? { className } : {})}>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-auto">
        <ContextMenuItem onClick={() => void onAct({ action: "reload", index: tab.index })}>Reload</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => void onAct({ action: "duplicate", index: tab.index })}>Duplicate</ContextMenuItem>
        <ContextMenuItem onClick={() => void navigator.clipboard.writeText(tab.url)}>Copy URL</ContextMenuItem>
        {onOpenExternal && (
          // Offered only for a page the system browser can actually take. The
          // shell refuses anything else anyway; a row that always fails would
          // be this surface lying about what it can do.
          <ContextMenuItem disabled={!web} onClick={() => void onOpenExternal(tab.url)}>
            Open in system browser
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => void onAct({ action: "close", index: tab.index })}>Close</ContextMenuItem>
        <ContextMenuItem
          disabled={tabs.length < 2}
          onClick={() => {
            void (async () => {
              for (const other of [...tabs].sort((a, b) => b.index - a.index)) {
                if (other.id !== tab.id) await onAct({ action: "close", index: other.index });
              }
            })();
          }}
        >
          Close others
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** The shell's bridge, or undefined outside the desktop app. */
export function desktopBrowserBridge(): DesktopBrowserBridge | undefined {
  if (typeof window === "undefined" || hostFromPathname(window.location.pathname) !== LOCAL_HOST_ID) return undefined;
  return (window as unknown as { telarDesktop?: { browser?: DesktopBrowserBridge } }).telarDesktop?.browser;
}

/**
 * Glue Fit mode to the whole host. Fixed viewports reserve right and bottom
 * rails (`stageOf`) so the native layer cannot cover their resize handles.
 *
 * `layoutKey` is anything that moves the host WITHOUT changing its size — a
 * toolbar row opening above it changes its size (ResizeObserver sees that),
 * but a sibling above it changing height while the host is `flex-1` and
 * the column is fixed does not always; nor does a change in what the host
 * shows. Republishing on it is the self-heal that used to require dragging
 * the sidebar. Bounds are always published with the LATEST rect, and the
 * host serializes them per tab (browser-manager applyGeometry).
 */
function useDesktopBrowserViewport(bridge: DesktopBrowserBridge, scopeKey: string, hostRef: RefObject<HTMLDivElement | null>, layoutKey: string, mode: ViewportMode, overlayRef: RefObject<boolean>) {
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let frame = 0;
    let transitionFrame = 0;
    let disposed = false;
    let visibilityRequested = false;
    const applyBounds = async () => {
      const rect = host.getBoundingClientRect();
      const stage = mode === "fixed" ? stageOf(rect) : rect;
      await bridge.setBounds(scopeKey, { x: rect.left, y: rect.top, width: rect.width === 0 ? 0 : stage.width, height: rect.height === 0 ? 0 : stage.height });
      if (disposed) return;
      // The zero-area latch — see the header comment.
      if (rect.width === 0 || rect.height === 0) {
        visibilityRequested = false;
        return;
      }
      // A MENU IS OPEN OVER THE PANEL. The native view is down so it can be
      // seen at all (`lib/native-view-overlay.ts`), and a bounds sync must not
      // put it back. Latched like the zero-area case, so the next sync after
      // the menu closes re-asserts visibility on its own.
      if (overlayRef.current) {
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
  }, [bridge, hostRef, scopeKey, mode, overlayRef]);
  // The republish: same rect, re-sent — the host re-places the view.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const frame = window.requestAnimationFrame(() => {
      const rect = host.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const stage = mode === "fixed" ? stageOf(rect) : rect;
      void bridge.setBounds(scopeKey, { x: rect.left, y: rect.top, width: stage.width, height: stage.height });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [bridge, hostRef, scopeKey, layoutKey, mode]);
}

/**
 * THE RESIZE RAILS — right edge, bottom edge, corner — at the fitted page's
 * edges inside the stage, in the rail the native view never enters.
 * Pointer-captured drags; arrow keys for the keyboard; a drag in progress
 * shows its size live and commits on release (Escape/cancel drops it).
 */
function ViewportRails({ viewport, scale, fit, onPreview, onCommit }: {
  viewport: { width: number; height: number };
  scale: number;
  fit: { x: number; y: number; width: number; height: number };
  onPreview: (size: { width: number; height: number } | undefined) => void;
  onCommit: (size: { width: number; height: number }) => void;
}) {
  /**
   * THE ONE DRAG THIS COMPONENT MAY HOLD, and how it ends. Every ending —
   * release, cancel, Escape, the window losing focus, capture lost, or this
   * component unmounting (the rails are keyed per tab, so a session or tab
   * switch unmounts them) — runs the same cleanup. A drag that is not
   * finished by a `pointerup` this component saw commits NOTHING: a release
   * after a scope switch must never write into the session it started in.
   */
  const dragRef = useRef<(() => void) | null>(null);
  useEffect(() => () => dragRef.current?.(), []);
  const startDrag = (direction: ResizeDirection, event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    dragRef.current?.();
    const target = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    const start = { width: viewport.width, height: viewport.height };
    let latest = start;
    try { target.setPointerCapture(pointerId); } catch { /* window listeners below still work */ }
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      moveEvent.preventDefault();
      latest = resizeByDrag(start, { x: moveEvent.clientX - startX, y: moveEvent.clientY - startY }, scale, direction);
      onPreview(latest);
    };
    // Drop the drag without committing — every ending but a seen release.
    const abandon = () => {
      cleanup();
      onPreview(undefined);
    };
    const cleanup = () => {
      if (dragRef.current === cleanup) dragRef.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", abandon);
      window.removeEventListener("blur", abandon);
      window.removeEventListener("keydown", escape, true);
      target.removeEventListener("lostpointercapture", abandon);
      try { target.releasePointerCapture(pointerId); } catch { /* already released */ }
    };
    const finish = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerId) return;
      // Capture is released by `cleanup` BEFORE the commit, and the
      // `lostpointercapture` listener is gone by then, so it cannot abandon
      // a release we saw.
      cleanup();
      onPreview(undefined);
      if (latest.width !== start.width || latest.height !== start.height) onCommit(latest);
    };
    const escape = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key !== "Escape") return;
      keyEvent.preventDefault();
      abandon();
    };
    dragRef.current = cleanup;
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", abandon);
    window.addEventListener("blur", abandon);
    window.addEventListener("keydown", escape, true);
    target.addEventListener("lostpointercapture", abandon);
  };
  const onKey = (direction: ResizeDirection, event: React.KeyboardEvent<HTMLButtonElement>) => {
    const next = resizeByKey(viewport, event.key, event.shiftKey, direction);
    if (!next) return;
    event.preventDefault();
    event.stopPropagation();
    onCommit(next);
  };
  const right = fit.x + fit.width;
  const bottom = fit.y + fit.height;
  const rail = "group absolute z-20 touch-none rounded-sm bg-transparent outline-none focus-visible:bg-foreground/10";
  const grip = "pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-muted-foreground/50 group-hover:bg-foreground/70 group-focus-visible:bg-foreground group-active:bg-foreground";
  return (
    <>
      <button type="button" aria-label="Resize viewport width. Use left and right arrow keys." title="Drag to change the viewport width" className={cn(rail, "cursor-ew-resize")} style={{ left: right, top: fit.y, width: VIEWPORT_RAIL, height: fit.height }} onPointerDown={(event) => startDrag("east", event)} onKeyDown={(event) => onKey("east", event)}>
        <span aria-hidden className={cn(grip, "h-8 w-1")} />
      </button>
      <button type="button" aria-label="Resize viewport height. Use up and down arrow keys." title="Drag to change the viewport height" className={cn(rail, "cursor-ns-resize")} style={{ left: fit.x, top: bottom, width: fit.width, height: VIEWPORT_RAIL }} onPointerDown={(event) => startDrag("south", event)} onKeyDown={(event) => onKey("south", event)}>
        <span aria-hidden className={cn(grip, "h-1 w-8")} />
      </button>
      <button type="button" aria-label="Resize viewport. Use arrow keys." title="Drag to resize the viewport" className={cn(rail, "z-30 cursor-nwse-resize")} style={{ left: right, top: bottom, width: VIEWPORT_RAIL, height: VIEWPORT_RAIL }} onPointerDown={(event) => startDrag("southeast", event)} onKeyDown={(event) => onKey("southeast", event)}>
        <span aria-hidden className={cn(grip, "size-1.5")} />
      </button>
    </>
  );
}

/**
 * The frame around the fitted page. The shell's `presentation.rect` is in
 * WINDOW coordinates (what `setBounds` was given, fitted); this host's own
 * rect is subtracted so the frame lands on the native pixels. Only the
 * margins are painted — the page itself is the native view above.
 */
/** The host's size, observed rather than read during render (React's rule). */
function useHostSize(hostRef: RefObject<HTMLDivElement | null>): { width: number; height: number } | undefined {
  const [size, setSize] = useState<{ width: number; height: number }>();
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, [hostRef]);
  return size;
}

/**
 * Whether the address row is too narrow to spell its controls out.
 *
 * MEASURED, not a media query: the panel's width is its own — the window can be
 * wide while this column is narrow because the conversation took the
 * difference — so the only width that answers the question is this row's. Only
 * the boolean is state, so a drag across the whole range re-renders twice.
 */
function useCompactAddressRow(rowRef: RefObject<HTMLElement | null>): boolean {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setCompact(addressRowCompact(entry.contentRect.width));
    });
    observer.observe(row);
    return () => observer.disconnect();
  }, [rowRef]);
  return compact;
}

/**
 * The frame, rails and readout around the fitted page. The SAME fit
 * arithmetic the shell applies to the native view (`fitViewport` over the
 * stage), so what is drawn here and the pixels the view shows are one rect.
 * `preview` is a drag in progress: the frame and readout follow it live
 * while the native view stays at the committed size until release.
 */
function DeviceFrame({ viewport, mode, hostSize, preview, onPreview, onCommit, railsKey }: {
  viewport: { width: number; height: number };
  mode: ViewportMode;
  /** The session + tab the rails belong to: a change REMOUNTS them, which
   *  ends any drag in progress without committing (see ViewportRails). */
  railsKey: string;
  hostSize: { width: number; height: number };
  preview: { width: number; height: number } | undefined;
  onPreview: (size: { width: number; height: number } | undefined) => void;
  onCommit: (size: { width: number; height: number }) => void;
}) {
  const stage = stageOf(hostSize);
  const fit = fitViewport(viewport, stage);
  const shown = preview ?? viewport;
  const previewFit = preview ? fitViewport(preview, stage) : fit;
  return (
    <>
      <div
        aria-hidden
        className={cn("pointer-events-none absolute rounded-sm ring-1", preview ? "ring-primary/70" : "ring-border/70")}
        style={{ left: previewFit.x, top: previewFit.y, width: previewFit.width, height: previewFit.height, boxShadow: "0 0 0 9999px color-mix(in oklab, var(--muted) 55%, transparent)" }}
      />
      {preview && (
        <span aria-live="polite" className="pointer-events-none absolute z-30 rounded-md bg-foreground px-1.5 py-0.5 font-mono text-3xs text-background" style={{ left: previewFit.x + 6, top: previewFit.y + 6 }}>
          {shown.width}×{shown.height}
        </span>
      )}
      {/* Fit mode has no edges to drag: the viewport IS the stage. */}
      {mode === "fixed" && <ViewportRails key={railsKey} viewport={viewport} scale={fit.scale} fit={previewFit} onPreview={onPreview} onCommit={onCommit} />}
    </>
  );
}

/** One row in either of the toolbar's menus — the cockpit's popover-row shape,
 *  with the leading slot every row reserves for its check. */
const menuRow =
  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[0.75rem] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-50";

/** The address a human sees: the page's URL, or empty on the blank tab. */
export function addressValue(url: string | undefined): string {
  return !url || url === "about:blank" ? "" : url;
}

/**
 * THE ORIGIN A PERMISSION BELONGS TO, or undefined where none can. A blank tab,
 * a local file and an extension page hold nothing — `file:` has origin `null` in
 * the spec, so every local file would otherwise share one bucket. The same rule
 * the shell applies (site-permissions.js), said here so the lock icon is absent
 * rather than showing an empty list.
 */
export function originOfUrl(url: string | undefined): string | undefined {
  if (!url || url === "about:blank") return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * WHAT THE ADDRESS ROW SPENDS ON EVERYTHING THAT IS NOT THE ADDRESS.
 *
 * The row is one no-wrap flex line, so every control on it is width the input
 * does not get. At the right panel's default (~510px) the labelled controls
 * cost more than the row has and the input — the only thing on the row you can
 * TYPE into — collapsed to about 30px, which is the bug (#319).
 *
 * Measured in px off the row's own classes rather than guessed: back, forward,
 * reload and the profile mark are 22 each (`p-1` around a 14px glyph); the LOCK
 * is 18 (`p-0.5` around the same glyph); the viewport control is 26 icon-only
 * (`px-1.5`); the password control is 44 at its widest, which is the glyph with
 * the warning mark beside it; the row spends seven 4px gaps between its eight
 * children. Padding is NOT counted — the observer below reads the content box.
 *
 * THE LOCK IS THE TIGHT ONE ON PURPOSE (#422). It is the only control this row
 * has gained since #319, and at the width that issue was filed about (a 420px
 * panel, 404px of content) the compact row clears the input floor by exactly
 * nothing. At `p-1` it would be 4px short — so the site-permissions anchor wears
 * the smallest padding on the row, and #319's acceptance still holds.
 */
const ADDRESS_CONTROLS_COMPACT = 4 * 22 + 18 + 26 + 44 + 7 * 4;
/**
 * The same row spelling its ONE labelled control out: "Fit panel" or a size
 * (+49).
 *
 * THE PROFILE USED TO BE THE OTHER ONE, and its `max-w-28` label was the single
 * most expensive thing on the row at +116. It is a glyph now (#366) — never
 * written out, so never a label the row has to buy back — and that is why 510px
 * keeps the viewport's words where it used to drop them.
 */
const ADDRESS_CONTROLS_LABELLED = ADDRESS_CONTROLS_COMPACT + 49;
/** The row's own `px-2`, which the content box the observer reports excludes. */
export const ADDRESS_ROW_PADDING = 16;
/** Under this the address bar is a decoration rather than a place to type a
 *  URL: "Type an address" does not fit, and neither does most of a hostname. */
export const ADDRESS_INPUT_FLOOR = 200;

/** What is left for the address input on a row of `rowWidth` content px. */
export function addressInputRoom(rowWidth: number, labelled: boolean): number {
  return rowWidth - (labelled ? ADDRESS_CONTROLS_LABELLED : ADDRESS_CONTROLS_COMPACT);
}

/** Whether the row must drop its labels for the input to clear the floor. */
export function addressRowCompact(rowWidth: number): boolean {
  return addressInputRoom(rowWidth, true) < ADDRESS_INPUT_FLOOR;
}

/**
 * WHAT ONE SITE HOLDS IN THIS SESSION'S PROFILE, or nothing.
 *
 * A module function rather than a hook, because both of its callers close over
 * values derived from the panel's own state and the compiler's
 * preserve-memoization rule will not have a manual memo over those. It answers
 * `[]` for every reason there is to have no answer — no shell, a blank tab, an
 * unbound scope — so the lock popover says "has not asked for anything", which
 * is true in all of them.
 */
async function readSitePermissionsFor(
  bridge: DesktopBrowserBridge,
  scopeKey: string,
  origin: string | undefined,
): Promise<SitePermissionRecord[]> {
  if (!bridge.sitePermissions || !origin) return [];
  try {
    const answer = await bridge.sitePermissions({ scopeKey, origin });
    return answer && "kinds" in answer && Array.isArray(answer.kinds) ? (answer.kinds as SitePermissionRecord[]) : [];
  } catch {
    return [];
  }
}

/** Thrown by `bindNow` when the session scope changed while it awaited, so the
 *  caller aborts the (now stale) action instead of running it. */
class StaleScopeError extends Error {}

/**
 * THE SCOPE, NOT THE SESSION. This prop was `sessionId` — the shell keys a
 * native browser on an opaque scope string and the renderer had only ever one
 * per session to hand it. A session can now hold two Browser tabs (#322), each
 * driving its own native browser, so what identifies this surface's browser is
 * the SCOPE KEY its panel tab derives (`browserScopeKey` in right-panel.tsx):
 * the bare session id for the first Browser tab — the one the agent drives and
 * the one every persisted native tab was filed under — and a suffixed key for
 * any other. Every use below was already a scope; only the name was wrong.
 */
export function DesktopBrowserSurface({
  bridge,
  scopeKey,
  projectId,
  onEnded,
}: {
  bridge: DesktopBrowserBridge;
  scopeKey: string;
  projectId?: string;
  /**
   * THE LAST TAB CLOSED, so this browser is over (#383) — the panel tab that
   * holds this surface should close with it.
   *
   * Owned by the panel rather than decided here: a surface cannot remove its
   * own tab, and a browser that answered "no tabs" by drawing a start page
   * would be the panel keeping a tab for a browser the person just shut.
   */
  onEnded?: () => void;
}) {
  const [state, setState] = useState<DesktopBrowserPanelState>();
  const [draft, setDraft] = useState<string>();
  const [extension, setExtension] = useState<DesktopExtensionStatus>();
  const [extensionError, setExtensionError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const hostRef = useRef<HTMLDivElement>(null);
  const addressRowRef = useRef<HTMLFormElement>(null);
  const keyButtonRef = useRef<HTMLButtonElement>(null);

  /**
   * SCOPE GENERATION — this component is REUSED across sessions (Next reuses
   * the instance when only the `scopeKey` prop changes), so an async result
   * for the OLD session must never be applied under the NEW one: it would show
   * the old project's tabs, whose indices then act against the new scope. Every
   * async UI result checks this stamp before `setState`; a stale one is
   * dropped. Bumped on scope/project change, NOT on first mount (the initial
   * load must apply).
   */
  // Lazy, stable per instance (not read from a ref during render).
  const [scope] = useState(makeScopeGuard);
  /** Whether THIS scope's profile binding has landed — what the start page
   *  waits for, so its first suggestions read is never against an unbound
   *  scope. Reset with the scope (see the generation effect below). */
  const [bound, setBound] = useState(false);
  /**
   * WHICH OF THE TOOLBAR'S MENUS IS OPEN — at most one, which is also what
   * `useNativeViewOverlay` is told. One state rather than a boolean each, so
   * a menu cannot be added here without joining the thing that hides the
   * native view underneath it (see `lib/native-view-overlay.ts`).
   */
  const [openOverlay, setOpenOverlay] = useState<"profile" | "viewport" | "site" | null>(null);
  useNativeViewOverlay(openOverlay !== null);
  /** Which pane the profile menu shows: its list, or one of its two forms. */
  const [profilePane, setProfilePane] = useState<"menu" | "rename" | "new">("menu");
  /**
   * SITE PERMISSIONS (#422). The questions the shell is waiting on, the ones a
   * person has waved away for now, what this session's profile remembers about
   * the page in front of them, and the sentence for when macOS refuses a device
   * after they said yes.
   *
   * DISMISSING IS NOT ANSWERING. A prompt covers the native view while it is up
   * (see `useNativeViewOverlay` below), so Esc and a click outside have to put
   * the page back — but the question is still open, the shell's own minute is
   * still running, and the lock icon keeps a mark until it is answered or times
   * out. That is what the omnibox icon does in every browser.
   */
  const [prompts, setPrompts] = useState<PermissionPrompt[]>([]);
  const [dismissedPrompts, setDismissedPrompts] = useState<readonly string[]>([]);
  const [sitePermissions, setSitePermissions] = useState<SitePermissionRecord[]>([]);
  const [permissionBusy, setPermissionBusy] = useState(false);
  const [permissionDenial, setPermissionDenial] = useState<string>();
  const firstScopeRef = useRef(true);
  const partitionRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (firstScopeRef.current) { firstScopeRef.current = false; return; }
    scope.bump();
    partitionRef.current = undefined;
    setBound(false);
    setState(undefined);
    setExtension(undefined);
    setActionError(undefined);
    setExtensionError(undefined);
    // A SESSION SWITCH UNMOUNTS AN OPEN MENU with no `onOpenChange` to close
    // it, and an overlay left claimed would keep the native view hidden for
    // the session you just arrived at.
    setOpenOverlay(null);
    setProfilePane("menu");
    // A question belongs to the session that was asked it; arriving at another
    // one must not show its prompt, and the shell still holds the original.
    setPrompts([]);
    setDismissedPrompts([]);
    setSitePermissions([]);
    setPermissionDenial(undefined);
  }, [scope, scopeKey, projectId]);

  // Typing an address is the human's hands on the tab BEFORE submit; the
  // agent should already be deferring. One signal per burst is enough.
  const intentAt = useRef(0);
  const signalIntent = useCallback(() => {
    const now = Date.now();
    if (now - intentAt.current < 500) return;
    intentAt.current = now;
    // Intent is only a deferral signal; it opens no tab, so it needs no bind.
    const gen = scope.capture();
    void bridge.action(scopeKey, { action: "intent" }).then((next) => { if (scope.isCurrent(gen)) setState(next); }, () => undefined);
  }, [bridge, scope, scopeKey]);
  const activeTab = state?.tabs.find((tab) => tab.active);
  /** The page's own origin — what a permission is scoped to. A blank tab, a
   *  local file and an extension page have none, and hold none. */
  const activeOrigin = originOfUrl(activeTab?.url);
  /** This tab's open question, if it has one. A prompt with no tab (the shell
   *  could not attribute it) is shown here rather than nowhere. */
  const tabPrompt = prompts.find((prompt) => prompt.tabId === null || prompt.tabId === activeTab?.id);
  const activePrompt = tabPrompt && !dismissedPrompts.includes(tabPrompt.requestId) ? tabPrompt : undefined;
  /**
   * A SECOND CLAIM ON THE NATIVE VIEW, and a separate one on purpose: the hook
   * COUNTS claims, so a prompt appearing while the profile menu is open — and
   * either one closing first — never reveals the page under the other.
   */
  useNativeViewOverlay(Boolean(activePrompt));
  // Advisory, per tab: the mark speaks about the tab you are LOOKING at.
  const [newProfileLabel, setNewProfileLabel] = useState("");
  const [newProfileAccount, setNewProfileAccount] = useState("");
  /** A custom viewport size being typed into the viewport menu. */
  const [customSize, setCustomSize] = useState("");
  /** Shut whichever menu is open, back on its list pane for next time. */
  const closeOverlay = () => {
    setOpenOverlay(null);
    setProfilePane("menu");
  };
  /** A rail drag in progress — shown live, committed on release. */
  const [dragPreview, setDragPreview] = useState<{ width: number; height: number }>();
  const hostSize = useHostSize(hostRef);
  /** The toolbar's labels come off before the address bar does — see #319. */
  const compactRow = useCompactAddressRow(addressRowRef);
  const viewportMode: ViewportMode = activeTab?.viewport?.mode ?? "fit";

  /**
   * WHILE A MENU IS OPEN ANYWHERE IN THE RIGHT PANEL, THIS VIEW IS DOWN.
   * The native `WebContentsView` is composited above the renderer's DOM, so
   * this is what lets the panel's menus be real portals rather than inline
   * rows — see `lib/native-view-overlay.ts`. The ref is also read by the
   * viewport hook, which must not re-show the view under an open menu.
   */
  const overlayRef = useRef(false);
  useEffect(
    () =>
      onNativeViewOverlay((hidden) => {
        if (overlayRef.current === hidden) return;
        overlayRef.current = hidden;
        // Showing restores the scope's own remembered rect (see setVisible),
        // so nothing has to be republished here.
        void bridge.setVisible(scopeKey, !hidden).catch(() => undefined);
      }),
    [bridge, scopeKey],
  );

  const refresh = useCallback(async () => {
    const gen = scope.capture();
    try {
      const next = await bridge.getState(scopeKey);
      // Drop a read that resolved after the user navigated to another session.
      if (scope.isCurrent(gen)) setState(next);
    } catch {
      // The shell mid-reload must not take the panel down with it.
    }
  }, [bridge, scope, scopeKey]);

  // BIND THE PROJECT PROFILE BEFORE ANYTHING OPENS. The host refuses tabs for
  // an unbound scope. Binding is IDEMPOTENT and re-issued on EVERY mutating
  // entry, not cached: a host restart while this renderer stays alive would
  // drop the manager's in-memory binding, and a once-resolved promise would
  // never notice. `bindNow` re-declares it for THIS session/project. It SIGNALS
  // STALE (throws) when the scope changed while it awaited — so the caller
  // aborts the action rather than acting on the wrong scope — and only writes
  // the partition when still current. Non-desktop is a no-op.
  const bindNow = useCallback(async (gen: number = scope.capture()) => {
    if (!bridge.bindProfile) return;
    const result = await bridge.bindProfile(scopeKey, projectId ?? "none");
    if (!scope.isCurrent(gen)) throw new StaleScopeError();
    partitionRef.current = result?.partition;
  }, [bridge, scope, scopeKey, projectId]);

  /** Read through a ref so the subscription below is not re-registered on every
   *  render of a parent that passes a fresh closure. */
  const endedRef = useRef(onEnded);
  useEffect(() => {
    endedRef.current = onEnded;
  });

  useEffect(() => {
    // A microtask, not a direct call: refresh sets state, and React's lint is
    // right that a synchronous set inside an effect can cascade renders.
    const first = window.setTimeout(() => void refresh(), 0);
    // The manager pushes on every change; the interval is the belt to that
    // suspender (a push lost during a renderer reload).
    const timer = window.setInterval(() => void refresh(), 2_000);
    const unsubscribe = bridge.onState((next) => {
      if (next.scopeKey !== scopeKey) return;
      setState(next);
      // THE LAST TAB CLOSED: this browser is over, and so is the tab holding
      // it. Only the push can say so — `refresh` above reads a state where
      // "no tabs" means "nothing opened yet" just as much as "all closed".
      if (next.ended) endedRef.current?.();
    });
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [bridge, refresh, scopeKey]);

  // Republish the stage whenever what the host shows changes shape: the
  // active tab, its viewport/mode, the rows above it, a loading strip, an
  // error strip. A size the observer already reports is harmless to resend.
  useDesktopBrowserViewport(
    bridge,
    scopeKey,
    hostRef,
    // The privacy bar is a ROW ABOVE THE STRIP, so it moves the native view
    // down; its two states are different heights, so both are in the key.
    [activeTab?.id, activeTab?.viewport?.width, activeTab?.viewport?.height, viewportMode, Boolean(actionError), Boolean(extensionError), Boolean(permissionDenial), Boolean(state?.privacy?.private), Boolean(state?.privacy?.stuck), activeTab?.sleeping].join("|"),
    viewportMode,
    overlayRef,
  );

  // BIND, THEN read the extension status — the status is per partition, so it
  // is meaningless before the bind lands, and reading first can show the button
  // as unavailable after a transient unbound failure. This effect owns the
  // scope generation: it bumps it, resets the known partition, binds, and only
  // then reads status; everything is cancelled on scope change.
  useEffect(() => {
    let cancelled = false;
    const gen = scope.capture();
    void bindNow(gen)
      .then(() => {
        if (cancelled || !scope.isCurrent(gen)) return undefined;
        // The binding landed for THIS scope: the start page may read now.
        setBound(true);
        if (!bridge.extensionStatus) return undefined;
        return bridge.extensionStatus(scopeKey);
      })
      .then((status) => { if (!cancelled && scope.isCurrent(gen) && status) setExtension(status); })
      .catch((error: unknown) => {
        if (cancelled || !scope.isCurrent(gen) || error instanceof StaleScopeError) return;
        setExtensionError(error instanceof Error ? error.message : "Could not load the password manager for this session.");
      });
    // The shell pushes per partition; keep only the status for this session's
    // own partition. While binding is still pending (partition unknown), a
    // PARTITIONED push is ignored rather than trusted — it could be another
    // project's host. A legacy push with no partition is always accepted.
    const unsubscribe = bridge.onExtension?.((next) => {
      if (cancelled) return;
      if (next.partition && next.partition !== partitionRef.current) return;
      setExtension(next);
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [bridge, bindNow, scope, scopeKey]);

  /**
   * One profile action, then a refresh. Every one of these changes what the
   * NEXT tab opens in and nothing about the tabs already open, so there is no
   * scope-guard subtlety beyond dropping a result for a session you left.
   */
  const profileAction = useCallback(
    async (run: () => Promise<unknown>) => {
      const gen = scope.capture();
      try {
        await run();
        if (!scope.isCurrent(gen)) return;
        setActionError(undefined);
        await refresh();
      } catch (error) {
        if (!scope.isCurrent(gen) || error instanceof StaleScopeError) return;
        setActionError(error instanceof Error ? error.message : "That browser profile change could not be applied.");
      }
    },
    [refresh, scope],
  );

  /**
   * THE QUESTIONS THIS SESSION IS WAITING ON. A push arrives the moment a page
   * asks; the read is the reconciler, and it is what makes three separate things
   * work with no extra machinery — a panel that remounted mid-prompt finds it,
   * a prompt the shell timed out after its minute disappears, and an answer that
   * raced a push cannot leave a dead question on screen.
   */
  const readPrompts = useCallback(async () => {
    if (!bridge.permissionPrompts) return;
    const gen = scope.capture();
    try {
      const answer = await bridge.permissionPrompts(scopeKey);
      if (scope.isCurrent(gen)) setPrompts(answer.prompts ?? []);
    } catch {
      // The shell mid-reload is not a reason to drop what is on screen.
    }
  }, [bridge, scope, scopeKey]);

  useEffect(() => {
    const unsubscribeRequest = bridge.onPermissionRequest?.((prompt) => {
      if (prompt.scopeKey && prompt.scopeKey !== scopeKey) return;
      setPrompts((current) => (current.some((open) => open.requestId === prompt.requestId) ? current : [...current, prompt]));
    });
    // macOS refused the device after the human allowed the site — the one
    // failure the page cannot explain, because all it ever sees is
    // NotAllowedError. It goes on the panel's own strip.
    const unsubscribeDenied = bridge.onPermissionDenied?.((denial) => setPermissionDenial(describePermissionDenial(denial)));
    const first = window.setTimeout(() => void readPrompts(), 0);
    const timer = window.setInterval(() => void readPrompts(), 2_000);
    return () => {
      unsubscribeRequest?.();
      unsubscribeDenied?.();
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [bridge, readPrompts, scopeKey]);

  /**
   * What this session's profile remembers about the page in front of the person.
   * Re-read when the page changes and after every write.
   *
   * THE READ ITSELF IS A MODULE FUNCTION (`readSitePermissionsFor`), not a
   * `useCallback`: it closes over `activeOrigin`, which is derived from `state`,
   * and the compiler's preserve-memoization rule refuses a manual memo over that
   * — the same reason `onKeys` below is a plain function. Freshness is guarded
   * by the effect's own cancel flag here and by the scope stamp at the call
   * sites, which is what the memo was doing anyway.
   */
  useEffect(() => {
    let cancelled = false;
    const task = window.setTimeout(() => {
      void readSitePermissionsFor(bridge, scopeKey, activeOrigin).then((records) => {
        if (!cancelled) setSitePermissions(records);
      });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(task);
    };
  }, [bridge, scopeKey, activeOrigin]);

  /**
   * ANSWER ONE QUESTION. The prompt leaves the screen on the press rather than
   * on the round trip — the shell ignores a second answer to the same request,
   * so nothing can be double-answered, and a prompt that lingered while IPC
   * settled would read as a button that did nothing.
   */
  // Plain functions, like `onKeys` below and for the same reason: both close
  // over `activeOrigin`, which is derived from `state`, and the compiler's
  // preserve-memoization rule will not accept a manual memo over that. The
  // compiler memoizes them itself.
  const answerPermission = async (requestId: string, answer: PermissionAnswer) => {
    if (!bridge.answerPermission) return;
    setPermissionBusy(true);
    setPrompts((current) => current.filter((prompt) => prompt.requestId !== requestId));
    try {
      await bridge.answerPermission({ requestId, ...answer });
    } catch {
      // The shell timed it out, or went away. Either way the question is over;
      // re-reading is what puts the truth back on screen.
    } finally {
      setPermissionBusy(false);
      void readPrompts();
      void readSitePermissionsFor(bridge, scopeKey, activeOrigin).then(setSitePermissions);
    }
  };

  /** Take an answer back — one kind, or (with none) everything this site holds. */
  const forgetPermission = async (kind?: SitePermissionKind) => {
    if (!bridge.forgetSitePermission || !activeOrigin) return;
    setPermissionBusy(true);
    try {
      await bridge.forgetSitePermission({ scopeKey, origin: activeOrigin, ...(kind ? { kind } : {}) });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "That site permission could not be forgotten.");
    } finally {
      setPermissionBusy(false);
      void readSitePermissionsFor(bridge, scopeKey, activeOrigin).then(setSitePermissions);
    }
  };

  const openPasswordManager = useCallback(async () => {
    if (!bridge.openExtensionPopup) return;
    const rect = keyButtonRef.current?.getBoundingClientRect();
    const gen = scope.capture();
    setExtensionError(undefined);
    try {
      // The popup opens for this session's tab, so its profile must be bound.
      await bindNow(gen);
      const status = await bridge.openExtensionPopup(scopeKey, rect ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height } : { x: 0, y: 0, width: 24, height: 24 });
      if (scope.isCurrent(gen)) setExtension(status);
    } catch (error) {
      // A scope change mid-flight is not an error to show — just drop it.
      if (!scope.isCurrent(gen) || error instanceof StaleScopeError) return;
      setExtensionError(error instanceof Error ? error.message : String(error));
    }
  }, [bridge, bindNow, scope, scopeKey]);

  const act = useCallback(
    async (action: Record<string, unknown>) => {
      const gen = scope.capture();
      try {
        // Re-declare the binding first (idempotent) so an action that opens a
        // tab cannot hit an unbound scope — including after a host restart, when
        // a cached bind would be stale. `bindNow(gen)` THROWS if the scope
        // changed while it awaited, cancelling the action before it runs.
        await bindNow(gen);
        const next = await bridge.action(scopeKey, action);
        // Drop a result that resolved after the user navigated away — applying
        // it would show another project's tabs and index against this scope.
        if (!scope.isCurrent(gen)) return;
        setActionError(undefined);
        setState(next);
      } catch (error) {
        // A scope change is not a failure to report — just abandon it.
        if (!scope.isCurrent(gen) || error instanceof StaleScopeError) return;
        // A genuine failure on the CURRENT scope: surface it (the silent
        // refresh alone hid real toolbar errors), and resync from the host.
        setActionError(error instanceof Error ? error.message : "That browser action could not be completed.");
        void refresh();
      }
    },
    [bridge, bindNow, refresh, scope, scopeKey],
  );

  /**
   * ⌥⌘I — Chromium DevTools on the tab you are LOOKING at (#423).
   *
   * BOUND ONLY WHILE THERE IS ONE, which is what makes "when no browser tab is
   * active it does nothing" true rather than merely quiet: an unclaimed command
   * falls through to the destination table, which has nothing to say about this
   * one. Same shape the panel uses for "fill the window" — a component owns a
   * command exactly while it can answer it.
   */
  useCommandHandlers(activeTab ? { "toggle-devtools": () => void act({ action: "toggle-devtools" }) } : {}, [Boolean(activeTab)]);

  /**
   * Browser keys, panel-local: Cmd/Ctrl+T new, Cmd/Ctrl+W close, Cmd/Ctrl+1-9
   * select, Ctrl+Tab cycle. Scoped to this container's focus — the app menu
   * owns some of these chords globally (command-keys.js) and wins when focus
   * is elsewhere, which is why the + button stays the reliable path.
   */
  // A plain function: the compiler memoizes it, and a manual useCallback
  // here trips its preserve-memoization rule once `state` feeds a hook above.
  const onKeys = (event: React.KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      const tabs = state?.tabs ?? [];
      if (event.ctrlKey && event.key === "Tab" && tabs.length > 1) {
        const current = tabs.findIndex((tab) => tab.active);
        const next = tabs[(current + (event.shiftKey ? tabs.length - 1 : 1)) % tabs.length]!;
        event.preventDefault();
        void act({ action: "select", index: next.index });
        return;
      }
      if (!meta) return;
      if (event.key === "t") {
        event.preventDefault();
        void act({ action: "new" });
      } else if (event.key === "w" && activeTab) {
        event.preventDefault();
        void act({ action: "close", index: activeTab.index });
      } else if (/^[1-9]$/.test(event.key)) {
        const target = tabs[Number(event.key) - 1];
        if (target) {
          event.preventDefault();
          void act({ action: "select", index: target.index });
        }
      }
  };

  return (
    <div className="flex h-full min-h-0 flex-col" onKeyDown={onKeys}>
      {/* THE CREDENTIAL BOUNDARY (#480), ABOVE EVERYTHING — the pause is on the
          whole browser, not on one tab, so it sits over the strip rather than
          inside it. Drawn in every panel because privacy is global: the
          sign-in holding this session's tools may be another session's page,
          and the bar names it. Without the bridge method (an older shell) the
          bar still says what is happening; it just offers no way out. */}
      {state?.privacy?.private ? (
        <BrowserPrivacyBanner privacy={state.privacy} {...(bridge.resumeFromPrivate ? { onResume: bridge.resumeFromPrivate } : {})} />
      ) : null}
      {/* ── tab strip ─────────────────────────────────────────────────── */}
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-2 py-1" role="tablist" aria-label="Browser tabs">
        {(state?.tabs ?? []).map((tab) => (
          <div
            key={tab.id}
            className="min-w-0"
            // THE PULL GESTURE: a tab drags into the composer as a reference
            // that names it as open in the session's browser — the words that
            // tell the agent to reach for its browser tools rather than fetch
            // the URL cold. Same drag `drag-reference.ts` gives every panel row.
            //
            // IT STAYS ON THIS WRAPPER, outside the menu's trigger, so a
            // right-click cannot start or be confused with a drag — the board
            // card's rule in `spool/idiom.test.ts`.
            draggable
            onDragStart={(event) => startReferenceDrag(event.dataTransfer, browserPageReference({ title: tab.title, url: tab.url }))}
            // Middle-click closes, the way every browser's strip does.
            onAuxClick={(event) => {
              if (event.button === 1) void act({ action: "close", index: tab.index });
            }}
          >
          <TabMenu
            tab={tab}
            tabs={state?.tabs ?? []}
            onAct={act}
            {...(bridge.openExternal ? { onOpenExternal: bridge.openExternal } : {})}
            className={cn(
              "flex min-w-0 max-w-44 cursor-grab items-center gap-1 rounded-md px-2 py-1 active:cursor-grabbing",
              tab.active ? "bg-muted" : "hover:bg-muted/50",
              // A tab the agent is acting on right now wears a faint ring...
              tab.controller === "agent" && "ring-1 ring-primary/40",
              // ...and the tab it is WORKING IN keeps a fainter one between
              // actions, so a background agent is visible while you read
              // something else rather than only flickering as it clicks.
              tab.agentFocus && tab.controller !== "agent" && "ring-1 ring-primary/20",
            )}
          >
            {/* Loading takes the favicon's slot, the way every browser strip
                does it — one glyph, no second indicator to reconcile. */}
            {tab.loading ? (
              <Loader2Icon aria-label="Loading" className="size-3 shrink-0 animate-spin text-muted-foreground" />
            ) : tab.sleeping ? (
              // Remembered but not loaded yet (restored after a restart, or
              // put to sleep by the live-view budget): selecting it loads it.
              <span title="Remembered — loads when selected" className="flex shrink-0">
                <MoonIcon aria-label="Not loaded yet" className="size-3 text-muted-foreground/70" />
              </span>
            ) : tab.favicon ? (
              // eslint-disable-next-line @next/next/no-img-element -- page-supplied favicon URL; nothing for next/image here
              <img src={tab.favicon} alt="" aria-hidden className="size-3 shrink-0 rounded-[2px]" />
            ) : null}
            {/* A PAGE IN A BACKGROUND TAB IS ASKING FOR SOMETHING (#422). The
                prompt is drawn over ITS tab's address bar, which you are not
                looking at — so the strip says where the question is, the same
                way it says where the agent is working. The shell's own minute
                runs whether or not anyone comes to look. */}
            {prompts.some((prompt) => prompt.tabId === tab.id) && !tab.active ? (
              <span
                title={`This page is asking to use your ${describePermissionKinds(prompts.find((prompt) => prompt.tabId === tab.id)!.kinds)}`}
                className="flex shrink-0"
              >
                <span aria-label="Waiting for a permission answer" role="img" className="block size-1.5 rounded-full bg-primary" />
              </span>
            ) : null}
            {/* DevTools are open on this tab, in their own window (#423). The
                strip is where a stray DevTools window is traced back to the
                page it belongs to — and it is per tab, so two open at once
                are two marks. */}
            {tab.devtools ? (
              <span title="Developer Tools are open on this tab" className="flex shrink-0">
                <CodeXmlIcon aria-label="Developer Tools open" className="size-3 text-primary" />
              </span>
            ) : null}
            {/* A tab from ANOTHER identity, kept where it was when the session
                switched profiles. Said plainly rather than left to look like
                the current one. */}
            {state?.profile && tab.profileId && tab.profileId !== state.profile.id ? (
              <span
                title={`Signed in as ${state.profiles?.find((profile) => profile.id === tab.profileId)?.label ?? "another profile"} — the profile this tab was opened in`}
                className="flex shrink-0"
              >
                <UserRoundIcon aria-label="Another browser profile" className="size-3 text-warning" />
              </span>
            ) : null}
            <span
              aria-label={tab.openedBy === "human" ? "Opened by you" : "Opened by the agent"}
              title={`${tab.openedBy === "human" ? "Opened by you" : "Opened by the agent"}${tab.controller === "agent" ? " · agent acting" : tab.agentFocus ? " · the agent is working here" : ""}`}
              className={cn("size-1.5 shrink-0 rounded-full", tab.openedBy === "human" ? "bg-warning" : "bg-primary/70")}
            />
            <button
              type="button"
              role="tab"
              aria-selected={tab.active}
              className="min-w-0 flex-1 truncate text-left text-xs"
              title={`${tab.url}\nDrag into the message to reference this page`}
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
          </TabMenu>
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

      {/* ── address row ───────────────────────────────────────────────────
          THE ADDRESS IS WHAT THIS ROW IS FOR. Everything else on it gives up
          its label before the input gives up its width (`compactRow`), because
          a 30px address bar is a control you cannot use at all where an
          unlabelled glyph is one you can still read by its tooltip. */}
      <form
        ref={addressRowRef}
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
        {/* No stop button: the host exposes no stop action, and a control
            that does nothing is worse than none. The glyph spins instead. */}
        <button type="button" aria-label="Reload" className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => void act({ action: "reload" })}>
          <RotateCwIcon className={cn("size-3.5", activeTab?.loading && "animate-spin text-primary")} />
        </button>
        {/* ── the lock, and everything behind it ────────────────────────────
            WHERE A BROWSER PUTS IT: at the head of the address, because it is
            about the page the address names. It is the anchor for BOTH the
            permission prompt (a question the page just asked) and the list of
            what this site already holds — the same icon in Chrome, and for the
            same reason: the place you are asked is the place you go back to.

            ABSENT ON A PAGE THAT CAN HOLD NOTHING (a blank tab, a local file),
            rather than present and empty. The prompt still shows if one somehow
            arrives — a question with nowhere to be answered is worse. */}
        {(activeOrigin || activePrompt) && bridge.sitePermissions ? (
          <Popover
            open={openOverlay === "site" || Boolean(activePrompt)}
            onOpenChange={(open) => {
              if (open) {
                // Re-opening from the lock is how a waved-away question comes
                // back — the shell is still waiting on it.
                setDismissedPrompts([]);
                setOpenOverlay("site");
                return;
              }
              // Esc or a click outside: put the page back, keep the question.
              if (activePrompt) setDismissedPrompts((current) => [...current, activePrompt.requestId]);
              closeOverlay();
            }}
          >
            <PopoverTrigger
              render={
                <button
                  type="button"
                  aria-label={
                    activePrompt
                      ? `${siteLabel(activePrompt.origin)} is asking for permission`
                      : activeOrigin
                        ? `Site permissions for ${siteLabel(activeOrigin)}`
                        : "Site permissions"
                  }
                  title={activePrompt ? "This page is asking for permission" : "What this site is allowed to do"}
                  // `p-0.5`, NOT the `p-1` its neighbours wear, and that is the
                  // address row's budget talking: at the panel width #319 was
                  // filed about (420px) the row clears the input floor by
                  // exactly nothing, so the lock is the tightest icon button
                  // this toolbar has. See ADDRESS_CONTROLS_COMPACT.
                  className={cn(
                    "relative shrink-0 rounded-md p-0.5 hover:bg-muted",
                    tabPrompt ? "text-primary" : sitePermissions.some((record) => record.decision === "allow") ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                />
              }
            >
              <SiteSecurityIcon origin={activeOrigin} />
              {/* A question waved away is still a question. The mark is what
                  says the lock is worth clicking again. */}
              {tabPrompt && !activePrompt ? <span aria-hidden className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-primary" /> : null}
            </PopoverTrigger>
            <PopoverContent align="start" side="bottom" sideOffset={6} aria-label={activePrompt ? "Site permission request" : "Site permissions"} className="w-72">
              {activePrompt ? (
                <SitePermissionPrompt
                  prompt={activePrompt}
                  busy={permissionBusy}
                  onAnswer={(answer) => void answerPermission(activePrompt.requestId, answer)}
                />
              ) : (
                <SitePermissionsPopover
                  origin={activeOrigin}
                  records={sitePermissions}
                  busy={permissionBusy}
                  onForget={(kind) => void forgetPermission(kind)}
                  onReset={() => void forgetPermission()}
                />
              )}
            </PopoverContent>
          </Popover>
        ) : null}
        <input
          aria-label="Address"
          placeholder="Type an address"
          spellCheck={false}
          className="h-6 min-w-0 flex-1 rounded-md border border-transparent bg-muted/60 px-2 font-mono text-2xs outline-none focus:border-ring"
          // Uncontrolled-until-touched: the URL keeps updating under an
          // untouched field, and a draft survives navigation until submitted.
          value={draft ?? addressValue(activeTab?.url)}
          onChange={(event) => {
            setDraft(event.target.value);
            signalIntent();
          }}
          onBlur={() => setDraft(undefined)}
        />
        {/* THE VIEWPORT (item 11). The page lays out for its OWN size — the
            standard 1280×800, a preset, or a size typed here — whatever the
            column's width; the panel scales the presentation to fit. The
            agent sees the same page (its snapshot and clicks are in this
            size) and can change it too, through browser_resize. */}
        {activeTab?.viewport ? (
          <Popover open={openOverlay === "viewport"} onOpenChange={(open) => (open ? setOpenOverlay("viewport") : closeOverlay())}>
            <PopoverTrigger
              render={
                <button
                  type="button"
                  aria-label={`Viewport: ${describeViewport(activeTab.viewport, viewportMode)}`}
                  title={`Viewport ${describeViewport(activeTab.viewport, viewportMode)}${state?.presentation && state.presentation.scale < 1 ? ` · shown at ${Math.round(state.presentation.scale * 100)}%` : ""}`}
                  className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-3xs text-muted-foreground hover:bg-muted hover:text-foreground data-popup-open:bg-muted data-popup-open:text-foreground"
                >
                  <ScalingIcon className="size-3.5 shrink-0" />
                  {/* The size is in the label and in the title; on a narrow row
                      only the title has room for it. */}
                  {!compactRow && <span>{viewportMode === "fit" ? "Fit panel" : `${activeTab.viewport.width}×${activeTab.viewport.height}`}</span>}
                  {!compactRow && viewportMode === "fixed" && state?.presentation && state.presentation.scale < 1 ? <span className="text-muted-foreground/70">{Math.round(state.presentation.scale * 100)}%</span> : null}
                </button>
              }
            />
            <PopoverContent align="end" side="bottom" sideOffset={6} aria-label="Viewport size" className="w-60 gap-0 p-1">
              {/* FIT PANEL: the page's size follows the panel (scale 1, no
                  letterbox) while it is shown, and keeps the last shown size
                  while hidden so an agent working in the background sees the
                  layout the human last did. Fixed keeps the size where it is. */}
              <button
                type="button"
                aria-pressed={viewportMode === "fit"}
                title="Follow the panel's size"
                onClick={() => void act({ action: "resize", index: activeTab.index, mode: viewportMode === "fit" ? "fixed" : "fit" })}
                className={cn(menuRow, viewportMode === "fit" && "text-foreground")}
              >
                <CheckIcon className={cn("size-3.5 shrink-0", viewportMode === "fit" ? "opacity-100" : "opacity-0")} />
                <span className="min-w-0 flex-1">Fit panel</span>
              </button>
              <div aria-hidden className="my-1 h-px bg-border" />
              {VIEWPORT_PRESETS.map((preset) => {
                const on = viewportMode === "fixed" && activeTab.viewport?.preset === preset.key;
                return (
                  <button
                    key={preset.key}
                    type="button"
                    aria-pressed={on}
                    onClick={() => void act({ action: "resize", index: activeTab.index, preset: preset.key })}
                    className={cn(menuRow, on && "text-foreground")}
                  >
                    <CheckIcon className={cn("size-3.5 shrink-0", on ? "opacity-100" : "opacity-0")} />
                    <span className="min-w-0 flex-1">{preset.label}</span>
                    <span className="shrink-0 font-mono text-3xs text-muted-foreground">{preset.width}×{preset.height}</span>
                  </button>
                );
              })}
              <div aria-hidden className="my-1 h-px bg-border" />
              <form
                className="flex items-center gap-1 px-1 pb-0.5"
                onSubmit={(event) => {
                  event.preventDefault();
                  const parsed = parseViewportInput(customSize);
                  if (!parsed) return;
                  setCustomSize("");
                  void act({ action: "resize", index: activeTab.index, width: parsed.width, height: parsed.height });
                }}
              >
                <input
                  aria-label="Custom viewport size"
                  placeholder="e.g. 1024×768"
                  value={customSize}
                  onChange={(event) => setCustomSize(event.target.value)}
                  // A portal's events still bubble through the REACT tree, so
                  // the panel's browser chords would read what is typed here.
                  onKeyDown={(event) => event.stopPropagation()}
                  className="h-6 min-w-0 flex-1 rounded-md border border-border bg-background px-2 font-mono text-2xs outline-none focus:border-ring"
                />
                <Button type="submit" size="sm" variant="outline" className="h-6 shrink-0 px-2 text-2xs" disabled={!parseViewportInput(customSize)}>
                  Set
                </Button>
              </form>
            </PopoverContent>
          </Popover>
        ) : null}
        {/* WHICH IDENTITY THIS SESSION BROWSES AS. Always visible when the
            shell knows: a person with several accounts should never have to
            guess which one a page was loaded with. */}
        {state?.profile && bridge.setScopeProfile ? (
          <Popover open={openOverlay === "profile"} onOpenChange={(open) => (open ? setOpenOverlay("profile") : closeOverlay())}>
            <PopoverTrigger
              render={
                <button
                  type="button"
                  aria-label={`Browser profile: ${state.profile.label}${state.profile.account ? ` (${state.profile.account})` : ""}`}
                  title={`Browser profile ${state.profile.label}${state.profile.account ? ` · expected account ${state.profile.account}` : ""}\nNew tabs open signed in as this profile.`}
                  className="flex shrink-0 items-center justify-center rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground data-popup-open:bg-muted data-popup-open:text-foreground"
                >
                  {/* THE MARK, NOT THE NAME (#366). The name was the widest
                      thing in this row and the first to be truncated, so it
                      told you least exactly when the row was tightest. A glyph
                      in the profile's own colour is the same width always, and
                      the name is one hover away — it stays in `aria-label` and
                      `title`, which is where it was already doing the work on a
                      compact row. */}
                  <IdentityIcon icon={state.profile.icon} color={state.profile.color} className="size-3.5 shrink-0" />
                </button>
              }
            />
            {/* THE PROFILE MENU, on the 1Password mini menu's shape: who this
                session browses as at the top, every identity under it with the
                current one checked, then what can be done about it.

                SWITCHING CHANGES WHERE THE NEXT TAB OPENS. Tabs already open
                keep the identity they were signed into — Chromium cannot move
                a live page between cookie jars, and doing it silently would
                put the agent on the wrong account — so the menu says so. */}
            <PopoverContent align="end" side="bottom" sideOffset={6} aria-label="Browser profile" className="w-64 gap-0 p-1">
              {profilePane === "menu" ? (
                <>
                  <div className="flex items-start gap-2 px-2 pt-1 pb-1.5">
                    {/* The glyph the toolbar shows, next to the name it stands
                        for — this header is where the two are taught to a
                        reader who has only seen one of them. */}
                    <IdentityIcon icon={state.profile.icon} color={state.profile.color} className="mt-0.5 size-3.5 shrink-0" />
                    <div className="min-w-0">
                      <p className="truncate text-[0.75rem] font-medium">{state.profile.label}</p>
                      <p className="truncate font-mono text-3xs text-muted-foreground">
                        {state.profile.account || "No expected account"}
                      </p>
                    </div>
                  </div>
                  <div aria-hidden className="my-1 h-px bg-border" />
                  {(state.profiles ?? []).map((profile) => {
                    const current = profile.id === state.profile?.id;
                    return (
                      <button
                        key={profile.id}
                        type="button"
                        aria-pressed={current}
                        title={[
                          profile.account ? `Expected account ${profile.account}` : "No expected account set",
                          profile.projects?.length ? `Used by ${profile.projects.length} project${profile.projects.length === 1 ? "" : "s"}` : "Not assigned to a project",
                          profile.isDefault ? "The default for new projects" : "",
                        ].filter(Boolean).join("\n")}
                        onClick={() => {
                          closeOverlay();
                          void profileAction(() => bridge.setScopeProfile!(scopeKey, profile.id));
                        }}
                        className={cn(menuRow, current && "text-foreground")}
                      >
                        <CheckIcon className={cn("size-3.5 shrink-0", current ? "opacity-100" : "opacity-0")} />
                        {/* THE LIST KEEPS NAMES. The toolbar shows a glyph
                            because it has one glyph's worth of room; this menu
                            is where you choose, and choosing between marks you
                            set weeks ago is choosing between names. The glyph
                            rides along so the toolbar's is recognisable here. */}
                        <IdentityIcon icon={profile.icon} color={profile.color} className="size-3.5 shrink-0" />
                        <span className="min-w-0 flex-1 truncate">{profile.label}</span>
                        {profile.isDefault && <span className="shrink-0 text-3xs text-muted-foreground">default</span>}
                      </button>
                    );
                  })}
                  <div aria-hidden className="my-1 h-px bg-border" />
                  {bridge.assignProjectProfile && state.profileKey && state.profileKey !== "none" && (
                    <button
                      type="button"
                      title="Every session of this project opens in this profile from now on."
                      onClick={() => {
                        closeOverlay();
                        void profileAction(() => bridge.assignProjectProfile!({ scopeKey, profileId: state.profile!.id }));
                      }}
                      className={cn(menuRow, "pl-9")}
                    >
                      Use for this project
                    </button>
                  )}
                  {bridge.setDefaultProfile && !state.profile.isDefault && (
                    <button
                      type="button"
                      title="New projects with no browsing history of their own join this profile. Projects already signed in somewhere are not moved."
                      onClick={() => {
                        closeOverlay();
                        void profileAction(() => bridge.setDefaultProfile!(state.profile!.id));
                      }}
                      className={cn(menuRow, "pl-9")}
                    >
                      Make default
                    </button>
                  )}
                  {bridge.offerLoginMemory && (
                    <button
                      type="button"
                      title={"Already signed in on this page? Let agents reuse that login here.\nOpens Telar's own window; you pick the 1Password item there."}
                      onClick={() => {
                        closeOverlay();
                        void profileAction(async () => {
                          const result = await bridge.offerLoginMemory!(scopeKey);
                          // The shell's refusal ("open an http(s) page first") is
                          // the panel's error, same as any profile action's.
                          if (!result.ok && result.error) throw new Error(result.error);
                        });
                      }}
                      className={cn(menuRow, "pl-9")}
                    >
                      Let agents use a login…
                    </button>
                  )}
                  {bridge.updateProfile && (
                    <button type="button" onClick={() => setProfilePane("rename")} className={cn(menuRow, "pl-9")}>
                      Rename…
                    </button>
                  )}
                  {bridge.createProfile && (
                    <button type="button" onClick={() => setProfilePane("new")} className={cn(menuRow, "pl-9")}>
                      New profile…
                    </button>
                  )}
                  <p className="px-2 pt-1.5 pb-1 text-3xs leading-snug text-muted-foreground">
                    Switching changes where the next tab opens. Tabs already open stay signed in as the profile they were opened with — an
                    expected account is what you intend, not a verified login.
                  </p>
                </>
              ) : profilePane === "rename" ? (
                <form
                  className="flex flex-col gap-1.5 p-1.5"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const label = new FormData(event.currentTarget).get("label");
                    if (typeof label !== "string" || !label.trim()) return;
                    closeOverlay();
                    void profileAction(() => bridge.updateProfile!({ profileId: state.profile!.id, label }));
                  }}
                >
                  <label htmlFor="telar-browser-profile-rename" className="text-2xs text-muted-foreground">Rename this profile</label>
                  <input
                    id="telar-browser-profile-rename"
                    key={state.profile.id}
                    name="label"
                    autoFocus
                    defaultValue={state.profile.label}
                    onKeyDown={(event) => event.stopPropagation()}
                    className="h-7 rounded-md border border-border bg-background px-2 text-[0.75rem] outline-none focus:border-ring"
                  />
                  <div className="flex justify-end gap-1">
                    <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-2xs" onClick={() => setProfilePane("menu")}>
                      Cancel
                    </Button>
                    <Button type="submit" size="sm" variant="outline" className="h-6 px-2 text-2xs">
                      Rename
                    </Button>
                  </div>
                </form>
              ) : (
                <form
                  className="flex flex-col gap-1.5 p-1.5"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!newProfileLabel.trim()) return;
                    const label = newProfileLabel;
                    const account = newProfileAccount.trim();
                    setNewProfileLabel("");
                    setNewProfileAccount("");
                    closeOverlay();
                    void profileAction(() => bridge.createProfile!({ label, ...(account ? { account } : {}), scopeKey }));
                  }}
                >
                  <label htmlFor="telar-browser-profile-new" className="text-2xs text-muted-foreground">New profile</label>
                  <input
                    id="telar-browser-profile-new"
                    aria-label="New profile name"
                    placeholder="Name"
                    autoFocus
                    value={newProfileLabel}
                    onChange={(event) => setNewProfileLabel(event.target.value)}
                    onKeyDown={(event) => event.stopPropagation()}
                    className="h-7 rounded-md border border-border bg-background px-2 text-[0.75rem] outline-none focus:border-ring"
                  />
                  <input
                    aria-label="Expected account for the new profile"
                    placeholder="account (optional)"
                    value={newProfileAccount}
                    onChange={(event) => setNewProfileAccount(event.target.value)}
                    onKeyDown={(event) => event.stopPropagation()}
                    className="h-7 rounded-md border border-border bg-background px-2 font-mono text-2xs outline-none focus:border-ring"
                  />
                  <div className="flex justify-end gap-1">
                    <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-2xs" onClick={() => setProfilePane("menu")}>
                      Cancel
                    </Button>
                    <Button type="submit" size="sm" variant="outline" disabled={!newProfileLabel.trim()} className="h-6 px-2 text-2xs">
                      Add and use
                    </Button>
                  </div>
                </form>
              )}
            </PopoverContent>
          </Popover>
        ) : null}
        {/* Opening the extension does not take control of the browser. */}
        {extension && extension.phase !== "unavailable" ? (
          <button
            ref={keyButtonRef}
            type="button"
            // THE HEALTH SENTENCE IS THE TOOLTIP AND THE ACCESSIBLE NAME, in
            // every phase — it used to be written inline beside the glyph, and
            // at the panel's default width those ~190px were most of what the
            // address input had left (#319). The mark below says something is
            // wrong; the words say what, on hover and to a screen reader.
            aria-label={extension.phase === "ready" ? `Open ${extension.name ?? "password manager"} — ${describeExtensionHealth(extension).text}` : `${extension.name ?? "Password manager"}: ${describeExtensionHealth(extension).text}`}
            title={`${extension.name ?? "Password manager"}: ${describeExtensionHealth(extension).text}`}
            // Privacy pauses AGENTS, never the human's own credential tools:
            // the button stays live while private so a login can be chosen
            // and the popup closed and reopened. Disabled only while the
            // extension itself is not usable.
            disabled={extension.phase !== "ready"}
            onClick={() => void openPasswordManager()}
            className={cn(
              "flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-3xs font-medium",
              describeExtensionHealth(extension).tone === "error" ? "text-destructive hover:bg-muted" : extension.phase === "ready" ? "text-muted-foreground hover:bg-muted hover:text-foreground" : "text-muted-foreground/60",
            )}
          >
            {/* The official 1Password icon (read from the verified extension
                by the shell) once ready; the spinner while it loads; the key
                glyph as the last-resort fallback. */}
            {extension.phase === "installing" || extension.phase === "loading" ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : extension.phase === "ready" && extension.icon ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={extension.icon} alt="" width={14} height={14} className="size-3.5" />
            ) : (
              <KeyRoundIcon className="size-3.5" />
            )}
            {/* A genuine failure is MARKED, and the mark carries the sentence
                in its tooltip. Written out inline it was a paragraph in a
                toolbar, and it took the address bar's width to say it. */}
            {describeExtensionHealth(extension).tone === "error" ? <TriangleAlertIcon aria-hidden className="size-3 shrink-0 text-destructive" /> : null}
          </button>
        ) : null}
      </form>
      {/* A GENUINE BROWSER-ACTION FAILURE on this scope, surfaced rather than
          swallowed by the silent refresh (which hid real toolbar errors).
          Dismissible; it also clears on the next successful action. */}
      {actionError && (
        <div role="alert" className="flex shrink-0 items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 text-2xs text-destructive">
          <span className="min-w-0 flex-1 truncate">{actionError}</span>
          <button type="button" onClick={() => setActionError(undefined)} className="shrink-0 rounded px-1.5 py-0.5 hover:bg-destructive/20" aria-label="Dismiss">
            Dismiss
          </button>
        </div>
      )}
      {extensionError && (
        <div role="alert" className="flex shrink-0 items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 text-2xs text-destructive">
          <span className="min-w-0 flex-1 truncate">{extensionError}</span>
          <button type="button" onClick={() => setExtensionError(undefined)} className="shrink-0 rounded px-1.5 py-0.5 hover:bg-destructive/20">Dismiss</button>
        </div>
      )}
      {/* macOS REFUSED THE DEVICE AFTER THE PERSON ALLOWED THE SITE — the one
          failure the page cannot explain, because all it ever gets is
          NotAllowedError. A warning rather than an error: nothing here is
          broken, and the sentence names the pane that fixes it. */}
      {permissionDenial && (
        <div role="alert" className="flex shrink-0 items-start gap-2 border-b border-warning/40 bg-warning/10 px-3 py-1.5 text-2xs text-foreground">
          <TriangleAlertIcon aria-hidden className="mt-0.5 size-3 shrink-0 text-warning" />
          <span className="min-w-0 flex-1">{permissionDenial}</span>
          <button type="button" onClick={() => setPermissionDenial(undefined)} className="shrink-0 rounded px-1.5 py-0.5 hover:bg-warning/20">Dismiss</button>
        </div>
      )}

      {/* ── the native viewport is glued to this element's rect ─────────
          INSET, NOT CLIPPED. The WebContentsView ignores CSS radius, so the
          host sits 8px inside the panel card: a 14px corner overhangs a
          square by ~4px, and the inset clears it. The native pixels stay
          square; the card around them is what is rounded. */}
      <div ref={hostRef} className="relative min-h-0 flex-1 bg-muted/20 md:mx-2 md:mb-2 md:overflow-hidden md:rounded-lg" aria-label="Live browser viewport" aria-busy={activeTab?.loading || undefined}>
        {/* THE DEVICE FRAME: where the (scaled) page actually sits inside
            this host. The shell reports the native rect in window
            coordinates; drawn here relative to the host so a phone-sized
            page in a wide panel reads as a phone, not as a page with odd
            margins. Pointer-transparent — the native view is on top. */}
        {viewportMode === "fixed" && activeTab?.viewport && addressValue(activeTab.url) !== "" && !activeTab.sleeping && hostSize ? (
          <DeviceFrame
            viewport={activeTab.viewport}
            mode={viewportMode}
            hostSize={hostSize}
            preview={dragPreview}
            onPreview={setDragPreview}
            onCommit={(size) => void act({ action: "resize", index: activeTab.index, width: size.width, height: size.height })}
            railsKey={`${scopeKey}:${activeTab.id}`}
          />
        ) : null}
        {/* A hairline progress band at the top of the viewport while a page
            loads — what the native view does not draw for itself. */}
        {activeTab?.loading && <div aria-hidden className="absolute inset-x-0 top-0 z-10 h-0.5 animate-pulse bg-primary/70" />}
        {activeTab?.sleeping && (
          <div className="flex h-full items-center justify-center p-6 text-center text-xs text-muted-foreground">
            <MoonIcon className="mr-1.5 size-3.5" /> Remembered page — loading…
          </div>
        )}
        {/* THE START PAGE — no tabs, or a blank active tab. DOM, under
            nothing: the shell hides the native view of a blank tab so this
            can be read and clicked (browser-manager isBlank). Opening a
            site navigates the blank tab in place; with no tab at all it
            opens one. */}
        {bound && state && ((state.tabs.length === 0) || (activeTab && !activeTab.sleeping && addressValue(activeTab.url) === "" && !activeTab.loading)) && (
          <BrowserStartPage
            scopeKey={scopeKey}
            onOpen={(url) => void act(activeTab && addressValue(activeTab.url) === "" ? { action: "navigate", url } : { action: "new", url })}
          />
        )}
      </div>
    </div>
  );
}
