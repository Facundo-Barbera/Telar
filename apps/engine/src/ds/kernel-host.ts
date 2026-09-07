/**
 * One kernel per session, owned by the daemon.
 *
 * DAEMON-OWNED, NOT WORKER-OWNED. The browser lives in the worker because it
 * exists only inside a turn and dies with the lease. A kernel is the opposite:
 * its whole value is state that OUTLIVES the turn that created it, and the
 * notebook panel has to run a cell when no agent turn is running at all. So
 * the host sits beside the store, keyed by session id, and both doors — the
 * worker's toolkit and the cockpit's HTTP — reach the same process.
 *
 * LAZY, BOUNDED, REAPED. Nothing starts until the first execute; an idle
 * kernel is shut down after `idleMs`; more than `maxKernels` live at once
 * evicts the least recently used. A pid file beside the session records what
 * was spawned, so a daemon that crashed can kill what it left on the next
 * start rather than accumulating orphans.
 *
 * `bridge.py` IS IMPORTED AS TEXT and written to disk under a content hash on
 * first use — so a bridge upgrade is a new file, never an overwrite of one a
 * live kernel is still running from.
 */
/// <reference path="./bridge-source.d.ts" />
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
// Bun's text loader; the reference above makes the `*.py` module visible to
// ANY tsconfig that pulls this file in, not only the engine's own.
import BRIDGE_SOURCE from "./bridge.py" with { type: "text" };
import { KernelBridge, type SpawnBridge } from "./kernel-bridge";
import { CellOutput, type ExecResult, type KernelState } from "./outputs";

export type KernelSpec = {
  sessionId: string;
  /** Telar's venv python — the one with jupyter_client. */
  bridgePython: string;
  /** The project's site-packages, prepended to the kernel's PYTHONPATH. */
  sitePackages: string[];
  cwd: string;
};

export type KernelInfo = {
  sessionId: string;
  state: KernelState;
  startedAt?: number;
  lastUsedAt?: number;
  executionCount?: number;
  pid?: number;
  modules?: Record<string, boolean>;
};

export type KernelHostEvents = {
  onState?: (sessionId: string, state: KernelState, reason?: string) => void;
  /** Every output as it arrives — the host has already persisted images. */
  onOutput?: (sessionId: string, execId: string, cellId: string | undefined, output: CellOutput) => void;
  /** Called with raw bytes; returns the attachment id to put in the output. */
  persistImage?: (sessionId: string, input: { mediaType: string; data: Uint8Array; producer: string }) => string;
};

type Entry = {
  bridge: KernelBridge;
  info: KernelInfo;
  waiters: Map<string, CellOutput[]>;
  chain: Promise<unknown>;
};

export type KernelHostOptions = {
  engineRoot: string;
  sessionDir: (sessionId: string) => string;
  idleMs?: number;
  maxKernels?: number;
  now?: () => number;
  spawnImpl?: SpawnBridge;
  events?: KernelHostEvents;
};

export class KernelHost {
  private readonly kernels = new Map<string, Entry>();
  private readonly reaper: ReturnType<typeof setInterval>;
  private readonly now: () => number;
  private readonly idleMs: number;
  private readonly maxKernels: number;

  constructor(private readonly options: KernelHostOptions) {
    this.now = options.now ?? Date.now;
    this.idleMs = options.idleMs ?? 30 * 60_000;
    this.maxKernels = options.maxKernels ?? 8;
    this.reaper = setInterval(() => this.reap(), 60_000);
    this.reaper.unref?.();
    this.reapOrphans();
  }

