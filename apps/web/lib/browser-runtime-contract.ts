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
  available: boolean;
  running: boolean;
  tabs: ControlledBrowserTab[];
  screenshot: string | null;
  error: string | null;
  version: number;
  provider?: "desktop" | "playwright";
};

export type ControlledBrowserAction =
  | { action: "navigate"; url: string }
  | { action: "back" }
  | { action: "forward" }
  | { action: "reload" }
  | { action: "new"; url?: string }
  | { action: "select"; index: number }
  | { action: "close"; index?: number };
