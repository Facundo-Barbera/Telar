import {
  assignmentsOf,
  countsAsActivity,
  isBackgroundWork,
  livenessOf,
  waitingToolOf,
  type AssignmentTurn,
  type EngineRequest,
  type InboxPolicy,
  type Item,
  type Session,
  type SessionAssignment,
  type Subscription,
  type Task,
  type Turn,
  type WaitingOn,
} from "@telar/engine-client";
import type { Kernel } from "../../platform/kernel";
import { newestFirst, parseSession, sessionMetadataFile } from "./metadata";
import { isResultTurn } from "./records";
import { rowIsShelved } from "./session-index";

type ActivityDeps = {
  readQueue: (sessionId: string) => { turns: Turn[] };
  liveRequests: (sessionId: string) => ReadonlyMap<string, EngineRequest>;
  peekRun: (sessionId: string, runId: string) => Item[];
  readTasks: (sessionId: string) => Map<string, Task>;
  require: (sessionId: string) => Session;
  subscriptionsOf: (sessionId: string) => readonly Subscription[];
  nextWake: (sessionId: string) => number | undefined;
};

function lastEndedTurn(turns: readonly Turn[]): Turn | undefined {
  let latest: Turn | undefined;
  for (const turn of turns) {
    if (turn.completedAt === undefined) continue;
    if (latest?.completedAt === undefined || turn.completedAt >= latest.completedAt) latest = turn;
  }
  return latest;
}

// By sequence, not clock, so a read receipt can only move forward.
function lastResultTurn(turns: readonly Turn[]): Turn | undefined {
  let latest: Turn | undefined;
  for (const turn of turns) {
    if (!isResultTurn(turn)) continue;
    if (latest === undefined || turn.sequence > latest.sequence) latest = turn;
  }
  return latest;
}

/** What each session is doing, folded from its queue, open requests, tasks, subscriptions and schedules. */
export class SessionActivity {
  constructor(
    private readonly kernel: Kernel,
    private readonly deps: ActivityDeps,
  ) {}

  of(session: Session): Session {
    return this.from(session, this.deps.readQueue(session.id).turns);
  }

  /**
   * The fold over turns the caller already holds. `blocked` outranks `working`;
   * then queued, background tasks, waiting on another session, scheduled, idle.
   */
  from(session: Session, turns: Turn[]): Session {
    const ended = lastEndedTurn(turns);
    const result = lastResultTurn(turns);
    const base: Session = {
      ...session,
      ...(ended?.completedAt === undefined ? {} : { lastTurnEndedAt: ended.completedAt }),
      ...(result === undefined ? {} : { lastTurnSequence: result.sequence }),
      ...(ended?.state === "failed" ? { lastTurnFailed: true } : {}),
    };
    const settledRuns = new Set(turns.filter((turn) => turn.state === "completed" || turn.state === "failed" || turn.state === "stopped" || turn.state === "discarded").map((turn) => turn.runId));
    const open = [...this.deps.liveRequests(session.id).values()].filter((request) => request.state === "open" && !settledRuns.has(request.runId));
    if (open.length > 0) {
      return { ...base, activity: "blocked", activityAt: Math.min(...open.map((request) => request.openedAt)) };
    }
    const running = turns.find((turn) => turn.state === "running");
    if (running) {
      const waitingOn = this.onlyWaitingOn(session.id, running.runId);
      return {
        ...base,
        activity: "working",
        activityAt: running.startedAt ?? running.updatedAt,
        ...(waitingOn ? { activityDetail: { kind: "tool" as const, waitingOn } } : {}),
      };
    }
    // A held message is not queued: nothing is about to pick it up.
    const waiting = turns.find((turn) => (turn.state === "queued" && !turn.held) || turn.state === "claimed");
    if (waiting) return { ...base, activity: "queued", activityAt: waiting.acceptedAt };
    const tasks = [...this.deps.readTasks(session.id).values()];
    const live = livenessOf(tasks);
    if (live) {
      const counted = tasks.filter(countsAsActivity);
      const since = Math.min(...counted.map((task) => task.startedAt));
      if (live === "working") return { ...base, activity: "working", activityAt: since };
      const background = counted.filter(isBackgroundWork);
      return {
        ...base,
        activity: "monitoring",
        activityAt: since,
        activityDetail: { kind: "background", tasks: background.length, agents: background.filter((task) => task.kind === "agent").length },
      };
    }
    const awaited = this.deps.subscriptionsOf(session.id).flatMap((subscription) => {
      const busySince = this.busySince(subscription.targetSessionId);
      return busySince === undefined ? [] : [{ subscription, busySince }];
    });
    if (awaited.length > 0) {
      const longest = awaited.reduce((a, b) => (b.busySince < a.busySince ? b : a));
      const title = this.deps.require(longest.subscription.targetSessionId).title;
      return {
        ...base,
        activity: "waiting",
        activityAt: Math.min(...awaited.map((each) => each.subscription.createdAt)),
        activityDetail: { kind: "session", sessionId: longest.subscription.targetSessionId, ...(title ? { title } : {}), sessions: awaited.length },
      };
    }
    const wake = this.deps.nextWake(session.id);
    if (wake !== undefined) return { ...base, activity: "scheduled", activityDetail: { kind: "schedule", at: wake } };
    return { ...base, activity: "idle" };
  }

