/**
 * A PROJECT ON AN EXTERNAL DRIVE, through the store — issue #534.
 *
 * `volumes.test.ts` pins what the probe decides; this file is about what the
 * STORE does with it: the identity recorded at registration, the availability
 * every surface reads, what stops happening while a drive is away, and the
 * recovery that keeps a project's id when macOS remounts it at `<name> 1`.
 *
 * Every drive here is `fakeMounts()` — real directories in a temp folder with a
 * synthesized device and uuid. Nothing mounts or unmounts a real volume, and no
 * project of the person running this is ever registered.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakeMounts, type FakeMounts } from "./fake-mount";
import { EngineStore } from "../src/state";
import { assertProjectRoot } from "../src/worker";
import { prepareSessionWorktree } from "../src/worktree";

const drives: FakeMounts[] = [];
const homes: string[] = [];
const fixture = (): FakeMounts => {
  const made = fakeMounts();
  drives.push(made);
  return made;
};
const home = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-volume-state-"));
  homes.push(directory);
  return directory;
};
afterEach(() => {
  for (const drive of drives.splice(0)) drive.cleanup();
  for (const directory of homes.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

/** A store whose idea of disks is the fixture's, with one project on a drive. */
function onADrive(name = "TelarVR"): {
  store: EngineStore;
  mounts: FakeMounts;
  mount: string;
  root: string;
  tick: (ms: number) => void;
} {
  const mounts = fixture();
  let now = 1_000;
  const store = new EngineStore(home(), () => now, { volumes: mounts.deps });
  const mount = mounts.mount(name);
  const root = path.join(mount, "project");
  fs.mkdirSync(root);
  store.registerProject({ id: "project_one", name: "One", root });
  return { store, mounts, mount, root, tick: (ms) => { now += ms; } };
}

/* ------------------------------------------------------------------ *
 * Identity, recorded once
 * ------------------------------------------------------------------ */

test("registering a project on a drive records the drive's mount and uuid", () => {
  const { store, mounts, mount } = onADrive();
  expect(store.getProject("project_one").volume).toEqual({ mount, uuid: mounts.uuidOf("TelarVR") });
});

test("a project on this machine's own disk records no volume and is unchanged", () => {
  const mounts = fixture();
  const store = new EngineStore(home(), () => 1_000, { volumes: mounts.deps });
  const root = path.join(mounts.mountRoot, "plain-folder");
  fs.mkdirSync(root);

  store.registerProject({ id: "project_plain", name: "Plain", root });
  expect(store.getProject("project_plain").volume).toBeUndefined();
});

/* ------------------------------------------------------------------ *
 * One owner of availability
 * ------------------------------------------------------------------ */

test("the store classifies a drive that is here, gone, and faked by an empty folder", () => {
  const { store, mounts, root } = onADrive();
  const project = () => store.getProject("project_one");

  expect(store.projectAvailability(project())).toBe("available");

  mounts.unmount("TelarVR");
  expect(store.projectAvailability(project())).toBe("unmounted");

  mounts.leaveEmptyMountpoint("TelarVR");
  fs.mkdirSync(root, { recursive: true });
  expect(store.projectAvailability(project())).toBe("unmounted");
});

test("a project on this machine's own disk goes MISSING rather than unmounted", () => {
  const mounts = fixture();
  const store = new EngineStore(home(), () => 1_000, { volumes: mounts.deps });
  const root = path.join(mounts.mountRoot, "plain-folder");
  fs.mkdirSync(root);
  store.registerProject({ id: "project_plain", name: "Plain", root });

  expect(store.projectAvailability(store.getProject("project_plain"))).toBe("available");
  fs.rmSync(root, { recursive: true });
  expect(store.projectAvailability(store.getProject("project_plain"))).toBe("missing");
});

test("a TRANSITION drops what was read off the disk, rather than waiting out a TTL", async () => {
  const mounts = fixture();
  let now = 1_000;
  let reads = 0;
  const store = new EngineStore(home(), () => now, {
    volumes: mounts.deps,
    asyncGit: async () => { reads += 1; return { status: 1, stdout: "", stderr: "" }; },
  });
  const mount = mounts.mount("TelarVR");
  const root = path.join(mount, "project");
  fs.mkdirSync(root);
  store.registerProject({ id: "project_one", name: "One", root });

  // Probed once while the drive is here, which is what the ten-second tick and
  // the sweep at daemon start both do: a transition needs a previous answer to
  // be a transition FROM, and on a cold store there is nothing cached to drop.
  expect(store.projectAvailability(store.getProject("project_one"))).toBe("available");

  await store.projectDiffAsync("project_one");
  const primed = reads;
  await store.projectDiffAsync("project_one");
  expect(reads).toBe(primed);

  mounts.unmount("TelarVR");
  expect(store.projectAvailability(store.getProject("project_one"))).toBe("unmounted");

  // Same instant — the cache's own two seconds have not passed, and the entry
  // is gone anyway because the disk it was read from is.
  await store.projectDiffAsync("project_one");
  expect(reads).toBeGreaterThan(primed);
});

/* ------------------------------------------------------------------ *
 * Nothing is spawned against a disk that is not there
 * ------------------------------------------------------------------ */

/**
 * The metadata refresh is deliberately OFF the request path: `listProjects`
 * returns what it has and the branch, icon and remote arrive on their own
 * microtasks plus one real `readdir`. So a test waits for the answer rather
 * than for a duration — a fixed sleep is a guess that holds on an idle machine
 * and fails on a loaded one, which is how a real assertion becomes a flake.
 *
 * The 15 s bound is the suite's own (see `bunfig.toml`): long enough to outlast
 * a loaded runner, short enough to stay under the 20 s ceiling so a genuine
 * hang still fails as a hang.
 */
