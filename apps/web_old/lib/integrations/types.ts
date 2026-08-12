import type { ComponentType } from "react";

export type IntegrationCapability =
  | "usage-telemetry"
  | "credential-inventory"
  | "browser"
  | "issue-tracking"
  | "notifications"
  | "source-control";

export type IntegrationDefinition<Id extends string = string> = Readonly<{
  id: Id;
  label: string;
  category: string;
  summary: string;
  capabilities: readonly IntegrationCapability[];
  // Integrations are never required for Telar's core session path. An adapter
  // may observe or augment a harness, but cannot become account/model truth.
  optional: true;
}>;

export type IntegrationSettingsProps = {
  definition: IntegrationDefinition;
  initialStatus?: unknown;
};

export type IntegrationRegistration = Readonly<{
  definition: IntegrationDefinition;
  Settings: ComponentType<IntegrationSettingsProps>;
}>;

export function defineIntegration<const Id extends string>(
  definition: IntegrationDefinition<Id>,
): IntegrationDefinition<Id> {
  return Object.freeze(definition);
}
