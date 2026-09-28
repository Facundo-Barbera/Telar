import { CLAUDE_COMPACTION_ENV_NAMES, defaultInstanceIdForDriver, migrateClaudeCompaction, migrateLegacyPluginFields, type Item, type ProviderInstanceEnvVar } from "@telar/engine-client";
import type { Kernel } from "../../platform/kernel";
import { legacyLongSpelling, type ModelManifest } from "../providers";
import { sessionMetadataFile, type SessionItems, type SessionQueues } from "../sessions";
import { summariseTurn } from "../turns";

/**
 * Folds legacy `dataScience` / `latex` blocks into the plugin map on every open, because an engine rolled back
 * to writes them again. Idempotent and non-destructive: an existing map entry wins, and a clean registry is not written.
 */
export function migrateLegacyPluginFieldsOnOpen(kernel: Kernel): number {
  return kernel.command("migrateLegacyPluginFields", () => {
    let projects = 0;
    try {
      const stored = kernel.readDocument(kernel.paths.projects) as { projects?: Record<string, unknown>[] } | undefined;
      const next = (stored?.projects ?? []).map((project) => {
        const migrated = migrateLegacyPluginFields(project);
        if (migrated.changed) projects += 1;
        return migrated.project;
      });
      if (projects > 0) kernel.writeDocument(kernel.paths.projects, { ...stored, projects: next });
    } catch {
      // Reported by every other reader of the registry.
    }
    return projects;
  });
}

/**
 * Once, marked: a Claude login's compaction env rows become the per-class setting. Reads the raw registry, which
 * `readProviderInstances` would seed; a login whose rows are sensitive keeps them, as their values live in the secrets file.
 */
export function migrateClaudeCompactionToLimits(kernel: Kernel): number | undefined {
  if (kernel.readDocument(kernel.paths.claudeCompactionMigration) !== undefined) return undefined;
  return kernel.command("migrateClaudeCompactionToLimits", () => {
    let logins = 0;
    try {
      const stored = kernel.readDocument(kernel.paths.providerInstances) as { providerInstances?: Record<string, unknown>[] } | undefined;
      const next = (stored?.providerInstances ?? []).map((instance) => {
        const env = instance.env as ProviderInstanceEnvVar[] | undefined;
        if (instance.driver !== "claude" || !Array.isArray(env) || instance.autoCompact !== undefined) return instance;
        if (env.some((variable) => CLAUDE_COMPACTION_ENV_NAMES.includes(variable.name) && variable.sensitive)) return instance;
        const migrated = migrateClaudeCompaction(env);
        if (!migrated) return instance;
        logins += 1;
        return { ...instance, env: migrated.env, ...(migrated.autoCompact ? { autoCompact: migrated.autoCompact } : {}) };
      });
      if (logins > 0) kernel.writeDocument(kernel.paths.providerInstances, { ...stored, providerInstances: next });
    } catch {
      // A registry that will not parse is reported by every other reader of it.
    }
    kernel.writeDocument(kernel.paths.claudeCompactionMigration, { version: 1, at: kernel.now(), logins });
    return logins;
  });
}

/**
 * Once, marked, and before the first claim: records saved when a bare Claude id meant 1M get the explicit `[1m]` id
 * they always ran as, so they do not silently halve their window. Reads session metadata only; idempotent anyway.
 */
export function migrateBareClaudeIds(kernel: Kernel, sessionIds: () => string[], manifest: ModelManifest): { sessions: number; projects: number } | undefined {
  if (kernel.readDocument(kernel.paths.claudeLongWindowMigration) !== undefined) return undefined;
  const rewrite = (selection: unknown): string | undefined => {
    const model = (selection as { model?: unknown } | undefined)?.model;
    if (typeof model !== "string") return undefined;
    const long = legacyLongSpelling(model, manifest);
    return long === model ? undefined : long;
  };
  return kernel.command("migrateBareClaudeIds", () => {
    let sessions = 0;
    for (const id of sessionIds()) {
      try {
        const file = sessionMetadataFile(kernel.paths, id);
        const raw = kernel.readDocument(file) as { driver?: unknown; model?: Record<string, unknown> } | undefined;
        if (!raw || raw.driver !== "claude") continue;
        const long = rewrite(raw.model);
        if (!long) continue;
        kernel.writeDocument(file, { ...raw, model: { ...raw.model, model: long } });
        sessions += 1;
      } catch {
        // One unreadable session must not stop an engine from starting.
      }
    }
    let projects = 0;
    try {
      const stored = kernel.readDocument(kernel.paths.projects) as { projects?: Record<string, unknown>[] } | undefined;
      // The raw registry: `readProviderInstances` seeds one on first read and would make this pass write a file.
      const registry = kernel.readDocument(kernel.paths.providerInstances) as { providerInstances?: { id?: unknown; driver?: unknown }[] } | undefined;
      const claudeInstances = new Set(
        (registry?.providerInstances ?? []).flatMap((instance) => (instance.driver === "claude" && typeof instance.id === "string" ? [instance.id] : [])),
      );
      claudeInstances.add(defaultInstanceIdForDriver("claude"));
      const next = (stored?.projects ?? []).map((project) => {
        const selection = project.defaultModel as { instanceId?: unknown } | undefined;
        if (typeof selection?.instanceId !== "string" || !claudeInstances.has(selection.instanceId)) return project;
        const long = rewrite(selection);
        if (!long) return project;
        projects += 1;
        return { ...project, defaultModel: { ...selection, model: long } };
      });
      if (projects > 0) kernel.writeDocument(kernel.paths.projects, { ...stored, projects: next });
    } catch {
      // A registry that will not parse is reported by every other reader of it.
    }
    kernel.writeDocument(kernel.paths.claudeLongWindowMigration, { version: 1, at: kernel.now(), sessions, projects });
    return { sessions, projects };
  });
}

/**
 * Gives every turn a summary row: whole sessions at a time, only those with no rows at all, parsing `items.json`
 * once each. It migrates no items (the open path must stay cheap) and never throws for one bad session.
 */
export function backfillTurnSummaries(kernel: Kernel, items: SessionItems, queues: SessionQueues): { sessions: number; turns: number } {
  const store = kernel.executionStore;
  const missing = store.turnSummaryGaps();
  if (missing.length === 0) return { sessions: 0, turns: 0 };
  let turns = 0;
  let sessions = 0;
  items.withoutMigration(() => {
    for (const sessionId of missing) {
      try {
        kernel.command("backfillTurnSummaries", () => {
          const queue = queues.read(sessionId);
          if (queue.turns.length === 0) return;
          const byRun = new Map<string, Item[]>();
          for (const item of items.values(sessionId)) {
            const filed = byRun.get(item.runId);
            if (filed) filed.push(item);
            else byRun.set(item.runId, [item]);
          }
          for (const turn of queue.turns) store.writeTurnSummary(summariseTurn(turn, byRun.get(turn.runId) ?? []));
          turns += queue.turns.length;
          sessions += 1;
        });
      } catch {
        // Unreadable is skipped, not thrown.
      }
    }
  });
  // Drop everything read to get here, so the first read after a start pays for its own projection.
  items.clear();
  queues.clear();
  return { sessions, turns };
}
