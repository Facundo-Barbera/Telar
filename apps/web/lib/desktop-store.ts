"use client";

/**
 * WHERE THIS INSTALL KEEPS ITS STORE, as the cockpit sees it — issue #630.
 *
 * A LOCAL STRUCTURAL TYPE AND AN ACCESSOR, the same shape `desktop-updates.ts`
 * and `choose-directory.ts` use, and for the same reason: a global `Window`
 * augmentation would imply the bridge is always there, and in a browser tab it
 * never is.
 *
 * NOTHING HERE TALKS TO THE ENGINE, and that is not an accident of layering.
 * The store's location is decided by the shell before the engine exists and
 * read once at launch (`apps/desktop/main.js`), so an engine route would be
 * asking the thing being moved where it ought to be. It is a property of this
 * installation, like the update channel.
 */

import { useCallback, useEffect, useState } from "react";

/** A drive the store sits on. Absent when it is on this machine's own disk. */
export type StoreVolume = { mount: string; uuid?: string; label?: string };

export type StoreStatus = {
  /** Where the running engine's store actually is. */
  path: string;
  /** Where it would be with nothing configured — what "move it back" means. */
  defaultPath: string;
  storeId?: string;
  volume?: StoreVolume;
  /** An explicit TELAR_HOME is pointing this run somewhere; the controls say
   *  so rather than offering to move a store this install does not own. */
  pinnedByEnvironment: boolean;
  /** A previous store a completed move left behind, still on disk. */
  retired?: { source: string; stamp: string; bytes: number; removable: boolean };
};

export type StoreProgress = { phase: "copying" | "verifying"; bytesDone: number; bytesTotal: number };

export type StoreOutcome =
  | { ok: true; restartRequired?: boolean; bytes?: number; path?: string; removed?: number }
  | { ok: false; step?: string; message: string; detail?: string };

export type StoreBridge = {
  status: () => Promise<StoreStatus>;
  preflight: (path: string) => Promise<StoreOutcome>;
  move: (path: string) => Promise<StoreOutcome>;
  removeOld: () => Promise<StoreOutcome>;
  keepOld: () => Promise<StoreOutcome>;
  onProgress: (listener: (progress: StoreProgress) => void) => (() => void) | void;
};

export function desktopStore(): StoreBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { telarDesktop?: { store?: StoreBridge } }).telarDesktop?.store;
}

/**
 * THE SENTENCE SOMEBODY MOVING THEIR STORE ONTO A BUS-POWERED DRIVE IS
 * ENTITLED TO MEET, and the reason it lives here rather than only in the design
 * doc.
 *
 * It is deliberately narrow, because every clause in it is something that was
 * established by reading the code rather than assumed. The engine calls no
 * `fsync` at steady state, so a write it has acknowledged may still only be in
 * the page cache; sqlite's recovery gets the last committed transaction back
 * *if* the enclosure honoured its flushes, which enclosures are widely known to
 * lie about. What is structurally safe is that documents are written by rename,
 * so the failure mode is a missing recent write rather than a corrupt one.
 *
 * Claiming more than this would be claiming durability nobody established.
 */
export const REMOVABLE_DRIVE_WARNING =
  "If the drive is unplugged while Telar is running, any turn in flight fails and the most recent writes can be lost. Telar's history is written so that what survives is intact rather than half-written, but a drive that is pulled mid-write can still lose the newest entries. Eject before unplugging.";

/** What a move costs, phrased for a progress line rather than a log. */
export function progressLabel(progress: StoreProgress | null): string | undefined {
  if (!progress) return undefined;
  const percent = progress.bytesTotal > 0 ? Math.min(100, Math.round((progress.bytesDone / progress.bytesTotal) * 100)) : 0;
  // The two phases are named rather than averaged into one bar: a progress
  // indicator that sits at 100% while an unannounced verification runs is how
  // somebody learns to pull the drive out.
  return progress.phase === "copying" ? `Copying… ${percent}%` : `Checking the copy… ${percent}%`;
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** The shell's answer, re-read after anything that could change it. */
export function useStoreStatus(): { status: StoreStatus | null; supported: boolean; refresh: () => void } {
  const [status, setStatus] = useState<StoreStatus | null>(null);
  const bridge = typeof window === "undefined" ? undefined : desktopStore();
  const refresh = useCallback(() => {
    const store = desktopStore();
    if (!store) return;
    void store.status().then(setStatus);
  }, []);
  useEffect(refresh, [refresh]);
  return { status, supported: Boolean(bridge), refresh };
}
