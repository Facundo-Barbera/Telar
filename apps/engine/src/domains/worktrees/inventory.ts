import fs from "node:fs";
import path from "node:path";
import type {
  GitReadFailure,
  WorktreeForceReason,
  WorktreeInventory,
  WorktreeOwner,
  WorktreeRow,
  WorktreeVerdict,
} from "@telar/engine-client";
import type { AsyncGitRunner } from "../../platform/git/runner";

// Only the facts the classifier may read; a new rung adds its fact here.
export type CheckoutFacts = {
  /** Rung 0. False when the checkouts' drive or the project's is not there. */
  readable: boolean;
  /** Rung 1. The session's `activity !== "idle"`. */
  busy: boolean;
  /** Rung 2. The repository's main checkout, or the tree this engine runs
   *  from — reclaiming that one would kill the process doing the reclaiming. */
  protectedTree: boolean;
  /** Rung 3. */
  owner: WorktreeOwner;
  /** Rung 4. `undefined` means not proven, which is not `false`. */
  clean?: boolean;
  merged?: boolean;
  /** Whether there is a branch to have proved anything about. A detached
   *  checkout and one whose branch was deleted both answer false. */
  hasBranch: boolean;
};

// Rungs in order of certainty: unreadable, in-use, protected, active, then clean and merged.
// Git's lock is not a rung: removeSessionWorktreeAsync unlocks before removing, so it never refuses Telar.
export function classifyCheckout(facts: CheckoutFacts): WorktreeVerdict {
  if (!facts.readable) return { kind: "locked", reason: "unreadable" };
  if (facts.busy) return { kind: "locked", reason: "in-use" };
  if (facts.protectedTree) return { kind: "locked", reason: "protected" };
  // Nothing re-cuts a missing worktree, so a live session's checkout is never reclaimable.
  if (facts.owner.kind === "session" && facts.owner.lifecycle === "live") return { kind: "locked", reason: "active" };

  // Past here the owner is nothing, an archived session whose release never
  // happened, or a settled one — all three are things a person may legitimately
  // ask for back. What remains is whether the WORK inside is safe to lose.
  const reasons: WorktreeForceReason[] = [];
  if (!facts.hasBranch) reasons.push("no-branch");
  else if (facts.merged === undefined) reasons.push("unknown");
  else if (!facts.merged) reasons.push("unmerged");

  if (facts.clean === undefined) {
    // Only once: two unproven reads are one reason to go and look, and a row
    // reading "unknown, unknown" tells a person less than a row reading
    // "unknown" while looking like it tells them more.
    if (!reasons.includes("unknown")) reasons.push("unknown");
  } else if (!facts.clean) reasons.push("dirty");

  return reasons.length > 0 ? { kind: "needs-force", reasons } : { kind: "reclaimable" };
}

/** A session, as the inventory needs it. The store narrows its records to this
 *  so the gatherer never sees a whole `Session` and cannot grow a dependency on
 *  one. */
export type InventorySession = {
  id: string;
  title?: string;
  /** The path recorded on the session, never recomputed — `moveWorktrees`'
   *  discipline, and for its reason: the recorded path is what every other
   *  operation addresses this checkout by. */
  path: string;
  branch?: string;
  projectId: string;
  lifecycle: "live" | "settled" | "archived";
  busy: boolean;
};

/** A project, as the inventory needs it. `available` is the store's own
 *  `projectAvailability` probe, asked once per project rather than per row. */
export type InventoryProject = {
  id: string;
  name: string;
  root: string;
  available: boolean;
};

export type InventoryInput = {
  // Plural because a root move can be half-done; the old root still holds checkouts.
  roots: readonly string[];
  /** Whether the checkouts' own drive is there. False is rung 0 for every row
   *  under these roots, and it suppresses the disk scan entirely. */
  rootsReadable: boolean;
  /** Why, in words, when it is not. */
  blocker?: string;
  sessions: readonly InventorySession[];
  projects: readonly InventoryProject[];
  // The checkout the daemon runs from, when it runs from one.
  engineRoot?: string;
  now?: number;
};

export type InventoryDeps = {
  git: AsyncGitRunner;
  /** How a checkout is sized. Injected rather than imported so the classifier's
   *  tests never walk a real tree, and so the measurement stays the storage
   *  pane's — the rows have to sum to the figure that sent the person here. */
  measure: (target: string) => Promise<{ bytes?: number; partial: boolean }>;
};

/** `git worktree list --porcelain`, kept per path, including the `locked` line
 *  `parseWorktreeList` drops. The lock is evidence for the row; it is never a
 *  verdict. */
