import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Exec } from "../src/ds/python-env";
import { findLatexBinary, parseTexliveYear, probeTexliveRoot } from "../src/latex/toolchain";

const roots: string[] = [];
const dir = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-latex-toolchain-"));
  roots.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fakeBinary(binDir: string, name: string): void {
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, name), "#!/bin/sh\n", { mode: 0o755 });
}

test("the TeX Live year comes off the pdflatex banner", () => {
  expect(parseTexliveYear("pdfTeX 3.141592653-2.6-1.40.26 (TeX Live 2024)")).toBe("2024");
  expect(parseTexliveYear("pdfTeX 3.14 (TeX Live 2025/Homebrew)")).toBe("2025");
  expect(parseTexliveYear("Tectonic 0.15.0")).toBeUndefined();
});

test("findLatexBinary reads PATH first", () => {
  const binDir = dir();
  fakeBinary(binDir, "tectonic");
  expect(findLatexBinary("tectonic", { PATH: binDir })).toBe(path.join(binDir, "tectonic"));
  expect(findLatexBinary("tectonic", { PATH: dir() })).toBeUndefined();
});

test("probing a root reports the programs it holds, their versions and the year", async () => {
  const binDir = dir();
  for (const name of ["latexmk", "pdflatex", "tlmgr"]) fakeBinary(binDir, name);
  const banners: Record<string, string> = {
    latexmk: "Latexmk, John Collins, 7 Apr. 2024. Version 4.85",
    pdflatex: "pdfTeX 3.141592653-2.6-1.40.26 (TeX Live 2024)",
    tlmgr: "tlmgr revision 70671 (2024-03-15)",
  };
  const exec: Exec = async (file) => ({ status: 0, stdout: banners[path.basename(file)] ?? "", stderr: "" });
  const found = await probeTexliveRoot({ binDir, flavour: "tinytex" }, exec);
  expect(found).toBeDefined();
  expect(found!.year).toBe("2024");
  expect(found!.latexmk!.version).toBe("4.85");
  expect(found!.pdflatex).toBeDefined();
  expect(found!.tlmgr).toBeDefined();
  expect(found!.xelatex).toBeUndefined();
});

test("a root with no TeX programs probes to nothing", async () => {
  const exec: Exec = async () => ({ status: 0, stdout: "x", stderr: "" });
  expect(await probeTexliveRoot({ binDir: dir(), flavour: "texlive" }, exec)).toBeUndefined();
});
