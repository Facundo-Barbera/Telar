"use client";

/**
 * WHAT THIS CONVERSATION IS HOLDING FROM ITS PEERS — issue #723, retired to a
 * count by the session-tools audit.
 *
 * This row used to be a cadence picker: how often routine peer reports woke
 * the conversation. Reports never open a turn now — the engine holds them and
 * hands them over with the conversation's next turn, whatever starts it — so
 * there is nothing left to choose. What is left is the half that made a held
 * mailbox trustworthy: HOW MUCH IT IS HOLDING, because "held" and "lost" look
 * identical from outside it.
 *
 * IT POLLS, because a peer's report arriving writes nothing to THIS session's
 * journal. One small read on a ten-second clock, and only while the panel is
 * open.
 */
import { useEffect, useState } from "react";
import { InboxIcon } from "lucide-react";
import { PanelRow, PanelSectionLabel, type PanelTone } from "@/components/ui/panel";
import { createEngineApi } from "@/lib/engine/client";
import { LOCAL_HOST_ID } from "@/lib/hosts/book";
import { hostFetcher } from "@/lib/hosts/client";

/** The trailing count — only when something is held; nothing held is not a fact worth a number. */
export function heldLabel(held: number): string | undefined {
  return held > 0 ? `${held} held` : undefined;
}

export const HELD_DETAIL = "Reports never open a turn. They arrive with this conversation's next turn.";

/** The row, given its answer rather than fetching it, so a test can put a case to it. */
export function ReportCadenceView({ held }: { held: number }) {
  const waiting = heldLabel(held);
  const tone: PanelTone = waiting ? "info" : "none";
  return (
    <div className="flex flex-col">
      <PanelSectionLabel label="Reports from peers" />
      <PanelRow tone={tone} className="gap-2">
        <InboxIcon className="size-3 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-3xs text-muted-foreground">{HELD_DETAIL}</span>
        {waiting && <span className="shrink-0 font-mono text-3xs text-muted-foreground tabular-nums">{waiting}</span>}
      </PanelRow>
    </div>
  );
}

/**
 * THE READ. NOTHING AT ALL UNTIL THE FIRST ANSWER, and a failed read keeps the
 * last good one: "nothing held" invented from a dropped request is the one
 * wrong answer this row can give.
 */
function useHeld(sessionId: string | undefined, hostId: string | undefined, visible: boolean): number | undefined {
  const [held, setHeld] = useState<number>();
  useEffect(() => {
    if (!sessionId || !visible) return;
    let live = true;
    const api = createEngineApi(hostFetcher(hostId ?? LOCAL_HOST_ID));
    const tick = async () => {
      const status = await api.sessionReportWindow(sessionId).then(
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

export function ReportCadence({
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
  return <ReportCadenceView held={held} />;
}
