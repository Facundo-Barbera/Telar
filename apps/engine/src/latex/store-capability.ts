/**
 * `LatexCapability` over the daemon's own jobs and files. THE ONE
 * IMPLEMENTATION OF EVERY RULE: the worker's copy is HTTP calls that land on
 * routes that call this; the cockpit's LaTeX surface calls the same routes.
 *
 * What lives here and not in the toolkit: the compile job's lifecycle, the
 * PDF copy on success, log parsing, the last-compile memory, the journal
 * events. The walls only compose sentences.
 */
import fs from "node:fs";
import path from "node:path";
import type { EngineEvent } from "@telar/engine-client";
import type { JobRunner } from "../ds/jobs";
import type { CompileResult, CompileStatus, LatexCapability, ResolvedToolchainAnswer } from "./capability";
import { LATEX_AUX_DIR, logFileFor, planCompile, type ResolvedLatex } from "./compile";
import { firstErrorSentence, parseLatexLog, type LatexDiagnostic } from "./log-parser";
import { listTexPackages, missingTexPackages, TECTONIC_PACKAGES_NOTE, texInstallSteps, texRemoveSteps, type LatexPackagesAnswer } from "./packages";
import type { LatexToolchain, TexliveDistribution } from "./toolchain";

const LOG_TAIL = 40;
const DEFAULT_COMPILE_TIMEOUT_MS = 10 * 60 * 1000;
const PACKAGE_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

type JournalEntry =
  | Omit<Extract<EngineEvent, { type: "latex.compile.started" }>, "id" | "at" | "sessionId" | "runId">
  | Omit<Extract<EngineEvent, { type: "latex.compile.finished" }>, "id" | "at" | "sessionId" | "runId">;

export type StoreLatexDeps = {
  sessionId: string;
  /** The session's own tree — a worktree compiles ITS files. */
  cwd: string;
  resolved: ResolvedLatex;
  /** The machine's whole toolchain, for the `toolchain()` answer. */
  toolchain: () => Promise<LatexToolchain>;
  jobs: JobRunner;
  appendEvent: (event: JournalEntry) => void;
  now: () => number;
  /** The last compile, shared across capability instances for one session. */
  lastCompile: { get: () => CompileStatus | undefined; set: (status: CompileStatus) => void };
};

/** The distribution the resolved bin dir belongs to, for tlmgr operations. */
async function resolvedDistribution(deps: StoreLatexDeps): Promise<TexliveDistribution | undefined> {
  if (deps.resolved.kind !== "texlive") return undefined;
  const toolchain = await deps.toolchain();
  const real = (dir: string) => {
    try {
      return fs.realpathSync(dir);
    } catch {
      return dir;
    }
  };
  return toolchain.texlive.find((dist) => real(dist.binDir) === real(deps.resolved.binPath)) ?? toolchain.texlive[0];
}

