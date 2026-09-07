import { expect, test } from "bun:test";
import { planLatexBootstrap } from "../src/latex/bootstrap";
import type { LatexToolchain } from "../src/latex/toolchain";

const bare: LatexToolchain = { texlive: [] };
const withBrew: LatexToolchain = { texlive: [], brew: { path: "/opt/homebrew/bin/brew", version: "4.4.0" } };

test("tectonic goes through Homebrew when brew is there", () => {
  const plan = planLatexBootstrap({ what: "tectonic" }, withBrew);
  expect(plan.steps).toHaveLength(1);
  expect(plan.steps[0]!.args).toEqual(["install", "tectonic"]);
  expect(plan.expectBinary).toBe("tectonic");
});

test("without brew the installer downloads to a temp file — never curl piped to sh", () => {
  const plan = planLatexBootstrap({ what: "tectonic" }, bare);
  expect(plan.steps).toHaveLength(2);
  expect(plan.steps[0]!.file).toBe("curl");
  expect(plan.steps[0]!.args).toContain("-o");
  expect(plan.steps[1]!.file).toBe("sh");
  expect(plan.steps[1]!.args[0]).toBe(plan.steps[0]!.args[plan.steps[0]!.args.indexOf("-o") + 1]);
});

test("tinytex is always the vendor script and expects tlmgr", () => {
  const plan = planLatexBootstrap({ what: "tinytex" }, withBrew);
  expect(plan.steps[0]!.file).toBe("curl");
  expect(plan.steps[1]!.file).toBe("sh");
  expect(plan.expectBinary).toBe("tlmgr");
});

test("an already-installed tool refuses before any step", () => {
  expect(() => planLatexBootstrap({ what: "tectonic" }, { ...bare, tectonic: { path: "/x/tectonic", version: "0.15.0" } })).toThrow("already installed");
  expect(() => planLatexBootstrap({ what: "tinytex" }, { texlive: [{ binDir: "/y", flavour: "tinytex" }] })).toThrow("already installed");
});
