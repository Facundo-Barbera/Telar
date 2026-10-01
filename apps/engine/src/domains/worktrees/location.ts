// Engine state, read only when planning a cut: existing checkouts are addressed by their recorded path,
// so a new root applies to the next cut without a restart.

import fs from "node:fs";
import path from "node:path";
import { atomicWrite } from "../../platform/fs/atomic";
import { statePaths } from "../../platform/fs/state-paths";
import { knownVolumeMount, listedMounts, probeAvailability, volumeForRoot, volumeForRootAsync, volumeSupportOn, type ProjectAvailability, type VolumeDeps, type VolumeIdentity } from "../../platform/fs/volumes";

// Not marked for Spotlight or Time Machine: .metadata_never_index only works at a volume root,
// and excluding uncommitted work from backups is the owner's call.
export function defaultWorktreesRoot(engineRoot: string): string {
  return path.join(engineRoot, "worktrees");
}

// `volume` is recorded when chosen so a missing drive can still be named; the uuid spots a remount rename.
export type WorktreesLocation = {
  version: 1;
  root: string;
  volume?: VolumeIdentity;
  label?: string;
  movedAt: number;
};

export type WorktreesRootState =
  /** Nothing configured. The root is the default, beside the store. */
  | { kind: "default"; root: string }
  /** Somebody chose this, and it is there. */
  | { kind: "configured"; root: string; volume?: VolumeIdentity; label?: string }
  /** Chosen, on a drive, and the drive is not mounted. NOT an error: it is the
   *  designed-for state, and plugging the drive back in resolves it with
   *  nothing written in the meantime. */
  | { kind: "absent"; root: string; volume: VolumeIdentity; label?: string }
  // No mount roots on this platform (win32), so whether the drive is here is unknown; still a blocker.
  | { kind: "unverifiable"; root: string; volume: VolumeIdentity; label?: string }
  /** The file is there and this build cannot read it. */
  | { kind: "unreadable"; reason: string };

/** Where checkouts would go if this state were used — absent for the two
 *  states that have no usable answer. */
export function rootOf(state: WorktreesRootState): string | undefined {
  return state.kind === "default" || state.kind === "configured" ? state.root : undefined;
}

export function worktreesRootBlocker(state: WorktreesRootState): string | undefined {
  if (state.kind === "absent") {
    return `Telar keeps its session checkouts on ${state.label ?? path.basename(state.volume.mount)}, which is not connected. Plug it back in, or choose another location in Settings ▸ Storage.`;
  }
  if (state.kind === "unverifiable") {
    // NAMES WHAT THIS BUILD CANNOT DO, not what the person's disk is doing.
    // "Plug it back in" would be wrong half the time and unfalsifiable the
    // other half; this sends them to the one action that always works.
    return `Telar keeps its session checkouts on ${state.label ?? path.basename(state.volume.mount)}, and this build cannot tell whether that drive is connected. Make sure it is, or choose a location on this machine's own disk in Settings ▸ Storage.`;
  }
  if (state.kind === "unreadable") return state.reason;
  return undefined;
}

function locationFile(engineRoot: string): string {
  return statePaths(engineRoot).worktreesLocation;
}

const PRESENCE_REFRESH_MS = 2_000;
const presences = new Map<string, { value: ProjectAvailability; at: number }>();
const probing = new Map<string, Promise<ProjectAvailability>>();

const presenceKey = (root: string, volume?: VolumeIdentity): string => `${root}\0${volume?.mount ?? ""}`;

function probeRoot(root: string, volume: VolumeIdentity | undefined, deps: VolumeDeps): Promise<ProjectAvailability> {
  const key = presenceKey(root, volume);
  const running = probing.get(key);
  if (running) return running;
  const probe = probeAvailability({ root, ...(volume ? { volume } : {}) }, deps)
    .catch((): ProjectAvailability => "missing")
    .then((value) => {
      probing.delete(key);
      presences.set(key, { value, at: Date.now() });
      return value;
    });
  probing.set(key, probe);
  return probe;
}

// From memory, re-probed in the background once stale; before the first probe answers, a drive is here if it is listed.
function rootPresent(root: string, volume: VolumeIdentity | undefined, deps: VolumeDeps): boolean {
  const known = presences.get(presenceKey(root, volume));
  if (known === undefined || Date.now() - known.at >= PRESENCE_REFRESH_MS) void probeRoot(root, volume, deps);
  if (known !== undefined) return known.value === "available";
  return volume === undefined || listedMounts(deps).includes(volume.mount);
}

type LocationRecord = { root: string; volume?: VolumeIdentity; label?: string; movedAt?: number };

