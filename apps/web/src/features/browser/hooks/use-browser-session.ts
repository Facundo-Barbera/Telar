import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { SitePermissionKind } from "../desktop-site-permissions";
import { claimChords, useCommandHandlers } from "@/features/commands";
import { captionFor } from "../annotation";
import { describePermissionDenial, type PermissionAnswer } from "../components/permission-prompt";
import { addressValue, fileFromCapture, originOfUrl, readSitePermissionsFor, StaleScopeError, TAB_SELECT_CHORDS } from "../model";
import type { ScopeGuard } from "../scope-guard";
import type { DesktopBrowserBridge, DesktopBrowserCapture } from "../types";
import { keepRatio, ratioOf, sizeFromFields, stepField, type ViewportMode } from "../viewport";
import type { BrowserStore } from "./use-browser-store";
import { useDesktopBrowserViewport } from "./use-browser-viewport";

/** What the store implies about the tab in front of the person. */
export function browserView(s: BrowserStore) {
  const activeTab = s.state?.tabs.find((tab) => tab.active);
  const activeOrigin = originOfUrl(activeTab?.url);
  // A prompt the shell could not attribute to a tab is shown here rather than nowhere.
  const tabPrompt = s.prompts.find((prompt) => prompt.tabId === null || prompt.tabId === activeTab?.id);
  const activePrompt = tabPrompt && !s.dismissedPrompts.includes(tabPrompt.requestId) ? tabPrompt : undefined;
  const draftSize = s.sizeDraft && s.sizeDraft.tabId === activeTab?.id ? s.sizeDraft : undefined;
  // The device toolbar is the fixed viewport: derived, so the toggle cannot drift from the page.
  const viewportMode: ViewportMode = activeTab?.viewport?.mode ?? "fit";
  return { activeTab, activeOrigin, tabPrompt, activePrompt, draftSize, viewportMode, deviceToolbar: viewportMode === "fixed" };
}

export type BrowserView = ReturnType<typeof browserView>;

/** Everything the surface's pieces read: props, store, view and the hooks' handlers. */
export type BrowserUi = BrowserProps &
  BrowserStore &
  BrowserView &
  ReturnType<typeof useBrowserSync> &
  ReturnType<typeof useBrowserActions> &
  ReturnType<typeof useBrowserPermissions> &
  ReturnType<typeof useBrowserCapture> &
  ReturnType<typeof useDeviceSize> & { hostSize: { width: number; height: number } | undefined };

export type BrowserProps = {
  bridge: DesktopBrowserBridge;
  scopeKey: string;
  projectId?: string;
  onAttach?: (files: readonly File[], caption?: string) => void;
  onEnded?: () => void;
};

type SyncRefs = {
  intentAtRef: RefObject<number>;
  partitionRef: RefObject<string | undefined>;
  hostRef: RefObject<HTMLDivElement | null>;
  overlayRef: RefObject<boolean>;
};

