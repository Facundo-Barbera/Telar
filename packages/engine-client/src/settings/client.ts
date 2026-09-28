import type { ProviderDriverKind } from "../protocol/common";
import type { EngineTransport } from "../platform/transport";
import type { AgentOrientation, InboxPolicy, SessionDefaults, SessionDefaultsPatch, SidebarLayout, SidebarMode, TextGenPolicy } from "./schema";

type OrientationAnswer = { orientation: AgentOrientation; text: string };

export const settingsClient = {
  inboxPolicy(this: EngineTransport): Promise<{ inbox: InboxPolicy }> {
    return this.request("GET", "/v2/inbox");
  },

  /** `null` turns a window off. */
  setInboxPolicy(
    this: EngineTransport,
    patch: { autoSettleAfterHours?: number | null; settleDelegatedAfterHours?: number | null; settledTerminalLimit?: number },
  ): Promise<{ inbox: InboxPolicy }> {
    return this.request("PATCH", "/v2/inbox", patch);
  },

  orientation(this: EngineTransport): Promise<OrientationAnswer> {
    return this.request("GET", "/v2/orientation");
  },

  /** An absent switch is left alone. */
  setOrientation(this: EngineTransport, patch: { preamble?: boolean; skill?: boolean }): Promise<OrientationAnswer> {
    return this.request("PATCH", "/v2/orientation", patch);
  },

  sessionDefaults(this: EngineTransport): Promise<{ sessionDefaults: SessionDefaults }> {
    return this.request("GET", "/v2/session-defaults");
  },

  setSessionDefaults(this: EngineTransport, patch: SessionDefaultsPatch): Promise<{ sessionDefaults: SessionDefaults }> {
    return this.request("PATCH", "/v2/session-defaults", patch);
  },

  sidebarLayout(this: EngineTransport): Promise<{ layout: SidebarLayout }> {
    return this.request("GET", "/v2/sidebar-layout");
  },

  /** An absent field is left alone, so one arrangement cannot overwrite another. */
  setSidebarLayout(
    this: EngineTransport,
    patch: { projectOrder?: string[]; sessionOrder?: Record<string, string[]>; pinnedOrder?: string[]; mode?: SidebarMode },
  ): Promise<{ layout: SidebarLayout }> {
    return this.request("PATCH", "/v2/sidebar-layout", patch);
  },

  textGenPolicy(this: EngineTransport): Promise<{ textGen: TextGenPolicy }> {
    return this.request("GET", "/v2/textgen");
  },

  /** `model: null` returns to the driver's default; an absent field is left alone. */
  setTextGenPolicy(
    this: EngineTransport,
    patch: { titles?: boolean; renameBranches?: boolean; driver?: ProviderDriverKind; model?: string | null },
  ): Promise<{ textGen: TextGenPolicy }> {
    return this.request("PATCH", "/v2/textgen", patch);
  },

  completeStructured(
    this: EngineTransport,
    input: { prompt: string; schema: Record<string, unknown>; model?: string; effort?: "low" | "medium" | "high" },
    options: { signal?: AbortSignal } = {},
  ): Promise<{ result: Record<string, unknown> }> {
    return this.request("POST", "/v2/textgen/complete", input, options.signal);
  },
};
