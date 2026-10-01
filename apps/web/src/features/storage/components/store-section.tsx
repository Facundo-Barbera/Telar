"use client";

import { CopyIcon, HardDriveIcon, TrashIcon } from "lucide-react";
import { formatBytes } from "@/ui/format";
import { REMOVABLE_DRIVE_WARNING, useStoreStatus } from "../desktop-store";
import { useStoreActions } from "../hooks/use-store-actions";
import { Row, SettingsGroup } from "@/features/settings";
import { Button } from "@/ui/button";

export function StoreSection() {
  const { status, supported, refresh } = useStoreStatus();
  const { busy, failure, copying, copied, copyStore, removeOld, keepOld } = useStoreActions(refresh);

  if (!supported) {
    return (
      <SettingsGroup title="Store">
        <Row icon={HardDriveIcon} label="Desktop app only" hint="This browser tab has no store of its own." />
      </SettingsGroup>
    );
  }

  const retiredAt = status?.retired
    ? `${status.retired.bytes === undefined ? "" : `${formatBytes(status.retired.bytes)} at `}${status.retired.source}.`
    : "";
  const where = status?.volume?.label ? `${status.volume.label} · ${status.path}` : status?.path;

  return (
    <SettingsGroup title="Store">
      <Row
        icon={HardDriveIcon}
        label="Location"
        hint={status?.pinnedByEnvironment ? `${status.path} (pinned by TELAR_HOME).` : where}
        {...(status?.volume ? { info: REMOVABLE_DRIVE_WARNING } : {})}
        {...(failure ? { error: failure } : {})}
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
              ? `${retiredAt} The moved store is open; this copy can go.`
              : `${retiredAt} Restart Telar first.`
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