async function until(predicate: () => boolean, ms = 15_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return predicate();
}

/** One poll's worth of waiting for nothing to happen — the shape an assertion
 *  that something was NOT spawned needs. */
const settle = async (): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, 20)); };

/** A store that counts every git child, with one project on a drive. */
function counting(): { store: EngineStore; mounts: FakeMounts; spawns: () => number; tick: (ms: number) => void } {
  const mounts = fixture();
  let now = 1_000;
  let spawns = 0;
  const store = new EngineStore(home(), () => now, {
    volumes: mounts.deps,
    asyncGit: async () => { spawns += 1; return { status: 0, stdout: "main\n", stderr: "" }; },
  });
  const mount = mounts.mount("TelarVR");
  const root = path.join(mount, "project");
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "icon.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  store.registerProject({ id: "project_one", name: "One", root });
  return { store, mounts, spawns: () => spawns, tick: (ms) => { now += ms; } };
}

test("an away project spawns NO git children, however often the rail polls", async () => {
  const { store, mounts, spawns, tick } = counting();

  store.listProjects();
  expect(await until(() => spawns() > 0)).toBe(true);

  mounts.unmount("TelarVR");
  const beforeUnplug = spawns();
  // Six passes past the ten-second tick — what the old code spent about 18
  // children a minute on, forever, failing into a drive in somebody's bag.
  for (let pass = 0; pass < 6; pass += 1) {
    tick(11_000);
    store.listProjects();
    await settle();
  }
  expect(spawns()).toBe(beforeUnplug);
});

test("an away project shows no branch and no icon — a label read off a disk nobody can see", async () => {
  const { store, mounts } = counting();
  const row = () => store.listProjects().find((project) => project.id === "project_one")!;

  expect(await until(() => row().branch === "main" && row().icon !== undefined)).toBe(true);

  mounts.unmount("TelarVR");
  const gone = row();
  expect(gone.branch).toBeUndefined();
  expect(gone.icon).toBeUndefined();
});

test("git comes back on its own when the drive does", async () => {
  const { store, mounts, spawns, tick } = counting();
  store.listProjects();
  expect(await until(() => spawns() > 0)).toBe(true);

  mounts.unmount("TelarVR");
  tick(11_000);
  store.listProjects();
  await settle();
  const quiet = spawns();

  mounts.mount("TelarVR");
  fs.mkdirSync(path.join(mounts.mountRoot, "TelarVR", "project"), { recursive: true });
  tick(11_000);
  store.listProjects();
  expect(await until(() => spawns() > quiet)).toBe(true);
});

test("reprobe answers how many projects it asked about and how many moved", () => {
  const { store, mounts } = onADrive();

  expect(store.reprobeProjects()).toEqual({ projects: 1, changed: 1 });
  expect(store.reprobeProjects()).toEqual({ projects: 1, changed: 0 });

  mounts.unmount("TelarVR");
  expect(store.reprobeProjects()).toEqual({ projects: 1, changed: 1 });
});

test("restoring a project re-reads the drive rather than trusting what was stored", () => {
  const { store, mounts } = onADrive();
  store.unregisterProject("project_one");

  // The same folder, on a drive that has been reformatted since — a new uuid.
  mounts.unmount("TelarVR");
  const mount = mounts.mount("TelarVR", "FAKE-UUID-REFORMATTED");
  const root = path.join(mount, "project");
  fs.mkdirSync(root, { recursive: true });

  const restored = store.registerProject({ name: "One", root });
  expect(restored.id).toBe("project_one");
  expect(restored.volume).toEqual({ mount, uuid: "FAKE-UUID-REFORMATTED" });
});

/* ------------------------------------------------------------------ *
 * Nothing starts on a disk that is not there
 * ------------------------------------------------------------------ */

test("the worker refuses to spawn in a RECREATED EMPTY MOUNTPOINT, which every other check passes", () => {
  const mounts = fixture();
  const mount = mounts.mount("TelarVR");
  const root = path.join(mount, "project");
  fs.mkdirSync(root);

  expect(() => assertProjectRoot(root, mounts.deps)).not.toThrow();

  // macOS leaves the folder behind. `stat` succeeds, `isDirectory` succeeds,
  // `access` succeeds — and the provider would have worked in a directory that
  // disappears at the next remount.
  mounts.leaveEmptyMountpoint("TelarVR");
  fs.mkdirSync(root, { recursive: true });
  expect(() => assertProjectRoot(root, mounts.deps)).toThrow(/drive holding this project is not connected/i);
});

test("an unplugged drive is never described as a folder to re-register — that is how an id is lost", () => {
  const mounts = fixture();
  const mount = mounts.mount("TelarVR");
  const root = path.join(mount, "project");
  fs.mkdirSync(root);
  mounts.unmount("TelarVR");

  expect(() => assertProjectRoot(root, mounts.deps)).toThrow(/drive holding this project is not connected/i);
  expect(() => assertProjectRoot(root, mounts.deps)).not.toThrow(/re-register the project with its current location/i);
});

test("a worktree cut blames the drive, not the repository", () => {
  const mounts = fixture();
  const mount = mounts.mount("TelarVR");
  const projectRoot = path.join(mount, "project");
  fs.mkdirSync(projectRoot);

  // The old sentence was "worktree sessions need a git repository; <path> is
  // not one. Use envMode local for an unversioned project." — every word of it
  // wrong about a repository that exists and is in somebody's bag.
  expect(() =>
    prepareSessionWorktree(() => ({ status: 0, stdout: "true\n", stderr: "" }), {
      engineRoot: home(),
      projectRoot,
      projectName: "TelarVR Work",
      sessionId: "session_one",
      availability: "unmounted",
    }),
  ).toThrow("The drive holding TelarVR Work is not connected. Plug it back in and this will work again.");
});
