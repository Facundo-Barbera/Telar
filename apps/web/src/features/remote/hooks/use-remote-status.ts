"use client";

import { useCallback, useEffect, useState } from "react";
import { hostVisible, subscribeHostVisibility } from "@/platform/desktop/host-visibility";
import { EngineApiError } from "@/platform/engine";
import { mintPairing, remoteStatus, revokeDevice, revokeOtherDevices, setRemote, updateDevice, type MintedPairing, type RemoteStatus } from "../api";

export function useRemoteStatus() {
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [minted, setMinted] = useState<MintedPairing | null>(null);
  const [busy, setBusy] = useState(false);
  const [restartNeeded, setRestartNeeded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await remoteStatus());
      setError(null);
    } catch {
      setError("The pairing store did not answer.");
    }
  }, []);

  useEffect(() => {
    const task = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(task);
  }, [load]);

  const toggle = useCallback(
    async (next: boolean) => {
      setBusy(true);
      try {
        await setRemote({ requireAuth: next });
        if (!next) setMinted(null);
        await load();
      } catch {
        setError("Could not change the pairing requirement.");
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const patchNetwork = useCallback(
    async (body: Parameters<typeof setRemote>[0], fallback: string) => {
      setBusy(true);
      setError(null);
      try {
        await setRemote(body);
        setRestartNeeded(true);
        await load();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : fallback);
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const setExposure = useCallback(
    (next: "local-only" | "network-accessible") => patchNetwork({ exposure: next }, "Could not change network access."),
    [patchNetwork],
  );

  const setTailscaleServe = useCallback((next: boolean) => patchNetwork({ tailscaleServe: next }, "Could not change Tailscale HTTPS."), [patchNetwork]);

  const mint = useCallback(async () => {
    setBusy(true);
    try {
      setMinted(await mintPairing());
      await load();
    } catch {
      setError("Could not mint a pairing code.");
    } finally {
      setBusy(false);
    }
  }, [load]);

  const revoke = useCallback(
    async (deviceId: string) => {
      await revokeDevice(deviceId).catch(() => undefined);
      await load();
    },
    [load],
  );

  const patchDevice = useCallback(
    async (deviceId: string, body: { name?: string; role?: "full" | "observer" }) => {
      try {
        await updateDevice(deviceId, body);
        setError(null);
      } catch (cause) {
        setError(cause instanceof EngineApiError && cause.status === 409 ? "Keep at least one device with full access." : "Could not update the device.");
      }
      await load();
    },
    [load],
  );

  const revokeOthers = useCallback(async () => {
    await revokeOtherDevices().catch(() => undefined);
    await load();
  }, [load]);

  useEffect(
    () =>
      subscribeHostVisibility(() => {
        if (hostVisible()) void load();
      }),
    [load],
  );

  return { status, minted, busy, restartNeeded, error, toggle, setExposure, setTailscaleServe, mint, revoke, patchDevice, revokeOthers };
}
