import { expect, test } from "bun:test";
import { assertTexPackageNames, parseTlmgrList, texInstallSteps, texRemoveSteps } from "../src/latex/packages";
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
