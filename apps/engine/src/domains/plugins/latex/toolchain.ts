import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultExec, type Exec } from "../data-science/python-env";
import { compareVersions, findBrew, type ToolInfo } from "../data-science/toolchain";

type TexliveFlavour = "mactex" | "tinytex" | "texlive";

const TEXLIVE_BINARIES = ["latexmk", "pdflatex", "lualatex", "xelatex", "tlmgr", "kpsewhich"] as const;
type TexliveBinary = (typeof TEXLIVE_BINARIES)[number];

export type TexliveDistribution = {
  binDir: string;
  flavour: TexliveFlavour;
  year?: string;
} & Partial<Record<TexliveBinary, ToolInfo>>;

export type LatexToolchain = {
  tectonic?: ToolInfo;
  texlive: TexliveDistribution[];
  brew?: ToolInfo;
  managed?: {
    version: string;
    supported: boolean;
    installed: boolean;
    path?: string;
    installing: boolean;
    error?: string;
  };
};

const home = () => os.homedir();

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
  const match = /(\d+\.\d+(?:\.\d+)?(?:\.\d+)?)/.exec(result.stdout || result.stderr);
  return match?.[1];
}

export function parseTexliveYear(banner: string): string | undefined {
  return /TeX Live (\d{4})/.exec(banner)?.[1];
}

async function findTectonic(exec: Exec = defaultExec, env = process.env): Promise<ToolInfo | undefined> {
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

function texliveRootCandidates(env: NodeJS.ProcessEnv = process.env): RootCandidate[] {
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

export async function probeTexliveRoot(candidate: RootCandidate, exec: Exec = defaultExec): Promise<TexliveDistribution | undefined> {
  const tools: Partial<Record<TexliveBinary, ToolInfo>> = {};
  let year: string | undefined;
  for (const name of TEXLIVE_BINARIES) {
    const file = path.join(candidate.binDir, name);
    if (!executable(file)) continue;
    const result = await exec(file, ["--version"], { timeoutMs: 10_000 }).catch(() => undefined);
    if (!result || result.status !== 0) continue;
    const banner = result.stdout || result.stderr;
    const found = /(\d+\.\d+(?:\.\d+)?(?:[.-][\d.]+)?)/.exec(banner)?.[1] ?? /revision (\d+)/.exec(banner)?.[1];
    if (!found) continue;
    tools[name] = { path: file, version: found };
    if (name === "pdflatex") year = parseTexliveYear(banner);
  }
  if (Object.keys(tools).length === 0) return undefined;
  return { binDir: candidate.binDir, flavour: candidate.flavour, ...(year ? { year } : {}), ...tools };
}

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
