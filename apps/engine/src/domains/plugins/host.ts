import path from "node:path";
import { z } from "zod";
import { BUNDLED_PLUGIN_TOOL_PREFIXES, type PluginMeta, type PluginStatus } from "@telar/engine-client";
import {
  PLUGIN_DISPOSE_TIMEOUT_MS,
  PLUGIN_INIT_TIMEOUT_MS,
  type PluginDisposeReason,
  type PluginEngineModule,
  type PluginRecord,
} from "./contract";
import { ratifiedReadToolSet, unratifiedReadClaims } from "./policy";
import { PluginWorkLog, type PluginWorkRecord } from "./work-log";

const DRAIN_POLL_MS = 1_000;
const DRAIN_MAX_MS = 10 * 60_000;

type HostLog = (message: string, detail?: Record<string, unknown>) => void;

export type DrainOutcome = {
  drained: boolean;
  stillBusy: boolean;
};

export class PluginHost {
  private readonly records = new Map<string, PluginRecord>();
  private readonly prefixOwners = new Map<string, string>();
  private readonly drains = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly drainGenerations = new Map<string, number>();
  readonly work: PluginWorkLog;
  private disposed = false;

  constructor(
    modules: readonly PluginEngineModule[],
    private readonly options: {
      daemonId: string;
      stateDir: string;
      log?: HostLog;
      initTimeoutMs?: number;
      drainPollMs?: number;
      drainMaxMs?: number;
      declaredPrefixes?: readonly string[];
      refused?: readonly { meta: PluginMeta; error: string; installed?: { linked: boolean } }[];
    },
  ) {
    const declared = options.declaredPrefixes ?? BUNDLED_PLUGIN_TOOL_PREFIXES;
    for (const module of modules) {
      const { id, toolPrefixes } = module.meta;
      if (this.records.has(id)) throw new Error(`duplicate plugin id: ${id}`);
      for (const prefix of toolPrefixes) {
        const owner = this.prefixOwners.get(prefix);
        if (owner) throw new Error(`tool prefix "${prefix}" is claimed by both ${owner} and ${id}`);
        if (!declared.includes(prefix)) {
          throw new Error(
            `plugin ${id} claims tool prefix "${prefix}", which is not declared in BUNDLED_PLUGIN_TOOL_PREFIXES; ` +
              "add it there so approvals and timeline rows keep their type",
          );
        }
        this.prefixOwners.set(prefix, id);
      }
      this.records.set(id, { module, state: "ready", cleanups: [] });
    }
    for (const { meta, error, installed } of options.refused ?? []) this.refuse(meta, error, installed);
    this.work = new PluginWorkLog(path.join(options.stateDir, "plugins", "work"), options.daemonId);
  }

  refuse(meta: PluginMeta, error: string, installed?: { linked: boolean }): void {
    if (this.records.has(meta.id)) return;
    this.records.set(meta.id, { module: { meta, ...(installed ? { installed } : {}) }, state: "failed", error, cleanups: [] });
  }

  private log(message: string, detail?: Record<string, unknown>): void {
    this.options.log?.(message, detail);
  }

  metas(): PluginMeta[] {
    return [...this.records.values()].map((record) => record.module.meta);
  }

  toolPrefixes(): string[] {
    return [...this.prefixOwners.keys()];
  }

  ownerOfTool(tool: string): string | undefined {
    for (const [prefix, id] of this.prefixOwners) if (tool.startsWith(`${prefix}_`)) return id;
    return undefined;
  }

  module(id: string): PluginEngineModule | undefined {
    return this.records.get(id)?.module;
  }

  ready(id: string): PluginEngineModule | undefined {
    const record = this.records.get(id);
    return record?.state === "ready" ? record.module : undefined;
  }

