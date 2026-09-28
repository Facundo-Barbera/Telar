import fs from "node:fs";
import path from "node:path";
import type { PythonEnvironment } from "./environments";
import type { JobStep } from "./jobs";
import { defaultExec, type Exec } from "./python-env";
import type { Toolchain } from "./toolchain";

export type PackageInfo = { name: string; version: string; channel?: string };

const SPEC = /^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9._,\s-]+\])?\s*((?:[<>=!~]=?|===)\s*[A-Za-z0-9.*+!_-]+(?:\s*,\s*(?:[<>=!~]=?|===)\s*[A-Za-z0-9.*+!_-]+)*)?$/;
const NAME_ONLY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function validSpec(spec: string): boolean {
  return SPEC.test(spec.trim()) && spec.trim().length <= 200;
}

function validName(name: string): boolean {
  return NAME_ONLY.test(name.trim()) && name.trim().length <= 200;
}

function assertSpecs(specs: string[]): string[] {
  const clean = specs.map((spec) => spec.trim()).filter(Boolean);
  const bad = clean.filter((spec) => !validSpec(spec));
  if (bad.length) throw new Error(`not a package requirement: ${bad.join(", ")}`);
  if (!clean.length) throw new Error("no packages named");
  return clean;
}

function assertNames(names: string[]): string[] {
  const clean = names.map((name) => name.trim()).filter(Boolean);
  const bad = clean.filter((name) => !validName(name));
  if (bad.length) throw new Error(`not a package name: ${bad.join(", ")}`);
  if (!clean.length) throw new Error("no packages named");
  return clean;
}

type EnvRef = Pick<PythonEnvironment, "manager" | "root" | "python">;

export type ProjectContext = { root: string };

export function canonicalName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

const specName = (spec: string): string | undefined => {
  const match = /^[A-Za-z0-9][A-Za-z0-9._-]*/.exec(spec.trim());
  return match ? canonicalName(match[0]) : undefined;
};

