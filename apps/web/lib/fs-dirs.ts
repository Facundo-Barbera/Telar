/**
 * LISTING DIRECTORIES SO A PALETTE — OR A PHONE — CAN BROWSE ONE.
 *
 * THE RULES OF `/api/fs`, lifted out of the route so they can be tested.
 * The route has answered the phone's Add-project browser for a while
 * (`apps/ios/.../AddProjectView.swift`); the palette's in-app browser is the
 * second caller, and it needed three things the inline version did not have: a
 * `~` that expands, a dotfolder toggle, and — the important one — a refusal for
 * paths outside the places a folder picker has any business in. So the rules
 * moved here and grew those, rather than a second listing route appearing
 * beside this one with its own idea of what is allowed.
 *
 * IT STAYS IN THE WEB PROCESS rather than moving to the engine, because that is
 * where it already was and the hop it needs already exists: `/api/fs` on a
 * paired Mac is reached as `/api/hosts/:id/fs`, which forwards to THAT
 * cockpit's own Next process and lists ITS disk. An engine route would have
 * been a second path to the same answer.
 *
 * IT IS A READ, AND THE NARROWEST ONE THAT ANSWERS "WHICH FOLDER". Directories
 * only — no file names, no sizes, nothing's contents. `git` is the one extra
 * bit, and it is what makes three checkouts findable in a list of thirty.
 *
 * WHAT IT WILL NOT DO:
 *   - Leave the user's own directories. Home and this platform's mount points
 *     are the roots; anything else is refused BY NAME, with a sentence, rather
 *     than answered with an empty list that reads like a bug. This is new: the
 *     inline version listed any absolute path, `/private/var` included.
 *   - Follow a symlink. Children come from `lstat`, so a link is never a folder
 *     here — which is both how a loop becomes impossible and how a link
 *     pointing out of home stops being a way around the check above. A path
 *     TYPED into the field is canonicalised first, so containment is tested on
 *     where it really goes, and a self-referential link is a refusal rather
 *     than a hang.
 *   - Interpolate anything into a shell. There is no subprocess here at all.
 *
 * THE SHAPE IS THE PHONE'S, ADDED TO AND NOT CHANGED. `dirs`, and `git` on each
 * entry, are the names `DirectoryListing` decodes in Swift; `hidden` and
 * `truncated` are new keys, which a `Decodable` ignores if it does not know
 * them. Renaming `git` to the issue's `isRepo` would have been a cosmetic
 * change that broke a shipped client.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mountRootsFor } from "@telar/engine-client";

/** One folder somebody could descend into or take. */
export type DirectoryEntry = {
  name: string;
  /** Absolute, and always under the listing's own `path`. */
  path: string;
  /** A `.git` is there — a checkout, or a worktree whose `.git` is a file. */
  git: boolean;
  /** The name starts with a dot. On every entry, so a caller that shows them
   *  can mark them without re-deriving the rule from the name. */
  hidden: boolean;
};

export type DirectoryListing = {
  /** The canonical absolute directory these entries are in — symlinks already
   *  resolved, so it is where the caller really is. */
  path: string;
  /** Its last segment: what a person calls the folder they are looking at. */
  name: string;
  /** One step up, or `null` at a browsable root — so an up gesture never leads
   *  somewhere the next request would refuse. */
  parent: string | null;
  /** The home directory of the account that answered, so a field can show
   *  `~/code`. On a paired Mac this is not the machine asking, which is exactly
   *  why it is answered rather than assumed. */
  home: string;
  /**
   * THE PLACES BROWSING MAY START — home, and whatever is mounted right now.
   *
   * WHY THIS IS ANSWERED RATHER THAN ASSUMED (#630). `browseRoots` has always
   * allowed a mounted volume, and `listDirectories("/Volumes")` has always
   * worked. But the browser opens at home and home's `parent` is `null` — by
   * design, since `/Users` is outside the roots — so there was no gesture that
   * reached a drive. The only way in was to know the path and type it, which is
   * indistinguishable from "Telar cannot see my external disk".
   *
   * So the roots travel with the listing: the same list the refusal already
   * names, in a form a picker can render. Nothing new is PERMITTED here — the
   * containment check is unchanged — something already permitted is made
   * visible. A client that does not know the key ignores it.
   */
  roots: { name: string; path: string }[];
  dirs: DirectoryEntry[];
  /** The listing was cut. Said out loud, because a silently truncated list is
   *  one a reader scrolls to the bottom of looking for a folder that is there. */
  truncated: boolean;
};