type Registration = { path: string; branch?: string; locked: boolean; isMainCheckout: boolean };

function parseRegistrations(stdout: string): Registration[] {
  const entries: Registration[] = [];
  let current: { path?: string; branch?: string; locked?: boolean } = {};
  const flush = () => {
    if (!current.path) return;
    entries.push({
      path: current.path,
      ...(current.branch ? { branch: current.branch } : {}),
      locked: current.locked === true,
      // The first stanza `git worktree list` emits is always the main checkout;
      // comparing paths would repeat `samePath`'s normalisation for no gain.
      isMainCheckout: entries.length === 0,
    });
    current = {};
  };
  for (const line of stdout.split("\n")) {
    const value = line.trimEnd();
    if (!value.trim()) {
      flush();
      continue;
    }
    if (value.startsWith("worktree ")) {
      flush();
      current.path = value.slice("worktree ".length).trim();
    } else if (value.startsWith("branch ")) {
      current.branch = value.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    } else if (value === "locked" || value.startsWith("locked ")) {
      current.locked = true;
    }
  }
  flush();
  return entries;
}

// macOS /var and /tmp are symlinks into /private; a gone checkout falls back to resolve().
function canonical(target: string): string {
  try {
    return fs.realpathSync.native(path.resolve(target));
  } catch {
    return path.resolve(target);
  }
}

/** Whether a git read is a fact or a killed subprocess — `GitReadFailure`'s
 *  distinction, applied to the two proofs this module makes. */
function readFailure(result: { status: number; timedOut?: true }): GitReadFailure | undefined {
  if (result.timedOut) return "timeout";
  return result.status === 0 ? undefined : "failed";
}

// Exit 0 is merged, 1 is not, anything else is undefined: never guess merged.
async function proveMerged(
  git: AsyncGitRunner,
  projectRoot: string,
  branch: string,
  base: string,
): Promise<{ merged?: boolean; incomplete?: GitReadFailure }> {
  let result;
  try {
    result = await git(projectRoot, ["merge-base", "--is-ancestor", branch, base]);
  } catch {
    return { incomplete: "failed" };
  }
  if (result.status === 0) return { merged: true };
  if (result.status === 1 && !result.timedOut) return { merged: false };
  return { incomplete: result.timedOut ? "timeout" : "failed" };
}

/** Is the checkout free of uncommitted and untracked work? `undefined` when git
 *  did not answer — a `status` that was killed must never read as clean. */
async function proveClean(git: AsyncGitRunner, worktreePath: string): Promise<{ clean?: boolean; incomplete?: GitReadFailure }> {
  let result;
  try {
    result = await git(worktreePath, ["status", "--porcelain"]);
  } catch {
    return { incomplete: "failed" };
  }
  const failure = readFailure(result);
  if (failure) return { incomplete: failure };
  return { clean: result.stdout.trim().length === 0 };
}

