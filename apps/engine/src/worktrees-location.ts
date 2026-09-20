/**
 * ══ WHERE THE SESSION CHECKOUTS LIVE — issue #642 part 2 ══
 *
 * WHY THIS IS ENGINE STATE AND NOT THE SHELL'S, which is the opposite of where
 * #630 put the STORE's location and is a deliberate difference rather than an
 * inconsistency.
 *
 * #630 lives in the shell for one load-bearing reason: the shell has to tell
 * "your store is elsewhere and is not plugged in" from "this is a first run"
 * BEFORE any engine exists, because getting that wrong initialises an empty
 * store over somebody's absent history. **That reason does not exist here.**
 * Nothing about the worktrees root is needed to decide whether a store exists,
 * and the engine is the only thing that reads it. Copying the location of a
 * decision without the reason for it is how a codebase accumulates cargo, and
 * how the next reader concludes that the shell is simply where settings go.
 *
 * IT FOLLOWS THAT THE ROOT IS ALWAYS READABLE WHEN IT MATTERS. Engine state
 * lives in the store, and the store is present by definition while the engine
 * is running — so "the checkouts are on a drive that is not mounted" is a STATE
 * to sit in and recover from, exactly as #630's absent-volume case is, rather
 * than an exception at start-up. It is #630's discipline one level down.
 *
 * AND CHANGING IT NEEDS NO RESTART. The root is consulted at exactly one moment
 * — planning where a new checkout lands — and every later operation addresses a
 * worktree by the absolute path recorded on its session. A new root therefore
 * takes effect on the next cut, and worktrees already cut go on working, and
 * being removed, from wherever they are. `restartRequired` would be a symmetry
 * with #630 that costs a person a restart they do not need.
 */

import fs from "node:fs";
import path from "node:path";
import { atomicWrite } from "./atomic";
import { findVolumeMount, isMountPoint, volumeForRoot, type VolumeDeps, type VolumeIdentity } from "./volumes";

/**
 * The default: beside everything else the engine keeps. What "put it back"
 * means, and what every install has until somebody chooses otherwise.
 *
 * NOTHING HERE MARKS THE DIRECTORY FOR SPOTLIGHT OR TIME MACHINE, and that is a
 * decision rather than an omission — see `docs/worktrees-indexing.md` (#634).
 * Short version: `.metadata_never_index` only works at a VOLUME root and this
 * path is never one, so writing it would ship a no-op that reads like a fix;
 * and a Time Machine exclusion is the owner's call, because a worktree holds
 * uncommitted work and `tmutil`'s default exclusion is inherited by copies.
 */
export function defaultWorktreesRoot(engineRoot: string): string {
  return path.join(engineRoot, "worktrees");
}

/**
 * The record, on disk. VERSIONED, and read strictly — see `readWorktreesRoot`.
 *
 * `volume` IS RECORDED AT THE MOMENT OF CHOOSING and is what names the drive in
 * the refusal when it is not there, since the disk is not present to be asked.
 * The `uuid` is what lets a remount under a different name be recognised as a
 * rename rather than a loss; it is macOS-only and absent for network shares
 * (`volumes.ts:138`), so nothing load-bearing depends on having one.
 */
export type WorktreesLocation = {
  version: 1;
  root: string;
  volume?: VolumeIdentity;
  /** The drive's NAME the day it was chosen, kept because `VolumeIdentity` is
   *  a mount and a uuid and neither is what a person calls their disk. It is
   *  recorded rather than read because the moment it is needed — saying which
   *  drive is missing — is the moment the drive cannot be asked. Exactly
   *  #630's reason for recording the label at adoption. */
  label?: string;
  movedAt: number;
};

/**
 * What the engine knows about where checkouts go, as one answer.
 *
 * FOUR STATES AND NOT A PATH, because three of them are things a person has to
 * be told rather than a location to silently use.
 */
export type WorktreesRootState =
  /** Nothing configured. The root is the default, beside the store. */
  | { kind: "default"; root: string }
  /** Somebody chose this, and it is there. */
  | { kind: "configured"; root: string; volume?: VolumeIdentity; label?: string }
  /** Chosen, on a drive, and the drive is not mounted. NOT an error: it is the
   *  designed-for state, and plugging the drive back in resolves it with
   *  nothing written in the meantime. */
  | { kind: "absent"; root: string; volume: VolumeIdentity; label?: string }
  /** The file is there and this build cannot read it. */
  | { kind: "unreadable"; reason: string };

/** Where checkouts would go if this state were used — absent for the two
 *  states that have no usable answer. */
export function rootOf(state: WorktreesRootState): string | undefined {
  return state.kind === "default" || state.kind === "configured" ? state.root : undefined;
}

/**
 * WHY A CUT CANNOT HAPPEN, in a sentence a person can act on — or nothing.
 *
 * Every branch names the thing that is wrong and what would fix it. The drive's
 * name comes from the record rather than from the disk, because the disk is
 * what is missing.
 */
export function worktreesRootBlocker(state: WorktreesRootState): string | undefined {
  if (state.kind === "absent") {
    return `Telar keeps its session checkouts on ${state.label ?? path.basename(state.volume.mount)}, which is not connected. Plug it back in, or choose another location in Settings ▸ Storage.`;
  }
  if (state.kind === "unreadable") return state.reason;
  return undefined;
}

function locationFile(engineRoot: string): string {
  return path.join(engineRoot, "worktrees-location.json");
}

/**
 * READ IT, AND REFUSE RATHER THAN GUESS — #630's version discipline, with the
 * SCOPE of the refusal matched to the scope of what could not be read.
 *
 * #630 refuses to START on a shape it does not recognise, because falling back
 * to the default path there is the fresh-store-over-absent-history bug. Nothing
 * here is destructive: the worst a wrong answer does is put new checkouts
 * somewhere unexpected. So an unreadable record refuses THE CUT — a named
 * error on the request that asked for one — and leaves the rest of the engine
 * alone. Locking somebody out of every session and all their history over the
 * file that says where checkouts go would be a bigger failure than the one
 * being prevented.
 *
 * A REMOUNT UNDER A NEW NAME IS A RENAME, NOT A LOSS. macOS mounts a second
 * copy of a drive at `TelarVR 1`, and #630 already learnt to resolve that by
 * uuid rather than by path; the same resolution happens here, and the record is
 * rewritten so the next read is direct.
 */
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

/**
 * Put the checkouts somewhere else, from now on.
 *
 * WRITTEN ONLY ONCE THE FOLDER IS THERE. A record naming a path that does not
 * exist would be a configuration that refuses every cut until somebody notices,
 * and the caller is in a position to create it.
 *
 * NOTHING IS MOVED BY THIS, and that is the contract rather than an omission.
 * Worktrees already cut keep working where they are — they are addressed by the
 * path recorded on their session, never by recomputing one from this root — so
 * this is a decision about the NEXT cut and cannot lose anybody's work.
 */
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
