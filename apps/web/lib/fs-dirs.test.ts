/**
 * THE DIRECTORY LISTING BOTH ADD-PROJECT BROWSERS RUN ON — the palette's and
 * the phone's.
 *
 * Against a REAL filesystem, in a scratch home, rather than a mocked `fs`: the
 * three things this module exists to get right — a link that loops, a path that
 * leaves the allowed roots, and the lstat rule that makes links not-folders —
 * are all properties of the filesystem, and a fake would only ever agree with
 * whatever this module already believes.
 *
 * THE SHAPE TESTS ARE THE PHONE'S CONTRACT. `dirs`, `name` and `git` are what
 * `DirectoryListing` decodes in Swift (apps/ios/.../CatalogModels.swift), and
 * this route was answering it before the palette existed.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  browseRoots,
  compareNames,
  expandHome,
  isDirectoryFailure,
  listDirectories,
  listRoots,
  MAX_ENTRIES,
  within,
  type DirectoryListing,
  type DirectoryOutcome,
} from "./fs-dirs";

const homes: string[] = [];
/** A scratch home, CANONICALISED — the listing resolves symlinks before it
 *  checks containment, and macOS's `/var/folders/…` is a symlink to
 *  `/private/var/folders/…`, so an un-resolved root would refuse its own
 *  children. */
function scratchHome(): string {
  const home = realpathSync.native(mkdtempSync(path.join(tmpdir(), "telar-fs-dirs-")));
  homes.push(home);
  return home;
}
afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

/** The listing, or a failure naming the refusal instead of an unhelpful
 *  "undefined is not an object" three lines later. */
function listing(result: DirectoryOutcome): DirectoryListing {
  if (isDirectoryFailure(result)) throw new Error(`expected a listing, got ${result.code}: ${result.message}`);
  return result;
}

const names = (result: DirectoryOutcome) => listing(result).dirs.map((entry) => entry.name);

describe("expandHome", () => {
  test("nothing at all means home, which is where the phone's browser starts", () => {
    expect(expandHome(undefined, "/Users/someone")).toBe("/Users/someone");
    expect(expandHome(null, "/Users/someone")).toBe("/Users/someone");
    expect(expandHome("   ", "/Users/someone")).toBe("/Users/someone");
  });

  test("~ and ~/x expand; an absolute path is left alone", () => {
    expect(expandHome("~", "/Users/someone")).toBe("/Users/someone");
    expect(expandHome("~/", "/Users/someone")).toBe("/Users/someone");
    expect(expandHome("~/code/telar", "/Users/someone")).toBe("/Users/someone/code/telar");
    expect(expandHome("/tmp/x", "/Users/someone")).toBe("/tmp/x");
  });

  test("~someone is NOT expanded — another account's home is not this one's", () => {
    // Left verbatim, which then fails the absolute-path check rather than
    // quietly becoming a path under the wrong home.
    expect(expandHome("~root/secrets", "/Users/someone")).toBe("~root/secrets");
    expect(listDirectories({ path: "~root" }, { home: "/Users/someone" })).toMatchObject({ code: "invalid_request" });
  });
});

describe("within", () => {
  test("containment is tested on a separator boundary", () => {
    expect(within("/Users/someone", "/Users/someone")).toBe(true);
    expect(within("/Users/someone", "/Users/someone/code")).toBe(true);
    // The bug this prevents: a prefix match letting another account's home in.
    expect(within("/Users/some", "/Users/someone")).toBe(false);
    expect(within("/Users/someone", "/Users")).toBe(false);
  });
});

describe("browseRoots", () => {
  test("home, plus this platform's mount points when they exist", () => {
    expect(browseRoots({ home: "/Users/someone", platform: "darwin", exists: () => true })).toEqual([
      "/Users/someone",
      "/Volumes",
    ]);
    expect(browseRoots({ home: "/home/someone", platform: "linux", exists: () => true })).toEqual([
      "/home/someone",
      "/media",
      "/mnt",
    ]);
    // A mount root that is not there is left out, so the refusal names only
    // places that really exist.
    expect(browseRoots({ home: "/Users/someone", platform: "darwin", exists: () => false })).toEqual(["/Users/someone"]);
  });
});

