/**
 * ══ WHAT IS BEING KEPT, AND WHICH OF IT CAN GO — issue #671 ══
 *
 * THE CLASSIFICATION IS THE FEATURE; A LIST IS NOT. That is the whole argument
 * for this module existing rather than the surface calling `git worktree list`
 * and drawing what comes back. Telar can prove whether a checkout is merged,
 * whether it is clean, and whether anything still needs it. A list that showed
 * those as four columns and left the reasoning to the reader would make someone
 * check three things by hand before daring to delete — which nobody does, which
 * is how 7.3 GB accumulates behind sessions that finished weeks ago. The proof
 * is done here, once, so it is not re-derived per row by a human.
 *
 * ── THE LADDER ────────────────────────────────────────────────────────────
 *
 * `classifyCheckout` is a PURE FUNCTION over facts and it is the heart of this
 * file. Everything else gathers what it needs. The rungs are asked in order and
 * the first that holds is the row's answer:
 *
 *   0  unreadable — nobody looked
 *   1  in-use     — a session is working in it right now
 *   2  protected  — the main checkout, or the tree this engine runs from
 *   3  active     — a live, unsettled session's checkout
 *   4  the content proofs: clean, and merged
 *
 * THE ORDER IS THE ORDER OF CERTAINTY, and each rung's read is sound only if
 * the ones above it passed. Asking "is it merged" about a checkout on a drive
 * that is not mounted produces a confident answer about nothing.
 *
 * ── RUNG 0 IS LOAD-BEARING AND IT IS NOT A FOOTNOTE ───────────────────────
 *
 * The checkouts live on an external volume (#642 part 2) and that volume comes
 * and goes. **Absence from a disk nobody can read is evidence of nothing.** A
 * classifier that walked an unmounted root would find no directories, match no
 * session's recorded path, and conclude that every checkout on that drive is an
 * orphan — offering to reclaim, in one press, the entire contents of a disk
 * that is merely in somebody's bag. So readability gates every read below it,
 * and an unreadable row gets no orphan verdict, no size, and no affordance.
 *
 * ── RUNG 1 IS A POLICY, NOT AN ERROR TO CATCH ─────────────────────────────
 *
 * #641 locks every session worktree, and the natural assumption is that the
 * lock is what refuses a removal while a session is working. **It is not.**
 * `removeSessionWorktreeAsync` unlocks unconditionally before removing, and its
 * comment says why — "a lock that outlives its reason is how 'never lose one'
 * becomes 'never remove one'". The lock guards against an OUTSIDER:
 * `gh pr merge --delete-branch` running `git worktree remove` on the tree that
 * holds the merged branch. Against Telar it does nothing.
 *
 * Which means a reclaim aimed at a working session's checkout would not fail
 * with an error worth rendering — it would SUCCEED, and take the directory an
 * agent is writing in. There is nothing to surface and nothing to retry. The
 * refusal has to be asserted here, before the press, from the same predicate
 * `moveWorktrees` refuses wholesale on: `activity !== "idle"`. A refusal a
 * person can predict is a feature; one they discover by trying is, in this
 * case, data loss.
 *
 * ── RUNG 3 IS WHERE THE OLD SURFACE DOES NOT TRANSLATE ────────────────────
 *
 * The surface this rebuilds keyed on "no active loom", and looms are gone
 * (#501). Ownership is session-shaped now, and it did not port one-for-one: a
 * loom had ONE axis (running or not) and a session has two that matter
 * independently — its lifecycle and its shelf. `settled` is the state the old
 * vocabulary had no word for and it is the one doing the accumulating, because
 * `archiveSession` releases a checkout and settling deliberately does not:
 * "settled is a shelf, not an ending, and a settled session's checkout is still
 * the thing it would resume into". That policy is correct and nothing here
 * changes it. What was missing is that its consequence was invisible.
 *
 * ── AND `unknown` IS AN ANSWER ────────────────────────────────────────────
 *
 * A git read that exits non-zero is not a fact about the repository — the
 * lesson #650 and #654 each learnt in a different surface. A killed
 * `merge-base` must not mark a merged branch unmerged (annoying) and a killed
 * `status` must not mark a dirty tree clean (loses work). So an unproven
 * checkout is removable but asks for the typed force, exactly like a dirty one,
 * and it says which of the two it is.
 *
 * ── THIS MODULE REMOVES NOTHING ───────────────────────────────────────────
 *
 * It reads, measures and classifies. Every removal goes through the store, on
 * the per-project worktree queue, by the paths that already exist. Keeping the
 * proof and the deletion in separate files is what makes the proof testable
 * without a fixture that can lose data.
 */

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
import type { AsyncGitRunner } from "./worktree";

/**
 * EVERYTHING THE LADDER NEEDS, AND NOTHING ELSE.
 *
 * Spelled as its own type rather than taken off `WorktreeRow` so the classifier
 * cannot quietly start reading a field that was gathered for display. If a rung
 * wants a new fact, it has to be added here, which is a decision somebody makes
 * rather than a coupling that happens.
 */
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
   *  checkout and one whose branch was deleted (#641) both answer false. */
  hasBranch: boolean;
};

