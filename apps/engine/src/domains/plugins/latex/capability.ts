/**
 * What the `latex_*` toolkit may do — a thin port, one member per store
 * method, exactly as `DsCapability` is. Validation lives behind it; the
 * walls compose sentences.
 *
 * TWO IMPLEMENTATIONS, ONE SHAPE: the worker builds this out of
 * `EngineClient.latex()` HTTP calls, the daemon builds it over its own jobs
 * and files. Both land on the same compile, because the jobs are the daemon's.
 */
import type { LatexDiagnostic } from "./log-parser";
import type { LatexPackagesAnswer } from "./packages";
import type { LatexToolchain } from "./toolchain";

export type CompileStatus = {
  status: "running" | "ok" | "failed" | "cancelled";
  /** Workspace-relative main file the compile ran on. */
  path: string;
  pdfPath?: string;
  diagnostics: LatexDiagnostic[];
  logTail: string[];
  jobId: string;
  startedAt: number;
  finishedAt?: number;
};

export type CompileResult = {
  ok: boolean;
  path: string;
  pdfPath?: string;
  diagnostics: LatexDiagnostic[];
  /** The job's last lines, for when the diagnostics missed something. */
  logTail: string[];
  error?: string;
};

export type ResolvedToolchainAnswer = {
  kind: "tectonic" | "texlive";
  binPath: string;
  engine?: string;
  version?: string;
  tlmgr: boolean;
  mainFile?: string;
  /** Everything else the machine carries, for "switch to…" conversations. */
  available: LatexToolchain;
};

export type LatexCapability = {
  /** Which distribution this session compiles with, and what else exists. */
  toolchain(): Promise<ResolvedToolchainAnswer>;
  /** Compile and WAIT — a model wants an answer, not a cursor. */
  compile(input?: { path?: string; timeoutMs?: number }): Promise<CompileResult>;
  status(): Promise<CompileStatus | { status: "never" }>;
  /** A window of the raw log: tail by default, around a line, or matching. */
  log(input?: { tail?: number; around?: number; find?: string }): Promise<{ lines: string[] }>;
  packages(): Promise<LatexPackagesAnswer>;
  /** tlmgr install/remove, waited on. Refused for tectonic projects. */
  install(input: { add?: string[]; remove?: string[] }): Promise<{ ok: boolean; lines: string[]; error?: string }>;
  /** Remove the aux out-dir; `pdf: true` removes the copied PDF too. */
  clean(input?: { pdf?: boolean }): Promise<{ removed: string[] }>;
};
