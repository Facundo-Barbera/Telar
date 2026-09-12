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
import { ArrowLeftIcon, ArrowRightIcon, CheckIcon, KeyRoundIcon, Loader2Icon, MoonIcon, PlusIcon, RotateCwIcon, ScalingIcon, UserRoundIcon, XIcon } from "lucide-react";
import { BrowserStartPage } from "@/components/browser-start-page";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { describeViewport, fitViewport, parseViewportInput, resizeByDrag, resizeByKey, stageOf, VIEWPORT_PRESETS, VIEWPORT_RAIL, type ResizeDirection, type ViewportMode, type ViewportPresetKey } from "@/lib/browser-viewport";
import { browserPageReference, startReferenceDrag } from "@/lib/drag-reference";
import { onNativeViewOverlay, useNativeViewOverlay } from "@/lib/native-view-overlay";
import { makeScopeGuard } from "@/lib/scope-guard";
import { hostFromPathname, LOCAL_HOST_ID } from "@/lib/hosts/client";
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
  isDefault?: boolean;
  /** The project keys assigned to this profile — how sharing is made visible. */
  projects?: string[];
};

/** The credential boundary, as the shell reports it (private-interaction.js). */
export type DesktopPrivacyState = { private: boolean; epoch: number; reason?: string; since?: number; scopeKey?: string | null; refused?: string; stuck?: boolean };

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
  updateProfile?(input: { profileId: string; label?: string; account?: string }): Promise<{ profiles: DesktopBrowserProfile[] }>;
  setDefaultProfile?(profileId: string): Promise<{ profiles: DesktopBrowserProfile[] }>;
  assignProjectProfile?(input: { scopeKey: string; profileId: string | null }): Promise<{ profiles: DesktopBrowserProfile[] }>;
  setScopeProfile?(scopeKey: string, profileId: string): Promise<{ profileId: string; partition: string }>;
  extensionStatus?(scopeKey: string): Promise<DesktopExtensionStatus>;
  openExtensionPopup?(scopeKey: string, anchorRect: { x: number; y: number; width: number; height: number }): Promise<DesktopExtensionStatus>;
  resumeFromPrivate?(): Promise<DesktopPrivacyState>;
  /** The EXPLICIT login-offer fallback (AUTH-001): open the shell's trusted
   *  offer window about this session's current page — for a sign-in Telar
   *  never saw, or an automatic offer that was dismissed. Opening only asks;
   *  the answer happens inside the shell's own window, never here. */
  offerLoginMemory?(scopeKey: string): Promise<{ ok: boolean; error?: string }>;
  onExtension?(listener: (status: DesktopExtensionStatus) => void): () => void;
};

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
        <span aria-live="polite" className="pointer-events-none absolute z-30 rounded-md bg-foreground px-1.5 py-0.5 font-mono text-[0.625rem] text-background" style={{ left: previewFit.x + 6, top: previewFit.y + 6 }}>
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

/** Thrown by `bindNow` when the session scope changed while it awaited, so the
 *  caller aborts the (now stale) action instead of running it. */
class StaleScopeError extends Error {}

