import type { Chat } from "@/lib/store";

// THE ROLLBACK PLANNER (message-lifecycle STEP 4) — pure: chat in, plan out,
// no I/O. The route acts on the plan; this function owns every refusal that
// can be decided from the record alone, so the tests can enumerate them
// without a server.
//
// `toTurn` is the number of turns KEPT. The discarded range is
// anchors[toTurn..]; the fork point is the KEPT turn's own tail — "fork at
// the kept turn's last chain entry, whatever it is" (sdk.d.ts's general rule,
// probe-verified). The drop guard (`resumeDropsTurn`) is included ONLY when
// exactly one turn is discarded and its prompt uuid exists: the option
// declares ONE dropped turn, so any wider rollback runs the documented
// unguarded truncation instead.
//
// Codex is EASIER: thread/rollback takes numTurns, the anchor INDEX is the
// whole address, and the child-per-turn lifecycle means the anchor array is
// 1:1 with Codex turns. `provider` on the anchors routes the plan; a range
// that spans both providers cannot be truncated by one mechanism and is
// refused in one sentence.

export type RollbackPlan =
  | { kind: "claude"; resumeSessionAt: string; resumeDropsTurn?: string }
  | { kind: "codex"; numTurns: number }
  | { kind: "refused"; reason: string };

export function planRollback(
  chat: Pick<Chat, "turns" | "turnAnchors">,
  toTurn: number,
): RollbackPlan {
  if (!Number.isInteger(toTurn) || toTurn < 0) {
    return { kind: "refused", reason: "That isn't a place this conversation has." };
  }
  if (toTurn === 0) {
    // Chat.id IS the SDK session id; "before the beginning" needs a new id,
    // which renames the session out from under everything. The UI offers
    // "New session with this text" instead — this refusal is the backstop.
    return { kind: "refused", reason: "The first message can't be removed — start a new session with it instead." };
  }
  if (toTurn >= chat.turns) {
    return { kind: "refused", reason: "There's nothing after that point to remove." };
  }
  const anchors = chat.turnAnchors;
  if (!anchors || anchors.length < chat.turns) {
    // A transcript that predates anchors makes no promise it cannot keep —
    // same rule that hides the pencil on legacy chats.
    return { kind: "refused", reason: "This session predates editing history." };
  }
  const discarded = anchors.slice(toTurn);
  const kept = anchors[toTurn - 1];
  if (!kept) return { kind: "refused", reason: "This session predates editing history." };

  const providers = new Set(discarded.map((a) => a.provider));
  if (providers.size > 1) {
    return {
      kind: "refused",
      reason: "These messages came from different agents and can't be removed together.",
    };
  }
  const provider = discarded[0]?.provider;
  if (provider === "codex") {
    return { kind: "codex", numTurns: discarded.length };
  }
  if (!kept.tail) {
    // No fork point — the kept turn never recorded its chain tail (a crash
    // before teardown, or a pre-anchor turn upgraded mid-history).
    return { kind: "refused", reason: "This session predates editing history." };
  }
  const single = discarded.length === 1 ? discarded[0] : null;
  return {
    kind: "claude",
    resumeSessionAt: kept.tail,
    // The guard names the ONE dropped turn's prompt. A hidden settle-append
    // has no prompt; dropping it runs unguarded, which the option's own
    // docs bless.
    ...(single?.prompt ? { resumeDropsTurn: single.prompt } : {}),
  };
}
