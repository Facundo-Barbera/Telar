/**
 * One compile, as JobRunner steps. NO PERSISTENT HOST: latexmk already runs
 * the rerun fixpoint (bibtex, cross-references) inside one invocation, so
 * unlike the Python kernel there is no state worth keeping between compiles.
 *
 * Aux clutter is contained in `.telar/latex/` inside the session's workspace
 * (`-outdir` — universal across latexmk vintages, unlike `-auxdir`); the PDF
 * is copied beside its source on success, where every LaTeX editor puts it
 * and where the files tree will find it.
 */
import fs from "node:fs";
import path from "node:path";
import type { JobStep } from "../ds/jobs";

export const LATEX_AUX_DIR = ".telar/latex";

export type LatexEngineName = "pdflatex" | "lualatex" | "xelatex";

/** What `resolveLatex(session)` proved: which program compiles this tree. */
export type ResolvedLatex = {
  kind: "tectonic" | "texlive";
  /** The tectonic binary, or the TeX Live bin directory. Absolute, existing. */
  binPath: string;
  engine?: LatexEngineName;
  /** Relative to the workspace, when the project configured one. */
  mainFile?: string;
  /**
   * May a failed compile install the packages it says are missing and try once
   * more? A TEX LIVE BEHAVIOUR ONLY — Tectonic fetches on first use and cannot
   * be told not to, so the flag is simply moot there rather than contradicted.
   * Resolved from this Mac's LaTeX defaults; see `resolveLatex`.
   */
  autoInstallPackages?: boolean;
};

export type CompilePlan = {
  steps: JobStep[];
  /** Workspace-relative main file the plan compiles. */
  mainFile: string;
  outDir: string;
  /** Where the engine writes the PDF, and where it is copied on success. */
  pdfSource: string;
  pdfTarget: string;
};

const LATEXMK_MODE: Record<LatexEngineName, string> = {
  pdflatex: "-pdf",
  lualatex: "-pdflua",
  xelatex: "-pdfxe",
};

/**
 * The argv for one compile. Refuses before any step runs when the main file
 * is missing, is not `.tex`, or points outside the workspace — the same
 * fail-before-spawn discipline as `planEnvironment`.
 */
export function planCompile(resolved: ResolvedLatex, workspace: string, requested?: string): CompilePlan {
  const mainFile = requested ?? resolved.mainFile;
  if (!mainFile) throw new Error("no main file — name one, or set it in Project settings → LaTeX");
  if (!/\.tex$/i.test(mainFile)) throw new Error(`${mainFile} is not a .tex file`);
  const absolute = path.resolve(workspace, mainFile);
  const relative = path.relative(workspace, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${mainFile} is outside this session's tree`);
  if (!fs.existsSync(absolute)) throw new Error(`${relative} is not in this session's tree`);

  const outDir = path.join(workspace, LATEX_AUX_DIR);
  const base = path.basename(relative, path.extname(relative));
  const pdfSource = path.join(outDir, `${base}.pdf`);
  const pdfTarget = path.join(path.dirname(absolute), `${base}.pdf`);

  if (resolved.kind === "tectonic") {
    return {
      steps: [
        {
          title: `Compiling ${relative} with Tectonic`,
          file: resolved.binPath,
          args: ["--keep-logs", "--synctex", "none", "--outdir", outDir, relative],
          cwd: workspace,
        },
      ],
      mainFile: relative,
      outDir,
      pdfSource,
      pdfTarget,
    };
  }

  const latexmk = path.join(resolved.binPath, "latexmk");
  const mode = LATEXMK_MODE[resolved.engine ?? "pdflatex"];
  return {
    steps: [
      {
        title: `Compiling ${relative} with latexmk (${resolved.engine ?? "pdflatex"})`,
        file: latexmk,
        args: [mode, "-interaction=nonstopmode", "-file-line-error", `-outdir=${outDir}`, relative],
        cwd: workspace,
        // Stops the 79-column log wrapping that breaks every parser.
        env: { max_print_line: "1000" },
      },
    ],
    mainFile: relative,
    outDir,
    pdfSource,
    pdfTarget,
  };
}

/** The compile job's log file, for `latex_log` after the job expired. */
export function logFileFor(outDir: string, mainFile: string): string {
  return path.join(outDir, `${path.basename(mainFile, path.extname(mainFile))}.log`);
}
