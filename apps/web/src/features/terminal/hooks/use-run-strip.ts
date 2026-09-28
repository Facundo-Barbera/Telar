"use client";

import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { hostFetcher, LOCAL_HOST_ID } from "@/platform/engine/host-client";
import { runAsChip } from "../reveal";
import { createRunApi } from "../run/api";
import { isOpenTerminal } from "../run/presentation";
import { useRunStatusFeed } from "../run/status-stream";
import type { RunConfigurationView, RunView } from "../run/types";
import { runShells, upsertRunShell, type TerminalWorkspace } from "../workspace";

/** The session's runs in the strip: one status read, then events. Pinned to one Mac, since session ids are per host. */
export function useRunStrip(sessionId: string | undefined, hostId: string | undefined, setWorkspace: Dispatch<SetStateAction<TerminalWorkspace>>) {
  const runApi = useMemo(() => createRunApi(hostFetcher(hostId ?? LOCAL_HOST_ID)), [hostId]);
  const runs = useRunStatusFeed({ sessionId: sessionId ?? "", ...(hostId ? { hostId } : {}), api: runApi });
  const [configs, setConfigs] = useState<RunConfigurationView[]>();

  // Read once, for the chips' glyphs.
  useEffect(() => {
    if (!sessionId) return;
    let alive = true;
    void runApi
      .configurations(sessionId)
      .then((answer) => {
        if (alive) setConfigs(answer.configurations);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [runApi, sessionId]);

  // Every open run gets a chip, and every existing chip stays current; a chip is never removed here.
  useEffect(() => {
    const status = runs.status;
    if (!status) return;
    // An older paired engine has no `terminals` list.
    const terminals = status.terminals ?? [];
    const task = window.setTimeout(() => {
      setWorkspace((current) => {
        let next = current;
        for (const shell of runShells(next)) {
          const view = terminals.find((run) => run.runId === shell.run!.runId);
          if (view) next = upsertRunShell(next, runAsChip(view));
        }
        for (const run of [...terminals].reverse()) if (isOpenTerminal(run)) next = upsertRunShell(next, runAsChip(run));
        return next;
      });
    }, 0);
    return () => window.clearTimeout(task);
  }, [runs.status, setWorkspace]);

  const runsById = useMemo(() => {
    const map = new Map<string, RunView>();
    for (const run of runs.status?.terminals ?? []) map.set(run.runId, run);
    return map;
  }, [runs.status]);

  /** Stop or restart, then one re-read so the pressed button does not look unpressed. Not a poll. */
  const actOnRun = (work: () => Promise<unknown>) => {
    void work()
      .catch(() => undefined)
      .finally(() => runs.refresh());
  };

  return { runApi, runs, configs, runsById, actOnRun };
}
