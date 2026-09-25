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
import type { WorktreeMoveResult, WorktreesRoot } from "@telar/engine-client";
import { FolderGitIcon, MoveRightIcon } from "lucide-react";
import { chooseDirectory } from "@/lib/choose-directory";
import { createEngineApi } from "@/lib/engine/client";
import { REMOVABLE_DRIVE_WARNING } from "@/lib/desktop-store";
import { Button } from "@/components/ui/button";
import { Row } from "./settings-shell";

const api = createEngineApi();

/**
 * The row's sentence, per state. Exported because each branch is a claim worth
 * pinning by itself — a hint that quietly stopped saying "already cut" would be
 * the setting over-promising, and nothing else would catch it.
 */
export function worktreesRootHint(state: WorktreesRoot): string {
  if (state.kind === "unreadable") {
    return state.blocker ?? "Telar cannot read where worktrees belong, and will not guess. Choose a location again.";
  }
  if (state.kind === "absent") return state.blocker ?? `${state.root} is on a drive that is not connected.`;
  /**
   * THE PLATFORM THAT CANNOT ANSWER — issue #665, and it deliberately does not
   * borrow `absent`'s sentence. "Plug it back in" would be wrong half the time
   * and unfalsifiable the other half; a person looking at a connected drive
   * being told to connect it trusts the next message less.
   */
  if (state.kind === "unverifiable") {
    return state.blocker ?? `${state.root} is on a drive this build cannot check. Make sure it is connected, or choose a location on this machine's own disk.`;
  }
  if (state.kind === "default") {
    return `${state.root}, beside the store.`;
  }
  return `${state.root}${state.label ? ` on ${state.label}` : ""}. Existing worktrees stay where they are. ${
    state.label ? REMOVABLE_DRIVE_WARNING : ""
  }`.trim();
}

/** Rows, not a group: they sit inside Storage's Worktrees group. */
export function WorktreesRootRows() {
  const [state, setState] = useState<WorktreesRoot>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [outcome, setOutcome] = useState<WorktreeMoveResult>();

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

  const move = async () => {
    setBusy(true);
    setFailure(undefined);
    setOutcome(undefined);
    try {
      setOutcome((await api.moveWorktrees()).move);
    } catch (cause) {
      // The refusal a person most often meets is "a session is still working",
      // and it is the engine's sentence rather than one composed here.
      setFailure(cause instanceof Error ? cause.message : "The checkouts could not be moved.");
    } finally {
      setBusy(false);
    }
  };

  const moved = state !== undefined && state.kind !== "default";

  return (
    <>
      <Row
        icon={FolderGitIcon}
        label="Location"
        hint={state ? worktreesRootHint(state) : "Where new worktrees are made."}
        info="Worktrees can be recreated, so an external drive can hold them; the store itself cannot live there."
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
      {/* Only once the root has moved: before that there is nowhere to move
          them to. It never forces a worktree git refuses to move. */}
      {moved ? (
        <Row
          icon={MoveRightIcon}
          label="Move existing worktrees"
          hint={outcome?.summary ?? "Recreates each one at the new location. One with uncommitted changes stays put until committed."}
          control={
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void move()}>
              {busy ? "Moving…" : "Move"}
            </Button>
          }
        />
      ) : null}
    </>
  );
}
