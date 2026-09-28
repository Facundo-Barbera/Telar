"use client";

/**
 * A COORDINATOR'S REACTIONS WHILE ITS COHORT WORKED, FOLDED.
 *
 * A fan-out used to leave a column of turns between the tasks going out and
 * the cohort's close: wakes, reports, a merge here and there, each a full turn.
 * The close is what the reader came for, so the turns between it and the
 * cohort's subscription fold into one line that says how many there were.
 *
 * THE BOUNDARIES ARE THE ENGINE'S. The close is the turn whose notification has
 * a `cohortId`, and the window opens at `cohortOpenedAt` (the cohort's own
 * `createdAt`). Nothing is read out of prose.
 *
 * WHAT NEVER FOLDS — the fold that was reverted in September hid completed
 * work, so the rule
 * is a list of what a person must see, and anything on it stays a row:
 * - the close itself, and the live turn;
 * - a turn the person wrote in, or one that did not simply complete;
 * - a turn that carries a result, a blocker, a task or a request, as its own
 *   notification or as an arrival hosted inside it;
 * - a turn that sent a result or a blocker, or answered a blocker;
 * - a turn the caller names in `keep`: one with any request, open or decided,
 *   and the newest answer, which a read receipt is about.
 */

import { useState, type ReactNode } from "react";
import { ChevronRightIcon } from "lucide-react";
import type { NotificationDetail } from "@telar/engine-client";
import type { JournalItem, JournalTurn } from "@/platform/engine";
import { cn } from "@/lib/utils";
import { ROW, tallyParts } from "@/features/transcript";

export type FoldTurn = Pick<JournalTurn, "runId" | "origin" | "state" | "acceptedAt" | "notification" | "agentIntent" | "items" | "failure" | "held">;

export type TranscriptSegment<T> = { kind: "turns"; turns: T[] } | { kind: "fold"; turns: T[]; cohortId: string; members: number };

const FOLDABLE_ORIGINS: ReadonlySet<JournalTurn["origin"]> = new Set(["session", "provider", "schedule"]);
const KEPT_INTENTS: ReadonlySet<string | undefined> = new Set(["result", "blocker", "task"]);

/** Every happening a notification carries, its lead included. */
function happenings(detail: NotificationDetail): Pick<NotificationDetail, "kind" | "intent" | "wakeKind" | "sessionId">[] {
  return [detail, ...(detail.entries ?? [])];
}

function mustSee(detail: NotificationDetail): boolean {
  return happenings(detail).some((each) => each.kind === "request" || each.wakeKind === "request_opened" || KEPT_INTENTS.has(each.intent));
}

/** A `sessions_send` this turn made, as `{ to, intent }`. */
function sends(items: readonly JournalItem[]): { to?: string; intent?: string }[] {
  return items.flatMap((item) => {
    const call = "call" in item.detail ? item.detail.call : undefined;
    if (!call || !/(^|__)sessions_send$/.test(call.name)) return [];
    const input = (call.input ?? {}) as { sessionId?: unknown; intent?: unknown };
    return [{ ...(typeof input.sessionId === "string" ? { to: input.sessionId } : {}), ...(typeof input.intent === "string" ? { intent: input.intent } : {}) }];
  });
}

function notificationsIn(turn: FoldTurn): NotificationDetail[] {
  const hosted = turn.items.flatMap((item) => (item.detail.type === "notification" ? [item.detail.notification] : []));
  return turn.notification ? [turn.notification, ...hosted] : hosted;
}

/**
 * THE TRANSCRIPT, CUT INTO RUNS OF ROWS AND FOLDS.
 *
 * Every turn comes back, in order, in exactly one segment. A fold is a run of
 * consecutive foldable turns inside one cohort's window; a kept turn in the
 * middle splits it, so what stays visible stays where it happened.
 */
export function foldCohortTurns<T extends FoldTurn>(
  turns: readonly T[],
  { activeRunId, keep = new Set() }: { activeRunId?: string; keep?: ReadonlySet<string> } = {},
): TranscriptSegment<T>[] {
  // Which close owns each turn: the first close after it whose window covers it.
  const owner = new Map<number, { cohortId: string; members: number }>();
  turns.forEach((close, at) => {
    const detail = close.notification;
    if (!detail?.cohortId || detail.cohortOpenedAt === undefined) return;
    const cohort = { cohortId: detail.cohortId, members: detail.entries?.length ?? 1 };
    for (let index = at - 1; index >= 0; index--) {
      const accepted = turns[index]!.acceptedAt;
      if (accepted === undefined || accepted <= detail.cohortOpenedAt) break;
      if (!owner.has(index)) owner.set(index, cohort);
    }
  });
  if (owner.size === 0) return turns.length === 0 ? [] : [{ kind: "turns", turns: [...turns] }];

  const blockedBy = new Set<string>();
  const foldable = turns.map((turn) => {
    const arrivals = notificationsIn(turn);
    for (const detail of arrivals) for (const each of happenings(detail)) if (each.intent === "blocker" && each.sessionId) blockedBy.add(each.sessionId);
    const sent = sends(turn.items);
    const answersBlocker = sent.some((send) => send.to !== undefined && blockedBy.has(send.to));
    for (const send of sent) if (send.to) blockedBy.delete(send.to);
    return (
      !turn.notification?.cohortId &&
      turn.runId !== activeRunId &&
      turn.state === "completed" &&
      !turn.failure &&
      !turn.held &&
      FOLDABLE_ORIGINS.has(turn.origin) &&
      !KEPT_INTENTS.has(turn.agentIntent) &&
      !turn.items.some((item) => item.detail.type === "user_message") &&
      !keep.has(turn.runId) &&
      !arrivals.some(mustSee) &&
      !answersBlocker &&
      !sent.some((send) => send.intent === "result" || send.intent === "blocker")
    );
  });

  const segments: TranscriptSegment<T>[] = [];
  turns.forEach((turn, index) => {
    const cohort = foldable[index] ? owner.get(index) : undefined;
    const open = segments.at(-1);
    if (cohort) {
      // The previous turn folded under this same close: the open fold is its.
      if (open?.kind === "fold" && foldable[index - 1] && owner.get(index - 1) === cohort) open.turns.push(turn);
      else segments.push({ kind: "fold", turns: [turn], ...cohort });
    } else if (open?.kind === "turns") open.turns.push(turn);
    else segments.push({ kind: "turns", turns: [turn] });
  });
  return segments;
}

/** "While 4 sessions worked · 3 updates · Ran command ×5 · Thought ×2". */
export function cohortFoldSummary(turns: readonly FoldTurn[], members: number): string {
  const work = turns.flatMap((turn) => turn.items.filter((item) => item.detail.type !== "notification" && item.detail.type !== "assistant_message"));
  return [
    `While ${members} session${members === 1 ? "" : "s"} worked`,
    `${turns.length} update${turns.length === 1 ? "" : "s"}`,
    ...tallyParts(work).slice(0, 3),
  ].join(" · ");
}

/** The fold's one line, and every turn it covers when opened — drawn by the caller exactly as they would be unfolded. */
export function CohortFold({ turns, members, children }: { turns: readonly FoldTurn[]; members: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mx-auto flex w-full max-w-[50rem] flex-col gap-2" data-cohort-fold={turns.length}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className={cn(ROW, "items-start text-muted-foreground hover:bg-muted/50")}
      >
        <ChevronRightIcon className={cn("mt-0.5 size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
        <span className="line-clamp-2 min-w-0">{cohortFoldSummary(turns, members)}</span>
      </button>
      {open && <div className="flex flex-col gap-8">{children}</div>}
    </div>
  );
}
