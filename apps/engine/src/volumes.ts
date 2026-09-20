/**
 * WHICH DISK A PROJECT LIVES ON, AND WHETHER THAT DISK IS HERE RIGHT NOW.
 *
 * WHY THIS EXISTS. Telar had no notion of a volume, and every surface that
 * asked the filesystem a question got a true answer to the wrong one. A project
 * on an unplugged drive is not a repository with no branch, an empty file tree
 * and a clean diff — it is a project whose disk is in somebody's bag. Three
 * `git` children per project every ten seconds went on failing into that bag
 * forever, and a `git worktree add` blamed the repository for not being one.
 *
 * TWO FACTS, AND THEY ARE DIFFERENT FACTS. `volume` is IDENTITY — recorded once,
 * at registration, and the thing that survives an unplug. `ProjectAvailability`
 * is STATE — re-derived from the filesystem whenever anyone asks, and never
 * stored. Conflating them is what made a remount lose the project: macOS mounts
 * a second copy of a name at `<name> 1`, so the PATH is not identity and a
 * registry keyed on it mints a stranger. The uuid is.
 *
 * WHAT COUNTS AS A VOLUME, and why it is a short list rather than a dev-number
 * walk. The obvious test — "the root's device differs from `/`'s" — is wrong on
 * every modern Mac: APFS puts `/Users` on a Data volume firmlinked under a
 * read-only System volume, so `~/code/anything` sits on a different `st_dev`
 * than `/` and every ordinary project would have been declared external. The
 * mount ROOTS are named instead: `/Volumes` on macOS, `/media` and `/mnt` on
 * Linux. `apps/web/lib/fs-dirs.ts` keeps the same list for the registration
 * browser's sake; they are two apps and neither imports the other, so the
 * duplication is deliberate and both say so.
 *
 * THE UUID READER IS INJECTABLE, which is the whole reason the tests need no
 * hardware. `diskutil info -plist` is one subprocess against a real mount; a
 * test hands back a constant for a temp directory it can move, and every
 * transition this module claims to classify is then a unit test.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Project, ProjectAvailability } from "@telar/engine-client";

/**
 * WHERE THIS PROJECT'S DISK IS, and what it IS — recorded at registration.
 *
 * `mount` is where the drive was mounted the day it was registered; it is a
 * HINT, and the recovery path exists precisely because it goes stale. `uuid` is
 * the drive's own identifier and is what a remount is matched on.
 *
 * THE CONTRACT'S SHAPE, NOT A SECOND SPELLING OF IT (`Project.volume`). Two
 * definitions of what a volume is would be two things to forget when one moves.
 */
export type VolumeIdentity = NonNullable<Project["volume"]>;

/** Re-exported so this module is the one import a caller here needs, and so
 *  `ProjectAvailability` still has exactly one definition — the contract's. */
export type { ProjectAvailability };

export type VolumeDeps = {
  platform?: NodeJS.Platform;
  /** The mount roots, when the platform's own are not what is being tested. A
   *  test cannot create `/Volumes`, and bending `stat` to pretend it did would
   *  be testing the fake rather than the rule. Same argument, and the same
   *  shape, as `fs-dirs.ts`'s `mounts`. */
  mounts?: readonly string[];
  stat?: (target: string) => fs.Stats;
  readdir?: (target: string) => string[];
  /** The drive's own id for a mount point. Injected so a fake mount in a temp
   *  directory can carry a stable one and every case below is unit-testable. */
  volumeUuid?: (mount: string) => string | undefined;
};

type Resolved = Required<VolumeDeps>;

/** This platform's mount roots — where an external disk appears. The twin of
 *  `fs-dirs.ts`'s `platformMounts`; see this module's header for why it is
 *  copied rather than shared. */
export function mountRootsFor(platform: NodeJS.Platform): string[] {
  return platform === "darwin" ? ["/Volumes"] : platform === "linux" ? ["/media", "/mnt"] : [];
}

/**
 * CAN THIS PLATFORM BE ASKED WHICH REMOVABLE VOLUME A PATH IS ON — issue #665,
 * and the answer is three-valued because the honest answer is.
 *
 * ══ THE SILENT `[]` IS THE BUG ══
 *
 * `mountRootsFor("win32")` returns an empty list, so `mountPointForRoot` finds
 * no mount, so `volumeForRoot` returns `undefined` — which everything above
 * reads as **"this path is on the machine's own disk"**. On Windows that is not
 * a cautious answer, it is a wrong one, and its two consequences point in
 * opposite directions:
 *
 *   - A store on `D:\` records no volume, so unplugging the drive skips the
 *     whole designed-for `waiting` state — no window naming the drive, no
 *     `volume-watch` recovery, no "nothing has been touched" — and lands on a
 *     flat refuse. The feature's best idea does not run there at all.
 *   - A checkouts root on `D:\` reports as *configured and fine* even while the
 *     drive is out, so the blocker never fires, the cut proceeds, and `mkdirSync`
 *     fails mid-session with an I/O error instead of the sentence the design
 *     wrote for exactly this.
 *
 * So the absence is made EXPLICIT rather than left to look like a negative
 * answer. Callers that can act on it check this and say so; callers that only
 * ever ask about a path they know is local are unaffected.
 *
 * ══ WHY LINUX IS ITS OWN ANSWER ══
 *
 * `/media` and `/mnt` are recognised, so a volume ON a Linux box is found. But
 * `readVolumeUuid` is darwin-only, so there is no identity to match a remount
 * against: a drive that comes back under a different name cannot be resolved as
 * a rename and stays `absent` until the person re-chooses the location by hand.
 * That is half the feature, and folding it in with either neighbour would state
 * something false about one of them.
 *
 * NOT A FOURTH COPY OF THE MOUNT LIST. It reads `mountRootsFor` for the first
 * half of its answer, so a platform gaining mount roots gains support here in
 * the same edit. (There are already four independent copies of that list in
 * this repository — `volume-watch.js`, `fs-dirs.ts`, `worktree.ts` and this
 * file — each of which says so; this does not add a fifth.)
 */
