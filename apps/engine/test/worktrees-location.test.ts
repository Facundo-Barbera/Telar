/**
 * WHERE SESSION CHECKOUTS GO — issue #642 part 2.
 *
 * The two claims that carry the design, and both are about refusing rather
 * than guessing:
 *
 *   A RECORD THIS BUILD CANNOT READ REFUSES THE CUT, not the engine. #630
 *   refuses to START on an unrecognised store record, because falling back to
 *   the default path there writes a fresh store over absent history. Nothing
 *   here is destructive, so the refusal is scoped to what cannot be read: no
 *   worktree session is cut, and every local session and all history is
 *   untouched.
 *
 *   A DRIVE THAT IS NOT THERE IS A STATE, not a crash — #630's absent-volume
 *   case one level down, and recovered from by plugging the drive back in with
 *   nothing written in the meantime.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clearWorktreesRoot,
  defaultWorktreesRoot,
  readWorktreesRoot,
  rootOf,
  worktreesRootBlocker,
  writeWorktreesRoot,
} from "../src/worktrees-location";

let root: string;
const made: string[] = [];

const temp = (prefix: string): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(directory);
  return directory;
};

beforeEach(() => {
  root = temp("telar-wtloc-");
});
afterEach(() => {
  for (const directory of made.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const locationFile = () => path.join(root, "worktrees-location.json");

test("nothing configured is the default beside the store", () => {
  const state = readWorktreesRoot(root);
  expect(state).toEqual({ kind: "default", root: defaultWorktreesRoot(root) });
  expect(rootOf(state)).toBe(path.join(root, "worktrees"));
  expect(worktreesRootBlocker(state)).toBeUndefined();
});

test("a chosen folder is used, and is created rather than merely recorded", () => {
  const elsewhere = path.join(temp("telar-checkouts-"), "cuts");
  writeWorktreesRoot(root, elsewhere);
  // A record naming a folder that does not exist would be a setting that
  // refuses every cut until somebody noticed.
  expect(fs.existsSync(elsewhere)).toBe(true);
  expect(readWorktreesRoot(root)).toMatchObject({ kind: "configured", root: elsewhere });
});

test("putting it back removes the record rather than writing the default into it", () => {
  const elsewhere = temp("telar-checkouts-");
  writeWorktreesRoot(root, elsewhere);
  clearWorktreesRoot(root);
  // Two ways to say "the default" is two things to keep in step the first time
  // the default moves.
  expect(fs.existsSync(locationFile())).toBe(false);
  expect(readWorktreesRoot(root).kind).toBe("default");
});

test("a version this build does not know refuses, and says which file to fix", () => {
  fs.writeFileSync(locationFile(), JSON.stringify({ version: 99, root: "/somewhere" }));
  const state = readWorktreesRoot(root);
  expect(state.kind).toBe("unreadable");
  // Named, so the sentence is actionable rather than a shrug.
  expect(worktreesRootBlocker(state)).toContain(locationFile());
  expect(rootOf(state)).toBeUndefined();
});

test("unparseable refuses too — it never falls back to the default", () => {
  fs.writeFileSync(locationFile(), "{ this is not json");
  const state = readWorktreesRoot(root);
  expect(state.kind).toBe("unreadable");
  /**
   * THE POINT OF THE WHOLE STATE. Falling back to the default here would put
   * new checkouts beside the store while every existing one sat on a drive —
   * a split nobody asked for, created silently, by guessing.
   */
  expect(rootOf(state)).toBeUndefined();
});

test("a relative path is not a location", () => {
  fs.writeFileSync(locationFile(), JSON.stringify({ version: 1, root: "checkouts", movedAt: 0 }));
  expect(readWorktreesRoot(root).kind).toBe("unreadable");
});

test("a drive that is not connected is a state, named by the label recorded when it was chosen", () => {
  fs.writeFileSync(
    locationFile(),
    JSON.stringify({ version: 1, root: "/Volumes/TelarVR/checkouts", volume: { mount: "/Volumes/TelarVR", uuid: "UUID-1" }, label: "TelarVR", movedAt: 1 }),
  );
  // Nothing is mounted at that path in a test, which is exactly the case.
  const state = readWorktreesRoot(root, { platform: "darwin", mounts: ["/Volumes"], volumeUuid: () => undefined });
  expect(state.kind).toBe("absent");
  const blocker = worktreesRootBlocker(state);
  // The drive is not here to be asked its name, which is why the label is
  // recorded rather than read.
  expect(blocker).toContain("TelarVR");
  expect(blocker).toContain("not connected");
});

/**
 * THE PLATFORM THAT CANNOT ANSWER THE QUESTION — issue #665.
 *
 * `mountRootsFor` returns an empty list on win32, so nothing is ever a mount
 * point there and `findVolumeMount` can never resolve a drive. Before this,
 * a checkouts root on `D:\` took the `configured` branch and reported as fine
 * whether or not the disk was connected: `worktreesRootBlocker` returned
 * nothing, the cut proceeded, and `mkdirSync` failed mid-session with an I/O
 * error instead of the sentence the design wrote for exactly this.
 *
 * The platform is INJECTED, because a test cannot change the one it runs on
 * and a Windows branch asserted by not running it is a branch nobody has ever
 * executed.
 */
