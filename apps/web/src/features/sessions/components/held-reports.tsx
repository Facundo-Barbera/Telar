"use client";

import { useState } from "react";
import { InboxIcon } from "lucide-react";
import { PanelRow, PanelSectionLabel } from "@/ui/panel";
import { usePoll } from "@/ui/hooks/use-poll";
import { createEngineApi } from "@/platform/engine";
import { LOCAL_HOST_ID } from "@telar/engine-client";
import { hostFetcher } from "@/platform/engine/host-client";

export function heldLabel(held: number): string | undefined {
  return held > 0 ? `${held} held` : undefined;
}

export const HELD_DETAIL = "Reports never open a turn. They arrive with this conversation's next turn.";

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

function useHeld(sessionId: string | undefined, hostId: string | undefined, visible: boolean): number | undefined {
  const [held, setHeld] = useState<number>();
  usePoll(
    async (signal) => {
      if (!sessionId) return;
      const status = await createEngineApi(hostFetcher(hostId ?? LOCAL_HOST_ID))
        .sessionHeldReports(sessionId)
        .catch(() => undefined);
      if (!signal.aborted && status !== undefined) setHeld(status.held);
    },
    sessionId && visible ? 10_000 : null,
    { key: `${sessionId}:${hostId}` },
  );
  return held;
}

export function HeldReports({
  sessionId,
  hostId,
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
