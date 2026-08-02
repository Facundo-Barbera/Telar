import type { IntegrationDefinition, IntegrationRegistration } from "./types";

// The only shared registration point. Adding an integration means adding one
// self-contained module and one line here; removing it is the inverse. Core
// provider/session code depends only on generic capability contracts and never
// on this registry.
export const INTEGRATION_REGISTRY: readonly IntegrationRegistration[] = [];

export type RegisteredIntegrationId = string;

export function integrationDefinition(id: string): IntegrationDefinition | undefined {
  return INTEGRATION_REGISTRY.find((integration) => integration.definition.id === id)?.definition;
}