test("a platform that cannot resolve volumes still uses a root that is there", () => {
  const elsewhere = temp("telar-checkouts-");
  fs.writeFileSync(
    locationFile(),
    JSON.stringify({ version: 1, root: elsewhere, volume: { mount: path.dirname(elsewhere), uuid: "SERIAL-1" }, label: "Backup", movedAt: 1 }),
  );
  const state = readWorktreesRoot(root, { platform: "win32" });
  expect(state.kind).toBe("configured");
  expect(rootOf(state)).toBe(elsewhere);
  expect(worktreesRootBlocker(state)).toBeUndefined();
});

test("…and refuses the cut, in its own words, when the root is not there", () => {
  // AN ABSOLUTE PATH IN THIS RUNTIME'S OWN SYNTAX, not `D:\…`: `path.isAbsolute`
  // answers for the platform the process is on rather than the one being
  // simulated, so a Windows-shaped path here would be refused as relative and
  // this would assert the wrong branch. What is being simulated is the VOLUME
  // resolution, which is what `platform` reaches.
  const gone = path.join(temp("telar-checkouts-"), "cuts");
  fs.writeFileSync(
    locationFile(),
    JSON.stringify({ version: 1, root: gone, volume: { mount: path.dirname(gone), uuid: "SERIAL-1" }, label: "Backup", movedAt: 1 }),
  );
  const state = readWorktreesRoot(root, { platform: "win32" });
  // NOT `absent`. "Your drive is unplugged" is precisely the claim this
  // platform cannot make, and a person looking at a connected drive being told
  // to connect it trusts the next message less.
  expect(state.kind).toBe("unverifiable");
  expect(rootOf(state)).toBeUndefined();
  const blocker = worktreesRootBlocker(state);
  expect(blocker).toContain("Backup");
  expect(blocker).toContain("cannot tell whether that drive is connected");
  expect(blocker).not.toContain("Plug it back in");
});

test("a remount under a new name is a rename, not a loss", () => {
  /**
   * macOS mounts a second copy of a drive at `TelarVR 1`. #630 learnt to
   * resolve that by the drive's own id rather than by its path, and the same
   * resolution happens here — otherwise a drive that came back under a
   * slightly different name would read as a drive that was gone.
   */
  const mounts = temp("telar-mounts-");
  const remounted = path.join(mounts, "TelarVR 1", "checkouts");
  fs.mkdirSync(remounted, { recursive: true });
  const was = path.join(mounts, "TelarVR");
  fs.writeFileSync(
    locationFile(),
    JSON.stringify({ version: 1, root: path.join(was, "checkouts"), volume: { mount: was, uuid: "UUID-1" }, label: "TelarVR", movedAt: 1 }),
  );

  // A mount point is a path whose `st_dev` differs from its parent's. A test
  // cannot create a real one, and bending `stat` to pretend it did would be
  // testing the fake — so the seam `volumes.ts` already exposes is used, and
  // ONLY the remounted path is given a device of its own.
  const deps = {
    platform: "darwin" as const,
    mounts: [mounts],
    stat: (target: string) => ({ dev: target === path.join(mounts, "TelarVR 1") ? 2 : 1 }) as fs.Stats,
    readdir: () => ["TelarVR 1"],
    volumeUuid: (mount: string) => (mount === path.join(mounts, "TelarVR 1") ? "UUID-1" : undefined),
  };
  const state = readWorktreesRoot(root, deps);

  expect(state).toMatchObject({ kind: "configured", root: remounted });
  // AND THE HINT IS REWRITTEN, so the next read resolves directly rather than
  // walking every mount again.
  expect(JSON.parse(fs.readFileSync(locationFile(), "utf8"))).toMatchObject({
    root: remounted,
    volume: { mount: path.join(mounts, "TelarVR 1") },
    label: "TelarVR",
  });
});

test("the whole point: changing the root never touches what is already cut", () => {
  /**
   * NOT A FILESYSTEM CLAIM — a claim about this module's surface. There is no
   * function here that moves, deletes or rewrites a worktree, and that is why
   * a PUT of this setting cannot lose anybody's work. Moving checkouts is a
   * separate, explicit operation with its own refusals.
   */
  const elsewhere = temp("telar-checkouts-");
  const existing = path.join(defaultWorktreesRoot(root), "already-cut");
  fs.mkdirSync(existing, { recursive: true });
  fs.writeFileSync(path.join(existing, "work.txt"), "uncommitted");

  writeWorktreesRoot(root, elsewhere);

  expect(fs.readFileSync(path.join(existing, "work.txt"), "utf8")).toBe("uncommitted");
  expect(fs.existsSync(existing)).toBe(true);
});
