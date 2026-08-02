import type { IntegrationDefinition } from "./types";

export type IntegrationConfigureResult = {
  statusCode: number;
  value: Record<string, unknown>;
};

export type IntegrationActionResult = IntegrationConfigureResult;

export type IntegrationServerAdapter<Status = unknown> = {
  definition: IntegrationDefinition;
  // Cheap, local-only seed for the settings shell. Network health is refreshed
  // by readStatus only when the integration card is actually mounted.
  readInitialStatus?: () => Status;
  readStatus: () => Promise<Status>;
  configure?: (input: unknown) => Promise<IntegrationConfigureResult>;
  actions?: Record<string, () => Promise<IntegrationActionResult>>;
};
