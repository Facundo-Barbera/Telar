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
import { CopyIcon, HardDriveIcon, TrashIcon } from "lucide-react";
import { chooseDirectory } from "@/lib/choose-directory";
import { formatBytes } from "@/lib/format";
import {
  desktopStore,
  progressLabel,
  REMOVABLE_DRIVE_WARNING,
  useStoreStatus,
  type StoreProgress,
} from "@/lib/desktop-store";
import { createEngineApi } from "@/lib/engine/client";
import { Row, SettingsGroup } from "./settings-shell";
import { Button } from "@/components/ui/button";

const api = createEngineApi();

export function StoreSection() {
  const { status, supported, refresh } = useStoreStatus();
  const [progress, setProgress] = useState<StoreProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [moved, setMoved] = useState(false);
  const [copying, setCopying] = useState(false);
  const [copied, setCopied] = useState<string | undefined>(undefined);

  /** The safe copy (#665). It re-measures nothing and says what it wrote,
   *  because "did that do anything" is the question a silent success leaves. */
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
      // A NEW FOLDER INSIDE THE ONE THEY PICKED, because the engine refuses a
      // destination that already exists — and a folder picker can only ever
      // return one that does. Naming it after the moment keeps two copies from
      // colliding, which is the other thing that refusal would catch.
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
      {/*
        A COPY SOMEBODY CAN OPEN WITHOUT RISK — issue #665, and the button whose
        ABSENCE was the finding. There was no sanctioned way to look at a store
        without opening the live one, so every question of the form "what is
        actually in there" became a hand-run query against the one
        irreplaceable artifact — which is how #646's figures came to be
        corrected twice.

        IT READS THE STORE AND WRITES ELSEWHERE. The database goes through
        `VACUUM INTO`, so the copy is consistent rather than pages from
        different moments, and the original is not rewritten. The destination
        must not already exist.

        IT IS SMALLER THAN THE STORAGE PANE'S TOTAL, deliberately: checkouts,
        Python environments and toolchains are re-makeable and are most of the
        bytes, so they are not carried. The hint says so, because a copy that
        silently weighed a tenth of the figure above would read as a failure.
      */}
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
