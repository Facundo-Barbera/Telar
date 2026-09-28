import path from "node:path";
import { machineAllows, type ProjectPlugins, type Session, type TurnAttachment } from "@telar/engine-client";
import { EngineStateError, type JournalEntry } from "../../platform/kernel";
import { readFenced, writeFenced } from "../files";
import { workspaceRootOf } from "../sessions";
import type { DsCapability } from "./data-science/capability";
import type { JobRunner } from "./data-science/jobs";
import type { KernelHost } from "./data-science/kernel-host";
import type { DataScienceOps } from "./data-science/operations";
import { DsFiles } from "./data-science/state-files";
import { NOTEBOOK_MAX_BYTES, storeDsCapability } from "./data-science/store-capability";
import { type TableWindow, windowCsv } from "./data-science/table";
import { telarVenvDir } from "./data-science/telar-venv";
import type { CompileStatus, LatexCapability } from "./latex/capability";
import type { ResolvedLatex } from "./latex/compile";
import { storeLatexCapability } from "./latex/store-capability";
import type { LatexToolchain } from "./latex/toolchain";

export type PluginDoorsHost = {
  engineRoot: string;
  now(): number;
  getSession(sessionId: string): Session;
  requireSession(sessionId: string): Session;
  machinePlugins(): ProjectPlugins;
  resolveDataScience(session: Session): { pythonPath: string } | undefined;
  resolveLatex(session: Session): ResolvedLatex | undefined;
  latexToolchain(): Promise<LatexToolchain>;
  sessionDir(sessionId: string): string;
  putAttachment(sessionId: string, input: { name: string; mediaType: string; data: Uint8Array; tags?: string[]; producer?: string }): TurnAttachment;
  attachmentBytes(sessionId: string, attachmentId: string): Uint8Array;
  appendEvent(sessionId: string, event: JournalEntry): void;
  dataScienceOps(): DataScienceOps;
};

export type KernelState = "starting" | "idle" | "busy" | "restarting" | "dead";

/** The data-science and LaTeX doors for one session: every route and toolkit reaches a kernel or a compile through these. */
export class PluginDoors {
  /** Absent means every kernel verb refuses with "no kernel host": the store must build in a test without spawning Python. */
  private kernels?: KernelHost;
  private pluginRelease?: (sessionId: string, reason: string) => void;
  /** The last compile per session, for `latex_status` and the surface. */
  private readonly latexCompiles = new Map<string, CompileStatus>();

  constructor(
    private readonly dsJobs: JobRunner,
    private readonly latexJobs: JobRunner,
    private readonly host: PluginDoorsHost,
  ) {}

  attachKernels(host: KernelHost): void {
    this.kernels = host;
  }

  disposeKernel(sessionId: string, reason: string): void {
    void this.kernels?.dispose(sessionId, reason);
  }

  /** The plugin host's per-session release, so a plugin gives back its state without the store naming it. */
  attachRelease(release: (sessionId: string, reason: string) => void): void {
    this.pluginRelease = release;
  }

  release(sessionId: string, reason: string): void {
    this.pluginRelease?.(sessionId, reason);
    this.disposeKernel(sessionId, reason);
  }

  /** Resolves the interpreter with the worktree rule; the refusal names which switch is off, the Mac's or the project's. */
  dataScience(sessionId: string): DsCapability {
    const session = this.host.getSession(sessionId);
    const resolved = this.host.resolveDataScience(session);
    if (!resolved) {
      throw new EngineStateError(
        "invalid_request",
        machineAllows(this.host.machinePlugins(), "data-science")
          ? "data science is not enabled for this session's project"
          : "data science is turned off for this Mac",
      );
    }
    if (!this.kernels) throw new EngineStateError("invalid_request", "this engine has no kernel host");
    const cwd = workspaceRootOf(session);
    const projectId = session.projectId!;
    return storeDsCapability({
      sessionId,
      cwd,
      python: resolved.pythonPath,
      telarVenv: telarVenvDir(this.host.engineRoot, projectId, session.workspace.mode === "worktree" ? path.basename(session.workspace.path) : undefined),
      host: this.kernels,
      files: new DsFiles(path.join(this.host.sessionDir(sessionId), "ds")),
      // A notebook with plots passes the editor's 512 KB ceiling in one cell, so both fences take the notebook cap.
      readFile: (target) => readFenced(cwd, target, "session workspace", NOTEBOOK_MAX_BYTES),
      writeFile: (target, text, expected) => writeFenced(cwd, target, text, expected, "session workspace", NOTEBOOK_MAX_BYTES),
      putAttachment: (input) => this.host.putAttachment(sessionId, input),
      attachmentBytes: (id) => this.host.attachmentBytes(sessionId, id),
      appendEvent: (event) => this.host.appendEvent(sessionId, event),
      now: () => this.host.now(),
      // Package operations resolve the environment against this session's workspace.
      packages: () => this.host.dataScienceOps().packages(projectId, cwd),
      startInstall: (input) => this.host.dataScienceOps().install(projectId, input as Parameters<DataScienceOps["install"]>[1], cwd),
      waitJob: (jobId, timeoutMs) => this.dsJobs.wait(jobId, timeoutMs),
      environments: async () => ({ environments: await this.host.dataScienceOps().environmentRows(projectId, cwd) }),
      useEnvironment: (target) => this.host.dataScienceOps().useEnvironment(sessionId, target),
    });
  }