export type DirectoryFailure = { code: "invalid_request" | "not_found"; message: string };
export type DirectoryOutcome = DirectoryListing | DirectoryFailure;

export function isDirectoryFailure(outcome: DirectoryOutcome): outcome is DirectoryFailure {
  return "code" in outcome;
}

/** A folder with more children than this is one nobody browses by eye, and the
 *  answer has to fit in one response. Was 250 inline; the browser's list
 *  scrolls, so it can afford more. */
export const MAX_ENTRIES = 500;

/** The narrow slice of `node:fs` this module uses, so a test can hand it a
 *  scratch home rather than the machine's. Real `fs` by default — the loop and
 *  the containment cases are only honest against a real filesystem. */
export type DirectoryDeps = {
  home?: string;
  platform?: NodeJS.Platform;
  /** The mount roots, when the platform's own are not what is being tested. A
   *  test cannot create `/Volumes`, and contorting `exists` to pretend it did
   *  would be testing the fake rather than the rule. */
  mounts?: readonly string[];
  realpath?: (target: string) => string;
  stat?: (target: string) => fs.Stats;
  readdir?: (target: string) => fs.Dirent[];
  exists?: (target: string) => boolean;
};

type Resolved = Required<DirectoryDeps>;

function resolveDeps(deps: DirectoryDeps): Resolved {
  const platform = deps.platform ?? process.platform;
  return {
    home: deps.home ?? os.homedir(),
    platform,
    // THE ONE LIST (#665) — this was the third copy, and it said so.
    mounts: deps.mounts ?? mountRootsFor(platform),
    realpath: deps.realpath ?? ((target) => fs.realpathSync.native(target)),
    stat: deps.stat ?? ((target) => fs.statSync(target)),
    readdir: deps.readdir ?? ((target) => fs.readdirSync(target, { withFileTypes: true })),
    exists: deps.exists ?? ((target) => fs.existsSync(target)),
  };
}

/**
 * `~`, `~/code`, and nothing at all, as absolute paths.
 *
 * NOTHING MEANS HOME, which is what the phone already relies on and what makes
 * the palette's first render a listing rather than an empty field. `~someone`
 * is NOT expanded — that is another account's home, which this never lists.
 */
export function expandHome(raw: string | null | undefined, home: string): string {
  const input = (raw ?? "").trim();
  if (!input || input === "~") return home;
  if (input === "~/" || input.startsWith("~/")) return path.join(home, input.slice(2));
  return input;
}

/**
 * WHERE BROWSING IS ALLOWED TO GO.
 *
 * Home, plus this platform's mount points — an external disk is exactly where
 * a second checkout lives, and refusing it would send somebody back to the
 * Finder dialog this replaces. `/` is not a root: the rest of the disk is the
 * operating system, and a folder picker for "add a project" has no business
 * walking `/private/var`.
 *
 * A mount root that does not exist is left out, so the refusal names only
 * places that are really there.
 */
export function browseRoots(deps: DirectoryDeps = {}): string[] {
  const { home, mounts, exists } = resolveDeps(deps);
  return [home, ...mounts.filter((mount) => exists(mount))];
}

/** `target` is `root` or sits under it. Compared on a SEPARATOR boundary, so
 *  `/Users/some` does not contain `/Users/someone`. */
export function within(root: string, target: string): boolean {
  if (target === root) return true;
  return target.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
}

/** The sentence a refused path gets. It NAMES the places that would work,
 *  because "outside your home directory" alone leaves somebody with an
 *  external disk guessing. */
function outsideMessage(roots: readonly string[]): string {
  const [home, ...mounts] = roots;
  const where = mounts.length > 0 ? `${home} or a mounted volume (${mounts.join(", ")})` : String(home);
  return `Telar only browses ${where}. Type a path inside one of those.`;
}

/** Natural order, so `run-2` sorts before `run-10` and case is not a filter —
 *  the order a Finder window shows. The inline version sorted lexically, which
 *  put `run-10` first. */
