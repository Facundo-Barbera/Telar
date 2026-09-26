import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStateError, EngineStore } from "../src/state";
import { probeAvailability, volumeForRoot } from "../src/volumes";
import { createAsyncGitRunner, createSessionWorktreeAsync, defaultGitRunner, defaultWorktreesRoot, isGitWorkTree, prepareSessionWorktree } from "../src/worktree";

/**
 * A REPOSITORY INSIDE A CLOUD DRIVE'S LOCAL MIRROR, end to end — the reported
 * case, on a fixture.
 *
 * macOS mounts these at `~/Library/CloudStorage/<Provider>-<account>/…`: under
 * home, on the boot disk's own Data volume, with spaces, `@` and brackets in the
 * path. Nothing here touches the real `~/Library/CloudStorage`; the directory is
 * a scratch one NAMED like it, which is all the engine's path logic can see.
 */
const scratch: string[] = [];
const tmp = (prefix: string): string => {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  scratch.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of scratch.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

/** `<home>/Library/CloudStorage/GoogleDrive-me@example.com/My Drive/[01] Work/repo`,
 *  holding a repository with one commit. */
function cloudRepo(): { home: string; root: string } {
  const home = tmp("telar-cloud-home-");
  const root = path.join(home, "Library", "CloudStorage", "GoogleDrive-me@example.com", "My Drive", "[01] Work", "repo");
  fs.mkdirSync(root, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@telar.local");
  git("config", "user.name", "Telar Test");
  fs.writeFileSync(path.join(root, "README.md"), "hello\n");
  git("add", "-A");
  git("commit", "-qm", "initial");
  return { home, root };
}

test("a cloud-folder repository registers as an ordinary project on this Mac's own disk", () => {
  const { root } = cloudRepo();
  const store = new EngineStore(tmp("telar-cloud-engine-"), () => 100);
  const project = store.registerProject({ name: "repo", root });
  expect(project.root).toBe(root);
  // Not a removable volume: it is under home, not a mount root, so there is no
  // drive to wait for and nothing that would read "unplugged".
  expect(project.volume).toBeUndefined();
  expect(volumeForRoot(root, { platform: "darwin" })).toBeUndefined();
  expect(probeAvailability(project, { platform: "darwin" })).toBe("available");
  expect(isGitWorkTree(defaultGitRunner, root)).toBe(true);
});

test("its worktrees are cut in the worktrees root, never inside the cloud folder", async () => {
  const { root } = cloudRepo();
  const engineRoot = tmp("telar-cloud-engine-");
  const { plan, baseSha } = prepareSessionWorktree(defaultGitRunner, { engineRoot, projectRoot: root, sessionId: "session_one" });
  expect(path.dirname(plan.path)).toBe(defaultWorktreesRoot(engineRoot));
  expect(plan.path.startsWith(path.dirname(root))).toBe(false);
  const cut = await createSessionWorktreeAsync(createAsyncGitRunner(), { engineRoot, projectRoot: root, plan, baseSha });
  expect(fs.existsSync(path.join(cut.path, "README.md"))).toBe(true);
  // Syncing a checkout per session into somebody's drive would be the surprise.
  expect(fs.readdirSync(path.dirname(root))).toEqual(["repo"]);
});

test("a folder that is there and unreadable is refused with the reason, not as missing", () => {
  const { home, root } = cloudRepo();
  const store = new EngineStore(tmp("telar-cloud-engine-"), () => 100);
  expect(() => store.registerProject({ name: "gone", root: path.join(root, "nope") })).toThrow("project root must be an existing directory");
  // Take the drive's permission away, as macOS does before it is granted.
  const drive = path.join(home, "Library", "CloudStorage");
  fs.chmodSync(drive, 0o000);
  try {
    let refusal: unknown;
    try {
      store.registerProject({ name: "repo", root });
    } catch (cause) {
      refusal = cause;
    }
    expect(refusal).toBeInstanceOf(EngineStateError);
    expect((refusal as EngineStateError).message).toContain("could not be read (EACCES)");
    expect((refusal as EngineStateError).message).toContain("cloud folder");
  } finally {
    fs.chmodSync(drive, 0o755);
  }
});