  latex(sessionId: string): LatexCapability {
    const session = this.host.getSession(sessionId);
    const resolved = this.host.resolveLatex(session);
    if (!resolved) {
      throw new EngineStateError(
        "invalid_request",
        machineAllows(this.host.machinePlugins(), "latex") ? "LaTeX is not enabled for this session's project" : "LaTeX is turned off for this Mac",
      );
    }
    return storeLatexCapability({
      sessionId,
      cwd: workspaceRootOf(session),
      resolved,
      toolchain: () => this.host.latexToolchain(),
      jobs: this.latexJobs,
      appendEvent: (event) => this.host.appendEvent(sessionId, event),
      now: () => this.host.now(),
      lastCompile: {
        get: () => this.latexCompiles.get(sessionId),
        set: (status) => { this.latexCompiles.set(sessionId, status); },
      },
    });
  }

  /** Journaled so the panel's pill follows the kernel. */
  recordKernelState(sessionId: string, state: KernelState, reason?: string): void {
    try {
      this.host.requireSession(sessionId);
    } catch {
      return; // a kernel outliving its session has nowhere to report
    }
    this.host.appendEvent(sessionId, { type: "kernel.state.changed", state, ...(reason ? { reason } : {}) });
  }

  /** A window of rows from a CSV, TSV or Parquet file in the session's tree; Parquet goes through the kernel. */
  async table(sessionId: string, target: string, options: { offset: number; limit: number; sort?: string; desc?: boolean }): Promise<TableWindow> {
    const session = this.host.getSession(sessionId);
    if (/\.parquet$/i.test(target)) {
      const ds = this.dataScience(sessionId);
      const sort = options.sort ? `.sort_values(${JSON.stringify(options.sort)}, ascending=${options.desc ? "False" : "True"})` : "";
      const code = `import pandas as _pd, json as _j\n_df = _pd.read_parquet(${JSON.stringify(path.resolve(workspaceRootOf(session), target))})${sort}\n_w = _df.iloc[${options.offset}:${options.offset + options.limit}]\nprint("__TELAR_TABLE__" + _j.dumps({"columns": list(map(str, _df.columns)), "dtypes": [str(_df.dtypes[c]) for c in _df.columns], "total": int(len(_df)), "rows": _j.loads(_w.to_json(orient="values", date_format="iso"))}, default=str))`;
      const result = await ds.execute({ code, producer: "table" });
      const line = result.outputs.find((o) => o.kind === "text" && o.text.includes("__TELAR_TABLE__"));
      if (!result.ok || !line || line.kind !== "text") throw new EngineStateError("invalid_request", result.error ? `${result.error.ename}: ${result.error.evalue}` : "could not read the parquet file");
      const parsed = JSON.parse(line.text.slice(line.text.indexOf("__TELAR_TABLE__") + 15)) as Omit<TableWindow, "offset" | "path">;
      return { path: target, offset: options.offset, ...parsed };
    }
    const file = readFenced(workspaceRootOf(session), target, "session workspace");
    if (file.binary) throw new EngineStateError("invalid_request", "that file is not text");
    return { path: target, ...windowCsv(file.text, /\.tsv$/i.test(target) ? "\t" : ",", options), ...(file.truncated ? { truncated: true } : {}) };
  }
}