  /** Where the bridge script lives on disk, written once per content hash. */
  bridgeFile(): string {
    const hash = crypto.createHash("sha256").update(BRIDGE_SOURCE).digest("hex").slice(0, 16);
    const dir = path.join(this.options.engineRoot, "python");
    const file = path.join(dir, `bridge-${hash}.py`);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, BRIDGE_SOURCE, { mode: 0o600 });
    }
    return file;
  }

  private pidFile(sessionId: string): string {
    return path.join(this.options.sessionDir(sessionId), "ds", "kernel.json");
  }

  /** Kill what a crashed daemon left behind, once, at start. */
  private reapOrphans(): void {
    const sessions = path.join(this.options.engineRoot, "sessions");
    let names: string[] = [];
    try { names = fs.readdirSync(sessions); } catch { return; }
    for (const name of names) {
      const file = path.join(sessions, name, "ds", "kernel.json");
      try {
        const record = JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: number; kernelPid?: number };
        for (const pid of [record.pid, record.kernelPid]) if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
        fs.rmSync(file, { force: true });
      } catch { /* no record */ }
    }
  }

  info(sessionId: string): KernelInfo | undefined {
    return this.kernels.get(sessionId)?.info;
  }

  list(): KernelInfo[] {
    return [...this.kernels.values()].map((entry) => entry.info);
  }

  /** Start if absent. Resolves once the kernel answers `idle`. */
  async ensure(spec: KernelSpec): Promise<KernelInfo> {
    const existing = this.kernels.get(spec.sessionId);
    if (existing && existing.bridge.alive) return existing.info;
    if (existing) this.kernels.delete(spec.sessionId);

    while (this.kernels.size >= this.maxKernels) {
      const oldest = [...this.kernels.entries()].sort((a, b) => (a[1].info.lastUsedAt ?? 0) - (b[1].info.lastUsedAt ?? 0))[0];
      if (!oldest) break;
      await this.dispose(oldest[0], "evicted: too many live kernels");
    }

    const bridge = new KernelBridge(spec.bridgePython, this.bridgeFile(), { cwd: spec.cwd, ...(this.options.spawnImpl ? { spawnImpl: this.options.spawnImpl } : {}) });
    const info: KernelInfo = { sessionId: spec.sessionId, state: "starting", startedAt: this.now(), lastUsedAt: this.now(), pid: bridge.pid };
    const entry: Entry = { bridge, info, waiters: new Map(), chain: Promise.resolve() };
    this.kernels.set(spec.sessionId, entry);

    bridge.onNotification = ({ method, params }) => {
      if (method === "status") {
        const state = String(params.state) as KernelState;
        info.state = state;
        this.options.events?.onState?.(spec.sessionId, state, typeof params.reason === "string" ? params.reason : undefined);
        return;
      }
      if (method === "output") {
        const execId = String(params.execId);
        const cellId = typeof params.cellId === "string" ? params.cellId : undefined;
        const parsed = CellOutput.safeParse(params.output);
        if (!parsed.success) return;
        const output = this.persist(spec.sessionId, parsed.data, cellId ?? execId);
        entry.waiters.get(execId)?.push(output);
        this.options.events?.onOutput?.(spec.sessionId, execId, cellId, output);
        return;
      }
      if (method === "exec_done" && typeof params.executionCount === "number") info.executionCount = params.executionCount;
    };
    bridge.onClose = (error) => {
      if (this.kernels.get(spec.sessionId) === entry) this.kernels.delete(spec.sessionId);
      info.state = "dead";
      this.options.events?.onState?.(spec.sessionId, "dead", error.message);
      fs.rmSync(this.pidFile(spec.sessionId), { force: true });
    };

    try {
      const started = await bridge.request<{ pid?: number }>("start", { cwd: spec.cwd, sitePackages: spec.sitePackages });
      const record = { pid: bridge.pid, kernelPid: started.pid ?? null, startedAt: info.startedAt };
      fs.mkdirSync(path.dirname(this.pidFile(spec.sessionId)), { recursive: true });
      fs.writeFileSync(this.pidFile(spec.sessionId), JSON.stringify(record), { mode: 0o600 });
      info.modules = (await bridge.request<{ modules: Record<string, boolean> }>("probe", { modules: ["pandas", "matplotlib", "duckdb", "pyarrow", "polars"] })).modules;
    } catch (error) {
      bridge.kill();
      this.kernels.delete(spec.sessionId);
      throw error;
    }
    return info;
  }

  private persist(sessionId: string, output: CellOutput, producer: string): CellOutput {
    if (output.kind !== "image" || !output.dataB64 || !this.options.events?.persistImage) return output;
    const data = new Uint8Array(Buffer.from(output.dataB64, "base64"));
    const attachmentId = this.options.events.persistImage(sessionId, { mediaType: output.mediaType, data, producer });
    const { dataB64: _dropped, ...rest } = output;
    return { ...rest, attachmentId };
  }

  private entry(sessionId: string): Entry {
    const entry = this.kernels.get(sessionId);
    if (!entry || !entry.bridge.alive) throw new Error("no live kernel for this session; start one first");
    entry.info.lastUsedAt = this.now();
    return entry;
  }

  /** Serialized per kernel: one shell channel, one execute at a time. */
  execute(sessionId: string, input: { code: string; cellId?: string; timeoutMs?: number }): Promise<ExecResult> {
    const entry = this.entry(sessionId);
    const run = async (): Promise<ExecResult> => {
      const outputs: CellOutput[] = [];
      // The bridge mints execId; we learn it from the first notification or the
      // reply. Register under a placeholder keyed by the request, then remap.
      const placeholder = `pending_${crypto.randomUUID()}`;
      entry.waiters.set(placeholder, outputs);
      const remap = ({ method, params }: { method: string; params: Record<string, unknown> }) => {
        if (method === "output" && typeof params.execId === "string" && !entry.waiters.has(params.execId)) {
          entry.waiters.set(params.execId, outputs);
        }
      };
      const previous = entry.bridge.onNotification;
      entry.bridge.onNotification = (n) => { remap(n); previous?.(n); };
      try {
        const reply = await entry.bridge.request<Omit<ExecResult, "outputs">>("execute", { code: input.code, ...(input.cellId ? { cellId: input.cellId } : {}), ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}) });
        return { ...reply, outputs };
      } finally {
        entry.bridge.onNotification = previous;
        for (const [key, value] of entry.waiters) if (value === outputs) entry.waiters.delete(key);
      }
    };
    const next = entry.chain.then(run, run);
    entry.chain = next.catch(() => undefined);
    return next;
  }

  interrupt(sessionId: string): Promise<void> {
    return this.entry(sessionId).bridge.request("interrupt").then(() => undefined);
  }

  restart(sessionId: string): Promise<void> {
    const entry = this.entry(sessionId);
    const next = entry.chain.then(() => entry.bridge.request("restart", { clearState: true }), () => entry.bridge.request("restart", { clearState: true }));
    entry.chain = next.catch(() => undefined);
    return next.then(() => undefined);
  }

  call<T>(sessionId: string, method: "list_vars" | "inspect_var" | "snapshot" | "checkpoint" | "restore" | "probe", params?: unknown): Promise<T> {
    const entry = this.entry(sessionId);
    const next = entry.chain.then(() => entry.bridge.request<T>(method, params), () => entry.bridge.request<T>(method, params));
    entry.chain = next.catch(() => undefined);
    return next;
  }

  async dispose(sessionId: string, reason: string): Promise<void> {
    const entry = this.kernels.get(sessionId);
    if (!entry) return;
    this.kernels.delete(sessionId);
    const killer = setTimeout(() => entry.bridge.kill(), 5_000);
    try { await entry.bridge.request("shutdown"); } catch { /* already gone */ }
    clearTimeout(killer);
    entry.bridge.kill();
    entry.info.state = "dead";
    this.options.events?.onState?.(sessionId, "dead", reason);
    fs.rmSync(this.pidFile(sessionId), { force: true });
  }

  private reap(): void {
    const cutoff = this.now() - this.idleMs;
    for (const [sessionId, entry] of this.kernels) {
      if (entry.info.state === "idle" && (entry.info.lastUsedAt ?? 0) < cutoff) void this.dispose(sessionId, "idle");
    }
  }

  async disposeAll(reason: string): Promise<void> {
    clearInterval(this.reaper);
    await Promise.all([...this.kernels.keys()].map((sessionId) => this.dispose(sessionId, reason)));
  }
}
