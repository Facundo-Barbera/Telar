import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LatexConfig, LatexPackagesAnswer, Project } from "@telar/engine-client";
import { EngineStateError } from "../../../platform/kernel";
import { adoptBinaryDir } from "../data-science/toolchain";
import type { JobRead, JobRunner } from "../data-science/jobs";
import { latexBlock, type PluginToolchains } from "../toolchains";
import { type LatexBootstrapRequest, planLatexBootstrap } from "./bootstrap";
import { listTexPackages, TECTONIC_PACKAGES_NOTE, texInstallSteps, texRemoveSteps } from "./packages";
import { findLatexBinary, type LatexToolchain } from "./toolchain";

const MAX_MAIN_CANDIDATES = 50;

/** `.tex` files carrying `\documentclass`, two levels deep and capped: a monorepo has thousands of files that are not a main file. */
function mainFileCandidates(root: string): string[] {
  const candidates: string[] = [];
  const scan = (dir: string, depth: number) => {
    let names: string[];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (candidates.length >= MAX_MAIN_CANDIDATES) return;
      if (name.startsWith(".") || name === "node_modules") continue;
      const file = path.join(dir, name);
      let stat: fs.Stats;
      try { stat = fs.statSync(file); } catch { continue; }
      if (stat.isDirectory()) {
        if (depth > 0) scan(file, depth - 1);
        continue;
      }
      if (!/\.tex$/i.test(name) || stat.size > 2 * 1024 * 1024) continue;
      try {
        if (fs.readFileSync(file, "utf8").includes("\\documentclass")) candidates.push(path.relative(root, file));
      } catch { /* unreadable is not a candidate */ }
    }
  };
  scan(root, 2);
  return candidates.sort();
}

/** The settings page's and the agent's TeX distribution and package operations; installs run as `jobs`. */
export class LatexOps {
  constructor(
    private readonly toolchains: PluginToolchains,
    private readonly jobs: JobRunner,
    private readonly getProject: (projectId: string) => Project,
  ) {}

  toolchain(fresh = false): Promise<LatexToolchain> {
    return this.toolchains.latexToolchain(fresh);
  }

  async distributions(projectId: string): Promise<{ toolchain: LatexToolchain; mainCandidates: string[]; current?: LatexConfig["toolchain"] }> {
    const project = this.getProject(projectId);
    const toolchain = await this.toolchain(true);
    const current = latexBlock(project)?.toolchain;
    return { toolchain, mainCandidates: mainFileCandidates(project.root), ...(current ? { current } : {}) };
  }

  /** Adopts the binary's directory on success so the next compile finds it without a restart. */
  async bootstrap(request: LatexBootstrapRequest): Promise<{ jobId: string }> {
    const toolchain = await this.toolchain(true);
    let plan;
    try {
      plan = planLatexBootstrap(request, toolchain);
    } catch (error) {
      throw new EngineStateError("invalid_request", error instanceof Error ? error.message : String(error));
    }
    if (request.what === "tectonic" && !toolchain.brew) {
      try { fs.mkdirSync(path.join(os.homedir(), ".local", "bin"), { recursive: true }); } catch { /* the installer will say so */ }
    }
    const expect = plan.expectBinary;
    return this.jobs.start({
      kind: `bootstrap:${request.what}`,
      lock: `bootstrap:${request.what}`,
      steps: plan.steps,
      onDone: () => {
        this.toolchains.forgetLatexToolchain();
        const found = findLatexBinary(expect);
        if (!found) throw new Error(`${expect} was installed but cannot be found — open a new terminal, check your PATH, then detect again`);
        adoptBinaryDir(found);
        return { binary: found };
      },
    });
  }

  private async configuredTexLive(projectId: string) {
    const config = latexBlock(this.getProject(projectId));
    if (!config?.enabled || !config.toolchain) throw new EngineStateError("invalid_request", "this project has no TeX toolchain configured");
    if (config.toolchain.kind === "tectonic") return { tectonic: true as const };
    const toolchain = await this.toolchain();
    const configured = config.toolchain.path;
    return { tectonic: false as const, dist: toolchain.texlive.find((candidate) => candidate.binDir === configured) ?? toolchain.texlive[0] };
  }

  async packages(projectId: string): Promise<LatexPackagesAnswer> {
    const texlive = await this.configuredTexLive(projectId);
    if (texlive.tectonic) return { mode: "automatic", note: TECTONIC_PACKAGES_NOTE };
    if (!texlive.dist) return { mode: "unavailable", reason: "the configured TeX Live was not found on this machine" };
    return listTexPackages(texlive.dist);
  }

  /** tlmgr install/remove; Tectonic projects are refused, and the agent's tool says why. */
  async install(projectId: string, input: { add?: string[]; remove?: string[] }): Promise<{ jobId: string }> {
    const texlive = await this.configuredTexLive(projectId);
    if (texlive.tectonic) throw new EngineStateError("invalid_request", TECTONIC_PACKAGES_NOTE);
    const dist = texlive.dist;
    if (!dist) throw new EngineStateError("invalid_request", "the configured TeX Live was not found on this machine");
    try {
      const steps = [
        ...(input.remove?.length ? texRemoveSteps(dist, input.remove) : []),
        ...(input.add?.length ? texInstallSteps(dist, input.add) : []),
      ];
      if (!steps.length) throw new Error("nothing to install or remove");
      return this.jobs.start({ kind: "tex-packages", lock: `${dist.binDir}:tex-packages`, steps });
    } catch (error) {
      throw new EngineStateError("invalid_request", error instanceof Error ? error.message : String(error));
    }
  }

  job(jobId: string, after?: number): JobRead {
    try {
      return this.jobs.read(jobId, after);
    } catch (error) {
      throw new EngineStateError("not_found", error instanceof Error ? error.message : String(error));
    }
  }

  cancelJob(jobId: string): void {
    this.jobs.cancel(jobId);
  }
}