export function DesktopBrowserSurface({ bridge, sessionId, projectId }: { bridge: DesktopBrowserBridge; sessionId: string; projectId?: string }) {
  const [state, setState] = useState<DesktopBrowserPanelState>();
  const [draft, setDraft] = useState<string>();
  const [extension, setExtension] = useState<DesktopExtensionStatus>();
  const [extensionError, setExtensionError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const hostRef = useRef<HTMLDivElement>(null);
  const keyButtonRef = useRef<HTMLButtonElement>(null);

  /**
   * SCOPE GENERATION — this component is REUSED across sessions (Next reuses
   * the instance when only the `sessionId` prop changes), so an async result
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
  const [openOverlay, setOpenOverlay] = useState<"profile" | "viewport" | null>(null);
  useNativeViewOverlay(openOverlay !== null);
  /** Which pane the profile menu shows: its list, or one of its two forms. */
  const [profilePane, setProfilePane] = useState<"menu" | "rename" | "new">("menu");
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
  }, [scope, sessionId, projectId]);

  // Typing an address is the human's hands on the tab BEFORE submit; the
  // agent should already be deferring. One signal per burst is enough.
  const intentAt = useRef(0);
  const signalIntent = useCallback(() => {
    const now = Date.now();
    if (now - intentAt.current < 500) return;
    intentAt.current = now;
    // Intent is only a deferral signal; it opens no tab, so it needs no bind.
    const gen = scope.capture();
    void bridge.action(sessionId, { action: "intent" }).then((next) => { if (scope.isCurrent(gen)) setState(next); }, () => undefined);
  }, [bridge, scope, sessionId]);
  const activeTab = state?.tabs.find((tab) => tab.active);
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
        void bridge.setVisible(sessionId, !hidden).catch(() => undefined);
      }),
    [bridge, sessionId],
  );

  const refresh = useCallback(async () => {
    const gen = scope.capture();
    try {
      const next = await bridge.getState(sessionId);
      // Drop a read that resolved after the user navigated to another session.
      if (scope.isCurrent(gen)) setState(next);
    } catch {
      // The shell mid-reload must not take the panel down with it.
    }
  }, [bridge, scope, sessionId]);

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
    const result = await bridge.bindProfile(sessionId, projectId ?? "none");
    if (!scope.isCurrent(gen)) throw new StaleScopeError();
    partitionRef.current = result?.partition;
  }, [bridge, scope, sessionId, projectId]);

  useEffect(() => {
    // A microtask, not a direct call: refresh sets state, and React's lint is
    // right that a synchronous set inside an effect can cascade renders.
    const first = window.setTimeout(() => void refresh(), 0);
    // The manager pushes on every change; the interval is the belt to that
    // suspender (a push lost during a renderer reload).
    const timer = window.setInterval(() => void refresh(), 2_000);
    const unsubscribe = bridge.onState((next) => {
      if (next.scopeKey === sessionId) setState(next);
    });
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [bridge, refresh, sessionId]);

  // Republish the stage whenever what the host shows changes shape: the
  // active tab, its viewport/mode, the rows above it, a loading strip, an
  // error strip. A size the observer already reports is harmless to resend.
  useDesktopBrowserViewport(
    bridge,
    sessionId,
    hostRef,
    [activeTab?.id, activeTab?.viewport?.width, activeTab?.viewport?.height, viewportMode, Boolean(actionError), Boolean(extensionError), activeTab?.sleeping].join("|"),
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
        return bridge.extensionStatus(sessionId);
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
  }, [bridge, bindNow, scope, sessionId]);

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

  const openPasswordManager = useCallback(async () => {
    if (!bridge.openExtensionPopup) return;
    const rect = keyButtonRef.current?.getBoundingClientRect();
    const gen = scope.capture();
    setExtensionError(undefined);
    try {
      // The popup opens for this session's tab, so its profile must be bound.
      await bindNow(gen);
      const status = await bridge.openExtensionPopup(sessionId, rect ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height } : { x: 0, y: 0, width: 24, height: 24 });
      if (scope.isCurrent(gen)) setExtension(status);
    } catch (error) {
      // A scope change mid-flight is not an error to show — just drop it.
      if (!scope.isCurrent(gen) || error instanceof StaleScopeError) return;
      setExtensionError(error instanceof Error ? error.message : String(error));
    }
  }, [bridge, bindNow, scope, sessionId]);

  const act = useCallback(
    async (action: Record<string, unknown>) => {
      const gen = scope.capture();
      try {
        // Re-declare the binding first (idempotent) so an action that opens a
        // tab cannot hit an unbound scope — including after a host restart, when
        // a cached bind would be stale. `bindNow(gen)` THROWS if the scope
        // changed while it awaited, cancelling the action before it runs.
        await bindNow(gen);
        const next = await bridge.action(sessionId, action);
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
    [bridge, bindNow, refresh, scope, sessionId],
  );

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
      {/* ── tab strip ─────────────────────────────────────────────────── */}
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-2 py-1" role="tablist" aria-label="Browser tabs">
        {(state?.tabs ?? []).map((tab) => (
          <div
            key={tab.id}
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
            // THE PULL GESTURE: a tab drags into the composer as a reference
            // that names it as open in the session's browser — the words that
            // tell the agent to reach for its browser tools rather than fetch
            // the URL cold. Same drag `drag-reference.ts` gives every panel row.
            draggable
            onDragStart={(event) => startReferenceDrag(event.dataTransfer, browserPageReference({ title: tab.title, url: tab.url }))}
            // Middle-click closes, the way every browser's strip does.
            onAuxClick={(event) => {
              if (event.button === 1) void act({ action: "close", index: tab.index });
            }}
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
        {/* No stop button: the host exposes no stop action, and a control
            that does nothing is worse than none. The glyph spins instead. */}
        <button type="button" aria-label="Reload" className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => void act({ action: "reload" })}>
          <RotateCwIcon className={cn("size-3.5", activeTab?.loading && "animate-spin text-primary")} />
        </button>
        <input
          aria-label="Address"
          placeholder="Type an address"
          spellCheck={false}
          className="h-6 min-w-0 flex-1 rounded-md border border-transparent bg-muted/60 px-2 font-mono text-[0.6875rem] outline-none focus:border-ring"
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
                  className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[0.625rem] text-muted-foreground hover:bg-muted hover:text-foreground data-popup-open:bg-muted data-popup-open:text-foreground"
                >
                  <ScalingIcon className="size-3.5" />
                  <span>{viewportMode === "fit" ? "Fit panel" : `${activeTab.viewport.width}×${activeTab.viewport.height}`}</span>
                  {viewportMode === "fixed" && state?.presentation && state.presentation.scale < 1 ? <span className="text-muted-foreground/70">{Math.round(state.presentation.scale * 100)}%</span> : null}
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
                    <span className="shrink-0 font-mono text-[0.625rem] text-muted-foreground">{preset.width}×{preset.height}</span>
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
                  className="h-6 min-w-0 flex-1 rounded-md border border-border bg-background px-2 font-mono text-[0.6875rem] outline-none focus:border-ring"
                />
                <Button type="submit" size="sm" variant="outline" className="h-6 shrink-0 px-2 text-[0.6875rem]" disabled={!parseViewportInput(customSize)}>
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
                  className="flex min-w-0 shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[0.625rem] text-muted-foreground hover:bg-muted hover:text-foreground data-popup-open:bg-muted data-popup-open:text-foreground"
                >
                  <UserRoundIcon className="size-3.5 shrink-0" />
                  <span className="max-w-28 truncate">{state.profile.label}</span>
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
                  <div className="px-2 pt-1 pb-1.5">
                    <p className="truncate text-[0.75rem] font-medium">{state.profile.label}</p>
                    <p className="truncate font-mono text-[0.625rem] text-muted-foreground">
                      {state.profile.account || "No expected account"}
                    </p>
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
                          void profileAction(() => bridge.setScopeProfile!(sessionId, profile.id));
                        }}
                        className={cn(menuRow, current && "text-foreground")}
                      >
                        <CheckIcon className={cn("size-3.5 shrink-0", current ? "opacity-100" : "opacity-0")} />
                        <span className="min-w-0 flex-1 truncate">{profile.label}</span>
                        {profile.isDefault && <span className="shrink-0 text-[0.625rem] text-muted-foreground">default</span>}
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
                        void profileAction(() => bridge.assignProjectProfile!({ scopeKey: sessionId, profileId: state.profile!.id }));
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
                          const result = await bridge.offerLoginMemory!(sessionId);
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
                  <p className="px-2 pt-1.5 pb-1 text-[0.625rem] leading-snug text-muted-foreground">
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
                  <label htmlFor="telar-browser-profile-rename" className="text-[0.6875rem] text-muted-foreground">Rename this profile</label>
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
                    <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-[0.6875rem]" onClick={() => setProfilePane("menu")}>
                      Cancel
                    </Button>
                    <Button type="submit" size="sm" variant="outline" className="h-6 px-2 text-[0.6875rem]">
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
                    void profileAction(() => bridge.createProfile!({ label, ...(account ? { account } : {}), scopeKey: sessionId }));
                  }}
                >
                  <label htmlFor="telar-browser-profile-new" className="text-[0.6875rem] text-muted-foreground">New profile</label>
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
                    className="h-7 rounded-md border border-border bg-background px-2 font-mono text-[0.6875rem] outline-none focus:border-ring"
                  />
                  <div className="flex justify-end gap-1">
                    <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-[0.6875rem]" onClick={() => setProfilePane("menu")}>
                      Cancel
                    </Button>
                    <Button type="submit" size="sm" variant="outline" disabled={!newProfileLabel.trim()} className="h-6 px-2 text-[0.6875rem]">
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
            aria-label={extension.phase === "ready" ? `Open ${extension.name ?? "password manager"} — ${describeExtensionHealth(extension).text}` : `${extension.name ?? "Password manager"}: ${extension.phase}`}
            title={extension.phase === "ready" ? `${extension.name}: ${describeExtensionHealth(extension).text}` : extension.error ?? extension.phase}
            // Privacy pauses AGENTS, never the human's own credential tools:
            // the button stays live while private so a login can be chosen
            // and the popup closed and reopened. Disabled only while the
            // extension itself is not usable.
            disabled={extension.phase !== "ready"}
            onClick={() => void openPasswordManager()}
            className={cn(
              "flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[0.625rem] font-medium",
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
            {/* A genuine failure is written out, not hidden behind a glyph. */}
            {describeExtensionHealth(extension).tone === "error" ? <span className="max-w-48 truncate">{describeExtensionHealth(extension).text}</span> : null}
          </button>
        ) : null}
      </form>
      {/* A GENUINE BROWSER-ACTION FAILURE on this scope, surfaced rather than
          swallowed by the silent refresh (which hid real toolbar errors).
          Dismissible; it also clears on the next successful action. */}
      {actionError && (
        <div role="alert" className="flex shrink-0 items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 text-[0.6875rem] text-destructive">
          <span className="min-w-0 flex-1 truncate">{actionError}</span>
          <button type="button" onClick={() => setActionError(undefined)} className="shrink-0 rounded px-1.5 py-0.5 hover:bg-destructive/20" aria-label="Dismiss">
            Dismiss
          </button>
        </div>
      )}
      {extensionError && (
        <div role="alert" className="flex shrink-0 items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 text-[0.6875rem] text-destructive">
          <span className="min-w-0 flex-1 truncate">{extensionError}</span>
          <button type="button" onClick={() => setExtensionError(undefined)} className="shrink-0 rounded px-1.5 py-0.5 hover:bg-destructive/20">Dismiss</button>
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
            railsKey={`${sessionId}:${activeTab.id}`}
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
            scopeKey={sessionId}
            onOpen={(url) => void act(activeTab && addressValue(activeTab.url) === "" ? { action: "navigate", url } : { action: "new", url })}
          />
        )}
      </div>
    </div>
  );
}
