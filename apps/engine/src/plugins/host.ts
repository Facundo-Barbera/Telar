/**
 * THE REGISTRY. What holds the plugins, starts them without letting one hang the
 * daemon, takes them down without lying about what it took down, and answers
 * "which plugin owns this tool name" so that nothing else in the tree has to
 * know the answer by name.
 *
 * Three properties are worth stating because each replaces something the tree
 * used to do by hand:
 *
 *   ONE PREFIX, ONE OWNER, asserted at construction. `parseToolName` finds a
 *   capability by `startsWith`, so two plugins claiming `ds` would make tool
 *   routing depend on registration order — a bug that would appear as tools
 *   silently going to the wrong plugin. It fails loudly at startup instead.
 *
 *   INIT IS BOUNDED AND UNWINDS. A plugin that hangs, throws, or half-succeeds
 *   loses only itself: its registered cleanups run in reverse, its state becomes
 *   `failed` with the reason, and the daemon carries on. `startAll` runs the
 *   plugins concurrently, so one slow probe does not add its timeout to the
 *   others'.
 *
 *   DISABLE DRAINS. Flipping a project's switch off refuses new work
 *   immediately, lets running work finish, and releases resources once idle —
 *   see `contract.ts` for why that is three verbs and not one.
 */
import path from "node:path";
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

/** How often a drain re-checks whether a plugin's work has finished. */
const DRAIN_POLL_MS = 1_000;
/**
 * How long a drain waits for running work before releasing anyway. Generous
 * because the point of a drain is to let work finish — but not unbounded, or a
 * plugin whose `busy` is wrong would pin its resources until shutdown. Hitting
 * this ceiling is reported, never silent.
 */
const DRAIN_MAX_MS = 10 * 60_000;

type HostLog = (message: string, detail?: Record<string, unknown>) => void;

export type DrainOutcome = {
  /** New work is refused. True as soon as `drain` returned. */
  drained: boolean;
  /** Whether work was still running, so release is happening in the background. */
  stillBusy: boolean;
};

export class PluginHost {
  private readonly records = new Map<string, PluginRecord>();
  /** prefix → plugin id, built once and asserted unique. */
  private readonly prefixOwners = new Map<string, string>();
  private readonly drains = new Map<string, ReturnType<typeof setTimeout>>();
  readonly work: PluginWorkLog;
  private disposed = false;

