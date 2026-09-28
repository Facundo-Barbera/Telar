"use client";

import { useEffect, useState } from "react";
import { createEngineApi, type JournalTurn } from "@/platform/engine";
import { hostFetcher } from "@/platform/engine/host-client";
import { dispatchedFrom } from "../dispatch";
import type { SessionDirectory } from "../components/dispatch-block";

const EMPTY: SessionDirectory = new Map();

export function useSessionDirectory(hostId: string, turns: readonly JournalTurn[]): SessionDirectory {
  const tasked = [...new Set(turns.flatMap((turn) => dispatchedFrom(turn.items)))].sort().join(",");
  const [directory, setDirectory] = useState<SessionDirectory>(EMPTY);
  useEffect(() => {
    if (!tasked) return;
    let stale = false;
    const wanted = new Set(tasked.split(","));
    createEngineApi(hostFetcher(hostId))
      .liveSessions({ all: true })
      .then((list) => {
        if (stale) return;
        setDirectory(new Map(list.sessions.filter((session) => wanted.has(session.id)).map((session) => [session.id, { title: session.title, projectId: session.projectId }])));
      }, () => {});
    return () => {
      stale = true;
    };
  }, [hostId, tasked]);
  return directory;
}
