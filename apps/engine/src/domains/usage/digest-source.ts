import type { UsageDigest } from "@telar/engine-client";
import os from "node:os";
import path from "node:path";
import type { EngineStore } from "../../state";
import { buildUsageDigest } from "./digest";
import { loadRates } from "./pricing";
import { readUsageReport } from "./scan";
import { attributeClaudeLogs } from "./log-attribution";
import { defaultWorktreesRoot, readWorktreesRoot, rootOf } from "../worktrees";

const MONTH_MS = 30 * 86_400_000;

export async function usageDigestFor(store: EngineStore, exclude?: (sessionId: string) => boolean): Promise<{ digest: UsageDigest; names: Record<string, string> }> {
  const now = store.kernel.now();
  const [rates, report] = await Promise.all([
    loadRates(store.paths.usageModelRates),
    readUsageReport({ sinceMs: now - MONTH_MS, untilMs: now, resolution: "day", timeZone: "UTC" }, { ratesCachePath: store.paths.usageModelRates, scanCachePath: store.paths.usageScanCache }),
  ]);
  const logs = new Map<string, { provider: string; tokens: number; costUsd: number }>();
  for (const bucket of report.buckets) {
    const entry = logs.get(bucket.driver) ?? { provider: bucket.driver, tokens: 0, costUsd: 0 };
    entry.tokens += bucket.tokens.input + bucket.tokens.output + bucket.tokens.cacheRead + bucket.tokens.cacheCreate;
    entry.costUsd += bucket.costUsd;
    logs.set(bucket.driver, entry);
  }
  const defaults = store.settings.sessionDefaults();
  const textGen = store.settings.textGen();
  const registered = store.projectRegistry.list({ includeRemoved: true });
  const projects = new Map(registered.map((project) => [project.id, project.name]));
  const storeSessions = new Set(
    store.kernel.executionStore
      .statement("SELECT json_extract(value,'$.resumeCursor') cursor FROM documents WHERE key LIKE 'sessions/%/session.json'")
      .all()
      .flatMap((row) => (typeof row.cursor === "string" ? [row.cursor] : [])),
  );
  const claudeHome = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude");
  const claudeLogs = await attributeClaudeLogs({
    logsRoot: path.join(claudeHome, "projects"),
    sinceMs: now - MONTH_MS,
    rates,
    storeSessions,
    storeFolders: [rootOf(readWorktreesRoot(store.paths.root)) ?? defaultWorktreesRoot(store.paths.root)],
    telarFolders: registered.map((project) => project.root),
  });
  return buildUsageDigest({
    claudeLogs,
    projectRoots: registered.map((project) => ({ id: project.id, root: project.root })),
    db: store.kernel.executionStore,
    now,
    rates,
    providerLogs: [...logs.values()],
    projectName: (projectId) => projects.get(projectId),
    ...(exclude ? { exclude } : {}),
    config: {
      defaultRuntimeMode: defaults.runtimeMode ?? "default",
      continueAfterReset: defaults.resumeAfterRateLimit ?? true,
      generatedTextTitles: textGen.titles,
      generatedTextModel: textGen.model ?? "default",
      generatedTextEffort: textGen.effort ?? "default",
      orientation: store.settings.orientation().preamble,
      mcpServers: store.mcpServers.list().filter((server) => server.enabled).length,
      projects: projects.size,
    },
  });
}
