import type { EngineTransport } from "../platform/transport";
import type { UsageLimits, UsageLimitSource, UsageLimitSourceKind, UsageReport, UsageResolution } from "./schema";
import type { UsageDiagnosisTool } from "./diagnosis";

export const usageClient = {
  usageReport(
    this: EngineTransport,
    input: { sinceMs: number; untilMs: number; resolution?: UsageResolution; timeZone?: string },
  ): Promise<{ usage: UsageReport }> {
    const query = new URLSearchParams({ since: String(input.sinceMs), until: String(input.untilMs) });
    if (input.resolution) query.set("resolution", input.resolution);
    if (input.timeZone) query.set("tz", input.timeZone);
    return this.request("GET", `/v2/usage?${query.toString()}`);
  },

  usageLimitSources(this: EngineTransport): Promise<{ sources: UsageLimitSource[] }> {
    return this.request("GET", "/v2/usage/sources");
  },

  /** `label: null` clears the label; an absent field is left alone. */
  saveUsageLimitSource(
    this: EngineTransport,
    input: { id: string; kind?: UsageLimitSourceKind; label?: string | null; url?: string; managementKey?: string; enabled?: boolean },
  ): Promise<{ source: UsageLimitSource }> {
    const { id, ...patch } = input;
    return this.request("PUT", `/v2/usage/sources/${encodeURIComponent(id)}`, patch);
  },

  removeUsageLimitSource(this: EngineTransport, id: string): Promise<{ removed: boolean }> {
    return this.request("DELETE", `/v2/usage/sources/${encodeURIComponent(id)}`);
  },

  usageLimits(this: EngineTransport, options: { refresh?: boolean } = {}): Promise<{ limits: UsageLimits }> {
    return this.request("GET", `/v2/usage/limits${options.refresh ? "?refresh=1" : ""}`);
  },

  usageDiagnosisTool(this: EngineTransport, sessionId: string, tool: UsageDiagnosisTool, args: Record<string, unknown>): Promise<{ text: string }> {
    return this.request("POST", `/v2/sessions/${encodeURIComponent(sessionId)}/usage-diagnosis/${tool}`, args);
  },

};
