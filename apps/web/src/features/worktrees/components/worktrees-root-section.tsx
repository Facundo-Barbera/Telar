"use client";

import { useCallback, useEffect, useState } from "react";
import type { WorktreeMoveResult, WorktreesRoot } from "@telar/engine-client";
import { FolderGitIcon, MoveRightIcon } from "lucide-react";
import { chooseDirectory } from "@/lib/choose-directory";
import { createEngineApi } from "@/platform/engine/index";
import { REMOVABLE_DRIVE_WARNING } from "@/features/storage";
import { Button } from "@/components/ui/button";
import { Row } from "@/features/settings";

const api = createEngineApi();

export function worktreesRootHint(state: WorktreesRoot): string {
  if (state.kind === "unreadable") {
    return state.blocker ?? "Telar cannot read where worktrees belong, and will not guess. Choose a location again.";
  }
  if (state.kind === "absent") return state.blocker ?? `${state.root} is on a drive that is not connected.`;
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