export function compareNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/**
 * The directories inside one directory.
 *
 * A FAILURE IS A VALUE, as in `apps/engine/src/clone.ts`: each arm is a
 * sentence a caller shows under its own field, and "that is not a folder",
 * "that folder is not there" and "Telar does not browse there" read very
 * differently to the person who typed it.
 */
export function listDirectories(
  input: { path?: string | null; hidden?: boolean } = {},
  deps: DirectoryDeps = {},
): DirectoryOutcome {
  const resolved = resolveDeps(deps);
  const { home, realpath, stat, readdir, exists } = resolved;
  const requested = expandHome(input.path, home);
  if (!path.isAbsolute(requested)) {
    return { code: "invalid_request", message: "A folder path has to be absolute, or start with ~." };
  }

  // CANONICAL FIRST, THEN CHECKED. `realpath` resolves every symlink on the way
  // down, which is what makes the containment test below a test of where the
  // path really goes — and it is where a self-referential link turns into ELOOP
  // instead of a walk that never ends.
  let target: string;
  try {
    target = realpath(requested);
  } catch (cause) {
    const code = (cause as { code?: string } | null)?.code;
    if (code === "ELOOP") return { code: "invalid_request", message: "That path loops through itself." };
    if (code === "EACCES" || code === "EPERM") return { code: "invalid_request", message: "That folder is not readable." };
    return { code: "not_found", message: "That folder does not exist." };
  }

  const roots = browseRoots(resolved);
  if (!roots.some((root) => within(root, target))) {
    return { code: "invalid_request", message: outsideMessage(roots) };
  }

  try {
    if (!stat(target).isDirectory()) return { code: "invalid_request", message: "That is a file, not a folder." };
  } catch {
    return { code: "not_found", message: "That folder does not exist." };
  }

  let children: fs.Dirent[];
  try {
    children = readdir(target);
  } catch {
    return { code: "invalid_request", message: "That folder is not readable." };
  }

  // `isDirectory()` on a `withFileTypes` entry reads the LSTAT, so a symlink is
  // false here however it resolves. That is the whole loop defence: a link is
  // never offered as a folder to descend into, and typing its path takes the
  // canonical route above.
  const names = children.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const visible = input.hidden ? names : names.filter((name) => !name.startsWith("."));
  const truncated = visible.length > MAX_ENTRIES;
  const dirs = visible
    .sort(compareNames)
    .slice(0, MAX_ENTRIES)
    .map((name) => {
      const full = path.join(target, name);
      let git = false;
      try {
        git = exists(path.join(full, ".git"));
      } catch {
        // An unreadable child is still a folder; it just gets no branch glyph.
      }
      return { name, path: full, git, hidden: name.startsWith(".") };
    });

  const up = path.dirname(target);
  return {
    path: target,
    name: path.basename(target) || target,
    // A root has no up. Home's parent is `/Users` — outside the roots, so
    // offering it would be an up gesture whose answer is a refusal.
    parent: up !== target && roots.some((root) => within(root, up)) ? up : null,
    home,
    roots: listRoots(resolved),
    dirs,
    truncated,
  };
}

/**
 * The browsable roots, each with the name a person would call it.
 *
 * A MOUNT ROOT IS EXPANDED TO THE DRIVES INSIDE IT, because "/Volumes" is not
 * somewhere anybody means to go — the drive is. Home keeps its own entry and is
 * always first, so the list reads as "your files, then your disks". A mount
 * root with nothing in it contributes nothing rather than an empty heading.
 */
export function listRoots(deps: DirectoryDeps = {}): { name: string; path: string }[] {
  const resolved = resolveDeps(deps);
  const { home, mounts, readdir, exists } = resolved;
  const roots = [{ name: "Home", path: home }];
  for (const mount of mounts) {
    if (!exists(mount)) continue;
    let names: string[];
    try {
      names = readdir(mount).map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const name of names.filter((entry) => !entry.startsWith(".")).sort(compareNames)) {
      const full = path.join(mount, name);
      // The same `st_dev` test `volumes.ts` uses: the empty folder macOS leaves
      // behind at an old mount point looks exactly like a drive by its path,
      // and offering it would send somebody into a directory that disappears.
      try {
        if (resolved.stat(full).dev === resolved.stat(mount).dev) continue;
      } catch {
        continue;
      }
      roots.push({ name, path: full });
    }
  }
  return roots;
}