/**
 * THE LADDER. Pure, total, and the one function in this feature worth reading
 * on its own — every safety property the surface claims is decided here.
 *
 * NOTE WHAT IS NOT A RUNG: git's lock. It appears on the row as evidence and
 * never in this function, because it does not refuse Telar (see the header) and
 * a classifier that treated it as protection would be claiming a guarantee
 * nothing provides.
 */
export function classifyCheckout(facts: CheckoutFacts): WorktreeVerdict {
  if (!facts.readable) return { kind: "locked", reason: "unreadable" };
  if (facts.busy) return { kind: "locked", reason: "in-use" };
  if (facts.protectedTree) return { kind: "locked", reason: "protected" };
  // A live, unsettled session is somebody's current work whether or not a turn
  // is in flight this second. Removing its checkout frees no session: nothing
  // re-cuts a missing worktree, so the record would name a directory that is
  // not there and every read on it would fail with no explanation.
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
  /**
   * THE CHECKOUT ROOTS, PLURAL, because a #642 move can be half-done: changing
   * where checkouts go affects the next cut and leaves the existing ones where
   * they are. An inventory of the configured root alone would omit exactly the
   * gigabytes somebody changed the setting to shed — `measureStorage` walks
   * both for the same reason.
   */
  roots: readonly string[];
  /** Whether the checkouts' own drive is there. False is rung 0 for every row
   *  under these roots, and it suppresses the disk scan entirely. */
  rootsReadable: boolean;
  /** Why, in words, when it is not. */
  blocker?: string;
  sessions: readonly InventorySession[];
  projects: readonly InventoryProject[];
  /**
   * THE CHECKOUT THIS ENGINE IS RUNNING OUT OF, when it is running out of one.
   * On a packaged install this is absent; on the machine Telar is developed on
   * it is a worktree of Telar itself, and reclaiming it would delete the tree
   * the daemon is executing from mid-press.
   */
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
 *  verdict (see the header). */
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

/**
 * macOS hands out `/var` and `/tmp` as symlinks into `/private`, so the path a
 * session recorded and the path git reports can name one directory in two
 * spellings. Every join in this module is by path, so they have to agree.
 *
 * `realpathSync` WHERE IT CAN, `resolve` WHERE IT CANNOT. A checkout that is
 * gone has no real path, and falling back rather than throwing is what lets a
 * released-but-still-recorded row be matched at all.
 */
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

/**
 * IS THE BRANCH ALREADY IN THE DEFAULT BASE? Three answers, never two.
 *
 * `merge-base --is-ancestor` exits 0 for yes and 1 for no, and ANYTHING ELSE IS
 * NOT AN ANSWER — a missing branch, a killed child, a repository that could not
 * be opened. Mapping the third case onto "not merged" would be the safe-looking
 * mistake: it only ever adds a force prompt. Mapping it onto "merged" loses
 * work. Returning `undefined` is what lets the row say "Telar could not tell",
 * which is the only one of the three that is true.
 */
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

/**
 * WHAT A PROJECT'S BRANCHES ARE MEASURED AGAINST — the same `origin/main` the
 * base-ref picker offers, read once per project rather than per row.
 *
 * FALLS BACK TO THE LOCAL DEFAULT, AND THEN TO NOTHING. A repository with no
 * remote still has a main branch worth being merged into; one with neither has
 * no base at all, and every row under it is honestly unproven rather than
 * assumed unmerged.
 */
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

/**
 * THE INVENTORY. Three witnesses, unioned by canonical path.
 *
 * WHY THREE, when `git worktree list` sounds like it should be enough: it is
 * the one witness that CANNOT see the class this feature exists for. A
 * directory whose registration was pruned — which is what `removeSessionWorktree`
 * does on every teardown, and what a `git worktree prune` from any other tool
 * does — is invisible to git and to the session records alike. It is just a
 * folder, holding gigabytes, that nothing will ever mention again. Only reading
 * the checkouts root itself finds it, and `planSessionWorktree` puts every cut
 * flat at `<root>/<name>-<8hex>`, so one `readdir` per root is the whole scan.
 *
 * AND THE SCAN IS SKIPPED ENTIRELY WHEN THE ROOTS ARE NOT READABLE, which is
 * rung 0 doing its job before any row exists: an empty `readdir` of a drive
 * that is out would make every recorded checkout an orphan at once.
 */
export async function buildInventory(deps: InventoryDeps, input: InventoryInput): Promise<WorktreeInventory> {
  const at = input.now ?? Date.now();
  const roots = [...new Set(input.roots.map((root) => path.resolve(root)))];
  const engineTree = input.engineRoot ? canonical(input.engineRoot) : undefined;
  let partial = false;
  let measuring = false;

  type Draft = {
    path: string;
    canonical: string;
    session?: InventorySession;
    project?: InventoryProject;
    registration?: Registration;
    onDisk: boolean;
  };
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
        // An absent root is zero checkouts, not a partial read — the default
        // root does not exist until the first cut. A root that exists and
        // cannot be listed is caught by the same call and is rarer than the
        // case this comment protects.
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

  // ── The proofs, per row ─────────────────────────────────────────────────
  const rows: WorktreeRow[] = [];
  for (const draft of drafts.values()) {
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

    let clean: boolean | undefined;
    let merged: boolean | undefined;
    let mergedInto: string | undefined;
    let incomplete: GitReadFailure | undefined;
    let bytes: number | undefined;
    let updatedAt: number | undefined;

    // NOTHING BELOW RUNS ON AN UNREADABLE ROW, which is rung 0 enforced rather
    // than described: no status, no merge-base, no walk. Each would answer
    // about a disk nobody can read, and each answer would be believed.
    if (readable && draft.onDisk && !protectedTree) {
      const status = await proveClean(deps.git, draft.path);
      clean = status.clean;
      incomplete ??= status.incomplete;

      const base = project ? bases.get(project.id) : undefined;
      if (branch && base && project) {
        const proof = await proveMerged(deps.git, project.root, branch, base);
        merged = proof.merged;
        if (proof.merged !== undefined) mergedInto = base;
        incomplete ??= proof.incomplete;
      }

      // No `bytes` is "not sized yet" — the engine sizes checkouts in the
      // background — and the inventory says so rather than showing a zero.
      const measured = await deps.measure(draft.path);
      bytes = measured.bytes;
      measuring ||= bytes === undefined;
      partial ||= measured.partial;

      /**
       * HOW LONG IT HAS BEEN SITTING THERE, which is the other half of "should
       * this still exist" and the one the size cannot answer: a 40 MB checkout
       * touched this morning and a 40 MB one last touched in June are the same
       * row without it.
       *
       * THE DIRECTORY'S OWN mtime, NOT THE SESSION'S `updatedAt`. They differ
       * exactly where it matters — a session whose record was rewritten by a
       * settle or a title change has a recent timestamp and a checkout nobody
       * has written to in weeks.
       */
      try {
        updatedAt = fs.statSync(draft.path).mtimeMs;
      } catch {
        // A directory that vanished between the scan and here has no age, and
        // the row says nothing rather than inventing one.
      }
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

  /**
   * A REGISTERED-BUT-ABSENT MAIN CHECKOUT IS NOT A ROW. `git worktree list`
   * always names the project root first, and the project root is not a session
   * checkout — it is somebody's repository, which this surface has no business
   * listing among things that can be reclaimed. It is dropped rather than shown
   * `protected`, because a list of reclaimable checkouts that opens with a row
   * nobody may ever touch teaches people to skim past the first row.
   */
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

/**
 * WHAT ONE PRESS OF RECLAIM DID, in a sentence — `describeOutcome`'s discipline
 * and for its reason: one reason per refusal, never a single total, because the
 * reasons send a person to different places.
 *
 * THE TWO ACTS ARE COUNTED SEPARATELY. "Archived 3 sessions and removed 2
 * checkouts" and "gave back 5 checkouts" describe the same press, and only the
 * first says that three conversations were ended. The disk is the consequence;
 * the sessions are the decision.
 */
export function describeReclaim(results: readonly { ok: boolean; action?: string; refusal?: string; bytes?: number }[]): string {
  const parts: string[] = [];
  const archived = results.filter((result) => result.ok && result.action === "archived").length;
  const removed = results.filter((result) => result.ok && result.action === "removed").length;
  const freed = results.filter((result) => result.ok).reduce((sum, result) => sum + (result.bytes ?? 0), 0);

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

  if (inUse > 0) parts.push(`${inUse} ${inUse === 1 ? "is" : "are"} being worked in right now and ${inUse === 1 ? "was" : "were"} left alone.`);
  if (active > 0) parts.push(`${active} ${active === 1 ? "belongs" : "belong"} to a session that is still on the rail — settle ${active === 1 ? "it" : "them"} first.`);
  if (unreadable > 0) parts.push(`${unreadable} ${unreadable === 1 ? "is" : "are"} on a drive that is not connected, so nothing was touched.`);
  if (confirm > 0) parts.push(`${confirm} needed the name typed to confirm and ${confirm === 1 ? "was" : "were"} skipped.`);
  if (missing > 0) parts.push(`${missing} ${missing === 1 ? "was" : "were"} already gone.`);
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

/**
 * BIGGEST RECLAIMABLE FIRST, then everything else by size.
 *
 * The row somebody needs is the one they did not know about, and on this
 * surface that is the largest thing nothing needs — `measureStorage`'s
 * reasoning, one level down. Locked rows sort last because no amount of reading
 * them changes what a person can do.
 */
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
