import fs from "node:fs";
import path from "node:path";
import type { JobStep } from "../data-science/jobs";

export const LATEX_AUX_DIR = ".telar/latex";

type LatexEngineName = "pdflatex" | "lualatex" | "xelatex";

export type ResolvedLatex = {
  kind: "tectonic" | "texlive";
  binPath: string;
  engine?: LatexEngineName;
  mainFile?: string;
  autoInstallPackages?: boolean;
};

export type CompilePlan = {
  steps: JobStep[];
  mainFile: string;
  outDir: string;
  pdfSource: string;
  pdfTarget: string;
};

const LATEXMK_MODE: Record<LatexEngineName, string> = {
  pdflatex: "-pdf",
  lualatex: "-pdflua",
  xelatex: "-pdfxe",
};

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
        env: { max_print_line: "1000" },
      },
    ],
    mainFile: relative,
    outDir,
    pdfSource,
    pdfTarget,
  };
}

export function logFileFor(outDir: string, mainFile: string): string {
  return path.join(outDir, `${path.basename(mainFile, path.extname(mainFile))}.log`);
}