  statuses(): PluginStatus[] {
    return [...this.records.values()].map((record) => {
      const project = record.module.publishedSettingsSchema ?? settingsJsonSchema(record.module.settingsSchema);
      const machine = record.module.publishedMachineSettingsSchema ?? settingsJsonSchema(record.module.machineSettingsSchema);
      return {
        meta: record.module.meta,
        state: record.state,
        ...(record.error === undefined ? {} : { error: record.error }),
        ...(record.initMs === undefined ? {} : { initMs: record.initMs }),
        ...(project ? { settingsSchema: project } : {}),
        ...(machine ? { machineSettingsSchema: machine } : {}),
        ...(record.module.installed ? { installed: record.module.installed } : {}),
      };
    });
  }

  ratifiedReadTools(): Set<string> {
    return ratifiedReadToolSet(this.metas());
  }

  async add(module: PluginEngineModule): Promise<PluginStatus> {
    const { id, toolPrefixes } = module.meta;
    const existing = this.records.get(id);
    if (existing && existing.state !== "failed") throw new Error(`duplicate plugin id: ${id}`);
    for (const prefix of toolPrefixes) {
      const owner = this.prefixOwners.get(prefix);
      if (owner && owner !== id) throw new Error(`tool prefix "${prefix}" is claimed by both ${owner} and ${id}`);
    }
    if (existing) await this.remove(id);
    for (const prefix of toolPrefixes) this.prefixOwners.set(prefix, id);
    this.records.set(id, { module, state: "ready", cleanups: [] });
    await this.start(id);
    return this.statuses().find((status) => status.meta.id === id)!;
  }

  async remove(id: string): Promise<void> {
    const record = this.records.get(id);
    if (!record) return;
    this.records.delete(id);
    for (const [prefix, owner] of this.prefixOwners) if (owner === id) this.prefixOwners.delete(prefix);
    for (const [key, timer] of this.drains) {
      if (key.startsWith(`${id}:`)) {
        clearTimeout(timer);
        this.drains.delete(key);
      }
    }
    await this.unwind(record, "disabled");
  }

  async startAll(): Promise<PluginStatus[]> {
    const interrupted = this.work.claimInterrupted();
    if (interrupted.length > 0) {
      this.log("plugin work interrupted by a previous engine exit", {
        count: interrupted.length,
        plugins: [...new Set(interrupted.map((record) => record.plugin))],
      });
    }
    this.interrupted = interrupted;
    await Promise.all([...this.records.keys()].map((id) => this.start(id)));
    for (const meta of this.metas()) {
      const refused = unratifiedReadClaims(meta);
      if (refused.length > 0) {
        this.log("plugin read-tool claims not ratified by the host; they will require approval", {
          plugin: meta.id,
          tools: refused,
        });
      }
    }
    return this.statuses();
  }

  private interrupted: PluginWorkRecord[] = [];

  interruptedWork(filter?: { plugin?: string; sessionId?: string }): PluginWorkRecord[] {
    return this.interrupted.filter(
      (record) =>
        (filter?.plugin === undefined || record.plugin === filter.plugin) &&
        (filter?.sessionId === undefined || record.sessionId === filter.sessionId),
    );
  }

  private async start(id: string): Promise<void> {
    const record = this.records.get(id);
    if (!record || !record.module.init) return;
    const startedAt = Date.now();
    const context = {
      daemonId: this.options.daemonId,
      stateDir: path.join(this.options.stateDir, "plugins", id),
      work: this.work,
      onDispose: (name: string, cleanup: () => void | Promise<void>) => {
        record.cleanups.unshift({ name, run: cleanup });
      },
    };
    const budget = this.options.initTimeoutMs ?? PLUGIN_INIT_TIMEOUT_MS;
    try {
      await withTimeout(
        Promise.resolve(record.module.init(context)),
        budget,
        `plugin ${id} did not finish starting within ${budget}ms`,
      );
      record.initMs = Date.now() - startedAt;
    } catch (error) {
      record.state = "failed";
      record.error = error instanceof Error ? error.message : String(error);
      record.initMs = Date.now() - startedAt;
      this.log("plugin failed to start; unwinding what it acquired", {
        plugin: id,
        error: record.error,
        cleanups: record.cleanups.length,
      });
      await this.unwind(record, "init_failed");
    }
  }

