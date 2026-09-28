import path from "node:path";

export type EngineStatePaths = {
  root: string;
  projects: string;
  machinePlugins: string;
  claudeDefault: string;
  claudeLongWindowMigration: string;
  claudeCompactionMigration: string;
  sessions: string;
  mcpServers: string;
  providerInstances: string;
  providerSecrets: string;
  modelOverlays: string;
  modelCatalogues: string;
  mcpOAuth: string;
  mcpOAuthPending: string;
  inbox: string;
  retention: string;
  orientation: string;
  usageLimitSources: string;
  usageLimitSecrets: string;
  subscriptions: string;
  cohorts: string;
  textGen: string;
  sessionDefaults: string;
  plannedRestart: string;
  workspace: string;
  cleanup: string;
  sidebarLayout: string;
  appearance: string;
  engine: string;
  lock: string;
  executionStore: string;
  taskStops: string;
  worktreesLocation: string;
  usageScanCache: string;
  usageModelRates: string;
  mainSession: string;
  decommissionMarker: string;
  retired: string;
  agentRetiredMarker: string;
  browserProfiles: string;
  diagnostics: string;
  nodeModulesReaped: string;
};

export function statePaths(root: string): EngineStatePaths {
  const resolved = path.resolve(root);
  return {
    root: resolved,
    projects: path.join(resolved, "projects.json"),
    machinePlugins: path.join(resolved, "machine-plugins.json"),
    claudeDefault: path.join(resolved, "claude-default-model.json"),
    claudeLongWindowMigration: path.join(resolved, "claude-long-window-migration.json"),
    claudeCompactionMigration: path.join(resolved, "claude-compaction-migration.json"),
    sessions: path.join(resolved, "sessions"),
    mcpServers: path.join(resolved, "mcp-servers.json"),
    providerInstances: path.join(resolved, "provider-instances.json"),
    providerSecrets: path.join(resolved, "provider-secrets.json"),
    modelOverlays: path.join(resolved, "model-overlays.json"),
    modelCatalogues: path.join(resolved, "model-catalogues.json"),
    mcpOAuth: path.join(resolved, "mcp-oauth.json"),
    mcpOAuthPending: path.join(resolved, "mcp-oauth-pending.json"),
    inbox: path.join(resolved, "inbox.json"),
    retention: path.join(resolved, "retention.json"),
    orientation: path.join(resolved, "orientation.json"),
    usageLimitSources: path.join(resolved, "usage-limit-sources.json"),
    usageLimitSecrets: path.join(resolved, "usage-limit-secrets.json"),
    subscriptions: path.join(resolved, "subscriptions.json"),
    cohorts: path.join(resolved, "cohorts.json"),
    textGen: path.join(resolved, "text-generation.json"),
    sessionDefaults: path.join(resolved, "session-defaults.json"),
    plannedRestart: path.join(resolved, "planned-restart.json"),
    workspace: path.join(resolved, "workspace.json"),
    cleanup: path.join(resolved, "cleanup.json"),
    sidebarLayout: path.join(resolved, "sidebar-layout.json"),
    appearance: path.join(resolved, "appearance.json"),
    engine: path.join(resolved, "engine.json"),
    lock: path.join(resolved, "engine.lock"),
    executionStore: path.join(resolved, "execution-store.json"),
    taskStops: path.join(resolved, "task-stops.json"),
    worktreesLocation: path.join(resolved, "worktrees-location.json"),
    usageScanCache: path.join(resolved, "usage-scan-cache.json"),
    usageModelRates: path.join(resolved, "usage-model-rates.json"),
    mainSession: path.join(resolved, "main-session.json"),
    decommissionMarker: path.join(resolved, "decommissioned-spool-looms"),
    retired: path.join(resolved, "retired"),
    agentRetiredMarker: path.join(resolved, "decommissioned-agent"),
    browserProfiles: path.join(resolved, "browser-profiles"),
    diagnostics: path.join(resolved, "diagnostics"),
    nodeModulesReaped: path.join(resolved, "node-modules-reaped"),
  };
}
