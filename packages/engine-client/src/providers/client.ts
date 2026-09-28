import type { ProviderDriverKind } from "../protocol/common";
import type { EngineTransport } from "../platform/transport";
import type { AutoCompact, CustomProviderModel, ModelCatalogue, ModelOverlay, ProviderInstance, ProviderInstanceEnvVar, ProviderProbe, ProviderUpdateRun } from "./schema";

type ProviderInstances = { providerInstances: ProviderInstance[]; probes: ProviderProbe[] };

const instancePath = (id: string) => `/v2/provider-instances/${encodeURIComponent(id)}`;

export const providersClient = {
  listProviderInstances(this: EngineTransport, options: { refresh?: boolean } = {}): Promise<ProviderInstances> {
    return this.request("GET", `/v2/provider-instances${options.refresh ? "?refresh=1" : ""}`);
  },

  updateProviderCli(this: EngineTransport, instanceId: string): Promise<ProviderInstances & { result: ProviderUpdateRun }> {
    return this.request("POST", `/v2/provider-updates/${encodeURIComponent(instanceId)}`, {});
  },

  /** `null` returns a field to its default; an absent field is left alone. */
  saveProviderInstance(
    this: EngineTransport,
    input: {
      id: string;
      driver?: ProviderDriverKind;
      displayName?: string | null;
      accentColor?: string | null;
      contextNoticePercent?: number | null;
      autoCompact?: AutoCompact | null;
      configDir?: string | null;
      binaryPath?: string | null;
      enabled?: boolean;
      env?: ProviderInstanceEnvVar[];
      carryOverInherited?: string[];
    },
  ): Promise<{ providerInstance: ProviderInstance; stoppedInheriting?: string[] }> {
    const { id, ...patch } = input;
    return this.request("PUT", instancePath(id), patch);
  },

  /** Refused for a driver's built-in slot. */
  removeProviderInstance(this: EngineTransport, id: string): Promise<{ removed: boolean }> {
    return this.request("DELETE", instancePath(id));
  },

  modelCatalogue(
    this: EngineTransport,
    driver: ProviderDriverKind,
    options: { refresh?: boolean; instanceId?: string } = {},
  ): Promise<{ catalogue: ModelCatalogue }> {
    const query = new URLSearchParams({ driver });
    if (options.refresh) query.set("refresh", "1");
    if (options.instanceId) query.set("instanceId", options.instanceId);
    return this.request("GET", `/v2/models?${query.toString()}`);
  },

  modelOverlay(this: EngineTransport, instanceId: string): Promise<{ overlay: ModelOverlay }> {
    return this.request("GET", `${instancePath(instanceId)}/models`);
  },

  /** A submitted array replaces that list whole: `{ hidden: [] }` clears the hides, omitting `hidden` keeps them. */
  setModelOverlay(
    this: EngineTransport,
    instanceId: string,
    patch: { favorites?: string[]; hidden?: string[]; order?: string[]; custom?: CustomProviderModel[]; default?: string | null },
  ): Promise<{ overlay: ModelOverlay }> {
    return this.request("PATCH", `${instancePath(instanceId)}/models`, patch);
  },
};