export function storeLatexCapability(deps: StoreLatexDeps): LatexCapability {
  const { sessionId, cwd, resolved, jobs } = deps;

  /**
   * ONE INVOCATION of the planned steps, waited on, with its log parsed. Split
   * out of `compile` so an auto-install retry runs the SAME code the first
   * attempt did — a second inlined copy is how the retry path ends up parsing
   * the log differently from the path everybody actually exercises.
   *
   * `onStart` HANDS BACK THE JOB ID BEFORE THE WAIT, and it is not a nicety:
   * the running status is what `latex_status` and the compile surface read, and
   * a cancel is aimed at the job id it finds there. A retry starts a SECOND job,
   * so the status has to follow it or the cancel button would, from the moment
   * the retry began, be pointed at a job that had already finished.
   */
  async function runOnce(plan: ReturnType<typeof planCompile>, timeoutMs: number, onStart: (jobId: string) => void) {
    const { jobId } = jobs.start({ kind: "latex-compile", lock: `${sessionId}:compile`, steps: plan.steps });
    const startedAt = deps.now();
    onStart(jobId);
    const read = await jobs.wait(jobId, timeoutMs).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return { status: "failed" as const, lines: [message], error: message, cursor: 0, jobId, kind: "latex-compile", startedAt };
    });
    // The engine's own log says more than the job's stdout for TeX Live runs.
    let logText = read.lines.join("\n");
    try {
      logText = fs.readFileSync(logFileFor(plan.outDir, plan.mainFile), "utf8");
    } catch {
      // Tectonic without --keep-logs reaching disk, or a failure before TeX ran.
    }
    return {
      read,
      jobId,
      diagnostics: parseLatexLog(logText, { workspace: cwd, kind: resolved.kind }),
      ok: read.status === "ok",
    };
  }

  /**
   * Install what the log says is missing, and say so in the returned lines.
   * Answers whether anything was installed — false means there is no point
   * compiling again.
   */
  async function installMissing(diagnostics: LatexDiagnostic[]): Promise<{ installed: boolean; lines: string[] }> {
    const wanted = missingTexPackages(diagnostics);
    if (wanted.length === 0) return { installed: false, lines: [] };
    const dist = await resolvedDistribution(deps);
    if (!dist?.tlmgr) return { installed: false, lines: [] };
    let steps;
    try {
      steps = texInstallSteps(dist, wanted);
    } catch {
      return { installed: false, lines: [] };
    }
    const { jobId } = jobs.start({ kind: "tex-packages", lock: `${dist.binDir}:tex-packages`, steps });
    const read = await jobs.wait(jobId, PACKAGE_INSTALL_TIMEOUT_MS).catch((error: unknown) => ({
      status: "failed" as const,
      lines: [error instanceof Error ? error.message : String(error)],
    }));
    // THE INSTALL IS REPORTED WHETHER OR NOT IT WORKED. A compile that silently
    // ran tlmgr and then failed anyway leaves a person reading a log for a step
    // they never asked for and cannot see.
    const note = read.status === "ok"
      ? `Telar installed ${wanted.join(", ")} and is compiling again.`
      : `Telar tried to install ${wanted.join(", ")} and could not; compiling again anyway.`;
    return { installed: read.status === "ok", lines: [note, ...read.lines] };
  }

  async function compile(input?: { path?: string; timeoutMs?: number }): Promise<CompileResult> {
    const plan = planCompile(resolved, cwd, input?.path);
    fs.mkdirSync(plan.outDir, { recursive: true });
    const timeoutMs = input?.timeoutMs ?? DEFAULT_COMPILE_TIMEOUT_MS;
    const startedAt = deps.now();
    /** Whichever compile job is live, so a cancel lands on the running one. */
    const running = (jobId: string) =>
      deps.lastCompile.set({ status: "running", path: plan.mainFile, diagnostics: [], logTail: [], jobId, startedAt });
    deps.appendEvent({ type: "latex.compile.started", path: plan.mainFile });

    let attempt = await runOnce(plan, timeoutMs, running);
    let installLines: string[] = [];
    /**
     * ONE RETRY, NEVER A LOOP. A `.sty` whose tlmgr package is named something
     * else fails the install and then fails the compile the same way — retrying
     * until it works would never terminate, and each round is a tlmgr fetch. So:
     * install once, compile once more, report what actually happened.
     */
    if (!attempt.ok && resolved.autoInstallPackages && resolved.kind === "texlive") {
      const installed = await installMissing(attempt.diagnostics);
      installLines = installed.lines;
      if (installed.installed) attempt = await runOnce(plan, timeoutMs, running);
    }

    const { read, jobId, diagnostics, ok } = attempt;

    let pdfPath: string | undefined;
    if (ok && fs.existsSync(plan.pdfSource)) {
      fs.copyFileSync(plan.pdfSource, plan.pdfTarget);
      pdfPath = path.relative(cwd, plan.pdfTarget);
    }

    // The install's own output leads the tail, so "why did this take 40 seconds
    // and mention tlmgr" is answered in the same place the failure is read.
    const logTail = [...installLines, ...read.lines].slice(-LOG_TAIL);
    const finishedAt = deps.now();
    deps.lastCompile.set({
      status: ok ? "ok" : read.status === "cancelled" ? "cancelled" : "failed",
      path: plan.mainFile,
      ...(pdfPath ? { pdfPath } : {}),
      diagnostics,
      logTail,
      jobId,
      startedAt,
      finishedAt,
    });
    const errors = diagnostics.filter((d: LatexDiagnostic) => d.severity === "error").length;
    const warnings = diagnostics.length - errors;
    const firstError = firstErrorSentence(diagnostics);
    deps.appendEvent({
      type: "latex.compile.finished",
      path: plan.mainFile,
      ok,
      ...(pdfPath ? { pdfPath } : {}),
      errors,
      warnings,
      ...(firstError ? { firstError } : {}),
    });

    return { ok, path: plan.mainFile, ...(pdfPath ? { pdfPath } : {}), diagnostics, logTail, ...(read.error ? { error: read.error } : {}) };
  }

  return {
    async toolchain(): Promise<ResolvedToolchainAnswer> {
      const available = await deps.toolchain();
      const dist = await resolvedDistribution(deps);
      const version = resolved.kind === "tectonic" ? available.tectonic?.version : dist?.latexmk?.version ?? dist?.pdflatex?.version;
      return {
        kind: resolved.kind,
        binPath: resolved.binPath,
        ...(resolved.engine ? { engine: resolved.engine } : {}),
        ...(version ? { version } : {}),
        tlmgr: Boolean(dist?.tlmgr),
        ...(resolved.mainFile ? { mainFile: resolved.mainFile } : {}),
        available,
      };
    },

    compile,

    async status() {
      return deps.lastCompile.get() ?? { status: "never" as const };
    },

    async log(input?: { tail?: number; around?: number; find?: string }) {
      const last = deps.lastCompile.get();
      const mainFile = last?.path ?? resolved.mainFile;
      if (!mainFile) return { lines: [] };
      let text: string;
      try {
        text = fs.readFileSync(logFileFor(path.join(cwd, LATEX_AUX_DIR), mainFile), "utf8");
      } catch {
        return { lines: last?.logTail ?? [] };
      }
      const lines = text.split(/\r?\n/);
      if (typeof input?.around === "number") {
        const centre = Math.max(0, Math.min(lines.length - 1, input.around - 1));
        return { lines: lines.slice(Math.max(0, centre - 20), centre + 21) };
      }
      if (input?.find) {
        const needle = input.find.toLowerCase();
        const hit = lines.findIndex((line) => line.toLowerCase().includes(needle));
        if (hit === -1) return { lines: [`(nothing in the log matches "${input.find}")`] };
        return { lines: lines.slice(Math.max(0, hit - 5), hit + 16) };
      }
      return { lines: lines.slice(-(input?.tail ?? LOG_TAIL)) };
    },

    async packages(): Promise<LatexPackagesAnswer> {
      if (resolved.kind === "tectonic") return { mode: "automatic", note: TECTONIC_PACKAGES_NOTE };
      const dist = await resolvedDistribution(deps);
      if (!dist) return { mode: "unavailable", reason: "the configured TeX Live was not found on this machine" };
      return listTexPackages(dist);
    },

    async install(input: { add?: string[]; remove?: string[] }) {
      if (resolved.kind === "tectonic") return { ok: false, lines: [], error: TECTONIC_PACKAGES_NOTE };
      const dist = await resolvedDistribution(deps);
      if (!dist) return { ok: false, lines: [], error: "the configured TeX Live was not found on this machine" };
      const steps = [
        ...(input.add?.length ? texInstallSteps(dist, input.add) : []),
        ...(input.remove?.length ? texRemoveSteps(dist, input.remove) : []),
      ];
      if (!steps.length) return { ok: false, lines: [], error: "no packages named" };
      const { jobId } = jobs.start({ kind: "tex-packages", lock: `${dist.binDir}:tex-packages`, steps });
      const read = await jobs.wait(jobId, 10 * 60 * 1000);
      return { ok: read.status === "ok", lines: read.lines, ...(read.error ? { error: read.error } : {}) };
    },

    async clean(input?: { pdf?: boolean }) {
      const removed: string[] = [];
      const outDir = path.join(cwd, LATEX_AUX_DIR);
      if (fs.existsSync(outDir)) {
        fs.rmSync(outDir, { recursive: true, force: true });
        removed.push(LATEX_AUX_DIR);
      }
      const last = deps.lastCompile.get();
      if (input?.pdf && last?.pdfPath) {
        const target = path.join(cwd, last.pdfPath);
        if (fs.existsSync(target)) {
          fs.rmSync(target);
          removed.push(last.pdfPath);
        }
      }
      return { removed };
    },
  };
}
