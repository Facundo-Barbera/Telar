/**
 * The TeX programs this machine carries — Tectonic, and every TeX Live root
 * (MacTeX, TinyTeX, a vanilla install) — FOUND, NEVER ASSUMED, the same
 * courtesy `ds/toolchain.ts` extends to uv and conda. Discovery returns a
 * LIST, never a choice: a missed root costs the person a manual path entry,
 * a wrong guess costs them a compile against the wrong distribution.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultExec, type Exec } from "../ds/python-env";
import { compareVersions, findBrew, type ToolInfo } from "../ds/toolchain";

export type { ToolInfo } from "../ds/toolchain";
export { findBrew } from "../ds/toolchain";

export type TexliveFlavour = "mactex" | "tinytex" | "texlive";

/** The programs a compile and a package install lean on, per root. */
export const TEXLIVE_BINARIES = ["latexmk", "pdflatex", "lualatex", "xelatex", "tlmgr", "kpsewhich"] as const;
export type TexliveBinary = (typeof TEXLIVE_BINARIES)[number];

export type TexliveDistribution = {
  binDir: string;
  flavour: TexliveFlavour;
  /** "2025", parsed from the pdflatex banner when it names one. */
  year?: string;
} & Partial<Record<TexliveBinary, ToolInfo>>;

export type LatexToolchain = {
  tectonic?: ToolInfo;
  texlive: TexliveDistribution[];
  brew?: ToolInfo;
};

const home = () => os.homedir();

/** Where installers put tectonic when it is not on PATH yet. */
const TECTONIC_FALLBACK_DIRS = () => [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  path.join(home(), ".cargo", "bin"),
  path.join(home(), ".local", "bin"),
];

function executable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** PATH first, then the fallbacks. Same shape as `ds/toolchain.findBinary`,
 *  kept separate because the fallback table is TeX's own. */
export function findLatexBinary(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const dir of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, name);
    if (executable(candidate)) return candidate;
  }
  const fallbacks = name === "tectonic" ? TECTONIC_FALLBACK_DIRS() : texliveRootCandidates(env).map((root) => root.binDir);
  for (const dir of fallbacks) {
    const candidate = path.join(dir, name);
    if (executable(candidate)) return candidate;
  }
  return undefined;
}

async function version(exec: Exec, file: string): Promise<string | undefined> {
  const result = await exec(file, ["--version"], { timeoutMs: 10_000 }).catch(() => undefined);
  if (!result || result.status !== 0) return undefined;
  // "Tectonic 0.15.0", "Latexmk, John Collins, ... Version 4.85", "pdfTeX 3.141592653-2.6-1.40.26 (TeX Live 2024)"
  const match = /(\d+\.\d+(?:\.\d+)?(?:\.\d+)?)/.exec(result.stdout || result.stderr);
  return match?.[1];
}

/** "pdfTeX 3.14… (TeX Live 2025)" → "2025". MacTeX and TinyTeX both say it. */
export function parseTexliveYear(banner: string): string | undefined {
  return /TeX Live (\d{4})/.exec(banner)?.[1];
}

export async function findTectonic(exec: Exec = defaultExec, env = process.env): Promise<ToolInfo | undefined> {
  const file = findLatexBinary("tectonic", env);
  if (!file) return undefined;
  const found = await version(exec, file);
  return found ? { path: file, version: found } : undefined;
}

type RootCandidate = { binDir: string; flavour: TexliveFlavour };

function glob(dir: string): string[] {
  try {
    return fs.readdirSync(dir).map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

/**
 * Every place a TeX Live bin directory lives on the platforms we run on:
 * MacTeX's symlink farm, year-versioned vanilla roots, TinyTeX's per-arch
 * directory — plus wherever PATH's latexmk/pdflatex actually are, so an
 * exotic install is found through the same door a shell finds it.
 */
export function texliveRootCandidates(env: NodeJS.ProcessEnv = process.env): RootCandidate[] {
  const candidates: RootCandidate[] = [{ binDir: "/Library/TeX/texbin", flavour: "mactex" }];
  for (const yearRoot of glob("/usr/local/texlive")) for (const arch of glob(path.join(yearRoot, "bin"))) candidates.push({ binDir: arch, flavour: "texlive" });
  for (const base of [path.join(home(), "Library", "TinyTeX", "bin"), path.join(home(), ".TinyTeX", "bin")])
    for (const arch of glob(base)) candidates.push({ binDir: arch, flavour: "tinytex" });
  for (const name of ["latexmk", "pdflatex"]) {
    for (const dir of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
      if (executable(path.join(dir, name))) candidates.push({ binDir: dir, flavour: "texlive" });
    }
  }
  return candidates;
}

/** Probe one bin directory for the six programs. Undefined when it holds none. */
export async function probeTexliveRoot(candidate: RootCandidate, exec: Exec = defaultExec): Promise<TexliveDistribution | undefined> {
  const tools: Partial<Record<TexliveBinary, ToolInfo>> = {};
  let year: string | undefined;
  for (const name of TEXLIVE_BINARIES) {
    const file = path.join(candidate.binDir, name);
    if (!executable(file)) continue;
    const result = await exec(file, ["--version"], { timeoutMs: 10_000 }).catch(() => undefined);
    if (!result || result.status !== 0) continue;
    const banner = result.stdout || result.stderr;
    const found = /(\d+\.\d+(?:\.\d+)?(?:[.-][\d.]+)?)/.exec(banner)?.[1];
    if (!found) continue;
    tools[name] = { path: file, version: found };
    if (name === "pdflatex") year = parseTexliveYear(banner);
  }
  if (Object.keys(tools).length === 0) return undefined;
  return { binDir: candidate.binDir, flavour: candidate.flavour, ...(year ? { year } : {}), ...tools };
}

/**
 * One probe of the whole TeX toolchain. Spawns several `--version` processes;
 * call it from a page, never from a poll. Roots are deduped by realpath so
 * MacTeX's symlink farm and the year directory it points at count once.
 */
export async function latexToolchainStatus(exec: Exec = defaultExec, env = process.env): Promise<LatexToolchain> {
  const [tectonic, brew] = await Promise.all([findTectonic(exec, env), findBrew(exec, env)]);
  const seen = new Set<string>();
  const texlive: TexliveDistribution[] = [];
  for (const candidate of texliveRootCandidates(env)) {
    let real: string;
    try {
      real = fs.realpathSync(candidate.binDir);
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    const found = await probeTexliveRoot(candidate, exec);
    if (found) texlive.push(found);
  }
  texlive.sort((a, b) => compareVersions(b.year ?? "0", a.year ?? "0"));
  return { ...(tectonic ? { tectonic } : {}), texlive, ...(brew ? { brew } : {}) };
}