export type VolumeSupport = "identified" | "located" | "unsupported";
export function volumeSupportOn(platform: NodeJS.Platform = process.platform): VolumeSupport {
  if (mountRootsFor(platform).length === 0) return "unsupported";
  return platform === "darwin" ? "identified" : "located";
}

function resolveDeps(deps: VolumeDeps): Resolved {
  const platform = deps.platform ?? process.platform;
  return {
    platform,
    mounts: deps.mounts ?? mountRootsFor(platform),
    stat: deps.stat ?? ((target) => fs.statSync(target)),
    readdir: deps.readdir ?? ((target) => fs.readdirSync(target)),
    volumeUuid: deps.volumeUuid ?? ((mount) => readVolumeUuid(mount, platform)),
  };
}

/**
 * THE MOUNT A PATH SITS ON, or nothing when it is on this machine's own disk.
 *
 * One segment under a mount root and no deeper: `/Volumes/TelarVR` is a volume,
 * `/Volumes/TelarVR/code/thing` is a path ON that volume, and `/Volumes` itself
 * is a directory on the boot disk that happens to be where volumes land.
 */
export function mountPointForRoot(root: string, deps: VolumeDeps = {}): string | undefined {
  const { mounts } = resolveDeps(deps);
  for (const mountRoot of mounts) {
    const prefix = mountRoot.endsWith(path.sep) ? mountRoot : `${mountRoot}${path.sep}`;
    if (!root.startsWith(prefix)) continue;
    const [name] = root.slice(prefix.length).split(path.sep);
    if (!name) continue;
    return path.join(mountRoot, name);
  }
  return undefined;
}

/**
 * WHETHER SOMETHING IS ACTUALLY MOUNTED THERE — the check a recreated empty
 * `/Volumes/<name>` fails.
 *
 * A mount point's `st_dev` differs from its parent directory's, because they are
 * two filesystems. An empty folder somebody (or macOS) left behind where a drive
 * used to be shares its parent's, and is therefore NOT a mount however much its
 * path looks like one. This is the difference between telling the person their
 * drive is unplugged and letting an agent work in an empty folder that will
 * vanish the next time it is remounted.
 */
export function isMountPoint(mount: string, deps: VolumeDeps = {}): boolean {
  const { stat } = resolveDeps(deps);
  const parent = path.dirname(mount);
  if (parent === mount) return false;
  try {
    return stat(mount).dev !== stat(parent).dev;
  } catch {
    // Nothing there at all: the ordinary shape of an unplugged drive.
    return false;
  }
}

/**
 * The drive's own identifier, read once at registration.
 *
 * macOS only, and absent rather than invented anywhere else: without a uuid
 * there is nothing to match a remount against, so a project that cannot produce
 * one keeps exactly today's behaviour instead of half of this feature. A network
 * share and a filesystem `diskutil` has no VolumeUUID for both land here.
 */
export function readVolumeUuid(mount: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform !== "darwin") return undefined;
  let plist: string;
  try {
    plist = execFileSync("diskutil", ["info", "-plist", mount], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      // Registration is a request somebody is waiting on, and `diskutil` talks
      // to diskarbitrationd: bounded so a wedged daemon cannot hold the engine.
      timeout: 5_000,
    });
  } catch {
    return undefined;
  }
  return parseVolumeUuid(plist);
}

/** `VolumeUUID` out of a `diskutil info -plist` answer. A regex rather than a
 *  plist parser: one key, one string, and no dependency worth the other 200. */
export function parseVolumeUuid(plist: string): string | undefined {
  const match = /<key>VolumeUUID<\/key>\s*<string>([^<]+)<\/string>/.exec(plist);
  const uuid = match?.[1]?.trim();
  return uuid ? uuid : undefined;
}

/**
 * The volume identity to store for a project root, or nothing for a project on
 * this machine's own disk — which is every project that existed before this and
 * which goes on behaving exactly as it did.
 */
