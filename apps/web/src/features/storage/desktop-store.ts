"use client";

import { useCallback, useEffect, useState } from "react";

type StoreVolume = { mount: string; uuid?: string; label?: string };

export type StoreStatus = {
  path: string;
  defaultPath: string;
  storeId?: string;
  volume?: StoreVolume;
  pinnedByEnvironment: boolean;
  retired?: { source: string; stamp: string; bytes?: number; removable: boolean };
};

type StoreOutcome = { ok: true; removed?: number } | { ok: false; message: string };

export type StoreBridge = {
  status: () => Promise<StoreStatus>;
  removeOld: () => Promise<StoreOutcome>;
  keepOld: () => Promise<StoreOutcome>;
};

export function desktopStore(): StoreBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { telarDesktop?: { store?: StoreBridge } }).telarDesktop?.store;
}

export const REMOVABLE_DRIVE_WARNING =
  "Unplugging the drive while Telar is running fails any turn in flight and can lose the newest writes. Eject before unplugging.";

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
