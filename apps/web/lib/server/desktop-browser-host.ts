import type { BrowserToolResult } from "@/lib/server/browser-runtime";
import type { ControlledBrowserState } from "@/lib/browser-runtime-contract";

export type DesktopBrowserCommand = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};

type PendingResponse = {
  resolve: (result: BrowserToolResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const HOST_STALE_MS = 35_000;
const COMMAND_TIMEOUT_MS = 30_000;

export class DesktopBrowserHostBroker {
  private hostId: string | null = null;
  private lastSeen = 0;
  private stateValue: ControlledBrowserState | null = null;
  private commands: DesktopBrowserCommand[] = [];
  private commandListeners = new Set<(command: DesktopBrowserCommand) => void>();
  private responses = new Map<string, PendingResponse>();
  private listeners = new Set<() => void>();

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }

  register(hostId: string, state: ControlledBrowserState) {
    if (this.hostId && this.hostId !== hostId) this.disconnect(this.hostId);
    this.hostId = hostId;
    this.lastSeen = Date.now();
    this.stateValue = { ...state, provider: "desktop", running: true, available: true };
    this.emit();
  }

  touch(hostId: string) {
    if (hostId === this.hostId) this.lastSeen = Date.now();
  }

  disconnect(hostId: string) {
    if (hostId !== this.hostId) return;
    this.hostId = null;
    this.lastSeen = 0;
    this.stateValue = null;
    this.commands = [];
    this.commandListeners.clear();
    for (const pending of this.responses.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("The Telar desktop browser host disconnected."));
    }
    this.responses.clear();
    this.emit();
  }

  online() {
    return this.hostId !== null && Date.now() - this.lastSeen < HOST_STALE_MS;
  }

  state(): ControlledBrowserState | null {
    if (!this.online()) {
      if (this.hostId) this.disconnect(this.hostId);
      return null;
    }
    return this.stateValue;
  }

  updateState(hostId: string, state: ControlledBrowserState) {
    if (hostId !== this.hostId) return;
    this.lastSeen = Date.now();
    this.stateValue = { ...state, provider: "desktop", running: true, available: true };
    this.emit();
  }

  subscribeCommands(hostId: string, listener: (command: DesktopBrowserCommand) => void) {
    if (hostId !== this.hostId) return () => {};
    this.touch(hostId);
    this.commandListeners.add(listener);
    for (const command of this.commands.splice(0)) listener(command);
    return () => this.commandListeners.delete(listener);
  }

  call(name: string, args: Record<string, unknown>): Promise<BrowserToolResult> {
    if (!this.online() || !this.hostId) {
      return Promise.reject(new Error("Open Telar Desktop and its Browser surface to share tabs with the agent."));
    }
    const id = crypto.randomUUID();
    const command = { id, name, args };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.responses.delete(id);
        reject(new Error(`The desktop browser timed out while running ${name}.`));
      }, COMMAND_TIMEOUT_MS);
      this.responses.set(id, { resolve, reject, timer });
      const listener = this.commandListeners.values().next().value as
        | ((command: DesktopBrowserCommand) => void)
        | undefined;
      if (listener) listener(command);
      else this.commands.push(command);
    });
  }

  respond(hostId: string, id: string, result?: BrowserToolResult, error?: string) {
    if (hostId !== this.hostId) return;
    this.lastSeen = Date.now();
    const pending = this.responses.get(id);
    if (!pending) return;
    this.responses.delete(id);
    clearTimeout(pending.timer);
    if (error) pending.reject(new Error(error));
    else pending.resolve(result ?? { content: [{ type: "text", text: "Desktop browser action completed." }] });
  }
}

const GLOBAL_KEY = Symbol.for("telar.desktop-browser-host.v1");
const brokerGlobal = globalThis as typeof globalThis & { [GLOBAL_KEY]?: DesktopBrowserHostBroker };

export function desktopBrowserHost(): DesktopBrowserHostBroker {
  return brokerGlobal[GLOBAL_KEY] ??= new DesktopBrowserHostBroker();
}