describe("listDirectories", () => {
  test("directories only — files are not folders and are not listed", () => {
    const home = scratchHome();
    mkdirSync(path.join(home, "code"));
    mkdirSync(path.join(home, "notes"));
    writeFileSync(path.join(home, "README.md"), "x");
    expect(names(listDirectories({}, { home, platform: "darwin" }))).toEqual(["code", "notes"]);
  });

  test("the shape is the one the phone decodes: path, name, parent, home, dirs", () => {
    const home = scratchHome();
    mkdirSync(path.join(home, "code"));
    const result = listing(listDirectories({}, { home, platform: "darwin" }));
    expect(result.path).toBe(home);
    expect(result.name).toBe(path.basename(home));
    expect(result.home).toBe(home);
    // `git` is the entry's own word, and it stays that: renaming it would be a
    // cosmetic change that broke a shipped client.
    expect(result.dirs[0]).toEqual({ name: "code", path: path.join(home, "code"), git: false, hidden: false });
    // Home's parent is outside the roots, so offering an up gesture there would
    // be offering a button whose answer is a refusal. The phone never reads
    // `parent`, and its type is optional.
    expect(result.parent).toBeNull();
  });

  test("~/child expands, and its parent is the way back", () => {
    const home = scratchHome();
    mkdirSync(path.join(home, "code", "telar"), { recursive: true });
    const result = listing(listDirectories({ path: "~/code" }, { home, platform: "darwin" }));
    expect(result.path).toBe(path.join(home, "code"));
    expect(result.parent).toBe(home);
    expect(result.dirs.map((entry) => entry.path)).toEqual([path.join(home, "code", "telar")]);
  });

  test("hidden folders are listed only when asked, and always say so", () => {
    const home = scratchHome();
    mkdirSync(path.join(home, "code"));
    mkdirSync(path.join(home, ".config"));
    mkdirSync(path.join(home, ".cache"));
    // A home directory is mostly dotfolders; offering them by default buries
    // `code` under three screens of them.
    expect(names(listDirectories({}, { home, platform: "darwin" }))).toEqual(["code"]);
    expect(names(listDirectories({ hidden: true }, { home, platform: "darwin" }))).toEqual([".cache", ".config", "code"]);
    const shown = listing(listDirectories({ hidden: true }, { home, platform: "darwin" })).dirs;
    expect(shown.map((entry) => entry.hidden)).toEqual([true, true, false]);
  });

  test("git is the presence of .git — a checkout, and a worktree whose .git is a file", () => {
    const home = scratchHome();
    mkdirSync(path.join(home, "telar", ".git"), { recursive: true });
    mkdirSync(path.join(home, "worktree"));
    writeFileSync(path.join(home, "worktree", ".git"), "gitdir: /elsewhere\n");
    mkdirSync(path.join(home, "plain"));
    const entries = listing(listDirectories({}, { home, platform: "darwin" })).dirs;
    expect(entries.map((entry) => [entry.name, entry.git])).toEqual([
      ["plain", false],
      ["telar", true],
      ["worktree", true],
    ]);
  });

  test("natural order, so run-2 comes before run-10 and case is not a filter", () => {
    const home = scratchHome();
    for (const name of ["run-10", "run-2", "Zed", "apps"]) mkdirSync(path.join(home, name));
    expect(names(listDirectories({}, { home, platform: "darwin" }))).toEqual(["apps", "run-2", "run-10", "Zed"]);
    expect(compareNames("run-2", "run-10")).toBeLessThan(0);
  });

  test("a path outside home and the mount points is refused BY NAME", () => {
    const home = scratchHome();
    const outside = scratchHome();
    const refused = listDirectories({ path: outside }, { home, mounts: ["/Volumes"], exists: () => true });
    expect(refused).toMatchObject({ code: "invalid_request" });
    if (!isDirectoryFailure(refused)) throw new Error("expected a refusal");
    // The sentence names the places that WOULD work — "outside your home
    // directory" alone leaves somebody with an external disk guessing.
    expect(refused.message).toContain(home);
    expect(refused.message).toContain("/Volumes");
  });

  test("a mounted volume is browsable, because that is where a second checkout lives", () => {
    const home = scratchHome();
    // A scratch directory standing in for `/Volumes` — same rule, a root that
    // is not home. Refusing mounts would send somebody with an external disk
    // back to the Finder dialog this replaces.
    const volumes = scratchHome();
    mkdirSync(path.join(volumes, "Backup", "telar"), { recursive: true });
    const result = listing(listDirectories({ path: path.join(volumes, "Backup") }, { home, mounts: [volumes] }));
    expect(result.path).toBe(path.join(volumes, "Backup"));
    expect(result.dirs.map((entry) => entry.name)).toEqual(["telar"]);
    // Up stops at the mount root, not at `/`.
    expect(result.parent).toBe(volumes);
    expect(listing(listDirectories({ path: volumes }, { home, mounts: [volumes] })).parent).toBeNull();
  });

  /**
   * ISSUE #630. Browsing a drive was always ALLOWED and never REACHABLE: the
   * browser opens at home, home's parent is null by design, and so the only
   * route to a volume was knowing its path and typing it. These roots are what
   * makes the allowance visible — a drive being MOUNTED is what puts it in the
   * list, which is why the `st_dev` test is here and not just in `volumes.ts`.
   */
  test("the roots offer home and each mounted drive, by the name a person calls it", () => {
    const home = scratchHome();
    const volumes = scratchHome();
    mkdirSync(path.join(volumes, "Backup"), { recursive: true });
    // A differing `st_dev` is what makes it a mount. A test cannot create one,
    // so this is the seam — the same arrangement the containment cases use.
    const roots = listRoots({
      home,
      mounts: [volumes],
      exists: () => true,
      stat: (target) => ({ dev: target === path.join(volumes, "Backup") ? 42 : 1 }) as never,
    });
    expect(roots[0]).toEqual({ name: "Home", path: home });
    expect(roots.map((root) => root.name)).toEqual(["Home", "Backup"]);
  });

  test("a folder left behind where a drive used to be is not offered as a root", () => {
    const home = scratchHome();
    const volumes = scratchHome();
    mkdirSync(path.join(volumes, "Ghost"), { recursive: true });
    // Same `dev` as its parent: not a mount, however much the path looks like
    // one. Offering it would send somebody into a directory that vanishes.
    const roots = listRoots({ home, mounts: [volumes], exists: () => true, stat: () => ({ dev: 1 }) as never });
    expect(roots.map((root) => root.name)).toEqual(["Home"]);
  });

  test("a listing carries the roots, so the browser has somewhere to offer", () => {
    const home = scratchHome();
    const result = listing(listDirectories({ path: home }, { home, mounts: [] }));
    expect(result.roots).toEqual([{ name: "Home", path: home }]);
  });

  test("a symlink is never a folder here, so a loop cannot be walked into", () => {
    const home = scratchHome();
    mkdirSync(path.join(home, "code"));
    // `loop` points at the directory that contains it. Listing it as a folder
    // is how a browser walks `loop/loop/loop/…` for ever.
    symlinkSync(home, path.join(home, "loop"));
    expect(names(listDirectories({}, { home, platform: "darwin" }))).toEqual(["code"]);
  });

  test("a symlink out of home is not a way around the root check", () => {
    const home = scratchHome();
    const outside = scratchHome();
    mkdirSync(path.join(outside, "secrets"));
    symlinkSync(outside, path.join(home, "escape"));
    // Not listed — and typing its path resolves to where it really goes, which
    // is outside the roots.
    expect(names(listDirectories({}, { home, platform: "darwin" }))).toEqual([]);
    expect(listDirectories({ path: path.join(home, "escape") }, { home, platform: "darwin" })).toMatchObject({
      code: "invalid_request",
    });
  });

  test("a link that resolves through itself is a refusal, not a hang", () => {
    const home = scratchHome();
    // A relative self-link: resolving `mirror` requires resolving `mirror`.
    // This is the shape that makes the kernel answer ELOOP, and the one that
    // would spin a resolver written by hand.
    symlinkSync("mirror", path.join(home, "mirror"));
    expect(listDirectories({ path: path.join(home, "mirror") }, { home, platform: "darwin" })).toMatchObject({
      code: "invalid_request",
      message: "That path loops through itself.",
    });
    // And it is not offered as a folder in the first place.
    expect(names(listDirectories({}, { home, platform: "darwin" }))).toEqual([]);
  });

  test("links that point at each other resolve normally — a cycle of links is not a loop", () => {
    const home = scratchHome();
    const a = path.join(home, "a");
    const b = path.join(home, "b");
    mkdirSync(a);
    mkdirSync(b);
    symlinkSync(b, path.join(a, "to-b"));
    symlinkSync(a, path.join(b, "to-a"));
    // Every hop here is finite, so this is `b` and answering it is correct —
    // the defence is the lstat rule above, not a refusal of every link.
    expect(listing(listDirectories({ path: path.join(a, "to-b", "to-a", "to-b") }, { home, platform: "darwin" })).path).toBe(b);
  });

  test("a folder that is not there, and a file asked for as a folder, read differently", () => {
    const home = scratchHome();
    writeFileSync(path.join(home, "notes.md"), "x");
    expect(listDirectories({ path: path.join(home, "nope") }, { home, platform: "darwin" })).toMatchObject({
      code: "not_found",
      message: "That folder does not exist.",
    });
    // A file's realpath resolves fine; it is the stat that catches it.
    expect(listDirectories({ path: path.join(home, "notes.md") }, { home, platform: "darwin" })).toMatchObject({
      code: "invalid_request",
      message: "That is a file, not a folder.",
    });
  });

  test("a relative path is refused rather than resolved against this process's cwd", () => {
    expect(listDirectories({ path: "code" }, { home: "/Users/someone" })).toMatchObject({
      code: "invalid_request",
      message: "A folder path has to be absolute, or start with ~.",
    });
  });

  test("a long listing is cut, and says that it was", () => {
    const home = scratchHome();
    for (let index = 0; index <= MAX_ENTRIES; index += 1) mkdirSync(path.join(home, `d${String(index).padStart(4, "0")}`));
    const result = listing(listDirectories({}, { home, platform: "darwin" }));
    expect(result.dirs.length).toBe(MAX_ENTRIES);
    // Silently truncated is a list somebody scrolls to the bottom of looking
    // for a folder that is there.
    expect(result.truncated).toBe(true);
  });
});