export function volumeForRoot(root: string, deps: VolumeDeps = {}): VolumeIdentity | undefined {
  const resolved = resolveDeps(deps);
  /**
   * `undefined` HERE MEANS "ON THIS MACHINE'S OWN DISK", and on a platform this
   * module cannot read it would mean "we could not tell" — two different facts
   * with one spelling. A caller that must distinguish them asks
   * `volumeSupportOn` first; this refuses rather than record an identity it has
   * no way to check later, which would be a `Project.volume` that never matches
   * on remount and an unplug that reads as a deletion.
   */
  if (volumeSupportOn(resolved.platform) === "unsupported") return undefined;
  const mount = mountPointForRoot(root, resolved);
  if (mount === undefined) return undefined;
  if (!isMountPoint(mount, resolved)) return undefined;
  const uuid = resolved.volumeUuid(mount);
  return uuid === undefined ? undefined : { mount, uuid };
}

/**
 * THE ONE PROBE. Every surface's answer to "is this project readable" comes
 * from here, so there is one place where "the drive is away" is decided and no
 * chance of a rail and a composer disagreeing about it.
 *
 * CHEAP ENOUGH TO POLL: three `stat`s at worst, no subprocess, no `diskutil`.
 * That is what lets it ride `projectMetadata`'s existing ten-second tick instead
 * of earning a timer of its own.
 *
 * THE ORDER MATTERS. The mount is asked FIRST for a volume project, because the
 * empty-mountpoint case passes a `stat` on the root and would otherwise read as
 * available — which is the failure that let a provider run in a folder that was
 * about to disappear.
 */
export function probeAvailability(
  project: { root: string; volume?: VolumeIdentity },
  deps: VolumeDeps = {},
): ProjectAvailability {
  const resolved = resolveDeps(deps);
  const readable = () => {
    try {
      return resolved.stat(project.root).isDirectory();
    } catch {
      return false;
    }
  };
  if (project.volume === undefined) return readable() ? "available" : "missing";
  if (!isMountPoint(project.volume.mount, resolved)) return "unmounted";
  if (!readable()) {
    // The drive IS here and the folder is not on it. That is a deletion, not a
    // cable, and saying "unmounted" would tell the person to plug in a disk
    // they are already looking at.
    return "missing";
  }
  try {
    // The root must be ON the mounted volume. A path that resolved to some
    // other filesystem is a coincidence of names, not this project.
    if (resolved.stat(project.root).dev !== resolved.stat(project.volume.mount).dev) return "unmounted";
  } catch {
    return "unmounted";
  }
  return "available";
}

/**
 * WHERE THIS DRIVE IS MOUNTED NOW, whatever it is called this time.
 *
 * macOS mounts a volume whose name is already taken at `<name> 1`, so replugging
 * the drive a project was registered from routinely changes its path. Scanning
 * the mount roots for the recorded uuid is what makes that a rename rather than
 * a lost project — see `state.ts`'s recovery, which is the one sanctioned writer
 * of `Project.root`.
 *
 * ONLY CALLED FOR A PROJECT THAT IS NOT AVAILABLE, and that bound is the reason
 * a `diskutil` per mounted volume is affordable: it runs when a drive is away,
 * not on the poll path.
 */
/**
 * WHAT IS MOUNTED RIGHT NOW, as one comparable string.
 *
 * WHY THIS EXISTS: `findVolumeMount` costs a `diskutil` child PER MOUNTED
 * VOLUME, and the poll path cannot afford to pay that every ten seconds for
 * every away project — that would be a worse version of exactly the git churn
 * this issue is about. But a drive can only have come back if the set of mount
 * points CHANGED, and that question is a `readdir` and a `stat` each.
 *
 * So this is the cheap precondition: while it reads the same, no drive has
 * arrived or left and there is nothing for a uuid search to find. It is a HINT
 * in the same sense the desktop's watcher is — a signature that failed to change
 * costs a search that would have found nothing.
 */
export function mountSignature(deps: VolumeDeps = {}): string {
  const resolved = resolveDeps(deps);
  const mounted: string[] = [];
  for (const mountRoot of resolved.mounts) {
    let names: string[];
    try {
      names = resolved.readdir(mountRoot);
    } catch {
      continue;
    }
    for (const name of names) {
      const mount = path.join(mountRoot, name);
      if (isMountPoint(mount, resolved)) mounted.push(mount);
    }
  }
  // JSON rather than a joined string: a separator character is a character a
  // mount name could contain, and two different sets that joined to one string
  // would read as "nothing changed" — which is exactly the case this exists to
  // detect. It also keeps the repository's no-invisible-characters rule, which
  // an obvious NUL separator would have broken.
  return JSON.stringify(mounted.sort());
}

export function findVolumeMount(uuid: string, deps: VolumeDeps = {}): string | undefined {
  const resolved = resolveDeps(deps);
  for (const mountRoot of resolved.mounts) {
    let names: string[];
    try {
      names = resolved.readdir(mountRoot);
    } catch {
      continue;
    }
    for (const name of names) {
      const mount = path.join(mountRoot, name);
      if (!isMountPoint(mount, resolved)) continue;
      if (resolved.volumeUuid(mount) === uuid) return mount;
    }
  }
  return undefined;
}
