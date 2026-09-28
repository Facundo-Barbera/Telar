import type { FrozenFrame } from "@/lib/native-view-overlay";
import type { SitePermissionsBridge } from "./desktop-site-permissions";
import type { ElementBox } from "./annotation";
import type { ViewportMode, ViewportPresetKey, ViewportZoom } from "./viewport";

export type DesktopBrowserTab = {
  index: number;
  id: string;
  title: string;
  url: string;
  active: boolean;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  controller?: "agent" | "human" | "idle";
  openedBy?: "agent" | "human";
  /** The tab the agent's calls land in, independent of `active`. */
  agentFocus?: boolean;
  favicon?: string | null;
  /** Remembered with no live page yet; selecting it loads the page. */
  sleeping?: boolean;
  devtools?: boolean;
  viewport?: { width: number; height: number; preset: ViewportPresetKey | null; mode?: ViewportMode };
  /** Page zoom factor, not the presentation scale. */
  zoom?: number;
  colorScheme?: "light" | "dark" | "system";
  /** Moved into a window of its own, so the panel has no page to draw. */
  preview?: boolean;
  profileId?: string | null;
};

export type DesktopBrowserProfile = {
  id: string;
  label: string;
  account?: string;
  partition: string;
  icon?: string;
  color?: string;
  isDefault?: boolean;
  projects?: string[];
};

/** `rect` is in this page's CSS pixels: where the device frame is drawn. */
export type DesktopBrowserPresentation = {
  width: number;
  height: number;
  scale: number;
  zoom?: ViewportZoom;
  rect: { x: number; y: number; width: number; height: number };
};

/** A capture at the tab's own viewport; `data` is base64 without a data-URL prefix. */
export type DesktopBrowserCapture = {
  data: string;
  mimeType: string;
  url: string;
  title?: string;
  width: number;
  height: number;
  fullPage?: boolean;
  elements?: readonly ElementBox[];
};

export type DesktopBrowserPanelState = {
  scopeKey: string;
  controller?: "agent" | "human" | "idle";
  tabs: DesktopBrowserTab[];
  presentation?: DesktopBrowserPresentation | null;
  profile?: DesktopBrowserProfile | null;
  profiles?: DesktopBrowserProfile[];
  profileKey?: string | null;
  // An event on exactly one push, never on a `getState` read: "no tabs" alone
  // cannot tell a closed browser from one that has not opened a page yet.
  ended?: boolean;
};

export type DesktopExtensionStatus = {
  id?: string;
  name?: string;
  partition?: string;
  icon?: string;
  phase: "idle" | "installing" | "loading" | "ready" | "failed" | "unavailable";
  version?: string;
  error?: string;
  health?: {
    workerErrors: Record<string, number>;
    native: { state: "not attempted" | "available" | "unavailable"; helpers: number; lastExitCode?: number | null; hint?: string };
  };
};

/** `scopeKey` is null when the page that started the download is gone. */
export type DesktopBrowserDownload = {
  scopeKey: string | null;
  tabId: string | null;
  state: "started" | "completed" | "cancelled" | "interrupted";
  path: string;
  filename: string;
};

/** The shell's `telarDesktop.browser`. Optional methods are absent on older shells; their controls are hidden. */
export type DesktopBrowserBridge = {
  getState(scopeKey: string): Promise<DesktopBrowserPanelState>;
  action(scopeKey: string, action: Record<string, unknown>): Promise<DesktopBrowserPanelState>;
  setBounds(scopeKey: string, bounds: { x: number; y: number; width: number; height: number; radius?: number }): Promise<void>;
  setVisible(scopeKey: string, visible: boolean): Promise<void>;
  freezeView?(scopeKey: string): Promise<FrozenFrame | null>;
  onState(listener: (state: DesktopBrowserPanelState) => void): () => void;
  releaseScope?(scopeKey: string, destroy?: boolean, options?: { closedByPerson?: boolean }): Promise<void>;
  bindProfile?(scopeKey: string, profileKey: string): Promise<{ scopeKey: string; profileKey: string; partition: string; profileId?: string; label?: string }>;
  createProfile?(input: { label: string; account?: string; scopeKey?: string; assignProject?: boolean }): Promise<{ profiles: DesktopBrowserProfile[]; active: DesktopBrowserProfile }>;
  updateProfile?(input: { profileId: string; label?: string; account?: string; icon?: string | null; color?: string | null }): Promise<{ profiles: DesktopBrowserProfile[] }>;
  setDefaultProfile?(profileId: string): Promise<{ profiles: DesktopBrowserProfile[] }>;
  assignProjectProfile?(input: { scopeKey: string; profileId: string | null }): Promise<{ profiles: DesktopBrowserProfile[] }>;
  setScopeProfile?(scopeKey: string, profileId: string): Promise<{ profileId: string; partition: string }>;
  capture?(scopeKey: string, options?: { fullPage?: boolean; elements?: boolean }): Promise<DesktopBrowserCapture>;
  extensionStatus?(scopeKey: string): Promise<DesktopExtensionStatus>;
  openExtensionPopup?(scopeKey: string, anchorRect: { x: number; y: number; width: number; height: number }): Promise<DesktopExtensionStatus>;
  openExternal?(url: string): Promise<{ ok: boolean; error?: string }>;
  clearBrowsingData?(scopeKey: string, kind: "cookies" | "cache"): Promise<{ ok: boolean; kind: string; partition: string; profile?: string | null }>;
  offerLoginMemory?(scopeKey: string): Promise<{ ok: boolean; error?: string }>;
  onDownload?(listener: (download: DesktopBrowserDownload) => void): () => void;
  revealDownload?(path: string): Promise<{ ok: boolean; error?: string }>;
  onExtension?(listener: (status: DesktopExtensionStatus) => void): () => void;
} & SitePermissionsBridge;
