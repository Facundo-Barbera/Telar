// Engine state, read only when planning a cut: existing checkouts are addressed by their recorded path,
// so a new root applies to the next cut without a restart.

import fs from "node:fs";
import path from "node:path";
import { atomicWrite } from "../../platform/fs/atomic";
import { statePaths } from "../../state-paths";
import { findVolumeMount, isMountPoint, volumeForRoot, volumeSupportOn, type VolumeDeps, type VolumeIdentity } from "../../volumes";

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

// An unreadable record refuses the cut, not the engine. A remount under a new name is resolved by uuid
// and the record rewritten.
export function readWorktreesRoot(engineRoot: string, deps: VolumeDeps = {}): WorktreesRootState {
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

  const volume = record.volume;
  const label = typeof record.label === "string" ? record.label : undefined;
  if (!volume) return { kind: "configured", root: path.resolve(record.root) };

  // Checked first: on a platform with no mount roots the branches below would call a connected drive absent.
  if (volumeSupportOn(deps.platform ?? process.platform) === "unsupported") {
    if (fs.existsSync(record.root)) return { kind: "configured", root: path.resolve(record.root), volume, ...(label ? { label } : {}) };
    return { kind: "unverifiable", root: path.resolve(record.root), volume, ...(label ? { label } : {}) };
  }

  // Still mounted where it was: the ordinary case, and the cheapest check.
  if (isMountPoint(volume.mount, deps) && fs.existsSync(record.root)) {
    return { kind: "configured", root: path.resolve(record.root), volume, ...(label ? { label } : {}) };
  }
  // Mounted elsewhere — resolve by the drive's own id, and rewrite the hint.
  const moved = volume.uuid ? findVolumeMount(volume.uuid, deps) : undefined;
  if (moved && moved !== volume.mount) {
    const root = path.join(moved, path.relative(volume.mount, record.root));
    if (fs.existsSync(root)) {
      const next: WorktreesLocation = { version: 1, root, volume: { ...volume, mount: moved }, ...(label ? { label } : {}), movedAt: record.movedAt ?? Date.now() };
      try {
        atomicWrite(locationFile(engineRoot), next, 0o600);
      } catch {
        // The answer is right either way; rewriting only saves the next read
        // from resolving it again.
      }
      return { kind: "configured", root, volume: next.volume!, ...(label ? { label } : {}) };
    }
  }
  return { kind: "absent", root: path.resolve(record.root), volume, ...(label ? { label } : {}) };
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
  return record;
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
