import { expect, test } from "bun:test";
import { assertTexPackageNames, missingTexPackages, parseTlmgrList, texInstallSteps, texRemoveSteps } from "../src/latex/packages";
import { parseLatexLog } from "../src/latex/log-parser";
import type { TexliveDistribution } from "../src/latex/toolchain";

const dist: TexliveDistribution = {
  binDir: "/opt/tex/bin",
  flavour: "tinytex",
  tlmgr: { path: "/opt/tex/bin/tlmgr", version: "5.0" },
};

test("tlmgr --data output parses into name, revision, description", () => {
  const output = ["siunitx,64123,A comprehensive (SI) units package", "booktabs,53402,\"Publication quality tables\"", "", "notaname!!,1,junk"].join("\n");
  const packages = parseTlmgrList(output);
  expect(packages.map((p) => p.name)).toEqual(["booktabs", "siunitx"]);
  expect(packages[1]!.revision).toBe("64123");
  expect(packages[0]!.description).toBe("Publication quality tables");
});

test("names are validated so a flag can never reach argv", () => {
  expect(assertTexPackageNames(["siunitx", "pgf-blur"])).toEqual(["siunitx", "pgf-blur"]);
  expect(() => assertTexPackageNames(["--repository=evil"])).toThrow("not a TeX package name");
  expect(() => assertTexPackageNames(["ok", "-r"])).toThrow("not a TeX package name");
  expect(() => assertTexPackageNames([])).toThrow("no packages named");
});

test("install and remove become tlmgr steps; no tlmgr refuses with the TinyTeX pointer", () => {
  expect(texInstallSteps(dist, ["siunitx"])[0]!.args).toEqual(["install", "siunitx"]);
  expect(texRemoveSteps(dist, ["siunitx"])[0]!.args).toEqual(["remove", "siunitx"]);
  const bare: TexliveDistribution = { binDir: "/x", flavour: "mactex" };
  expect(() => texInstallSteps(bare, ["siunitx"])).toThrow("TinyTeX");
});

/**
 * What "install missing packages automatically" actually installs. Read out of
 * a real log rather than from hand-built diagnostics, because the setting is
 * only as good as the parse behind it.
 */
test("a failed compile's own log names the packages to install", () => {
  const log = [
    "(./paper.tex",
    "! LaTeX Error: File `siunitx.sty' not found.",
    "! LaTeX Error: File `pgf-blur.sty' not found.",
    // A .cls is a package too — a missing document class is the same problem.
    "! LaTeX Error: File `acmart.cls' not found.",
    // Not a package: a figure the author has not drawn yet. Installing
    // "diagram" from tlmgr would be nonsense.
    "! LaTeX Error: File `figures/diagram.png' not found.",
  ].join("\n");
  expect(missingTexPackages(parseLatexLog(log, { kind: "texlive" }))).toEqual(["acmart", "pgf-blur", "siunitx"]);
});

test("A NAME FROM A LOG IS STILL VALIDATED — a .tex somebody was sent is untrusted input", () => {
  // The log is TeX's echo of a filename the document chose, so it reaches this
  // function under the author's control and leaves it heading for argv.
  const nasty = missingTexPackages([
    { code: "missing-package", message: "File --repository=evil.sty not found" },
    { code: "missing-package", message: "File ../../etc/passwd.sty not found" },
    { code: "missing-package", message: "File siunitx.sty not found" },
    // Not a package error at all; it must not be collected whatever it says.
    { code: "overfull", message: "File booktabs.sty not found" },
  ]);
  expect(nasty).toEqual(["siunitx"]);
});

test("nothing to install is an empty list, not a guess", () => {
  expect(missingTexPackages([])).toEqual([]);
  expect(missingTexPackages([{ code: "undefined-reference", message: "Reference `fig:one' undefined" }])).toEqual([]);
});
