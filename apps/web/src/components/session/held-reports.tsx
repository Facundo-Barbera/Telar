"use client";

import { useEffect, useState } from "react";
import { InboxIcon } from "lucide-react";
import { PanelRow, PanelSectionLabel } from "@/components/ui/panel";
import { createEngineApi } from "@/lib/engine/client";
import { LOCAL_HOST_ID } from "@telar/engine-client";
import { hostFetcher } from "@/lib/hosts/client";

/** The trailing count — only when something is held; nothing held is not a fact worth a number. */
export function heldLabel(held: number): string | undefined {
  return held > 0 ? `${held} held` : undefined;
}

export const HELD_DETAIL = "Reports never open a turn. They arrive with this conversation's next turn.";

/** The row, given its answer rather than fetching it, so a test can put a case to it. */
export function HeldReportsView({ held }: { held: number }) {
  const waiting = heldLabel(held);
  return (
    <div className="flex flex-col">
      <PanelSectionLabel label="Reports from peers" />
      <PanelRow className="gap-2">
        <InboxIcon className="size-3 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-3xs text-muted-foreground">{HELD_DETAIL}</span>
        {waiting && <span className="shrink-0 font-mono text-3xs text-muted-foreground tabular-nums">{waiting}</span>}
      </PanelRow>
    </div>
  );
}

/** Polls, because a peer's report writes nothing to this session's journal.
 *  A failed read keeps the last good count rather than inventing zero. */
function useHeld(sessionId: string | undefined, hostId: string | undefined, visible: boolean): number | undefined {
  const [held, setHeld] = useState<number>();
  useEffect(() => {
    if (!sessionId || !visible) return;
    let live = true;
    const api = createEngineApi(hostFetcher(hostId ?? LOCAL_HOST_ID));
    const tick = async () => {
      const status = await api.sessionHeldReports(sessionId).then(
        (value) => value,
        () => undefined,
      );
      if (live && status !== undefined) setHeld(status.held);
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 10_000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [sessionId, hostId, visible]);
  return held;
}

export function HeldReports({
  sessionId,
  hostId,
  /** False while the panel is behind another tab — nothing polls off screen. */
  visible = true,
}: {
  sessionId?: string;
  hostId?: string;
  visible?: boolean;
}) {
  const held = useHeld(sessionId, hostId, visible);
  if (!sessionId || held === undefined) return null;
  return <HeldReportsView held={held} />;
}
