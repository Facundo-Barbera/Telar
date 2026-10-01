"use client";

import { useCallback, useEffect, useState } from "react";
import type { WorktreesRoot } from "@telar/engine-client";
import { FolderGitIcon } from "lucide-react";
import { chooseDirectory } from "@/platform/desktop/choose-directory";
import { createEngineApi } from "@/platform/engine";
import { REMOVABLE_DRIVE_WARNING } from "@/features/storage";
import { Button } from "@/ui/button";
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
  return `New worktrees are made in ${state.root}.`;
}

export const ROTATIONAL_WARNING = "This is a spinning disk, so sessions here will be slow.";

const LOCATION_INFO = "Changing it moves nothing already made; move those from the summary below. The store itself cannot live on an external drive.";

export function WorktreesRootRow({ onChanged }: { onChanged?: () => void }) {
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
      onChanged?.();
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

  const custom = state !== undefined && state.kind !== "default";

  return (
    <Row
      icon={FolderGitIcon}
      label="Location"
      hint={
        state ? (
          <>
            {worktreesRootHint(state)}
            {state.rotational ? <span className="block text-warning">{ROTATIONAL_WARNING}</span> : null}
          </>
        ) : (
          "Where new worktrees are made."
        )
      }
      info={state?.label ? `${REMOVABLE_DRIVE_WARNING} ${LOCATION_INFO}` : LOCATION_INFO}
      {...(failure ? { error: failure } : {})}
      control={
        <span className="flex items-center gap-2">
          {custom ? (
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
  );
}
