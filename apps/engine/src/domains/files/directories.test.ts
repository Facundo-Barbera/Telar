import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, type Dirent, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  browseRoots,
  compareNames,
  expandHome,
  GIT_PROBE_BUDGET_MS,
  isDirectoryFailure,
  listDirectories,
  listRoots,
  MAX_ENTRIES,
  within,
  type DirectoryOutcome,
} from "./directories";
import type { DirectoryListing } from "@telar/engine-client";

const homes: string[] = [];
function scratchHome(): string {
  const home = realpathSync.native(mkdtempSync(path.join(tmpdir(), "telar-fs-dirs-")));
  homes.push(home);
  return home;
}
afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

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
    expect(expandHome("~root/secrets", "/Users/someone")).toBe("~root/secrets");
    expect(listDirectories({ path: "~root" }, { home: "/Users/someone" })).toMatchObject({ code: "invalid_request" });
  });
});

describe("within", () => {
  test("containment is tested on a separator boundary", () => {
    expect(within("/Users/someone", "/Users/someone")).toBe(true);
    expect(within("/Users/someone", "/Users/someone/code")).toBe(true);
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
    expect(result.dirs[0]).toEqual({ name: "code", path: path.join(home, "code"), git: false, hidden: false });
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
    expect(refused.message).toContain(home);
    expect(refused.message).toContain("/Volumes");
  });

  test("a mounted volume is browsable, because that is where a second checkout lives", () => {
    const home = scratchHome();
    const volumes = scratchHome();
    mkdirSync(path.join(volumes, "Backup", "telar"), { recursive: true });
    const result = listing(listDirectories({ path: path.join(volumes, "Backup") }, { home, mounts: [volumes] }));
    expect(result.path).toBe(path.join(volumes, "Backup"));
    expect(result.dirs.map((entry) => entry.name)).toEqual(["telar"]);
    expect(result.parent).toBe(volumes);
    expect(listing(listDirectories({ path: volumes }, { home, mounts: [volumes] })).parent).toBeNull();
  });

  test("the roots offer home and each mounted drive, by the name a person calls it", () => {
    const home = scratchHome();
    const volumes = scratchHome();
    mkdirSync(path.join(volumes, "Backup"), { recursive: true });
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
    symlinkSync(home, path.join(home, "loop"));
    expect(names(listDirectories({}, { home, platform: "darwin" }))).toEqual(["code"]);
  });

  test("a symlink out of home is not a way around the root check", () => {
    const home = scratchHome();
    const outside = scratchHome();
    mkdirSync(path.join(outside, "secrets"));
    symlinkSync(outside, path.join(home, "escape"));
    expect(names(listDirectories({}, { home, platform: "darwin" }))).toEqual([]);
    expect(listDirectories({ path: path.join(home, "escape") }, { home, platform: "darwin" })).toMatchObject({
      code: "invalid_request",
    });
  });

  test("a link that resolves through itself is a refusal, not a hang", () => {
    const home = scratchHome();
    symlinkSync("mirror", path.join(home, "mirror"));
    expect(listDirectories({ path: path.join(home, "mirror") }, { home, platform: "darwin" })).toMatchObject({
      code: "invalid_request",
      message: "That path loops through itself.",
    });
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
    expect(listing(listDirectories({ path: path.join(a, "to-b", "to-a", "to-b") }, { home, platform: "darwin" })).path).toBe(b);
  });

  test("a folder that is not there, and a file asked for as a folder, read differently", () => {
    const home = scratchHome();
    writeFileSync(path.join(home, "notes.md"), "x");
    expect(listDirectories({ path: path.join(home, "nope") }, { home, platform: "darwin" })).toMatchObject({
      code: "not_found",
      message: "That folder does not exist.",
    });
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
    expect(result.truncated).toBe(true);
  });
});