  private async unwind(record: PluginRecord, reason: PluginDisposeReason): Promise<void> {
    const cleanups = record.cleanups.splice(0, record.cleanups.length);
    for (const cleanup of cleanups) {
      try {
        await withTimeout(
          Promise.resolve(cleanup.run()),
          PLUGIN_DISPOSE_TIMEOUT_MS,
          `plugin ${record.module.meta.id} cleanup "${cleanup.name}" did not finish`,
        );
      } catch (error) {
        this.log("plugin cleanup failed", {
          plugin: record.module.meta.id,
          cleanup: cleanup.name,
          reason,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async drainProject(id: string, projectId: string, reason: PluginDisposeReason = "disabled"): Promise<DrainOutcome> {
    const record = this.records.get(id);
    if (!record || record.state !== "ready") return { drained: true, stillBusy: false };
    const hooks = record.module.hooks;
    try {
      await hooks?.drain?.(projectId, reason);
    } catch (error) {
      this.log("plugin drain failed", { plugin: id, error: error instanceof Error ? error.message : String(error) });
    }
    if (!hooks?.busy?.(projectId)) {
      await this.release(record, projectId);
      return { drained: true, stillBusy: false };
    }
    const key = `${record.module.meta.id}:${projectId}`;
    const pending = this.drains.get(key);
    if (pending) clearTimeout(pending);
    this.drains.delete(key);
    const generation = (this.drainGenerations.get(key) ?? 0) + 1;
    this.drainGenerations.set(key, generation);
    this.watchDrain(record, projectId, Date.now() + (this.options.drainMaxMs ?? DRAIN_MAX_MS), generation);
    return { drained: true, stillBusy: true };
  }

  private watchDrain(record: PluginRecord, projectId: string, deadline: number, generation: number): void {
    const key = `${record.module.meta.id}:${projectId}`;
    if (this.drains.has(key)) return;
    const tick = async () => {
      this.drains.delete(key);
      if (this.disposed) return;
      if ((this.drainGenerations.get(key) ?? 0) !== generation) return;
      const busy = record.module.hooks?.busy?.(projectId) ?? false;
      if (busy && Date.now() < deadline) {
        this.watchDrain(record, projectId, deadline, generation);
        return;
      }
      if (busy) {
        this.log("plugin still has work after the drain ceiling; resources stay held until it finishes", {
          plugin: record.module.meta.id,
          projectId,
          ceilingMs: this.options.drainMaxMs ?? DRAIN_MAX_MS,
        });
        return;
      }
      await this.release(record, projectId);
    };
    const timer = setTimeout(() => void tick(), this.options.drainPollMs ?? DRAIN_POLL_MS);
    timer.unref?.();
    this.drains.set(key, timer);
  }

  cancelDrain(id: string, projectId: string): void {
    const key = `${id}:${projectId}`;
    const timer = this.drains.get(key);
    if (timer) clearTimeout(timer);
    this.drains.delete(key);
    this.drainGenerations.set(key, (this.drainGenerations.get(key) ?? 0) + 1);
  }

  private async release(record: PluginRecord, projectId: string): Promise<void> {
    try {
      await record.module.hooks?.releaseProject?.(projectId);
    } catch (error) {
      this.log("plugin project release failed", {
        plugin: record.module.meta.id,
        projectId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async releaseSession(sessionId: string, reason: string): Promise<void> {
    await Promise.all(
      [...this.records.values()]
        .filter((record) => record.state === "ready")
        .map(async (record) => {
          try {
            await record.module.hooks?.releaseSession?.(sessionId, reason);
          } catch (error) {
            this.log("plugin session release failed", {
              plugin: record.module.meta.id,
              sessionId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }),
    );
  }

  async disposeAll(reason: PluginDisposeReason = "shutdown"): Promise<void> {
    this.disposed = true;
    for (const timer of this.drains.values()) clearTimeout(timer);
    this.drains.clear();
    for (const record of this.records.values()) {
      await this.unwind(record, reason);
      if (record.state === "ready") record.state = "disposed";
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function settingsJsonSchema(schema: z.ZodType<unknown> | undefined): Record<string, unknown> | undefined {
  if (!schema) return undefined;
  try {
    return z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