  /**
   * One pass over the live sessions, reading each queue once for both the
   * activity and the assignments. `only` narrows it to rows already chosen.
   */
  foldLive(only?: Iterable<string>): { sessions: Session[]; assignments: Record<string, SessionAssignment[]> } {
    const sessions: Session[] = [];
    const assignments: Record<string, SessionAssignment[]> = {};
    for (const id of only ?? this.kernel.executionStore.sessionIds()) {
      const stored = this.kernel.readDocument(sessionMetadataFile(this.kernel.paths, id));
      if (stored === undefined) continue;
      let record: Session;
      try {
        record = parseSession(stored);
      } catch {
        continue;
      }
      if (record.state !== "active") continue;
      const turns = this.deps.readQueue(id).turns;
      sessions.push(this.from(structuredClone(record), turns));
      const held = assignmentsOf(turns as AssignmentTurn[]);
      if (held.length > 0) assignments[id] = held;
    }
    sessions.sort(newestFirst);
    return { sessions, assignments };
  }

  /** Which rows the rail would draw, decided from the index alone. */
  shelf(inbox: InboxPolicy, all: boolean, keep?: string): { chosen: Set<string>; settledCount: number } {
    const at = { now: this.kernel.now(), autoSettleAfterHours: inbox.autoSettleAfterHours };
    const chosen = new Set<string>();
    let settledCount = 0;
    for (const row of this.kernel.executionStore.liveSessionRows()) {
      if (row.id !== keep && rowIsShelved(row, at)) {
        settledCount += 1;
        if (!all) continue;
      }
      chosen.add(row.id);
    }
    return { chosen, settledCount };
  }

  // Only when every open row is a recognised wait; a cold JSON session answers nothing rather than parse.
  private onlyWaitingOn(sessionId: string, runId: string): WaitingOn | undefined {
    const open = this.deps.peekRun(sessionId, runId).filter((item) => item.status === "inProgress");
    if (open.length === 0) return undefined;
    const waits = open.map((item) => waitingToolOf(item.detail));
    return waits.every((wait) => wait !== undefined) ? waits[0] : undefined;
  }

  // Not `from` on the target: that reads subscriptions, and two mutual subscribers would recurse.
  private busySince(sessionId: string): number | undefined {
    let turns: Turn[];
    try {
      if (this.deps.require(sessionId).state !== "active") return undefined;
      turns = this.deps.readQueue(sessionId).turns;
    } catch {
      return undefined;
    }
    const open = turns.filter((turn) => turn.state === "running" || turn.state === "claimed" || turn.state === "steering" || (turn.state === "queued" && !turn.held));
    if (open.length > 0) return Math.min(...open.map((turn) => turn.startedAt ?? turn.acceptedAt));
    const tasks = [...this.deps.readTasks(sessionId).values()].filter(countsAsActivity);
    if (tasks.length > 0) return Math.min(...tasks.map((task) => task.startedAt));
    return undefined;
  }
}
