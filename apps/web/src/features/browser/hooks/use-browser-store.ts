import { useEffect, useRef, useState, type RefObject } from "react";
import type { PermissionPrompt, SitePermissionRecord } from "../desktop-site-permissions";
import type { AnnotateCapture } from "../components/annotate-overlay";
import { makeScopeGuard } from "../scope-guard";
import type { DesktopBrowserDownload, DesktopBrowserPanelState, DesktopExtensionStatus } from "../types";
import { useAddressRowTools } from "./use-browser-viewport";

export type BrowserOverlay = "profile" | "options" | "device" | "zoom" | "site" | null;

/** Every piece of the surface's state. The component instance is reused across scopes, so a scope change resets it. */
export function useBrowserStore(scopeKey: string, projectId: string | undefined, addressRowRef: RefObject<HTMLFormElement | null>, partitionRef: RefObject<string | undefined>) {
  const [state, setState] = useState<DesktopBrowserPanelState>();
  const [draft, setDraft] = useState<string>();
  const [extension, setExtension] = useState<DesktopExtensionStatus>();
  const [extensionError, setExtensionError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [scope] = useState(makeScopeGuard);
  const [bound, setBound] = useState(false);
  const [openOverlay, setOpenOverlay] = useState<BrowserOverlay>(null);
  const [profilePane, setProfilePane] = useState<"menu" | "rename" | "new">("menu");
  const [optionsPane, setOptionsPane] = useState<"menu" | "appearance" | "cookies" | "cache">("menu");
  const [clearing, setClearing] = useState(false);
  const [annotating, setAnnotating] = useState<AnnotateCapture>();
  const [capturing, setCapturing] = useState(false);
  const rowFitsTools = useAddressRowTools(addressRowRef);
  // Carries the tab it was typed for, so a half-typed size never shows on another tab.
  const [sizeDraft, setSizeDraft] = useState<{ tabId: string; width: string; height: string }>();
  const [prompts, setPrompts] = useState<PermissionPrompt[]>([]);
  // Dismissing is not answering: the question stays open in the shell.
  const [dismissedPrompts, setDismissedPrompts] = useState<readonly string[]>([]);
  const [sitePermissions, setSitePermissions] = useState<SitePermissionRecord[]>([]);
  const [permissionBusy, setPermissionBusy] = useState(false);
  const [permissionDenial, setPermissionDenial] = useState<string>();
  const [download, setDownload] = useState<DesktopBrowserDownload>();
  const firstScopeRef = useRef(true);
  useEffect(() => {
    if (firstScopeRef.current) { firstScopeRef.current = false; return; }
    scope.bump();
    partitionRef.current = undefined;
    setBound(false);
    setState(undefined);
    setExtension(undefined);
    setActionError(undefined);
    setExtensionError(undefined);
    // A scope switch unmounts an open menu without `onOpenChange`; a claim left open would hide the next scope's view.
    setOpenOverlay(null);
    setProfilePane("menu");
    setOptionsPane("menu");
    setSizeDraft(undefined);
    setPrompts([]);
    setDismissedPrompts([]);
    setSitePermissions([]);
    setPermissionDenial(undefined);
    setDownload(undefined);
  }, [scope, scopeKey, projectId, partitionRef]);

  const [newProfileLabel, setNewProfileLabel] = useState("");
  const [newProfileAccount, setNewProfileAccount] = useState("");
  const [dragPreview, setDragPreview] = useState<{ width: number; height: number }>();
  const [lockRatio, setLockRatio] = useState(false);
  const [chromeHasKeys, setChromeHasKeys] = useState(false);
  const closeOverlay = () => {
    setOpenOverlay(null);
    setProfilePane("menu");
    setOptionsPane("menu");
  };

  return {
    state, setState, draft, setDraft, extension, setExtension, extensionError, setExtensionError, actionError, setActionError,
    scope, bound, setBound, openOverlay, setOpenOverlay, profilePane, setProfilePane,
    optionsPane, setOptionsPane, clearing, setClearing, annotating, setAnnotating, capturing, setCapturing, rowFitsTools,
    sizeDraft, setSizeDraft, prompts, setPrompts, dismissedPrompts, setDismissedPrompts, sitePermissions, setSitePermissions,
    permissionBusy, setPermissionBusy, permissionDenial, setPermissionDenial, download, setDownload,
    newProfileLabel, setNewProfileLabel, newProfileAccount, setNewProfileAccount, dragPreview, setDragPreview, lockRatio,
    setLockRatio, chromeHasKeys, setChromeHasKeys, closeOverlay,
  };
}

export type BrowserStore = ReturnType<typeof useBrowserStore>;
