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
  /** Asked with `nearest`, the path that was requested and is not a folder —
   *  so the caller can say why it is looking at an ancestor instead. */
  missing?: string;
  /** The `.git` probes ran out of time before every row was asked, so some
   *  checkouts carry no branch glyph. See `GIT_PROBE_BUDGET_MS`. */
  gitPartial?: boolean;
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

/**
 * HOW LONG THE BRANCH GLYPHS MAY COST, in total.
 *
 * Each row's `.git` check is a lookup INSIDE that child, and in a cloud-synced
 * folder (macOS's `~/Library/CloudStorage/…`, served by a FileProvider
 * extension) that can mean the extension enumerating a folder it has never
 * fetched. Five hundred of those is a listing that never arrives, so past this
 * budget the remaining rows are listed without the glyph and the listing says
 * so. The folders are still there; only the badge is skipped.
 */
export const GIT_PROBE_BUDGET_MS = 1500;

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
  lstat?: (target: string) => fs.Stats;
  readdir?: (target: string) => fs.Dirent[];
  exists?: (target: string) => boolean;
  now?: () => number;
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
    lstat: deps.lstat ?? ((target) => fs.lstatSync(target)),
    readdir: deps.readdir ?? ((target) => fs.readdirSync(target, { withFileTypes: true })),
    exists: deps.exists ?? ((target) => fs.existsSync(target)),
    now: deps.now ?? Date.now,
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

/** Under macOS's cloud-folder mount point, where a read that fails is most
 *  often the sync app, or a privacy permission it asks for, rather than the
 *  folder. */
function inCloudFolder(target: string, home: string): boolean {
  return within(path.join(home, "Library", "CloudStorage"), target);
}

const errorCode = (cause: unknown): string | undefined => (cause as { code?: string } | null)?.code;

/** Nothing is at this path, as opposed to something being there that could
 *  not be read. Only the first is a reason to walk up. */
const absent = (code: string | undefined) => code === "ENOENT" || code === "ENOTDIR";

/**
 * The sentence for a folder that is THERE and could not be read.
 *
 * Every failure used to read "does not exist", which is false for a folder
 * somebody can see in Finder. A cloud folder gets the two causes that are
 * actually likely there, since neither is guessable from an error code.
 */
function unreadable(target: string, home: string, code: string | undefined): DirectoryFailure {
  const denied = code === "EACCES" || code === "EPERM";
  if (inCloudFolder(target, home)) {
    return {
      code: "invalid_request",
      message: denied
        ? "macOS has not let Telar read this cloud folder. Allow it in System Settings → Privacy & Security → Files & Folders, then try again."
        : `That cloud folder could not be read${code ? ` (${code})` : ""}. Check that its sync app is running and signed in, then try again.`,
    };
  }
  if (denied) return { code: "invalid_request", message: "That folder is not readable." };
  return { code: "invalid_request", message: `That folder could not be read${code ? ` (${code})` : ""}.` };
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
  input: { path?: string | null; hidden?: boolean; nearest?: boolean } = {},
  deps: DirectoryDeps = {},
): DirectoryOutcome {
  const resolved = resolveDeps(deps);
  const { home, realpath, stat, lstat, readdir, exists, now } = resolved;
  const requested = expandHome(input.path, home);
  if (!path.isAbsolute(requested)) {
    return { code: "invalid_request", message: "A folder path has to be absolute, or start with ~." };
  }

  // CANONICAL FIRST, THEN CHECKED. `realpath` resolves every symlink on the way
  // down, which is what makes the containment test below a test of where the
  // path really goes — and it is where a self-referential link turns into ELOOP
  // instead of a walk that never ends.
  //
  // `nearest` WALKS UP from a path that is not a folder — a pasted path to a
  // file, or to a folder since renamed — to the closest one that is, so the
  // browser opens somewhere useful and can say why. Only ABSENCE walks up: a
  // folder that is there and unreadable is reported, never skipped past.
  let candidate = requested;
  let walked = false;
  let target: string | undefined;
  while (target === undefined) {
    let real: string;
    let directory: boolean;
    try {
      real = realpath(candidate);
      directory = stat(real).isDirectory();
    } catch (cause) {
      const code = errorCode(cause);
      if (code === "ELOOP") return { code: "invalid_request", message: "That path loops through itself." };
      if (!absent(code)) return unreadable(candidate, home, code);
      if (!input.nearest || path.dirname(candidate) === candidate) {
        return { code: "not_found", message: "That folder does not exist." };
      }
      candidate = path.dirname(candidate);
      walked = true;
      continue;
    }
    if (directory) target = real;
    else if (!input.nearest) return { code: "invalid_request", message: "That is a file, not a folder." };
    else {
      candidate = path.dirname(candidate);
      walked = true;
    }
  }
  const folder = target;

  const roots = browseRoots(resolved);
  if (!roots.some((root) => within(root, folder))) {
    return { code: "invalid_request", message: outsideMessage(roots) };
  }

  let children: fs.Dirent[];
  try {
    children = readdir(folder);
  } catch (cause) {
    return unreadable(folder, home, errorCode(cause));
  }

  // `isDirectory()` on a `withFileTypes` entry reads the LSTAT, so a symlink is
  // false here however it resolves. That is the whole loop defence: a link is
  // never offered as a folder to descend into, and typing its path takes the
  // canonical route above.
  //
  // AN ENTRY WITH NO TYPE IS ASKED, ONE AT A TIME. A filesystem may answer
  // `readdir` without `d_type` (a FileProvider-backed cloud folder can), and
  // such an entry reads as "not a directory" — a folder plainly there and
  // missing from the list. So it gets its own `lstat`, and one that cannot be
  // stat'd is left out rather than failing every other row with it.
  const isFolder = (entry: fs.Dirent): boolean => {
    if (entry.isDirectory()) return true;
    if (entry.isFile() || entry.isSymbolicLink() || entry.isFIFO() || entry.isSocket()) return false;
    if (entry.isBlockDevice() || entry.isCharacterDevice()) return false;
    try {
      return lstat(path.join(folder, entry.name)).isDirectory();
    } catch {
      return false;
    }
  };
  const names = children.filter(isFolder).map((entry) => entry.name);
  const visible = input.hidden ? names : names.filter((name) => !name.startsWith("."));
  const truncated = visible.length > MAX_ENTRIES;
  const deadline = now() + GIT_PROBE_BUDGET_MS;
  let gitPartial = false;
  const dirs = visible
    .sort(compareNames)
    .slice(0, MAX_ENTRIES)
    .map((name) => {
      const full = path.join(folder, name);
      let git = false;
      if (!gitPartial && now() > deadline) gitPartial = true;
      if (!gitPartial) {
        try {
          git = exists(path.join(full, ".git"));
        } catch {
          // An unreadable child is still a folder; it just gets no branch glyph.
        }
      }
      return { name, path: full, git, hidden: name.startsWith(".") };
    });

  const up = path.dirname(folder);
  return {
    path: folder,
    name: path.basename(folder) || folder,
    // A root has no up. Home's parent is `/Users` — outside the roots, so
    // offering it would be an up gesture whose answer is a refusal.
    parent: up !== folder && roots.some((root) => within(root, up)) ? up : null,
    home,
    roots: listRoots(resolved),
    dirs,
    truncated,
    ...(walked ? { missing: requested } : {}),
    ...(gitPartial ? { gitPartial } : {}),
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
