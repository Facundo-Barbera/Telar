import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LATEX_AUX_DIR, logFileFor, planCompile, type ResolvedLatex } from "../src/latex/compile";

const roots: string[] = [];
const workspace = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-latex-compile-"));
  roots.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const texlive: ResolvedLatex = { kind: "texlive", binPath: "/Library/TeX/texbin", mainFile: "main.tex" };
const tectonic: ResolvedLatex = { kind: "tectonic", binPath: "/opt/homebrew/bin/tectonic", mainFile: "main.tex" };

function withMain(tree: string, name = "main.tex"): string {
  fs.mkdirSync(path.dirname(path.join(tree, name)), { recursive: true });
  fs.writeFileSync(path.join(tree, name), "\\documentclass{article}\\begin{document}x\\end{document}");
  return tree;
}

test("latexmk argv carries mode, nonstopmode, file-line-error and the outdir", () => {
  const tree = withMain(workspace());
  const plan = planCompile(texlive, tree);
  const step = plan.steps[0]!;
  expect(step.file).toBe("/Library/TeX/texbin/latexmk");
  expect(step.args).toEqual(["-pdf", "-interaction=nonstopmode", "-file-line-error", `-outdir=${path.join(tree, LATEX_AUX_DIR)}`, "main.tex"]);
  expect(step.env).toEqual({ max_print_line: "1000" });
  expect(step.cwd).toBe(tree);
});

test("the engine choice maps to latexmk's own mode flags", () => {
  const tree = withMain(workspace());
  expect(planCompile({ ...texlive, engine: "lualatex" }, tree).steps[0]!.args[0]).toBe("-pdflua");
  expect(planCompile({ ...texlive, engine: "xelatex" }, tree).steps[0]!.args[0]).toBe("-pdfxe");
});

test("tectonic argv keeps logs and skips synctex", () => {
  const tree = withMain(workspace());
  const step = planCompile(tectonic, tree).steps[0]!;
  expect(step.file).toBe("/opt/homebrew/bin/tectonic");
  expect(step.args).toContain("--keep-logs");
  expect(step.args.join(" ")).toContain("--synctex none");
});

test("the PDF lands in the outdir and is copied beside the source", () => {
  const tree = withMain(workspace(), "docs/thesis.tex");
  const plan = planCompile({ ...texlive, mainFile: "docs/thesis.tex" }, tree);
  expect(plan.pdfSource).toBe(path.join(tree, LATEX_AUX_DIR, "thesis.pdf"));
  expect(plan.pdfTarget).toBe(path.join(tree, "docs", "thesis.pdf"));
  expect(logFileFor(plan.outDir, plan.mainFile)).toBe(path.join(tree, LATEX_AUX_DIR, "thesis.log"));
});

test("refusals fire before any step: no main, not .tex, absent, outside the tree", () => {
  const tree = withMain(workspace());
  expect(() => planCompile({ kind: "texlive", binPath: "/x" }, tree)).toThrow("no main file");
  expect(() => planCompile(texlive, tree, "notes.md")).toThrow("not a .tex file");
  expect(() => planCompile(texlive, tree, "missing.tex")).toThrow("not in this session's tree");
  expect(() => planCompile(texlive, tree, "../outside.tex")).toThrow("outside this session's tree");
});

test("an explicit path wins over the configured main file", () => {
  const tree = withMain(withMain(workspace()), "other.tex");
  expect(planCompile(texlive, tree, "other.tex").mainFile).toBe("other.tex");
});