async function defaultBaseOf(git: AsyncGitRunner, projectRoot: string): Promise<string | undefined> {
  for (const candidate of ["refs/remotes/origin/HEAD", "refs/remotes/origin/main", "refs/remotes/origin/master", "refs/heads/main", "refs/heads/master"]) {
    try {
      const result = await git(projectRoot, ["rev-parse", "--verify", "--quiet", candidate]);
      if (result.status === 0 && result.stdout.trim()) return candidate.replace(/^refs\/remotes\//, "").replace(/^refs\/heads\//, "");
    } catch {
      // A runner that throws is a fake; the next candidate is still worth asking.
    }
  }
  return undefined;
}

type Draft = {
  path: string;
  canonical: string;
  session?: InventorySession;
  project?: InventoryProject;
  registration?: Registration;
  onDisk: boolean;
};

async function collectDrafts(deps: InventoryDeps, input: InventoryInput, roots: string[]) {
  let partial = false;
  const drafts = new Map<string, Draft>();
  const draftFor = (target: string): Draft => {
    const key = canonical(target);
    const existing = drafts.get(key);
    if (existing) return existing;
    const draft: Draft = { path: path.resolve(target), canonical: key, onDisk: false };
    drafts.set(key, draft);
    return draft;
  };

  const projectsById = new Map(input.projects.map((project) => [project.id, project]));

  // ── Witness 1: the session records ──────────────────────────────────────
  for (const session of input.sessions) {
    const draft = draftFor(session.path);
    draft.session = session;
    draft.project = projectsById.get(session.projectId);
  }

  // ── Witness 2: git's registrations, one listing per project ─────────────
  const bases = new Map<string, string | undefined>();
  for (const project of input.projects) {
    // A project whose own disk is gone is not one to ask. Its rows are still
    // drawn — from the session records — and they are `unreadable`, which is
    // the truth about them rather than a silent omission.
    if (!project.available) continue;
    let listing;
    try {
      listing = await deps.git(project.root, ["worktree", "list", "--porcelain"]);
    } catch {
      partial = true;
      continue;
    }
    if (listing.status !== 0 || listing.timedOut) {
      // The same care the composer's count already takes: a `worktree list`
      // that did not answer produces no rows rather than an authoritative none.
      partial = true;
      continue;
    }
    bases.set(project.id, await defaultBaseOf(deps.git, project.root));
    for (const registration of parseRegistrations(listing.stdout)) {
      const draft = draftFor(registration.path);
      draft.registration = registration;
      draft.project ??= project;
    }
  }

  // ── Witness 3: the checkouts roots themselves ───────────────────────────
  if (input.rootsReadable) {
    for (const root of roots) {
      let children: fs.Dirent[];
      try {
        children = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        // The default root does not exist until the first cut.
        continue;
      }
      for (const child of children) {
        if (!child.isDirectory()) continue;
        draftFor(path.join(root, child.name)).onDisk = true;
      }
    }
  }
  for (const draft of drafts.values()) {
    // A recorded or registered checkout outside the scanned roots — one cut
    // before the root moved and never migrated. It still exists and still costs
    // disk, so it is asked about directly rather than left off the list.
    if (!draft.onDisk && input.rootsReadable) draft.onDisk = fs.existsSync(draft.path);
  }
  return { drafts, bases, partial };
}

// Nothing here runs on an unreadable or protected row: each answer would be about a disk nobody can read.
async function proveDraft(deps: InventoryDeps, draft: Draft, branch: string | undefined, base: string | undefined) {
  const status = await proveClean(deps.git, draft.path);
  let incomplete: GitReadFailure | undefined = status.incomplete;
  let merged: boolean | undefined;
  let mergedInto: string | undefined;
  const project = draft.project;
  if (branch && base && project) {
    const proof = await proveMerged(deps.git, project.root, branch, base);
    merged = proof.merged;
    if (proof.merged !== undefined) mergedInto = base;
    incomplete ??= proof.incomplete;
  }
  // No `bytes` is "not sized yet" — the engine sizes checkouts in the
  // background — and the inventory says so rather than showing a zero.
  const measured = await deps.measure(draft.path);
  let updatedAt: number | undefined;
  // The directory's mtime, not the session's updatedAt, which a settle or rename bumps.
  try {
    updatedAt = fs.statSync(draft.path).mtimeMs;
  } catch {
    // A directory that vanished between the scan and here has no age.
  }
  return { clean: status.clean, merged, mergedInto, incomplete, bytes: measured.bytes, partial: measured.partial, updatedAt };
}

// Unions git's list, session records and a readdir of each root: a pruned checkout is only on disk.
// Unreadable roots are not scanned, or every recorded checkout would look orphaned.
export async function buildInventory(deps: InventoryDeps, input: InventoryInput): Promise<WorktreeInventory> {
  const at = input.now ?? Date.now();
  const roots = [...new Set(input.roots.map((root) => path.resolve(root)))];
  const engineTree = input.engineRoot ? canonical(input.engineRoot) : undefined;
  const collected = await collectDrafts(deps, input, roots);
  let partial = collected.partial;
  let measuring = false;

  const rows: WorktreeRow[] = [];
  for (const draft of collected.drafts.values()) {
    const project = draft.project;
    const readable = input.rootsReadable && (project?.available ?? true);
    const branch = draft.session?.branch ?? draft.registration?.branch;
    const owner: WorktreeOwner = draft.session
      ? {
          kind: "session",
          sessionId: draft.session.id,
          lifecycle: draft.session.lifecycle,
          ...(draft.session.title ? { title: draft.session.title } : {}),
        }
      : { kind: "none" };

    const protectedTree = draft.registration?.isMainCheckout === true || (engineTree !== undefined && engineTree === draft.canonical);
    const proof = readable && draft.onDisk && !protectedTree ? await proveDraft(deps, draft, branch, project ? collected.bases.get(project.id) : undefined) : undefined;
    const { clean, merged, mergedInto, incomplete, bytes, updatedAt } = proof ?? {};
    if (proof) {
      measuring ||= bytes === undefined;
      partial ||= proof.partial;
    }

    const verdict = classifyCheckout({
      readable,
      busy: draft.session?.busy === true,
      protectedTree,
      owner,
      hasBranch: branch !== undefined,
      ...(clean === undefined ? {} : { clean }),
      ...(merged === undefined ? {} : { merged }),
    });

    rows.push({
      path: draft.path,
      basename: path.basename(draft.path),
      ...(branch ? { branch } : {}),
      ...(project ? { projectId: project.id, projectName: project.name } : {}),
      owner,
      registered: draft.registration !== undefined,
      onDisk: draft.onDisk,
      ...(draft.registration?.locked ? { gitLocked: true } : {}),
      ...(bytes === undefined ? {} : { bytes }),
      ...(updatedAt === undefined ? {} : { updatedAt }),
      ...(clean === undefined ? {} : { clean }),
      ...(merged === undefined ? {} : { merged }),
      ...(mergedInto ? { mergedInto } : {}),
      ...(incomplete ? { incomplete } : {}),
      verdict,
    });
  }

  // The project's own checkout is never listed.
  const listed = rows.filter((row) => !(row.registered && row.verdict.kind === "locked" && row.verdict.reason === "protected" && row.owner.kind === "none"));

  return {
    rows: listed.sort(sortRows),
    roots,
    ...(input.blocker ? { blocker: input.blocker } : {}),
    partial,
    ...(measuring ? { measuring: true } : {}),
    measuredAt: at,
  };
}

// Archived sessions and removed checkouts are counted apart, one reason per refusal.
export function describeReclaim(results: readonly { ok: boolean; action?: string; refusal?: string; bytes?: number }[]): string {
  const parts: string[] = [];
  const released = results.filter((result) => result.ok && result.action === "released").length;
  const archived = results.filter((result) => result.ok && result.action === "archived").length;
  const removed = results.filter((result) => result.ok && result.action === "removed").length;
  const freed = results.filter((result) => result.ok).reduce((sum, result) => sum + (result.bytes ?? 0), 0);

  if (released > 0) parts.push(`Released ${released} checkout${released === 1 ? "" : "s"}; ${released === 1 ? "its session and branch are" : "their sessions and branches are"} kept, and the next message brings ${released === 1 ? "it" : "them"} back.`);
  if (archived > 0) parts.push(`Archived ${archived} session${archived === 1 ? "" : "s"} and gave back ${archived === 1 ? "its" : "their"} checkout${archived === 1 ? "" : "s"}.`);
  if (removed > 0) parts.push(`Removed ${removed} checkout${removed === 1 ? "" : "s"} that no session was holding.`);
  if (freed > 0) parts.push(`${formatBytes(freed)} back.`);

  const count = (refusal: string) => results.filter((result) => result.refusal === refusal).length;
  const inUse = count("in-use");
  const active = count("active");
  const unreadable = count("unreadable");
  const confirm = count("needs-confirm") + count("confirm-mismatch");
  const missing = count("not-found");
  const failed = count("failed") + count("protected");
  const unsafe = count("dirty") + count("unpushed") + count("process");

  if (inUse > 0) parts.push(`${inUse} ${inUse === 1 ? "is" : "are"} being worked in right now and ${inUse === 1 ? "was" : "were"} left alone.`);
  if (active > 0) parts.push(`${active} ${active === 1 ? "belongs" : "belong"} to a session that is still on the rail — settle ${active === 1 ? "it" : "them"} first.`);
  if (unreadable > 0) parts.push(`${unreadable} ${unreadable === 1 ? "is" : "are"} on a drive that is not connected, so nothing was touched.`);
  if (confirm > 0) parts.push(`${confirm} needed the name typed to confirm and ${confirm === 1 ? "was" : "were"} skipped.`);
  if (missing > 0) parts.push(`${missing} ${missing === 1 ? "was" : "were"} already gone.`);
  if (unsafe > 0) parts.push(`${unsafe} had uncommitted changes, unpushed commits or a running process, and ${unsafe === 1 ? "was" : "were"} left alone.`);
  if (failed > 0) parts.push(`${failed} could not be given back.`);

  if (parts.length === 0) return "There was nothing to give back.";
  return parts.join(" ");
}

/** Bytes as a person reads them. Matches the storage pane's rounding so the
 *  sentence and the row agree. */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function rank(row: WorktreeRow): number {
  if (row.verdict.kind === "reclaimable") return 0;
  if (row.verdict.kind === "needs-force") return 1;
  return 2;
}

function sortRows(left: WorktreeRow, right: WorktreeRow): number {
  const byRank = rank(left) - rank(right);
  if (byRank !== 0) return byRank;
  return (right.bytes ?? 0) - (left.bytes ?? 0);
}