/** Reads and pushes of the scope's state, the native view's bounds, and the profile binding. */
export function useBrowserSync({ bridge, scopeKey, projectId, onEnded }: BrowserProps, s: BrowserStore, view: BrowserView, { intentAtRef, partitionRef, hostRef, overlayRef }: SyncRefs) {
  const { scope, setState, setBound, setExtension, setExtensionError } = s;

  // Typing an address is the person's hands on the tab before submit; one signal per burst.
  const signalIntent = useCallback(() => {
    const now = Date.now();
    if (now - intentAtRef.current < 500) return;
    intentAtRef.current = now;
    const gen = scope.capture();
    void bridge.action(scopeKey, { action: "intent" }).then((next) => { if (scope.isCurrent(gen)) setState(next); }, () => undefined);
  }, [bridge, scope, scopeKey, intentAtRef, setState]);

  const refresh = useCallback(async () => {
    const gen = scope.capture();
    try {
      const next = await bridge.getState(scopeKey);
      if (scope.isCurrent(gen)) setState(next);
    } catch {
      // The shell mid-reload must not take the panel down with it.
    }
  }, [bridge, scope, scopeKey, setState]);

  // Re-declared before every mutating action rather than cached: a shell restart drops
  // the binding. Throws when the scope changed while it awaited.
  const bindNow = useCallback(async (gen: number = scope.capture()) => {
    if (!bridge.bindProfile) return;
    const result = await bridge.bindProfile(scopeKey, projectId ?? "none");
    if (!scope.isCurrent(gen)) throw new StaleScopeError();
    partitionRef.current = result?.partition;
  }, [bridge, scope, scopeKey, projectId, partitionRef]);

  const endedRef = useRef(onEnded);
  useEffect(() => {
    endedRef.current = onEnded;
  });

  useEffect(() => {
    const first = window.setTimeout(() => void refresh(), 0);
    // The shell pushes every change; the interval covers a push lost during a reload.
    const timer = window.setInterval(() => void refresh(), 2_000);
    const unsubscribe = bridge.onState((next) => {
      if (next.scopeKey !== scopeKey) return;
      setState(next);
      if (next.ended) endedRef.current?.();
    });
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [bridge, refresh, scopeKey, setState]);

  const { activeTab, viewportMode } = view;
  useDesktopBrowserViewport(
    bridge,
    scopeKey,
    hostRef,
    [activeTab?.id, activeTab?.viewport?.width, activeTab?.viewport?.height, viewportMode, Boolean(s.actionError), Boolean(s.extensionError), Boolean(s.permissionDenial), Boolean(s.download), activeTab?.sleeping, activeTab?.preview].join("|"),
    viewportMode,
    overlayRef,
  );

  // Bind, then read the extension status: it is per partition and meaningless before the bind.
  useEffect(() => {
    let cancelled = false;
    const gen = scope.capture();
    void bindNow(gen)
      .then(() => {
        if (cancelled || !scope.isCurrent(gen)) return undefined;
        setBound(true);
        if (!bridge.extensionStatus) return undefined;
        return bridge.extensionStatus(scopeKey);
      })
      .then((status) => { if (!cancelled && scope.isCurrent(gen) && status) setExtension(status); })
      .catch((error: unknown) => {
        if (cancelled || !scope.isCurrent(gen) || error instanceof StaleScopeError) return;
        setExtensionError(error instanceof Error ? error.message : "Could not load the password manager for this session.");
      });
    // Until the partition is known a partitioned push may be another project's; a legacy push without one is accepted.
    const unsubscribe = bridge.onExtension?.((next) => {
      if (cancelled) return;
      if (next.partition && next.partition !== partitionRef.current) return;
      setExtension(next);
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [bridge, bindNow, scope, scopeKey, setBound, setExtension, setExtensionError, partitionRef]);

  return { signalIntent, refresh, bindNow };
}

type Sync = { refresh: () => Promise<void>; bindNow: (gen?: number) => Promise<void> };
type Report = (error: string | undefined) => void;

/** Runs `work` under the current scope; a result or failure that arrives after a scope change is dropped. Returns whether it failed. */
async function attempt(scope: ScopeGuard, report: Report, fallback: string, work: (gen: number) => Promise<(() => void) | void>): Promise<boolean> {
  const gen = scope.capture();
  try {
    const done = await work(gen);
    if (scope.isCurrent(gen)) {
      report(undefined);
      done?.();
    }
    return false;
  } catch (error) {
    if (!scope.isCurrent(gen) || error instanceof StaleScopeError) return false;
    report(error instanceof Error ? error.message : fallback);
    return true;
  }
}

/** Every write the surface makes, each dropped when it resolves after a scope change. */
export function useBrowserActions({ bridge, scopeKey }: BrowserProps, s: BrowserStore, { refresh, bindNow }: Sync, keyButtonRef: RefObject<HTMLButtonElement | null>) {
  const { scope, setActionError, setState, setClearing, setExtension, setExtensionError } = s;

  const profileAction = useCallback(
    (run: () => Promise<unknown>) =>
      attempt(scope, setActionError, "That browser profile change could not be applied.", async () => {
        await run();
        return () => void refresh();
      }),
    [refresh, scope, setActionError],
  );

  const clearData = useCallback(
    async (kind: "cookies" | "cache") => {
      if (!bridge.clearBrowsingData) return;
      setClearing(true);
      await attempt(scope, setActionError, `Those ${kind} could not be cleared.`, async () => void (await bridge.clearBrowsingData!(scopeKey, kind)));
      setClearing(false);
    },
    [bridge, scope, scopeKey, setActionError, setClearing],
  );

  const openPasswordManager = useCallback(async () => {
    if (!bridge.openExtensionPopup) return;
    const rect = keyButtonRef.current?.getBoundingClientRect();
    const gen = scope.capture();
    setExtensionError(undefined);
    try {
      await bindNow(gen);
      const status = await bridge.openExtensionPopup(scopeKey, rect ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height } : { x: 0, y: 0, width: 24, height: 24 });
      if (scope.isCurrent(gen)) setExtension(status);
    } catch (error) {
      if (!scope.isCurrent(gen) || error instanceof StaleScopeError) return;
      setExtensionError(error instanceof Error ? error.message : String(error));
    }
  },[bridge, bindNow, scope, scopeKey, keyButtonRef, setExtension, setExtensionError]);

  const act = useCallback(
    async (action: Record<string, unknown>) => {
      const failed = await attempt(scope, setActionError, "That browser action could not be completed.", async (gen) => {
        await bindNow(gen);
        const next = await bridge.action(scopeKey, action);
        return () => setState(next);
      });
      // A genuine failure on this scope: resync from the shell as well as reporting it.
      if (failed) void refresh();
    },
    [bridge, bindNow, refresh, scope, scopeKey, setActionError, setState],
  );

  return { profileAction, clearData, openPasswordManager, act };
}

/** Open permission questions, what this site holds, and downloads, each kept to this scope. */
export function useBrowserPermissions({ bridge, scopeKey }: BrowserProps, s: BrowserStore, { activeOrigin }: BrowserView) {
  const { scope, setPrompts, setPermissionDenial, setDownload, setSitePermissions, setPermissionBusy, setActionError } = s;

  // The read reconciles pushes: a remounted panel finds its prompt and a timed-out one disappears.
  const readPrompts = useCallback(async () => {
    if (!bridge.permissionPrompts) return;
    const gen = scope.capture();
    try {
      const answer = await bridge.permissionPrompts(scopeKey);
      if (scope.isCurrent(gen)) setPrompts(answer.prompts ?? []);
    } catch {
      // The shell mid-reload is not a reason to drop what is on screen.
    }
  }, [bridge, scope, scopeKey, setPrompts]);

  useEffect(() => {
    const unsubscribeRequest = bridge.onPermissionRequest?.((prompt) => {
      if (prompt.scopeKey && prompt.scopeKey !== scopeKey) return;
      setPrompts((current) => (current.some((open) => open.requestId === prompt.requestId) ? current : [...current, prompt]));
    });
    const unsubscribeDenied = bridge.onPermissionDenied?.((denial) => setPermissionDenial(describePermissionDenial(denial)));
    const first = window.setTimeout(() => void readPrompts(), 0);
    const timer = window.setInterval(() => void readPrompts(), 2_000);
    return () => {
      unsubscribeRequest?.();
      unsubscribeDenied?.();
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [bridge, readPrompts, scopeKey, setPrompts, setPermissionDenial]);

  useEffect(
    () => bridge.onDownload?.((next) => { if (!next.scopeKey || next.scopeKey === scopeKey) setDownload(next); }),
    [bridge, scopeKey, setDownload],
  );

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
  }, [bridge, scopeKey, activeOrigin, setSitePermissions]);

  const settle = () => {
    setPermissionBusy(false);
    void readSitePermissionsFor(bridge, scopeKey, activeOrigin).then(setSitePermissions);
  };

  // The prompt leaves on the press; the shell ignores a second answer to the same request.
  const answerPermission = async (requestId: string, answer: PermissionAnswer) => {
    if (!bridge.answerPermission) return;
    setPermissionBusy(true);
    setPrompts((current) => current.filter((prompt) => prompt.requestId !== requestId));
    try {
      await bridge.answerPermission({ requestId, ...answer });
    } catch {
      // Timed out or gone: the re-read below puts the truth back on screen.
    } finally {
      void readPrompts();
      settle();
    }
  };

  const forgetPermission = async (kind?: SitePermissionKind) => {
    if (!bridge.forgetSitePermission || !activeOrigin) return;
    setPermissionBusy(true);
    try {
      await bridge.forgetSitePermission({ scopeKey, origin: activeOrigin, ...(kind ? { kind } : {}) });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "That site permission could not be forgotten.");
    } finally {
      settle();
    }
  };

  return { answerPermission, forgetPermission };
}

type Act = (action: Record<string, unknown>) => Promise<void>;

/** The camera and the pen; each capture is dropped if the scope changed while it ran. */
export function useBrowserCapture({ bridge, scopeKey, onAttach }: BrowserProps, s: BrowserStore, { activeTab }: BrowserView) {
  const { scope, capturing, setCapturing, setActionError, setAnnotating } = s;
  const shoot = async (options: { fullPage?: boolean; elements?: boolean }, failed: string, apply: (shot: DesktopBrowserCapture) => void) => {
    if (!bridge.capture || !onAttach || capturing) return;
    const gen = scope.capture();
    setCapturing(true);
    try {
      const shot = await bridge.capture(scopeKey, options);
      if (!scope.isCurrent(gen)) return;
      setActionError(undefined);
      apply(shot);
    } catch (error) {
      if (!scope.isCurrent(gen)) return;
      setActionError(error instanceof Error ? error.message : failed);
    } finally {
      setCapturing(false);
    }
  };
  const captureInto = (options: { fullPage?: boolean }) =>
    shoot(options, "That page could not be captured.", (shot) => onAttach?.([fileFromCapture(shot, "screenshot")], captionFor(shot)));
  // The frame is taken before `setAnnotating` claims the view, so the picture is of the live page.
  const startAnnotate = () =>
    shoot({ elements: true }, "That page could not be captured to annotate.", (shot) =>
      setAnnotating({
        dataUrl: `data:${shot.mimeType || "image/png"};base64,${shot.data}`,
        url: shot.url,
        ...(shot.title ? { title: shot.title } : {}),
        width: shot.width,
        height: shot.height,
        elements: shot.elements ?? [],
      }),
    );
  const canCapture = Boolean(bridge.capture && onAttach && activeTab && addressValue(activeTab.url) !== "" && !activeTab.sleeping && !activeTab.preview);
  return { captureInto, startAnnotate, canCapture };
}

/** The device toolbar's size fields and rail drags. */
export function useDeviceSize({ bridge, scopeKey }: BrowserProps, s: BrowserStore, { activeTab, draftSize }: BrowserView, act: Act) {
  const { lockRatio, setSizeDraft } = s;
  const resize = (next: { width: number; height: number }) => {
    const viewport = activeTab?.viewport;
    if (!viewport || !activeTab || (next.width === viewport.width && next.height === viewport.height)) return;
    void act({ action: "resize", index: activeTab.index, width: next.width, height: next.height });
  };
  // A draft that is not two numbers falls back to the tab's own size rather than resizing.
  const commitSize = () => {
    const viewport = activeTab?.viewport;
    if (!draftSize || !viewport || !activeTab) return;
    setSizeDraft(undefined);
    const typed = sizeFromFields(draftSize.width, draftSize.height);
    const next = typed && lockRatio ? keepRatio(typed, viewport, ratioOf(viewport)) : typed;
    if (next) resize(next);
  };
  const stepSize = (field: "width" | "height", event: React.KeyboardEvent<HTMLInputElement>) => {
    const viewport = activeTab?.viewport;
    if (!viewport || !activeTab) return;
    const stepped = stepField(draftSize?.[field] ?? String(viewport[field]), event.key, event.shiftKey);
    if (stepped === undefined) return;
    event.preventDefault();
    const typed = { width: viewport.width, height: viewport.height, [field]: Number(stepped) };
    setSizeDraft(undefined);
    resize(lockRatio ? keepRatio(typed, viewport, ratioOf(viewport)) : typed);
  };
  // A live frame of a rail drag: the shell answers nothing and only the release reports failure.
  const liveResize = (size: { width: number; height: number }) => {
    if (!activeTab) return;
    void bridge.action(scopeKey, { action: "resize", index: activeTab.index, width: size.width, height: size.height, live: true }).catch(() => {});
  };
  return { commitSize, stepSize, liveResize };
}

// ⌘1..⌘9 are claimed only while focus is in this chrome: when the page has focus the
// renderer sees no keydown, and the shell answers those itself.
export function useBrowserKeys(s: BrowserStore, { activeTab }: BrowserView, act: Act) {
  const { chromeHasKeys, state } = s;
  useCommandHandlers(activeTab ? { "toggle-devtools": () => void act({ action: "toggle-devtools" }) } : {}, [Boolean(activeTab)]);
  useEffect(() => {
    if (!chromeHasKeys) return undefined;
    return claimChords(TAB_SELECT_CHORDS);
  }, [chromeHasKeys]);

  return (event: React.KeyboardEvent) => {
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
}
