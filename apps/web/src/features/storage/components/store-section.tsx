"use client";

import { useEffect, useState } from "react";
import { CopyIcon, HardDriveIcon, TrashIcon } from "lucide-react";
import { chooseDirectory } from "@/platform/desktop/choose-directory";
import { formatBytes } from "@/ui/format";
import {
  desktopStore,
  progressLabel,
  REMOVABLE_DRIVE_WARNING,
  useStoreStatus,
  type StoreProgress,
} from "../desktop-store";
import { createEngineApi } from "@/platform/engine";
import { Row, SettingsGroup } from "@/features/settings";
import { Button } from "@/ui/button";

const api = createEngineApi();

export function StoreSection() {
  const { status, supported, refresh } = useStoreStatus();
  const [progress, setProgress] = useState<StoreProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [moved, setMoved] = useState(false);
  const [copying, setCopying] = useState(false);
  const [copied, setCopied] = useState<string | undefined>(undefined);

  const copyStore = async () => {
    const chosen = await chooseDirectory({ title: "Choose where Telar should write the copy" });
    if (!("path" in chosen)) {
      if ("unavailable" in chosen) setFailure(chosen.unavailable);
      return;
    }
    setCopying(true);
    setFailure(undefined);
    setCopied(undefined);
    try {
      const destination = `${chosen.path.replace(/\/$/, "")}/telar-store-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      const { copy } = await api.copyStore(destination);
      setCopied(`Copied ${copy.files.toLocaleString()} files (${formatBytes(copy.bytes)}) to ${copy.root}.`);
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : "Telar could not write the copy.");
    } finally {
      setCopying(false);
    }
  };

  useEffect(() => desktopStore()?.onProgress(setProgress) ?? undefined, []);

  if (!supported) {
    return (
      <SettingsGroup title="Store">
        <Row icon={HardDriveIcon} label="Desktop app only" hint="This browser tab has no store of its own to move." />
      </SettingsGroup>
    );
  }

  const move = async () => {
    setFailure(undefined);
    const chosen = await chooseDirectory({ title: "Choose where Telar should keep its store" });
    if (!("path" in chosen)) {
      if ("unavailable" in chosen) setFailure(chosen.unavailable);
      return;
    }
    const store = desktopStore();
    if (!store) return;

    const checked = await store.preflight(chosen.path);
    if (!checked.ok) {
      setFailure(checked.message);
      return;
    }

    setBusy(true);
    setProgress(null);
    try {
      const outcome = await store.move(chosen.path);
      if (!outcome.ok) {
        setFailure(outcome.message);
        return;
      }
      setMoved(true);
      refresh();
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const removeOld = async () => {
    setBusy(true);
    try {
      const outcome = await desktopStore()?.removeOld();
      if (outcome && !outcome.ok) setFailure(outcome.message);
      refresh();
    } finally {
      setBusy(false);
    }
  };

  const keepOld = async () => {
    await desktopStore()?.keepOld();
    refresh();
  };

  const onVolume = Boolean(status?.volume);
  const where = status?.volume?.label ? `${status.volume.label} · ${status.path}` : status?.path;

  return (
    <SettingsGroup title="Store">
      <Row
        icon={HardDriveIcon}
        label="Location"
        hint={
          status?.pinnedByEnvironment
            ? `${status.path} (pinned by TELAR_HOME).`
            : moved
              ? "Moved. Takes effect on the next start; the old store stays on disk."
              : onVolume
                ? `${where} — on a drive. ${REMOVABLE_DRIVE_WARNING}`
                : where
        }
        {...(failure ? { error: failure } : {})}
        control={
          status?.pinnedByEnvironment ? null : (
            <span className="flex items-center gap-2">
              {busy ? <span className="text-xs text-muted-foreground">{progressLabel(progress) ?? "Working…"}</span> : null}
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void move()}>
                Move…
              </Button>
            </span>
          )
        }
      />
      <Row
        icon={CopyIcon}
        label="Safe copy"
        hint={
          copied
            ? copied
            : "History, settings and notes to a new folder. Checkouts and environments are re-made, not carried."
        }
        control={
          <Button size="sm" variant="outline" disabled={busy || copying} onClick={() => void copyStore()}>
            {copying ? "Copying…" : "Copy…"}
          </Button>
        }
      />
      {status?.retired ? (
        <Row
          icon={TrashIcon}
          label="Previous store"
          hint={
            status.retired.removable
              ? `${formatBytes(status.retired.bytes)} at ${status.retired.source}. The moved store is open; this copy can go.`
              : `${formatBytes(status.retired.bytes)} at ${status.retired.source}. Restart Telar first.`
          }
          control={
            <span className="flex items-center gap-2">
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void keepOld()}>
                Keep it
              </Button>
              <Button size="sm" variant="outline" disabled={busy || !status.retired?.removable} onClick={() => void removeOld()}>
                Remove
              </Button>
            </span>
          }
        />
      ) : null}
    </SettingsGroup>
  );
}
