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
    };
  }
}