export function declaredDependencies(root: string, cap = 24): string[] {
  const names: string[] = [];
  const push = (spec: string) => {
    const name = specName(spec);
    if (name && !names.includes(name)) names.push(name);
  };
  try {
    const toml = fs.readFileSync(path.join(root, "pyproject.toml"), "utf8");
    const start = toml.search(/^\[project\]\s*$/m);
    if (start >= 0) {
      const rest = toml.slice(start).split("\n").slice(1).join("\n");
      const end = rest.search(/^\[/m);
      const body = end >= 0 ? rest.slice(0, end) : rest;
      const at = body.search(/(?:^|\n)dependencies\s*=\s*\[/);
      if (at >= 0) {
        const open = body.indexOf("[", body.indexOf("=", at));
        let index = open + 1;
        let depth = 1;
        let quote: string | undefined;
        for (; index < body.length && depth > 0; index++) {
          const char = body[index];
          if (quote) { if (char === quote) quote = undefined; }
          else if (char === '"' || char === "'") quote = char;
          else if (char === "[") depth += 1;
          else if (char === "]") depth -= 1;
        }
        for (const match of body.slice(open + 1, index - 1).matchAll(/"([^"]+)"|'([^']+)'/g)) push((match[1] ?? match[2])!);
      }
    }
  } catch { }
  try {
    for (const line of fs.readFileSync(path.join(root, "requirements.txt"), "utf8").split("\n")) {
      const spec = line.trim();
      if (!spec || spec.startsWith("#") || spec.startsWith("-")) continue;
      push(spec);
    }
  } catch { }
  return names.slice(0, cap);
}

function isUvProject(env: EnvRef, project: ProjectContext | undefined, toolchain: Toolchain): boolean {
  return Boolean(
    project && toolchain.uv && env.manager === "venv"
    && path.resolve(env.root) === path.join(path.resolve(project.root), ".venv")
    && fs.existsSync(path.join(project.root, "pyproject.toml")),
  );
}

export type InstallCommand = "uv add" | "uv pip" | "conda" | "pip";

export function installCommandFor(env: EnvRef, toolchain: Toolchain, project?: ProjectContext): InstallCommand {
  if (env.manager === "conda" && toolchain.conda) return "conda";
  if (isUvProject(env, project, toolchain)) return "uv add";
  return toolchain.uv ? "uv pip" : "pip";
}

export async function listPackages(env: EnvRef, toolchain: Toolchain, exec: Exec = defaultExec): Promise<PackageInfo[]> {
  if (env.manager === "conda" && toolchain.conda) {
    const result = await exec(toolchain.conda.path, ["list", "-p", env.root, "--json"], { timeoutMs: 60_000 });
    if (result.status !== 0) throw new Error(lastLine(result.stderr) || "conda list failed");
    const rows = JSON.parse(result.stdout) as { name: string; version: string; channel?: string }[];
    return rows.map((row) => ({ name: row.name, version: row.version, ...(row.channel ? { channel: row.channel } : {}) })).sort(byName);
  }
  const result = toolchain.uv
    ? await exec(toolchain.uv.path, ["pip", "list", "--python", env.python, "--format", "json"], { timeoutMs: 60_000 })
    : await exec(env.python, ["-m", "pip", "list", "--format", "json"], { timeoutMs: 60_000 });
  if (result.status !== 0) throw new Error(lastLine(result.stderr) || "pip list failed");
  const rows = JSON.parse(result.stdout.trim().split("\n").pop() ?? "[]") as { name: string; version: string }[];
  return rows.map((row) => ({ name: row.name, version: row.version })).sort(byName);
}

export function installSteps(env: EnvRef, specs: string[], toolchain: Toolchain, project?: ProjectContext): JobStep[] {
  const clean = assertSpecs(specs);
  return [mutationStep(env, toolchain, "install", clean, project)];
}

export function removeSteps(env: EnvRef, names: string[], toolchain: Toolchain, project?: ProjectContext): JobStep[] {
  const clean = assertNames(names);
  return [mutationStep(env, toolchain, "remove", clean, project)];
}

function mutationStep(env: EnvRef, toolchain: Toolchain, verb: "install" | "remove", items: string[], project?: ProjectContext): JobStep {
  const title = `${verb === "install" ? "Installing" : "Removing"} ${items.join(", ")}`;
  if (env.manager === "conda") {
    if (!toolchain.conda) throw new Error("this is a conda environment and conda is not installed");
    return { title, file: toolchain.conda.path, args: [verb, "-p", env.root, "-y", ...items] };
  }
  if (isUvProject(env, project, toolchain)) {
    return { title, file: toolchain.uv!.path, args: [verb === "install" ? "add" : "remove", ...items], cwd: project!.root, env: { UV_PROJECT_ENVIRONMENT: env.root } };
  }
  if (toolchain.uv) return { title, file: toolchain.uv.path, args: ["pip", verb === "install" ? "install" : "uninstall", "--python", env.python, ...items] };
  return { title, file: env.python, args: ["-m", "pip", verb === "install" ? "install" : "uninstall", ...(verb === "remove" ? ["-y"] : []), ...items] };
}

export type RequirementsSource = "requirements.txt" | "pyproject.toml" | "uv.lock" | "environment.yml" | "Pipfile";

export function projectRequirements(root: string): RequirementsSource[] {
  return (["requirements.txt", "pyproject.toml", "uv.lock", "environment.yml", "Pipfile"] as const).filter((name) => fs.existsSync(path.join(root, name)));
}

export function requirementsStep(env: EnvRef, projectRoot: string, source: RequirementsSource, toolchain: Toolchain): JobStep {
  const file = path.join(projectRoot, source);
  if (!fs.existsSync(file)) throw new Error(`${source} is not in this project`);
  switch (source) {
    case "environment.yml": {
      if (env.manager !== "conda" || !toolchain.conda) throw new Error("environment.yml installs into a conda environment");
      return { title: "Installing from environment.yml", file: toolchain.conda.path, args: ["env", "update", "-p", env.root, "-f", file, "--prune"], cwd: projectRoot };
    }
    case "uv.lock":
    case "pyproject.toml": {
      if (!toolchain.uv) throw new Error("installing from pyproject.toml needs uv");
      if (path.resolve(env.root) === path.join(projectRoot, ".venv")) {
        return { title: `Syncing from ${source}`, file: toolchain.uv.path, args: ["sync", ...(source === "uv.lock" ? ["--frozen"] : [])], cwd: projectRoot, env: { UV_PROJECT_ENVIRONMENT: env.root } };
      }
      return { title: "Installing from pyproject.toml", file: toolchain.uv.path, args: ["pip", "install", "--python", env.python, "-e", "."], cwd: projectRoot };
    }
    case "Pipfile":
    case "requirements.txt": {
      const target = source === "Pipfile" ? "requirements.txt" : source;
      if (source === "Pipfile") throw new Error("export the Pipfile to requirements.txt first (pipenv requirements > requirements.txt)");
      if (env.manager === "conda" && toolchain.conda) {
        return { title: `Installing from ${target}`, file: env.python, args: ["-m", "pip", "install", "-r", file], cwd: projectRoot };
      }
      if (toolchain.uv) return { title: `Installing from ${target}`, file: toolchain.uv.path, args: ["pip", "install", "--python", env.python, "-r", file], cwd: projectRoot };
      return { title: `Installing from ${target}`, file: env.python, args: ["-m", "pip", "install", "-r", file], cwd: projectRoot };
    }
  }
}

const byName = (a: PackageInfo, b: PackageInfo) => a.name.localeCompare(b.name);

function lastLine(text: string): string {
  return text.trim().split("\n").filter(Boolean).pop() ?? "";
}
