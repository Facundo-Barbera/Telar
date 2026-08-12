export type ControlledBrowserTab = {
  index: number;
  id?: string;
  title: string;
  url: string;
  active: boolean;
  loading?: boolean;
  canGoBack?: boolean;
  canGoForward?: boolean;
};

export type ControlledBrowserState = {
  scopeKey?: string;
  available: boolean;
  running: boolean;
  tabs: ControlledBrowserTab[];
  screenshot: string | null;
  error: string | null;
  version: number;
  provider?: "desktop" | "playwright";
};

export type BrowserAgentPresence = {
  status: "acting" | "settling";
  scopeKey?: string;
  tool: string;
  phase?: "move" | "click" | "type" | "navigate" | "inspect";
  tabId?: string;
  startedAt: string;
  lastActionAt?: string;
};

export type BrowserRuntimeEvent = {
  version: number;
  reveal: boolean;
  stateChanged: boolean;
  scopeKey?: string;
  presence?: BrowserAgentPresence;
};

/** Emitted in the renderer when a session-scoped browser runtime changes. */
export const TELAR_BROWSER_RUNTIME_EVENT = "telar:browser-runtime";
/** Emitted in the renderer when an agent mutation should reveal its session surface. */
export const TELAR_BROWSER_MUTATION_EVENT = "telar:browser-mutation";

export type ControlledBrowserAction =
  | { action: "navigate"; url: string }
  | { action: "back" }
  | { action: "forward" }
  | { action: "reload" }
  | { action: "new"; url?: string }
  | { action: "select"; index: number }
  | { action: "close"; index?: number };
