"use client";

/**
 * Where this install keeps its store. Shell-only: the location is decided before the engine
 * starts (`apps/desktop/main.js`), so there is no engine route for it.
 */

import { useCallback, useEffect, useState } from "react";

/** A drive the store sits on. Absent when it is on this machine's own disk. */
type StoreVolume = { mount: string; uuid?: string; label?: string };

export type StoreStatus = {
  /** Where the running engine's store actually is. */
  path: string;
  /** Where it would be with nothing configured. */
  defaultPath: string;
  storeId?: string;
  volume?: StoreVolume;
  /** An explicit TELAR_HOME points this run elsewhere, so the store cannot be moved. */
  pinnedByEnvironment: boolean;
  /** A previous store a completed move left behind, still on disk. */
  retired?: { source: string; stamp: string; bytes: number; removable: boolean };
};

export type StoreProgress = { phase: "copying" | "verifying"; bytesDone: number; bytesTotal: number };

type StoreOutcome =
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
 * Deliberately narrow: the engine does not fsync at steady state and enclosures may ignore
 * flushes, but documents are written by rename, so the risk is lost recent writes, not corruption.
 */
export const REMOVABLE_DRIVE_WARNING =
  "If the drive is unplugged while Telar is running, any turn in flight fails and the most recent writes can be lost. Telar's history is written so that what survives is intact rather than half-written, but a drive that is pulled mid-write can still lose the newest entries. Eject before unplugging.";

export function progressLabel(progress: StoreProgress | null): string | undefined {
  if (!progress) return undefined;
  const percent = progress.bytesTotal > 0 ? Math.min(100, Math.round((progress.bytesDone / progress.bytesTotal) * 100)) : 0;
  // The phases are named separately so a hidden verification never sits at 100%.
  return progress.phase === "copying" ? `Copying… ${percent}%` : `Checking the copy… ${percent}%`;
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
