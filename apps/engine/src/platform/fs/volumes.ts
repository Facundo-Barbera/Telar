import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { mountRootsFor, volumeSupportOn, type Project, type ProjectAvailability } from "@telar/engine-client";

export type VolumeIdentity = NonNullable<Project["volume"]>;

export type { ProjectAvailability };

export type VolumeDeps = {
  platform?: NodeJS.Platform;
  mounts?: readonly string[];
  stat?: (target: string) => fs.Stats;
  readdir?: (target: string) => string[];
  volumeUuid?: (mount: string) => string | undefined;
};

type Resolved = Required<VolumeDeps>;

export { mountRootsFor, volumeSupportOn } from "@telar/engine-client";

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

export function isMountPoint(mount: string, deps: VolumeDeps = {}): boolean {
  const { stat } = resolveDeps(deps);
  const parent = path.dirname(mount);
  if (parent === mount) return false;
  try {
    return stat(mount).dev !== stat(parent).dev;
  } catch {
    return false;
  }
}

function readVolumeUuid(mount: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform !== "darwin") return undefined;
  let plist: string;
  try {
    plist = execFileSync("diskutil", ["info", "-plist", mount], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
  } catch {
    return undefined;
  }
  return parseVolumeUuid(plist);
}

export function parseVolumeUuid(plist: string): string | undefined {
  const match = /<key>VolumeUUID<\/key>\s*<string>([^<]+)<\/string>/.exec(plist);
  const uuid = match?.[1]?.trim();
  return uuid ? uuid : undefined;
}

export function volumeForRoot(root: string, deps: VolumeDeps = {}): VolumeIdentity | undefined {
  const resolved = resolveDeps(deps);
  if (volumeSupportOn(resolved.platform) === "unsupported") return undefined;
  const mount = mountPointForRoot(root, resolved);
  if (mount === undefined) return undefined;
  if (!isMountPoint(mount, resolved)) return undefined;
  const uuid = resolved.volumeUuid(mount);
  return uuid === undefined ? undefined : { mount, uuid };
}

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
    return "missing";
  }
  try {
    if (resolved.stat(project.root).dev !== resolved.stat(project.volume.mount).dev) return "unmounted";
  } catch {
    return "unmounted";
  }
  return "available";
}

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

export function parseSolidState(info: string): boolean | undefined {
  const match = /^\s*Solid State:\s*(Yes|No)\s*$/im.exec(info);
  return match ? match[1]!.toLowerCase() === "yes" : undefined;
}

const rotational = new Map<string, Promise<boolean | undefined>>();

/** Whether `target` sits on a spinning disk; undefined when the platform cannot tell in time. */
export function onRotationalDisk(target: string): Promise<boolean | undefined> {
  if (process.platform !== "darwin") return Promise.resolve(undefined);
  const mount = mountPointForRoot(path.resolve(target)) ?? "/";
  let answer = rotational.get(mount);
  if (!answer) {
    answer = promisify(execFile)("diskutil", ["info", mount], { timeout: 5_000 }).then(
      ({ stdout }) => {
        const solid = parseSolidState(stdout);
        return solid === undefined ? undefined : !solid;
      },
      () => undefined,
    );
    rotational.set(mount, answer);
  }
  return answer;
}
