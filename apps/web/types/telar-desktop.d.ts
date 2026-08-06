import type {
  ControlledBrowserAction,
  ControlledBrowserState,
} from "@/lib/browser-runtime-contract";
import type { ClientRequestDiagnostics } from "@/lib/client-request-diagnostics";

type DesktopBrowserToolResult = {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  isError?: boolean;
};

type DesktopBrowserPointerEvent = {
  scopeKey: string;
  tabId: string;
  phase: "move" | "click";
  x: number;
  y: number;
  createdAt: string;
};

export type TelarDesktopUpdateStatus = {
  status: "checking" | "available" | "not-available" | "downloading" | "downloaded" | "error" | "unsupported";
  version?: string;
  percent?: number;
  message?: string;
};

/** Which stream of builds this INSTALL follows, and whether quitting is also
 *  consent to install. Persisted in the desktop shell's userData — a property
 *  of this machine's installation, never of a project or of the engine. */
export type TelarDesktopUpdatePrefs = {
  channel: string;
  installOnQuit: boolean;
};

export type TelarDesktopUpdatePrefsInfo = TelarDesktopUpdatePrefs & {
  /** The channels this build knows how to follow — enumerated by the shell so
   *  the UI never hard-codes a list that could drift from what is published. */
  channels: string[];
  /** False for a locally-packaged build with no feed baked in. The controls
   *  still render, and say why they will not do anything. */
  configured: boolean;
};

export type TelarDesktopUpdatesBridge = {
  check: () => Promise<{ status: string }>;
  install: () => Promise<void>;
  onStatus: (listener: (status: TelarDesktopUpdateStatus) => void) => () => void;
  getPrefs: () => Promise<TelarDesktopUpdatePrefsInfo>;
  setPrefs: (patch: Partial<TelarDesktopUpdatePrefs>) => Promise<TelarDesktopUpdatePrefs>;
};

export type TelarDesktopBrowserBridge = {
  getState: (scopeKey: string) => Promise<ControlledBrowserState>;
  action: (scopeKey: string, action: ControlledBrowserAction) => Promise<ControlledBrowserState>;
  callTool: (scopeKey: string, name: string, args: Record<string, unknown>) => Promise<DesktopBrowserToolResult>;
  setBounds: (scopeKey: string, bounds: { x: number; y: number; width: number; height: number }) => Promise<void>;
  setVisible: (scopeKey: string, visible: boolean) => Promise<void>;
  releaseScope: (scopeKey: string, destroy?: boolean) => Promise<void>;
  adoptScope: (fromScopeKey: string, toScopeKey: string) => Promise<void>;
  onState: (listener: (state: ControlledBrowserState) => void) => () => void;
  onPointer: (listener: (event: DesktopBrowserPointerEvent) => void) => () => void;
};

declare global {
  interface Window {
    __telarRequestDiagnostics?: () => ClientRequestDiagnostics;
    __telarDesktopPointerEvents?: DesktopBrowserPointerEvent[];
    __telarDesktopPointerCleanup?: () => void;
    telarDesktop?: {
      isDesktop: true;
      browser: TelarDesktopBrowserBridge;
      updates: TelarDesktopUpdatesBridge;
    };
  }
}
