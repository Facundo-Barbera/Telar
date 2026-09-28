import fs from "node:fs";
import path from "node:path";
import { workspaceBaseRef, workspacePath, type Project, type Session } from "@telar/engine-client";
import type { Kernel } from "../../platform/kernel";
import { findVolumeMount, mountSignature, type VolumeDeps } from "../../platform/fs/volumes";
import { sessionMetadataFile, storedSession } from "../sessions";
import type { WorktreePlan } from "../worktrees";
import type { ProjectProbes } from "./probes";
import type { ProjectRegistry } from "./registry";

type RemountDeps = {
  registry: ProjectRegistry;
  probes: ProjectProbes;
  volumes: VolumeDeps;
  sessions: () => Session[];
  prepareWorktree: (sessionId: string, projectRoot: string, plan: WorktreePlan, baseSha: string) => void;
};

/**
 * A project's drive came back mounted at a new path (macOS appends ` 1` when the
 * name is taken). Matched on the volume uuid, never a name, and only when the
 * project's folder exists on it; this is the one sanctioned write of `Project.root`.
 */
export class ProjectRemounts {
  private readonly attempts = new Map<string, string>();

  constructor(
    private readonly kernel: Kernel,
    private readonly deps: RemountDeps,
  ) {}

  /** The updated project, or nothing when there was nothing to recover. */
  recover(project: Project): Project | undefined {
    if (project.volume === undefined) return undefined;
    // Searching costs a `diskutil` per volume on a ten-second poll, so try once per distinct set of mounts.
    const signature = mountSignature(this.deps.volumes);
    if (this.attempts.get(project.id) === signature) return undefined;
    this.attempts.set(project.id, signature);
    const mount = findVolumeMount(project.volume.uuid, this.deps.volumes);
    if (mount === undefined || mount === project.volume.mount) return undefined;
    const within = path.relative(project.volume.mount, project.root);
    if (within.startsWith("..") || path.isAbsolute(within)) return undefined;
    const root = within === "" ? mount : path.join(mount, within);
    try {
      if (!fs.statSync(root).isDirectory()) return undefined;
    } catch {
      return undefined;
    }

    const parsed = this.deps.registry.read();
    const stored = parsed.projects.find((candidate) => candidate.id === project.id);
    if (stored === undefined) return undefined;
    const previousRoot = stored.root;
    stored.root = root;
    stored.volume = { mount, uuid: project.volume.uuid };
    stored.updatedAt = this.kernel.now();
    this.kernel.writeDocument(this.kernel.paths.projects, parsed);

    // Local sessions work in the root and move with it; a worktree's checkout lives on the internal disk and stays.
    const moved: string[] = [];
    const prefix = previousRoot.endsWith(path.sep) ? previousRoot : `${previousRoot}${path.sep}`;
    for (const session of this.deps.sessions()) {
      if (session.projectId !== project.id) continue;
      const current = workspacePath(session.workspace);
      if (current === undefined) continue;
      if (current !== previousRoot && !current.startsWith(prefix)) continue;
      const next = current === previousRoot ? root : path.join(root, current.slice(prefix.length));
      const updated: Session = {
        ...session,
        workspace: { ...session.workspace, path: next } as Session["workspace"],
        updatedAt: this.kernel.now(),
      };
      this.kernel.writeDocument(sessionMetadataFile(this.kernel.paths, session.id), storedSession(updated));
      this.kernel.appendEvent(session.id, { type: "session.updated", session: updated });
      moved.push(session.id);
    }

    this.deps.probes.forgetReads({ id: project.id, root: previousRoot });
    this.deps.probes.forgetReads({ id: project.id, root });
    this.deps.probes.forgetAvailability(project.id);

    // A record the engine rewrote on its own must be findable afterwards.
    process.stdout.write(
      `Telar engine: ${project.name} came back on its own drive at a new path — ${previousRoot} → ${root}` +
        `${moved.length > 0 ? ` (${moved.length} session${moved.length === 1 ? "" : "s"} moved with it)` : ""}\n`,
    );

    this.retryCutsFailedWhileAway(project.id, root);
    return structuredClone(stored);
  }

  // Once, and only on recovery: a cut that failed for its own reasons still fails with the drive plugged in.
  private retryCutsFailedWhileAway(projectId: string, projectRoot: string): void {
    for (const session of this.deps.sessions()) {
      if (session.projectId !== projectId) continue;
      if (session.preparation?.state !== "failed") continue;
      if (session.workspace.mode !== "worktree") continue;
      const plan: WorktreePlan = { path: session.workspace.path, branch: session.workspace.branch, named: false };
      const baseSha = workspaceBaseRef(session.workspace);
      if (baseSha === undefined) continue;
      this.deps.prepareWorktree(session.id, projectRoot, plan, baseSha);
    }
  }

  /**
   * Asks every project's disk now: at start, and when the shell sees a mount change. A project that cannot be read
   * gets the remount search here, off the poll path. Removed projects are on no surface, so they are skipped.
   */
  reprobe(): { projects: number; changed: number; recovered: number } {
    const projects = this.deps.registry.read().projects.filter((project) => project.removedAt === undefined);
    let changed = 0;
    let recovered = 0;
    for (const project of projects) {
      const before = this.deps.probes.lastAvailability(project.id);
      let availability = this.deps.probes.availability(project);
      if (availability !== "available" && this.recover(project) !== undefined) {
        recovered += 1;
        availability = this.deps.probes.availability(this.deps.registry.get(project.id));
      }
      if (availability !== before) changed += 1;
    }
    return { projects: projects.length, changed, recovered };
  }
}
