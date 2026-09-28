import type { JobStep } from "../data-science/jobs";
import { defaultExec, type Exec } from "../data-science/python-env";
import type { TexliveDistribution } from "./toolchain";

export type TexPackage = { name: string; revision?: string; description?: string };

export type LatexPackagesAnswer =
  | { mode: "automatic"; note: string }
  | { mode: "managed"; packages: TexPackage[] }
  | { mode: "unavailable"; reason: string };

export const TECTONIC_PACKAGES_NOTE =
  "This project compiles with Tectonic, which downloads packages automatically the first time a document uses them — just \\usepackage and compile.";

const NAME_ONLY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export function assertTexPackageNames(names: string[]): string[] {
  const clean = names.map((name) => name.trim()).filter(Boolean);
  const bad = clean.filter((name) => !NAME_ONLY.test(name));
  if (bad.length) throw new Error(`not a TeX package name: ${bad.join(", ")}`);
  if (!clean.length) throw new Error("no packages named");
  return clean;
}

export function parseTlmgrList(output: string): TexPackage[] {
  const packages: TexPackage[] = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [name, revision, ...rest] = trimmed.split(",");
    if (!name || !NAME_ONLY.test(name)) continue;
    packages.push({
      name,
      ...(revision ? { revision } : {}),
      ...(rest.length ? { description: rest.join(",").replace(/^"|"$/g, "") } : {}),
    });
  }
  return packages.sort((a, b) => a.name.localeCompare(b.name));
}

export async function listTexPackages(dist: TexliveDistribution, exec: Exec = defaultExec): Promise<LatexPackagesAnswer> {
  if (!dist.tlmgr) return { mode: "unavailable", reason: "this TeX Live has no tlmgr — packages are managed outside Telar" };
  const result = await exec(dist.tlmgr.path, ["info", "--only-installed", "--data", "name,localrev,shortdesc"], { timeoutMs: 60_000 });
  if (result.status !== 0) {
    const reason = result.stderr.trim().split("\n").filter(Boolean).pop() ?? "tlmgr info failed";
    return { mode: "unavailable", reason };
  }
  return { mode: "managed", packages: parseTlmgrList(result.stdout) };
}

export function texInstallSteps(dist: TexliveDistribution, names: string[]): JobStep[] {
  if (!dist.tlmgr) throw new Error("this TeX Live has no tlmgr — install TinyTeX for a Telar-managed distribution");
  const clean = assertTexPackageNames(names);
  return [{ title: `Installing ${clean.join(", ")}`, file: dist.tlmgr.path, args: ["install", ...clean] }];
}

export function texRemoveSteps(dist: TexliveDistribution, names: string[]): JobStep[] {
  if (!dist.tlmgr) throw new Error("this TeX Live has no tlmgr — install TinyTeX for a Telar-managed distribution");
  const clean = assertTexPackageNames(names);
  return [{ title: `Removing ${clean.join(", ")}`, file: dist.tlmgr.path, args: ["remove", ...clean] }];
}

export function missingTexPackages(diagnostics: { code?: string; message: string }[]): string[] {
  const names = new Set<string>();
  for (const diagnostic of diagnostics) {
    if (diagnostic.code !== "missing-package") continue;
    const file = /^File (\S+?) not found$/.exec(diagnostic.message)?.[1];
    if (!file) continue;
    const base = file.replace(/\.(sty|cls)$/i, "");
    if (NAME_ONLY.test(base)) names.add(base);
  }
  return [...names].sort();
}
