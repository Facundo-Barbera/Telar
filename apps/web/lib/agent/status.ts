"use client";

/**
 * WHAT THE RAIL'S AGENT ROW SAYS UNDERNEATH ITS NAME (#539).
 *
 * ── WHY THIS IS NOT ON THE LIVE READ ────────────────────────────────────────
 * The rail already polls `/v2/sessions/live` and already takes `agent: { enabled }`
 * off it, so the obvious move is to widen that object. It is the wrong one, and
 * the reason is the conditional read rather than the bytes: that route answers
 * `{ unchanged: true }` whenever `sessionsRevision` has not moved, and the
 * Agent's own turns move NOTHING in the sessions store. A status folded in there
 * would freeze on whatever it said when some unrelated session was last written
 * — "working" for an hour after the turn ended — and the only fix would be to
 * make the Agent bump the sessions revision, which is the conditional read
 * defeating itself.
 *
 * So the row asks `/api/agent` on its own small cadence, and ONLY while it is
 * drawn: the entry is gated on the flag from the live read, which is still the
 * thing that decides whether the row exists at all.
 *
 * ── ONE MAC, THE ONE BEING LOOKED AT ────────────────────────────────────────
 * Like the row itself. There is no fan-out here: a status for a Mac whose rail
 * you are not looking at is a request nobody reads.
 */

import { useEffect, useState } from "react";
import type { AgentState } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import { hostFetcher, LOCAL_HOST_ID } from "@/lib/hosts/client";

/**
 * HOW OFTEN THE ROW ASKS. Three seconds is the phone's own cadence and is well
 * inside the time it takes to notice a row changed — this is a status line on a
 * sidebar entry, not a progress bar.
 */
export const AGENT_STATUS_POLL_MS = 3_000;

export type AgentStatus = {
  /** What the line reads. Always a sentence; never empty. */
  label: string;
  /** `working` and `waiting` are the two a person may want to act on, so the
   *  row can mark them without re-parsing the label. */
  tone: "idle" | "working" | "waiting";
};

/**
 * THE STATUS LINE, from the Agent's own state.
 *
 * THE ORDER IS THE PRIORITY, and it is not alphabetical. A parked approval
 * outranks everything: it is the only one of these a person can DO something
 * about, and a row that said "working" while the Agent sat waiting for an answer
 * would be the machine hiding the one thing that needed them. Then working, then
 * what the last turn cost, then plain idle.
 *
 * A pure function of the state, so a test holds the ladder rather than a render.
 */
export function agentStatus(state: AgentState | undefined): AgentStatus {
  if (!state) return { label: "…", tone: "idle" };
  // WAITING BEATS RUNNING, and the engine agrees: `running` is false while a
  // turn is parked, which is why `request` sits beside it rather than inside.
  if (state.request) return { label: "waiting for you", tone: "waiting" };
  if (state.running) return { label: "working", tone: "working" };
  if (state.queued > 0) return { label: `${state.queued} queued`, tone: "working" };
  const tokens = state.lastUsage?.usage?.total;
  // ABSENT IS NOT ZERO. A provider that reported no usage leaves this out, and
  // "0 tokens last turn" would be a claim nobody made.
  if (tokens !== undefined) return { label: `${tokens.toLocaleString("en-US")} tokens last turn`, tone: "idle" };
  return { label: "idle", tone: "idle" };
}

/**
 * Poll one Mac's Agent state.
 *
 * NOTHING IS FETCHED WHEN THE ROW IS NOT DRAWN, and that is the MOUNT's job
 * rather than a flag here: the rail only renders `AgentEntryLive` when the live
 * read's `enabled` flag said the Mac has an Agent, so a cockpit whose Agent is
 * switched off never runs this hook at all. A flag would have been a second
 * copy of `agentEntryShown` in a worse place.
 */
export function useAgentStatus(hostId: string = LOCAL_HOST_ID): AgentState | undefined {
  const [state, setState] = useState<AgentState>();

  useEffect(() => {
    let cancelled = false;
    const api = createEngineApi(hostFetcher(hostId));
    const read = async () => {
      try {
        const answer = await api.agent();
        if (!cancelled) setState(answer.agent);
      } catch {
        // A MAC THAT DID NOT ANSWER KEEPS WHAT IS ON SCREEN. The row is still
        // worth pressing, and the next ask is three seconds away.
      }
    };
    // Deferred a tick like every other loader here — setting state from an
    // effect BODY is the cascade this app's lint forbids.
    const first = window.setTimeout(() => void read(), 0);
    const timer = window.setInterval(() => void read(), AGENT_STATUS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [hostId]);

  return state;
}
