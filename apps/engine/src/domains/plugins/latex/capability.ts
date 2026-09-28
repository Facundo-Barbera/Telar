import type { LatexDiagnostic } from "./log-parser";
import type { LatexPackagesAnswer } from "./packages";
import type { LatexToolchain } from "./toolchain";

export type CompileStatus = {
  status: "running" | "ok" | "failed" | "cancelled";
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
  available: LatexToolchain;
};

export type LatexCapability = {
  toolchain(): Promise<ResolvedToolchainAnswer>;
  compile(input?: { path?: string; timeoutMs?: number }): Promise<CompileResult>;
  status(): Promise<CompileStatus | { status: "never" }>;
  log(input?: { tail?: number; around?: number; find?: string }): Promise<{ lines: string[] }>;
  packages(): Promise<LatexPackagesAnswer>;
  install(input: { add?: string[]; remove?: string[] }): Promise<{ ok: boolean; lines: string[]; error?: string }>;
  clean(input?: { pdf?: boolean }): Promise<{ removed: string[] }>;
};
