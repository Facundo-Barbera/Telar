"use client";

// THE GOD-VIEW HANDOFF (docs/loom-model.md §5's "make this real" moment) and
// everything downstream of it: the loom this session started, its live state,
// the durable inline transcript rows one per transition, and the aggregate pill
// the header shows.
//
// The handoff itself is set by the session's SSE reducer the instant
// mcp__loom__start_loom's tool_result lands, which is why `setHandoff` is
// returned rather than owned privately — that result arrives on the session's
// wire, not this subscriber's.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WorkUnitState } from "@telar/core";
import type { LoomEventRow, LoomTone, PillLoom } from "@/components/session/session-loom";
import { shortId } from "@/lib/format";

// Map a real WorkUnitState to the loom pill/row urgency tone (accent only) and a
// human verb. blocked/failed/halted demand the human (amber + pulse); ready /
// needs-review / done are the green human-touchpoints; everything else weaves.
export function loomTone(s: WorkUnitState | null | undefined): LoomTone {
  if (s === "blocked" || s === "failed" || s === "halted") return "blocked";
  if (s === "ready" || s === "needs-review" || s === "done") return "ready";
  return "weaving";
}

export function loomVerb(s: WorkUnitState | null | undefined): string {
  switch (s) {
    case "blocked":
      return "Loom parked";
    case "ready":
      return "Loom ready";
    case "needs-review":
      return "Loom needs review";
    case "done":
      return "Loom done";
    case "failed":
      return "Loom failed";
    case "halted":
      return "Loom halted";
    default:
      return "Loom weaving";
  }
}

export function useLoomHandoff({
  initialLoomId,
  sessionTitle,
}: {
  /** Seeded from the persisted chat so the pill survives a refresh. */
  initialLoomId: string | undefined;
  /** Fallback pill title until the loom's own stream reports one. */
  sessionTitle: string;
}) {
  const [handoff, setHandoff] = useState<{ loomId: string; url: string } | null>(
    initialLoomId ? { loomId: initialLoomId, url: `/looms/${initialLoomId}` } : null,
  );
  // `live` is the latest state/title from the loom's own event stream; `events`
  // is the durable in-stream record appended on each transition.
  const [live, setLive] = useState<{ title: string; state: WorkUnitState } | null>(null);
  const [events, setEvents] = useState<LoomEventRow[]>([]);

  // Loom-notify (replaces the old persistent "Loom started" banner): tail THIS
  // session's loom event stream so the aggregate pill reflects the loom's real
  // state and each transition lands as a durable inline transcript row.
  // Durable-minimum only — state word + title + short id + god-view — no
  // thread/gate detail (the loom UI is still being shaped).
  const loomId = handoff?.loomId;
  const loomUrl = handoff?.url;
  const lastStateRef = useRef<WorkUnitState | null>(null);
  const seqRef = useRef(0);
  useEffect(() => {
    if (!loomId) return;
    lastStateRef.current = null;
    const url = loomUrl ?? `/looms/${loomId}`;
    const es = new EventSource(`/api/looms/${encodeURIComponent(loomId)}/events`);
    const onRun = (e: MessageEvent) => {
      let loom: { state?: WorkUnitState; title?: unknown };
      try {
        loom = JSON.parse(e.data);
      } catch {
        return;
      }
      const state = loom?.state;
      if (!state) return;
      const title = typeof loom.title === "string" && loom.title ? loom.title : shortId(loomId);
      setLive({ title, state });
      // Append an inline row only on a genuine state change (the connect-time
      // snapshot seeds the first row; later transitions each add one).
      if (lastStateRef.current !== state) {
        lastStateRef.current = state;
        const seq = seqRef.current++;
        setEvents((prev) => [
          ...prev,
          {
            id: `le${seq}`,
            loomId: shortId(loomId),
            title,
            verb: loomVerb(state),
            tone: loomTone(state),
            url,
          },
        ]);
      }
    };
    es.addEventListener("run", onRun as EventListener);
    es.addEventListener("end", () => es.close());
    return () => es.close();
  }, [loomId, loomUrl]);

  // The aggregate looms pill's data — one loom per session in practice (the
  // persisted Chat.loomId is single), modelled as an array so N looms roll up
  // cleanly if that ever changes. Tone follows the live state; title/state fall
  // back to sensible defaults before the first event lands.
  const pillLooms: PillLoom[] = useMemo(() => {
    if (!handoff) return [];
    return [
      {
        key: handoff.loomId,
        id: shortId(handoff.loomId),
        title: live?.title ?? sessionTitle,
        tone: loomTone(live?.state),
        stateWord: live?.state ?? "weaving",
        url: handoff.url,
      },
    ];
  }, [handoff, live, sessionTitle]);

  // Stable, so a transcript memo can depend on it without re-deriving per render.
  const dismissEvent = useCallback(
    (id: string) => setEvents((previous) => previous.filter((item) => item.id !== id)),
    [],
  );

  return { handoff, setHandoff, events, dismissEvent, pillLooms };
}
