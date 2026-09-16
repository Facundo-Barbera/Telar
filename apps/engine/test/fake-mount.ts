/**
 * A DRIVE YOU CAN UNPLUG, IN A TEMP DIRECTORY.
 *
 * WHY THIS EXISTS. Every claim the external-drive work makes is about a
 * TRANSITION — a drive going away, a drive coming back under a different name,
 * an empty folder left behind where one used to be — and none of them can be
 * observed by a test that has no drive. The alternative to this file is a drawer
 * of USB sticks and a human to plug them in, which means the transitions would
 * be tested by hand once and never again.
 *
 * WHAT IS FAKED, AND WHAT IS NOT. The directories are real: `mount()` makes one,
 * `unmount()` deletes it, `remount()` moves it, and everything the engine does
 * inside them — `registerProject`'s `realpath`, a `stat` on the root, a file
 * written into the checkout — runs against a real filesystem. Exactly two facts
 * are synthesized, because a temp directory cannot have them:
 *
 *   1. `st_dev`. A real mount has a device of its own, which is how
 *      `isMountPoint` tells a mounted volume from an empty folder somebody left
 *      at the same path. Two directories under `os.tmpdir()` share a device, so
 *      the injected `stat` hands a mounted subtree a device of its own and
 *      everything else the "boot disk"'s.
 *   2. The uuid. `diskutil` knows nothing about a temp directory; the fixture
 *      keeps one per mount and it SURVIVES `remount()`, which is the single
 *      fact the id-stable recovery is built on.
 *
 * Nothing here mounts, unmounts or touches a real volume, and no test using it
 * needs to.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { VolumeDeps } from "../src/volumes";

/** The device every path that is not on a fake mount reports — this machine's
 *  own disk, as far as the injected `stat` is concerned. */
const BOOT_DEVICE = 1;

export type FakeMounts = {
  /** Stands in for `/Volumes`. A real directory; hand it to `VolumeDeps.mounts`. */
  readonly mountRoot: string;
  /** Plug a drive in. Returns its mount path. The uuid is remembered under the
   *  name and re-used if the same name is mounted again. */
  mount(name: string, uuid?: string): string;
  /** Pull the drive out: the directory and everything on it goes. */
  unmount(name: string): void;
  /** macOS's own habit — the same drive, mounted under a different name,
   *  carrying the SAME uuid and the same files. Returns the new mount path. */
  remount(from: string, to: string): string;
  /** What macOS sometimes leaves behind: the path exists, nothing is mounted
   *  there. A `stat` on it succeeds, which is exactly the trap. */
  leaveEmptyMountpoint(name: string): string;
  /** The uuid a given mount is carrying, for a test that wants to assert on it. */
  uuidOf(name: string): string;
  /** Hand this to `new EngineStore(..., { volumes })`. */
  readonly deps: VolumeDeps;
  /** Delete the whole fixture. */
  cleanup(): void;
};

export function fakeMounts(): FakeMounts {
  /**
   * REALPATH'D, and this is load-bearing rather than tidy. `os.tmpdir()` on
   * macOS is `/var/folders/...`, which is a symlink into `/private/var`, and
   * `registerProject` stores `fs.realpathSync.native` of what it is given. A
   * fixture handing out the un-resolved path would have the engine store a root
   * that no longer starts with this mount root, and every volume in this file
   * would silently read as an ordinary internal-disk project.
   */
  const mountRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "telar-fake-volumes-")));
  /** mount path → the drive that is mounted there right now. */
  const mounted = new Map<string, { uuid: string; dev: number }>();
  /** name → the uuid it was first given, so a remount keeps its identity. */
  const uuids = new Map<string, string>();
  let nextDevice = BOOT_DEVICE + 1;

  /** Which fake mount, if any, owns a path. Longest prefix, so a project deep
   *  inside a drive answers the drive rather than its parent. */
  const owner = (target: string): { uuid: string; dev: number } | undefined => {
    for (const [mount, drive] of mounted) {
      if (target === mount || target.startsWith(`${mount}${path.sep}`)) return drive;
    }
    return undefined;
  };

  const deps: VolumeDeps = {
    platform: "darwin",
    mounts: [mountRoot],
    stat: (target) => {
      const real = fs.statSync(target);
      // `st_dev` is the ONE field overridden. The clone keeps `Stats`'s
      // prototype so `isDirectory()` still works off the real `mode`, and
      // everything else — size, times — is the real directory's. A `stat` on a
      // path that is gone still throws a real ENOENT, which is the case this
      // fixture exists to produce.
      const clone = Object.assign(Object.create(Object.getPrototypeOf(real) as object) as fs.Stats, real);
      clone.dev = owner(target)?.dev ?? BOOT_DEVICE;
      return clone;
    },
    readdir: (target) => fs.readdirSync(target),
    volumeUuid: (mount) => mounted.get(mount)?.uuid,
  };

  const mount: FakeMounts["mount"] = (name, uuid) => {
    const target = path.join(mountRoot, name);
    const identity = uuid ?? uuids.get(name) ?? `FAKE-UUID-${name.replaceAll(/[^A-Za-z0-9]/g, "-").toUpperCase()}`;
    uuids.set(name, identity);
    fs.mkdirSync(target, { recursive: true });
    mounted.set(target, { uuid: identity, dev: nextDevice++ });
    return target;
  };

  return {
    mountRoot,
    mount,
    unmount(name) {
      const target = path.join(mountRoot, name);
      mounted.delete(target);
      fs.rmSync(target, { recursive: true, force: true });
    },
    remount(from, to) {
      const source = path.join(mountRoot, from);
      const target = path.join(mountRoot, to);
      const drive = mounted.get(source);
      if (drive === undefined) throw new Error(`nothing is mounted at ${source}`);
      fs.renameSync(source, target);
      mounted.delete(source);
      // SAME UUID, NEW DEVICE — which is what a replug actually is: the drive
      // is the same drive and the kernel gives it whatever device is free.
      mounted.set(target, { uuid: drive.uuid, dev: nextDevice++ });
      uuids.set(to, drive.uuid);
      return target;
    },
    leaveEmptyMountpoint(name) {
      const target = path.join(mountRoot, name);
      mounted.delete(target);
      fs.rmSync(target, { recursive: true, force: true });
      fs.mkdirSync(target, { recursive: true });
      return target;
    },
    uuidOf(name) {
      const uuid = uuids.get(name);
      if (uuid === undefined) throw new Error(`no drive has ever been mounted as ${name}`);
      return uuid;
    },
    deps,
    cleanup() {
      mounted.clear();
      fs.rmSync(mountRoot, { recursive: true, force: true });
    },
  };
}
