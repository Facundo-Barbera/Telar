import type { IntegrationServerAdapter } from "./server-types";

// Server adapters are registered separately from client-safe descriptors so
// secrets and filesystem code can never leak into the browser bundle.
export const INTEGRATION_SERVER_REGISTRY: readonly IntegrationServerAdapter[] = [];

export function integrationServerAdapter(id: string): IntegrationServerAdapter | undefined {
  return INTEGRATION_SERVER_REGISTRY.find((adapter) => adapter.definition.id === id);
}
