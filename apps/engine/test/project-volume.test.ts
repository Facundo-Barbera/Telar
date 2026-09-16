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
