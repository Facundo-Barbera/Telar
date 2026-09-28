import type { Project } from "@telar/engine-client";
import type { Kernel } from "../../platform/kernel";
import { projectRemoteAsync } from "../git";
import { probeAvailability, type ProjectAvailability, type VolumeDeps } from "../../platform/fs/volumes";
import type { AsyncGitRunner } from "../../platform/git/runner";
import { confirmProjectIcon, findProjectIconAsync, type ProjectIcon } from "../appearance";

const ICON_TTL_FOUND = 300_000;
const ICON_TTL_MISSING = 15_000;
const ICON_CACHE_CAPACITY = 512;
const METADATA_REFRESH_MS = 10_000;

type Metadata = Pick<Project, "branch" | "icon" | "remoteUrl">;

type ProbeDeps = {
  asyncGit: AsyncGitRunner;
  volumes: VolumeDeps;
  forgetGitReadsUnder: (root: string) => void;
  /** Called on every read of a project whose disk can't be read, so a remounted drive can be recovered. */
  onUnavailable: (project: Project) => void;
};

/**
 * What each project's checkout looks like right now: whether its disk is here,
 * its branch, icon and remote. Availability is probed on every ask and only its
 * transitions are remembered; branch, icon and remote refresh off the request path.
 */
export class ProjectProbes {
  // `resolvedAt` is the last full discovery; a confirmation never moves it, or a new higher-priority icon would stay hidden.
  private readonly icons = new Map<string, { icon?: ProjectIcon; resolvedAt: number }>();
  private readonly availabilities = new Map<string, ProjectAvailability>();
  private readonly metadataCache = new Map<string, { root: string; at: number; value: Metadata; pending?: Promise<void> }>();

  constructor(
    private readonly kernel: Kernel,
    private readonly deps: ProbeDeps,
  ) {}

  /** Always fresh; a change in either direction drops everything read off the old disk state. */
  availability(project: Pick<Project, "id" | "root"> & { volume?: Project["volume"] }): ProjectAvailability {
    const availability = probeAvailability(project, this.deps.volumes);
    const previous = this.availabilities.get(project.id);
    if (previous === availability) return availability;
    this.availabilities.set(project.id, availability);
    // The first answer is not a transition.
    if (previous !== undefined) this.forgetReads(project);
    return availability;
  }

  lastAvailability(projectId: string): ProjectAvailability | undefined {
    return this.availabilities.get(projectId);
  }

  forgetAvailability(projectId: string): void {
    this.availabilities.delete(projectId);
  }

  /** Branch, icon etag and remote for a listing. Nothing is spawned against a disk that isn't there. */
  metadata(project: Project): Metadata {
    // Before the lookup: a transition deletes this very entry.
    const availability = this.availability(project);
    let entry = this.metadataCache.get(project.id);
    if (!entry || entry.root !== project.root) {
      entry = { root: project.root, at: -Infinity, value: {} };
      this.metadataCache.set(project.id, entry);
    }
    if (availability !== "available") {
      entry.value = {};
      // Stamped first: a successful recovery deletes this entry.
      entry.at = this.kernel.now();
      this.deps.onUnavailable(project);
      return entry.value;
    }
    if (!entry.pending && this.kernel.now() - entry.at >= METADATA_REFRESH_MS) {
      const current = entry;
      current.pending = Promise.all([
        this.deps.asyncGit(project.root, ["rev-parse", "--abbrev-ref", "HEAD"], { timeoutMs: 5_000 }),
        this.icon(project),
        projectRemoteAsync(this.deps.asyncGit, project.root),
      ]).then(([head, icon, remoteUrl]) => {
        if (this.metadataCache.get(project.id) !== current) return;
        const branch = head.status === 0 ? head.stdout.trim() : "";
        current.value = {
          ...(branch && branch !== "HEAD" ? { branch } : {}),
          ...(icon ? { icon: icon.etag } : {}),
          ...(remoteUrl ? { remoteUrl } : {}),
        };
      }).catch(() => {
        // A stalled checkout must not hold up the registry or lose its row.
      }).finally(() => {
        current.at = this.kernel.now();
        current.pending = undefined;
      });
    }
    return entry.value;
  }

  async icon(project: Pick<Project, "id" | "root">): Promise<ProjectIcon | undefined> {
    const cached = this.cachedIcon(project.id);
    if (cached) {
      if (!cached.icon) return undefined;
      const confirmed = await confirmProjectIcon(cached.icon);
      if (confirmed) {
        const entry = this.icons.get(project.id);
        if (entry) entry.icon = confirmed;
        return confirmed;
      }
    }
    return this.rememberIcon(project.id, await findProjectIconAsync(project.root));
  }

  /** Drops a project's cached icon and metadata, so the next read resolves afresh. */
  forget(projectId: string): void {
    this.icons.delete(projectId);
    this.metadataCache.delete(projectId);
  }

  /** Drops everything read off a disk that has since changed under us. */
  forgetReads(project: Pick<Project, "id" | "root">): void {
    this.forget(project.id);
    this.deps.forgetGitReadsUnder(project.root);
  }

  private rememberIcon(projectId: string, icon: ProjectIcon | undefined): ProjectIcon | undefined {
    this.icons.delete(projectId);
    this.icons.set(projectId, { ...(icon ? { icon } : {}), resolvedAt: this.kernel.now() });
    while (this.icons.size > ICON_CACHE_CAPACITY) {
      const oldest = this.icons.keys().next();
      if (oldest.done) break;
      this.icons.delete(oldest.value);
    }
    return icon;
  }

  // `undefined` means the cache can't speak, which is not the same as "no icon".
  private cachedIcon(projectId: string): { icon?: ProjectIcon } | undefined {
    const cached = this.icons.get(projectId);
    if (!cached) return undefined;
    const age = this.kernel.now() - cached.resolvedAt;
    if (cached.icon) return age < ICON_TTL_FOUND ? { icon: cached.icon } : undefined;
    return age < ICON_TTL_MISSING ? {} : undefined;
  }
}
