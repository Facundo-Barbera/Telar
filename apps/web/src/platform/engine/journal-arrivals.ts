import type { JournalItem, JournalTurn } from "@/platform/engine/journal";

/**
 * Moves each passive arrival into the turn running when it was accepted, or,
 * if the session was idle, to the head of the next turn. Expects turns in start
 * order; returns copies of hosts, never the projector's cached folds.
 */
export function hostPassiveArrivals(turns: readonly JournalTurn[]): JournalTurn[] {
  const guestsOf = new Map<string, JournalTurn[]>();
  const hosted = new Set<string>();
  for (const [index, turn] of turns.entries()) {
    const arrived = turn.acceptedAt;
    if (turn.agentDelivery !== "passive" || !turn.notification || arrived === undefined) continue;
    const host = turns
      .slice(0, index)
      .findLast(
        (candidate) =>
          candidate.agentDelivery !== "passive" &&
          !candidate.decidedForBackgroundWork &&
          candidate.startedAt !== undefined &&
          candidate.startedAt <= arrived &&
          (candidate.endedAt === undefined ? candidate.state === "claimed" || candidate.state === "running" : candidate.endedAt >= arrived),
      ) ?? turns.slice(index + 1).find((candidate) => candidate.agentDelivery !== "passive" && !candidate.decidedForBackgroundWork);
    if (!host) continue;
    guestsOf.set(host.runId, [...(guestsOf.get(host.runId) ?? []), turn]);
    hosted.add(turn.runId);
  }
  if (hosted.size === 0) return [...turns];
  return turns
    .filter((turn) => !hosted.has(turn.runId))
    .map((turn) => {
      const guests = guestsOf.get(turn.runId);
      if (!guests) return turn;
      const items = [...turn.items];
      for (const guest of guests) {
        const row = arrivalRow(guest);
        const at = items.findIndex((item) => item.startedAt > row.startedAt);
        items.splice(at === -1 ? items.length : at, 0, row);
      }
      return { ...turn, items };
    });
}

/** The arrival's own notification row, or one built from the turn when the
 *  page did not carry it. */
function arrivalRow(guest: JournalTurn): JournalItem {
  const own = guest.items.find((item) => item.detail.type === "notification");
  if (own) return own;
  const at = guest.acceptedAt ?? 0;
  return {
    id: `notification_${guest.runId}`,
    runId: guest.runId,
    sessionId: guest.notification!.fetch?.sessionId ?? "",
    status: "completed",
    title: guest.notification!.summary,
    detail: { type: "notification", notification: guest.notification! },
    startedAt: at,
    completedAt: at,
    openedBy: 0,
    streamedText: "",
  };
}
