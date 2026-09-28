"use client";

import { useCallback, useMemo, useState } from "react";
import { createJournalProjector, hostPassiveArrivals, isActiveTurn, isCompacting, taskRoster } from "@/platform/engine";
import type { PanelTab, TaskFocus } from "@/features/panel";
import { questionFields } from "@/features/composer";
import { actionableRequests } from "../failed-turn-recovery";
import { processToReveal, stillWorking } from "../background-presence";
import type { useSessionSync } from "./use-session-sync";

/** The folded transcript and what the cockpit reads off it: the live turn, open requests, and which agent the panel should focus. */
export function useTranscriptModel(sessionId: string | undefined, sync: ReturnType<typeof useSessionSync>, showPanelTab: (tab: PanelTab) => void) {
  const { turns, items, events, tasks, requests } = sync;
  const [projectTranscript] = useState(createJournalProjector);
  // A peer's passive report is drawn inside the turn it arrived during.
  const transcript = useMemo(
    () => (sessionId ? hostPassiveArrivals(projectTranscript(turns, items, events, tasks)) : []),
    [sessionId, turns, items, events, tasks, projectTranscript],
  );
  const roster = useMemo(() => taskRoster(tasks, transcript.flatMap((turn) => turn.tasks)), [tasks, transcript]);
  /** Set by pressing an agent's chip; the nonce makes a second press on the same agent a second request. */
  const [focusedTask, setFocusedTask] = useState<TaskFocus>();
  const showAgent = useCallback(
    (taskId: string) => {
      setFocusedTask((current) => ({ id: taskId, nonce: (current?.nonce ?? 0) + 1 }));
      showPanelTab("agents");
    },
    [showPanelTab],
  );
  // With no single process to open, an earlier focus is dropped so the tab arrives with every row closed.
  const showProcesses = useCallback(() => {
    const id = processToReveal(tasks);
    setFocusedTask((current) => (id ? { id, nonce: (current?.nonce ?? 0) + 1 } : undefined));
    showPanelTab("processes");
  }, [tasks, showPanelTab]);
  const active =
    transcript.find((turn) => turn.state === "claimed" || turn.state === "running") ?? transcript.find((turn) => isActiveTurn(turn.state) && !turn.held);
  const compacting = isCompacting(active);
  const openRequests = useMemo(() => actionableRequests(requests, transcript), [requests, transcript]);
  const composerQuestion = useMemo(() => openRequests.find((request) => questionFields(request).length > 0), [openRequests]);
  const newestUsage = [...transcript].reverse().find((turn) => turn.usage)?.usage;
  // Background work outlives its turn, so it is counted over every task, with the rail's own predicate.
  const backgroundTasks = stillWorking(tasks).length;
  return { transcript, roster, focusedTask, showAgent, showProcesses, active, compacting, openRequests, composerQuestion, newestUsage, backgroundTasks };
}
