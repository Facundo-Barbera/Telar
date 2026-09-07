/**
 * TeX packages, honestly: the two managers disagree about what "packages"
 * even means, and the answer type refuses to paper over it. Tectonic fetches
 * on first use (nothing to list, nothing to install); TeX Live has tlmgr's
 * real inventory; a TeX Live whose tlmgr is missing or root-owned says so
 * instead of showing an empty list that reads as "none installed".
 *
 * NAMES ARE VALIDATED BEFORE THEY REACH ARGV — the `ds/packages.ts` rule.
 * tlmgr takes no version clauses, so the pattern is a bare name and nothing
 * that starts with a dash.
 */
import type { JobStep } from "../ds/jobs";
import { defaultExec, type Exec } from "../ds/python-env";
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

/** `tlmgr info --only-installed --data name,localrev,shortdesc` — CSV-ish, one row per line. */
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

/** The steps that add packages. Validated first; tlmgr only. */
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