describe("a cloud folder", () => {
  const DRIVE = path.join("Library", "CloudStorage", "GoogleDrive-me@example.com", "My Drive");

  function cloudHome(): { home: string; work: string; repo: string } {
    const home = scratchHome();
    const work = path.join(home, DRIVE, "[01] Work");
    const repo = path.join(work, "repo");
    mkdirSync(path.join(repo, ".git"), { recursive: true });
    mkdirSync(path.join(work, "notes"));
    writeFileSync(path.join(repo, "README.md"), "x");
    return { home, work, repo };
  }

  const message = (outcome: DirectoryOutcome) => (isDirectoryFailure(outcome) ? outcome.message : "");

  test("lists, badges the checkout, and takes the path typed or with ~", () => {
    const { home, work, repo } = cloudHome();
    const result = listing(listDirectories({ path: work }, { home, platform: "darwin" }));
    expect(result.path).toBe(work);
    expect(result.dirs.map((entry) => [entry.name, entry.git])).toEqual([
      ["notes", false],
      ["repo", true],
    ]);
    expect(result.missing).toBeUndefined();
    const tilde = listing(listDirectories({ path: `~/${path.relative(home, repo)}` }, { home, platform: "darwin" }));
    expect(tilde.path).toBe(repo);
    expect(tilde.parent).toBe(work);
  });

  test("nearest opens the closest existing folder, and says what was missing", () => {
    const { home, work, repo } = cloudHome();
    const gone = path.join(work, "renamed since", "deeper");
    const walked = listing(listDirectories({ path: gone, nearest: true }, { home, platform: "darwin" }));
    expect(walked.path).toBe(work);
    expect(walked.missing).toBe(gone);
    const file = listing(listDirectories({ path: path.join(repo, "README.md"), nearest: true }, { home, platform: "darwin" }));
    expect(file.path).toBe(repo);
    expect(listDirectories({ path: gone }, { home, platform: "darwin" })).toMatchObject({ code: "not_found" });
  });

  test("walking up never walks out of the roots", () => {
    const home = scratchHome();
    const outside = listDirectories({ path: "/telar-nowhere-9f3/x", nearest: true }, { home, platform: "darwin", mounts: [] });
    expect(outside).toMatchObject({ code: "invalid_request" });
    expect(message(outside)).toContain(home);
  });

  test("a typeless entry is asked by lstat, and one that fails does not fail the listing", () => {
    const { home, work } = cloudHome();
    const typeless = (name: string) =>
      ({
        name,
        isDirectory: () => false,
        isFile: () => false,
        isSymbolicLink: () => false,
        isFIFO: () => false,
        isSocket: () => false,
        isBlockDevice: () => false,
        isCharacterDevice: () => false,
      }) as unknown as Dirent;
    const result = listing(
      listDirectories(
        { path: work },
        {
          home,
          platform: "darwin",
          readdir: () => [typeless("fetched"), typeless("stalled"), typeless("file.txt")],
          lstat: (target) => {
            if (target.endsWith("stalled")) throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
            return { isDirectory: () => target.endsWith("fetched") } as Stats;
          },
        },
      ),
    );
    expect(result.dirs.map((entry) => entry.name)).toEqual(["fetched"]);
  });

  test("a cloud folder that is there and unreadable says why, rather than 'does not exist'", () => {
    const { home, work } = cloudHome();
    const failing = (code: string) => () => {
      throw Object.assign(new Error(code), { code });
    };
    const denied = listDirectories({ path: work }, { home, platform: "darwin", readdir: failing("EPERM") });
    expect(denied).toMatchObject({ code: "invalid_request" });
    expect(message(denied)).toContain("Privacy & Security");
    const stalled = listDirectories({ path: work, nearest: true }, { home, platform: "darwin", realpath: failing("ETIMEDOUT") });
    expect(stalled).toMatchObject({ code: "invalid_request" });
    expect(message(stalled)).toContain("(ETIMEDOUT)");
    expect(message(stalled)).toContain("sync app");
    expect(message(stalled)).not.toContain("Google");
  });

  test("slow .git probes stop at the budget, and the listing says some were skipped", () => {
    const { home, work } = cloudHome();
    for (const name of ["a", "b", "c"]) mkdirSync(path.join(work, name));
    let clock = 0;
    const probed: string[] = [];
    const result = listing(
      listDirectories(
        { path: work },
        {
          home,
          platform: "darwin",
          now: () => clock,
          mounts: [],
          exists: (target) => {
            probed.push(path.basename(path.dirname(target)));
            clock += 1000;
            return true;
          },
        },
      ),
    );
    expect(result.dirs.length).toBe(5);
    expect(result.gitPartial).toBe(true);
    expect(probed).toEqual(["a", "b"]);
    expect(GIT_PROBE_BUDGET_MS).toBe(1500);
  });
});
