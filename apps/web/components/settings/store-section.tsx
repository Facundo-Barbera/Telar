"use client";

/**
 * WHERE TELAR KEEPS ITS STORE — issue #630.
 *
 * A thin presenter over the shell's store bridge; no engine call and no route
 * handler, because the location is decided before the engine exists and read
 * once at launch. Same arrangement as `updates-section.tsx`.
 *
 * TWO THINGS THIS PANE REFUSES TO DO, and both are about not overstating:
 *
 *   IT SAYS A RESTART IS NEEDED rather than implying the change took. The root
 *   is handed to both children at launch and the daemon holds its lock and its
 *   sqlite handles for its whole life, so a move genuinely does not apply until
 *   the next start — `PATCH /api/remote`'s `restartRequired` is the existing
 *   pattern and this matches it.
 *
 *   IT SHOWS THE DURABILITY SENTENCE BEFORE THE MOVE, not after. Somebody
 *   choosing to put their history on a bus-powered drive is entitled to know
 *   what they are accepting, and the honest version of that is narrow enough to
 *   fit in a paragraph (`REMOVABLE_DRIVE_WARNING`).
 *
 * AND THE OLD STORE IS NOT DELETED BY THE MOVE. Removing it is a second,
 * explicit press that the shell refuses until the new store has actually been
 * opened — which is what makes "verified" mean "a store Telar has run from"
 * rather than "bytes that compared equal".
 */

import { useEffect, useState } from "react";
import { HardDriveIcon, TrashIcon } from "lucide-react";
import { chooseDirectory } from "@/lib/choose-directory";
import { formatBytes } from "@/lib/format";
import {
  desktopStore,
  progressLabel,
  REMOVABLE_DRIVE_WARNING,
  useStoreStatus,
  type StoreProgress,
} from "@/lib/desktop-store";
import { Row, SettingsGroup } from "./settings-shell";
import { Button } from "@/components/ui/button";

export function StoreSection() {
  const { status, supported, refresh } = useStoreStatus();
  const [progress, setProgress] = useState<StoreProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [moved, setMoved] = useState(false);

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

    // Refused while they are still choosing, rather than after they have
    // committed to a copy: no room, a folder that already holds a store, the
    // wreckage of an interrupted move.
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
            ? `TELAR_HOME is set for this run, so Telar is using ${status.path} and will not move it.`
            : moved
              ? "Moved. Telar will use the new location the next time it starts — nothing has changed in this session, and your old store is still on disk."
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
      {status?.retired ? (
        <Row
          icon={TrashIcon}
          label="Previous store"
          hint={
            status.retired.removable
              ? `${formatBytes(status.retired.bytes)} at ${status.retired.source}. Telar has opened the moved store, so this copy can go.`
              : `${formatBytes(status.retired.bytes)} at ${status.retired.source}. Restart Telar first — the old store stays until the new one has actually been opened.`
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
