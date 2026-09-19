"use client";

/**
 * WHERE SESSION CHECKOUTS GO — issue #642 part 2.
 *
 * THE ASYMMETRY IS THE WHOLE ARGUMENT, and it is written into this pane rather
 * than left in a commit message. Checkouts are **reproducible**: the engine
 * re-cuts one from the base commit it recorded, so with only these on an
 * external drive Telar still starts up completely without it — rail, history,
 * pairings all present, and only the checkouts missing. With the WHOLE store
 * out (#630) it cannot start at all. On the Mac this was measured on, the
 * reproducible part is 12 GB of 13.
 *
 * NO RESTART, AND THAT IS A FINDING RATHER THAN AN OVERSIGHT. #630's store move
 * genuinely cannot apply until the next launch — the root is handed to both
 * children at start and the daemon holds its lock and its sqlite handles for
 * its whole life. This one is consulted at exactly one moment, planning where a
 * new checkout lands, so it applies to the next cut. Printing `restartRequired`
 * here out of symmetry would cost somebody a restart they do not need.
 *
 * AND CHANGING IT MOVES NOTHING. Checkouts already cut keep working exactly
 * where they are, because every operation on one addresses it by the absolute
 * path recorded on its session. The row says so, because a setting that
 * silently left 12 GB behind would be read as a promise it did not keep.
 */

import { useCallback, useEffect, useState } from "react";
import type { WorktreesRoot } from "@telar/engine-client";
import { FolderGitIcon } from "lucide-react";
import { chooseDirectory } from "@/lib/choose-directory";
import { createEngineApi } from "@/lib/engine/client";
import { REMOVABLE_DRIVE_WARNING } from "@/lib/desktop-store";
import { Button } from "@/components/ui/button";
import { Row, SettingsGroup } from "./settings-shell";

const api = createEngineApi();

/**
 * The row's sentence, per state. Exported because each branch is a claim worth
 * pinning by itself — a hint that quietly stopped saying "already cut" would be
 * the setting over-promising, and nothing else would catch it.
 */
export function worktreesRootHint(state: WorktreesRoot): string {
  if (state.kind === "unreadable") {
    return state.blocker ?? "Telar cannot read where session checkouts belong, and will not guess. Choose a location again.";
  }
  if (state.kind === "absent") return state.blocker ?? `${state.root} is on a drive that is not connected.`;
  if (state.kind === "default") {
    return `${state.root} — beside everything else Telar keeps. Checkouts are re-cut from the commit each session recorded, so they are the one thing here that comes back.`;
  }
  return `${state.root}${state.label ? ` on ${state.label}` : ""}. New checkouts go here; the ones already cut stay where they are and keep working. ${
    state.label ? REMOVABLE_DRIVE_WARNING : ""
  }`.trim();
}

export function WorktreesRootSection() {
  const [state, setState] = useState<WorktreesRoot>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      setState((await api.worktreesRoot()).worktreesRoot);
    } catch {
      setFailure("The engine did not answer.");
    }
  }, []);

  useEffect(() => {
    const task = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(task);
  }, [load]);

  const save = async (root: string | null) => {
    setBusy(true);
    setFailure(undefined);
    try {
      setState((await api.setWorktreesRoot(root)).worktreesRoot);
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : "That folder could not be used for session checkouts.");
    } finally {
      setBusy(false);
    }
  };

  const choose = async () => {
    const chosen = await chooseDirectory({ title: "Choose where Telar should keep its session checkouts" });
    if (!("path" in chosen)) {
      if ("unavailable" in chosen) setFailure(chosen.unavailable);
      return;
    }
    await save(chosen.path);
  };

  const moved = state !== undefined && state.kind !== "default";

  return (
    <SettingsGroup
      title="Session checkouts"
      description="Telar re-cuts a checkout from the commit its session recorded, so these are the one thing it keeps that comes back. With only them on an external drive, Telar still starts without it — with the whole store out, it cannot start at all."
    >
      <Row
        icon={FolderGitIcon}
        label="Location"
        hint={state ? worktreesRootHint(state) : "Where new session checkouts are made."}
        {...(failure ? { error: failure } : {})}
        control={
          <span className="flex items-center gap-2">
            {moved ? (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void save(null)}>
                Use default
              </Button>
            ) : null}
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void choose()}>
              Change…
            </Button>
          </span>
        }
      />
    </SettingsGroup>
  );
}