function readRecord(engineRoot: string): LocationRecord | Extract<WorktreesRootState, { kind: "default" | "unreadable" }> {
  let raw: string;
  try {
    raw = fs.readFileSync(locationFile(engineRoot), "utf8");
  } catch {
    return { kind: "default", root: defaultWorktreesRoot(engineRoot) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "unreadable", reason: `Telar could not read ${locationFile(engineRoot)}, so it does not know where to put new session checkouts. Choose a location again in Settings ▸ Storage.` };
  }
  const record = parsed as Partial<WorktreesLocation> | null;
  if (record?.version !== 1) {
    return {
      kind: "unreadable",
      reason: `${locationFile(engineRoot)} was written by a different version of Telar and this one does not recognise it, so it will not guess where session checkouts belong. Choose a location again in Settings ▸ Storage.`,
    };
  }
  if (typeof record.root !== "string" || !path.isAbsolute(record.root)) {
    return { kind: "unreadable", reason: `${locationFile(engineRoot)} does not name an absolute folder for session checkouts. Choose a location again in Settings ▸ Storage.` };
  }
  return { root: record.root, ...(record.volume ? { volume: record.volume } : {}), ...(typeof record.label === "string" ? { label: record.label } : {}), ...(record.movedAt === undefined ? {} : { movedAt: record.movedAt }) };
}

// An unreadable record refuses the cut, not the engine. Whether the drive is here comes from memory, never a stat
// on the read; a remount under a new name is resolved by uuid and the record rewritten.
export function readWorktreesRoot(engineRoot: string, deps: VolumeDeps = {}): WorktreesRootState {
  const record = readRecord(engineRoot);
  if ("kind" in record) return record;
  const { volume, label } = record;
  const root = path.resolve(record.root);
  if (!volume) return { kind: "configured", root };
  const named = { volume, ...(label ? { label } : {}) };

  // Checked first: on a platform with no mount roots the branches below would call a connected drive absent.
  if (volumeSupportOn(deps.platform ?? process.platform) === "unsupported") {
    return { kind: rootPresent(root, undefined, deps) ? "configured" : "unverifiable", root, ...named };
  }
  if (rootPresent(root, volume, deps)) return { kind: "configured", root, ...named };
  const moved = volume.uuid ? knownVolumeMount(volume.uuid, deps) : undefined;
  if (moved && moved !== volume.mount) {
    const next: WorktreesLocation = { version: 1, root: path.join(moved, path.relative(volume.mount, root)), volume: { ...volume, mount: moved }, ...(label ? { label } : {}), movedAt: record.movedAt ?? Date.now() };
    if (rootPresent(next.root, next.volume, deps)) {
      try {
        atomicWrite(locationFile(engineRoot), next, 0o600);
      } catch {
        // The answer is right either way; rewriting only saves the next read resolving it again.
      }
      return { kind: "configured", root: next.root, volume: next.volume!, ...(label ? { label } : {}) };
    }
  }
  return { kind: "absent", root, ...named };
}

/** `readWorktreesRoot` once the disk has been asked, for a route a person is waiting on. */
export async function probeWorktreesRoot(engineRoot: string, deps: VolumeDeps = {}): Promise<WorktreesRootState> {
  const record = readRecord(engineRoot);
  if (!("kind" in record)) {
    const unsupported = volumeSupportOn(deps.platform ?? process.platform) === "unsupported";
    const volume = unsupported ? undefined : record.volume;
    await probeRoot(path.resolve(record.root), volume, deps);
    const moved = volume?.uuid ? knownVolumeMount(volume.uuid, deps) : undefined;
    if (volume && moved && moved !== volume.mount) {
      await probeRoot(path.join(moved, path.relative(volume.mount, path.resolve(record.root))), { ...volume, mount: moved }, deps);
    }
  }
  return readWorktreesRoot(engineRoot, deps);
}

// Written only once the folder exists. Nothing is moved: this only decides the next cut.
export function writeWorktreesRoot(engineRoot: string, root: string, deps: VolumeDeps = {}, now = Date.now()): WorktreesLocation {
  const resolved = path.resolve(root);
  if (!path.isAbsolute(root)) throw new Error("a worktrees root must be an absolute path");
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const volume = volumeForRoot(resolved, deps);
  const record: WorktreesLocation = {
    version: 1,
    root: resolved,
    ...(volume ? { volume, label: path.basename(volume.mount) } : {}),
    movedAt: now,
  };
  // `atomicWrite` serialises the VALUE — handing it a string would store a
  // JSON string, which parses back to a string and reads as an unrecognised
  // shape. The refusal would be correct and the cause would be here.
  atomicWrite(locationFile(engineRoot), record, 0o600);
  if (!volume) recordVolumeLater(engineRoot, resolved, deps);
  return record;
}

function recordVolumeLater(engineRoot: string, root: string, deps: VolumeDeps): void {
  void (async () => {
    const volume = await volumeForRootAsync(root, deps);
    if (!volume) return;
    const current = JSON.parse(await fs.promises.readFile(locationFile(engineRoot), "utf8")) as WorktreesLocation;
    if (current.root !== root || current.volume) return;
    atomicWrite(locationFile(engineRoot), { ...current, volume, label: path.basename(volume.mount) }, 0o600);
  })().catch(() => undefined);
}

/** Put it back beside the store. Removing the record IS the answer — a record
 *  naming the default would be a second way to say the same thing, and the two
 *  would drift the first time the default moved. */
export function clearWorktreesRoot(engineRoot: string): void {
  try {
    fs.rmSync(locationFile(engineRoot));
  } catch {
    // Already the default.
  }
}
