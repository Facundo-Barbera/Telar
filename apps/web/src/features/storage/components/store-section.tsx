"use client";

import { CopyIcon, HardDriveIcon, TrashIcon } from "lucide-react";
import { formatBytes } from "@/ui/format";
import { progressLabel, REMOVABLE_DRIVE_WARNING, useStoreStatus } from "../desktop-store";
import { useStoreActions } from "../hooks/use-store-actions";
import { Row, SettingsGroup } from "@/features/settings";
import { Button } from "@/ui/button";

export function StoreSection() {
  const { status, supported, refresh } = useStoreStatus();
  const { progress, busy, failure, moved, copying, copied, copyStore, move, removeOld, keepOld } = useStoreActions(refresh);

  if (!supported) {
    return (
      <SettingsGroup title="Store">
        <Row icon={HardDriveIcon} label="Desktop app only" hint="This browser tab has no store of its own to move." />
      </SettingsGroup>
    );
  }

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
