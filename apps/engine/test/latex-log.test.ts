import { expect, test } from "bun:test";
import { firstErrorSentence, parseLatexLog } from "../src/latex/log-parser";

test("file-line-error lines become errors with exact file and line", () => {
  const log = [
    "This is pdfTeX, Version 3.141592653-2.6-1.40.26 (TeX Live 2024)",
    "(./main.tex",
    "./main.tex:12: Undefined control sequence.",
    "l.12 \\badmacro",
    "",
  ].join("\n");
  const found = parseLatexLog(log, { kind: "texlive" });
  const error = found.find((d) => d.severity === "error")!;
  expect(error.file).toBe("main.tex");
  expect(error.line).toBe(12);
  expect(error.code).toBe("undefined-control-sequence");
});

test("a missing .sty becomes missing-package with a tlmgr suggestion on texlive", () => {
  const log = "! LaTeX Error: File `siunitx.sty' not found.";
  const [error] = parseLatexLog(log, { kind: "texlive" });
  expect(error!.code).toBe("missing-package");
  expect(error!.suggestion).toContain("siunitx");
  expect(error!.suggestion).toContain("latex_install");
});

test("the same missing .sty on tectonic points at automatic fetching, not tlmgr", () => {
  const [error] = parseLatexLog("! LaTeX Error: File `siunitx.sty' not found.", { kind: "tectonic" });
  expect(error!.code).toBe("missing-package");
  expect(error!.suggestion).not.toContain("latex_install");
  expect(error!.suggestion).toContain("automatically");
});

test("a missing graphics file is missing-file, not missing-package", () => {
  const [error] = parseLatexLog("! LaTeX Error: File `figure1.png' not found.", { kind: "texlive" });
  expect(error!.code).toBe("missing-file");
  expect(error!.suggestion).toBeUndefined();
});

test("a bare ! error recovers its line from the l.<n> context (the tectonic path)", () => {
  const log = ["! Undefined control sequence.", "<recently read> \\badmacro", "l.42 \\badmacro", " something"].join("\n");
  const [error] = parseLatexLog(log, { kind: "tectonic" });
  expect(error!.line).toBe(42);
  expect(error!.code).toBe("undefined-control-sequence");
});

test("multi-line warnings join until the block ends and keep the input line", () => {
  const log = [
    "LaTeX Warning: Reference `fig:results' on page 3 undefined",
    "on input line 87.",
    "",
    "Package hyperref Warning: Token not allowed in a PDF string (Unicode):",
    "(hyperref)                removing `\\\\' on input line 12.",
    "",
  ].join("\n");
  const found = parseLatexLog(log, {});
  expect(found).toHaveLength(2);
  expect(found[0]!.severity).toBe("warning");
  expect(found[0]!.code).toBe("undefined-reference");
  expect(found[0]!.line).toBe(87);
  expect(found[0]!.suggestion).toContain("Compile again");
  expect(found[1]!.message).toContain("removing");
  expect(found[1]!.line).toBe(12);
});

test("citations undefined and overfull boxes are classified", () => {
  const log = [
    "LaTeX Warning: Citation `knuth84' on page 1 undefined on input line 5.",
    "Overfull \\hbox (15.3pt too wide) in paragraph at lines 100--104",
    "",
  ].join("\n");
  const found = parseLatexLog(log, {});
  expect(found[0]!.code).toBe("citation-undefined");
  expect(found[1]!.code).toBe("overfull");
  expect(found[1]!.line).toBe(100);
});

test("tectonic's own error/warning framing is parsed", () => {
  const log = ["warning: main.tex is out of date; compiling", "error: halted on potentially-recoverable error as specified"].join("\n");
  const found = parseLatexLog(log, { kind: "tectonic" });
  expect(found.find((d) => d.severity === "error")!.message).toContain("halted");
  expect(found.find((d) => d.severity === "warning")).toBeDefined();
});

test("the parenthesis stack attributes a bare error to the open file", () => {
  const log = ["(./main.tex (./chapters/intro.tex", "! Missing $ inserted.", "l.9 x_1", ")"].join("\n");
  const [error] = parseLatexLog(log, {});
  expect(error!.file).toBe("chapters/intro.tex");
  expect(error!.line).toBe(9);
});

test("duplicates collapse and the total is capped", () => {
  const line = "LaTeX Warning: There were undefined references.";
  const repeated = Array.from({ length: 300 }, (_, i) => (i % 2 ? line : `./f.tex:${i}: Something broke here.`)).join("\n\n");
  const found = parseLatexLog(repeated, {});
  expect(found.length).toBeLessThanOrEqual(100);
  expect(found.filter((d) => d.message === "There were undefined references.")).toHaveLength(1);
});

test("firstErrorSentence names the first error with its place, or nothing", () => {
  expect(firstErrorSentence([])).toBeUndefined();
  expect(firstErrorSentence([{ severity: "warning", message: "w" }])).toBeUndefined();
  expect(
    firstErrorSentence([
      { severity: "warning", message: "w" },
      { severity: "error", message: "Undefined control sequence.", file: "main.tex", line: 12 },
    ]),
  ).toBe("Undefined control sequence. (main.tex:12)");
});