  constructor(
    modules: readonly PluginEngineModule[],
    private readonly options: {
      daemonId: string;
      stateDir: string;
      log?: HostLog;
      /** Overridable so a test can prove the bound without waiting for it. */
      initTimeoutMs?: number;
      drainPollMs?: number;
      /** The declared prefix set to assert against. Overridable for tests only. */
      declaredPrefixes?: readonly string[];
    },
  ) {
    const declared = options.declaredPrefixes ?? BUNDLED_PLUGIN_TOOL_PREFIXES;
    for (const module of modules) {
      const { id, toolPrefixes } = module.meta;
      if (this.records.has(id)) throw new Error(`duplicate plugin id: ${id}`);
      for (const prefix of toolPrefixes) {
        const owner = this.prefixOwners.get(prefix);
        if (owner) throw new Error(`tool prefix "${prefix}" is claimed by both ${owner} and ${id}`);
        // A prefix the protocol does not declare would still WORK — the tool
        // registers and the model can call it — but every call would render as
        // an anonymous MCP row and approvals would lose their type. That is a
        // silent degradation, so it fails here instead.
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
    this.work = new PluginWorkLog(path.join(options.stateDir, "plugins", "work"), options.daemonId);
  }

  private log(message: string, detail?: Record<string, unknown>): void {
    this.options.log?.(message, detail);
  }

  /** Every registered manifest, in registration order. */
  metas(): PluginMeta[] {
    return [...this.records.values()].map((record) => record.module.meta);
  }

  /** Tool prefixes, for the protocol's capability list. */
  toolPrefixes(): string[] {
    return [...this.prefixOwners.keys()];
  }

  /** Which plugin owns a tool, by its prefix. Undefined for a tool nobody claims. */
  ownerOfTool(tool: string): string | undefined {
    for (const [prefix, id] of this.prefixOwners) if (tool.startsWith(`${prefix}_`)) return id;
    return undefined;
  }

  module(id: string): PluginEngineModule | undefined {
    return this.records.get(id)?.module;
  }

  /** A plugin whose `init` succeeded — the only kind whose tools may be served. */
  ready(id: string): PluginEngineModule | undefined {
    const record = this.records.get(id);
    return record?.state === "ready" ? record.module : undefined;
  }

  statuses(): PluginStatus[] {
    return [...this.records.values()].map((record) => ({
      meta: record.module.meta,
      state: record.state,
      ...(record.error === undefined ? {} : { error: record.error }),
      ...(record.initMs === undefined ? {} : { initMs: record.initMs }),
    }));
  }

  /** The read classifications the host honours. See `policy.ts`. */
  ratifiedReadTools(): Set<string> {
    return ratifiedReadToolSet(this.metas());
  }

  /**
   * Start every plugin. Concurrent, individually bounded, and never throwing:
   * a plugin that cannot start is a feature that is unavailable, which the
   * status list reports — not a daemon that refuses to boot.
   */
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
        // Visible, not fatal: the plugin still works, its tools just park for
        // approval. Silence here would leave an author guessing.
        this.log("plugin read-tool claims not ratified by the host; they will require approval", {
          plugin: meta.id,
          tools: refused,
        });
      }
    }
    return this.statuses();
  }

  private interrupted: PluginWorkRecord[] = [];

  /**
   * Work lost to a previous engine exit, swept at startup. Read by plugins so
   * `latex_status` can say "interrupted" instead of "never". Scoped by session
   * because that is how every caller asks.
   */
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
      // PARTIAL INITIALISATION IS THE POINT. Whatever the hook managed to
      // acquire before it failed is registered, and giving it back matters more
      // than the error message does — a failed start that leaks a subprocess is
      // worse than one that does not.
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
        // One stuck cleanup must not strand the ones behind it.
        this.log("plugin cleanup failed", {
          plugin: record.module.meta.id,
          cleanup: cleanup.name,
          reason,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * A project turned a plugin off. Refuse new work now, let running work finish,
   * release when idle.
   *
   * RETURNS AS SOON AS NEW WORK IS REFUSED, which is what the HTTP caller
   * actually needs to know — the settings write is not going to sit open for ten
   * minutes waiting for a training cell. The release happens on a timer.
   */
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
    this.watchDrain(record, projectId);
    return { drained: true, stillBusy: true };
  }

  private watchDrain(record: PluginRecord, projectId: string): void {
    const key = `${record.module.meta.id}:${projectId}`;
    if (this.drains.has(key)) return; // already watching
    const deadline = Date.now() + DRAIN_MAX_MS;
    const tick = async () => {
      this.drains.delete(key);
      if (this.disposed) return;
      const busy = record.module.hooks?.busy?.(projectId) ?? false;
      if (busy && Date.now() < deadline) {
        this.watchDrain(record, projectId);
        return;
      }
      if (busy) {
        this.log("plugin still reports work after the drain ceiling; releasing anyway", {
          plugin: record.module.meta.id,
          projectId,
          ceilingMs: DRAIN_MAX_MS,
        });
      }
      await this.release(record, projectId);
    };
    const timer = setTimeout(() => void tick(), this.options.drainPollMs ?? DRAIN_POLL_MS);
    timer.unref?.();
    this.drains.set(key, timer);
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

  /**
   * A session went away. Fans out to every ready plugin — which is what
   * replaces the store reaching for `releaseDataScience` by name, and means the
   * next plugin with per-session state does not need a line added there.
   */
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

  /**
   * Shutdown. Drops the drain watchers first — a timer firing mid-teardown would
   * release into a half-disposed host — then unwinds every plugin.
   *
   * NOTE WHAT THIS DOES NOT PROMISE. Shutdown does not wait for running work;
   * the process is going away and pretending otherwise would hang it. Work still
   * running keeps its breadcrumb, and the next startup reports it as interrupted
   * — which is the honest account of what happened.
   */
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

/** Bound a hook without leaving a timer behind on the happy path. */
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
