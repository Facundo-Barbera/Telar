import type {
  ControlledBrowserAction,
  ControlledBrowserState,
} from "@/lib/browser-runtime-contract";

type DesktopBrowserToolResult = {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  isError?: boolean;
};

type DesktopBrowserPointerEvent = {
  tabId: string;
  phase: "move" | "click";
  x: number;
  y: number;
  createdAt: string;
};

export type TelarDesktopBrowserBridge = {
  getState: () => Promise<ControlledBrowserState>;
  action: (action: ControlledBrowserAction) => Promise<ControlledBrowserState>;
  callTool: (name: string, args: Record<string, unknown>) => Promise<DesktopBrowserToolResult>;
  setBounds: (bounds: { x: number; y: number; width: number; height: number }) => Promise<void>;
  setVisible: (visible: boolean) => Promise<void>;
  onState: (listener: (state: ControlledBrowserState) => void) => () => void;
  onPointer: (listener: (event: DesktopBrowserPointerEvent) => void) => () => void;
};

declare global {
  interface Window {
    __telarDesktopPointerEvents?: DesktopBrowserPointerEvent[];
    __telarDesktopPointerCleanup?: () => void;
    telarDesktop?: {
      isDesktop: true;
      browser: TelarDesktopBrowserBridge;
    };
  }
}
