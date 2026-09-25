/**
 * engine protocol v2 — tasks: sub-agents and background work.
 *
 * THE STRUCTURAL DECISION THIS FILE EXISTS TO ENCODE: aggregation is a
 * PROJECTION over the session's one event stream, not a parallel universe
 * beside it.
 *
 * The frozen cockpit's fan-out feature owned its own storage, journal, event
 * bus, wake loop, sandbox and surface — which is exactly why it needed a whole
 * second rail to display, plus a third for ordinary sub-agents. t3 code does
 * the opposite and it is the best structural idea in its contract: there is no
 * fleet or workflow entity at all. Everything rides the same stream as `task.*`
 * events, and every surface (the roster, the "still working" pill) is a fold
 * over that one stream. One timeline component renders sub-agents and
 * background shells alike.
 *
 * THAT DECISION OUTLIVED THE FEATURE THAT MOTIVATED IT. #877 retired Warp, and
 * the linkage block it added here — `WarpLinkage`, `WarpPhase`, and an optional
 * `warp` on every `Task` — went with it. Nothing here has to shrink to notice:
 * the linkage was optional AS A BLOCK precisely so an ordinary sub-agent
 * carried none of it, so removing it removes a field and no structure.
 */
import { z } from "zod";
import { Id, Effort, ModelSelection, Timestamp, UsageSnapshot } from "./common";

/**
 * What kind of work a task is.
 *
 * A DENYLIST-SHAPED CLASSIFICATION, following t3 code, and the reason is
 * measured rather than theoretical: provider SDKs rename their agent-flavored
 * task types (`subagent`, `local_agent`, `local_workflow`, …) and t3 code's
 * comments record that an ALLOWLIST silently dropped real sub-agents the moment
 * a new name appeared. Anything not recognised as background is treated as an
 * agent, so a new agent type shows up unstyled rather than invisible.
 */
export const TaskKind = z.enum([
  /** A real sub-agent: its own context, its own turns. */
  "agent",
  /** A watch loop or long-running shell — work that continues after the turn
   *  that started it settles. This is why a session can be "still working"
   *  with no active turn. */
  "background",
]);
export type TaskKind = z.infer<typeof TaskKind>;

export const TaskState = z.enum([
  "pending",
  "running",
  /** Blocked on a request of its own. */
  "waiting",
  "completed",
  "failed",
  "stopped",
]);
export type TaskState = z.infer<typeof TaskState>;

/**
 * One sub-agent or background job.
 *
 * `kind`, `title` and `model` REPEAT ON EVERY task event, not just on
 * `task.started`. That is deliberate and copied from t3 code, whose
 * comment explains the failure it prevents: a client that joined a late
 * progress row to its start row could not do so once the start row had aged out
 * of retention, and the agent silently vanished from the roster. Repetition is
 * cheap; reconstructing identity from an absent row is impossible.
 */
export const Task = z.object({
  id: Id,
  sessionId: Id,
  /** The turn that launched it. A background task may OUTLIVE this turn — that
   *  is the definition of background — so a client must not assume the turn is
   *  still running because a task is. */
  runId: Id,
  kind: TaskKind,
  state: TaskState,
  /**
   * DETACHED FROM ITS TURN — it outlives the turn, whatever its kind.
   *
   * `kind` says what a task IS; this says how it was LAUNCHED. A sub-agent
   * spawned in the background is still an agent (its own context, its own
   * turns, an agent's row in the roster) — but like a background shell it
   * keeps running after the turn that started it ends. Mirrors the SDK's
   * `is_backgrounded`. Measured: every backgrounded Explore agent was swept
   * to "failed" the moment its turn ended, then kept reporting from inside a
   * red row. See `isBackgroundWork`.
   */
  backgrounded: z.boolean().optional(),
  /**
   * THE PROVIDER SAYS THIS IS NOT ACTIVITY — housekeeping it runs on its own
   * (a live-update watcher, a transcript-less task). Mirrors the SDK's
   * `ambient`, whose doc is the rule: "hosts should exclude them from
   * activity indicators". The row may still be shown; it never makes the
   * session read as busy. See `countsAsActivity`.
   */
  ambient: z.boolean().optional(),

  title: z.string().optional(),
  /** The agent's role/persona when the launcher named one. */
  role: z.string().optional(),
  model: ModelSelection.optional(),
  effort: Effort.optional(),

  startedAt: Timestamp,
  updatedAt: Timestamp,
  completedAt: Timestamp.optional(),

  /**
   * Parent task when this was launched from inside another agent. An agent
   * nested under an agent stays in the roster (it can outlive its parent); a
   * plain shell nested under an agent is that agent's internal business and a
   * client should keep it out of the parent timeline.
   */
  parentTaskId: Id.optional(),

  /** The provider's own task/tool-use handle, for correlation. */
  providerTaskId: z.string().min(1).optional(),

  /** Per-task usage, so a fan-out's cost can be attributed rather than only
   *  summed at the turn. */
  usage: UsageSnapshot.optional(),

  /** Terminal text the task returned — a sub-agent's report to its caller. */
  resultText: z.string().optional(),
  failure: z.string().optional(),
});
export type Task = z.infer<typeof Task>;

/**
 * A task as the WORKER knows it, before the engine stamps ownership on it.
 *
 * DERIVED FROM `Task` BY OMISSION rather than written out again, for the same
 * reason `ItemSeed` is a hand-written sibling of `Item` and has already drifted
 * from it once: the five omitted fields are exactly the ones a worker must not
 * mint. `sessionId` and `runId` are the engine's routing; `startedAt`,
 * `updatedAt` and `completedAt` are the engine's clock. A worker that could set
 * its own timestamps could order two tasks against a clock nobody else reads.
 */
export const TaskSeed = Task.omit({
  sessionId: true,
  runId: true,
  startedAt: true,
  updatedAt: true,
  completedAt: true,
});
export type TaskSeed = z.infer<typeof TaskSeed>;

/**
 * Whether a task outlives the turn that started it — the one question every
 * turn-end sweep asks. A background shell does by definition; a backgrounded
 * agent does by launch. Spelled once here so the driver's sweep, the store's
 * sweeps and the cockpit's "still working" chip cannot disagree.
 */
export function isBackgroundWork(task: Pick<Task, "kind" | "backgrounded">): boolean {
  return task.kind === "background" || task.backgrounded === true;
}

/**
 * Whether a task is work in progress that a person should see as activity.
 *
 * NARROWER THAN "NOT FINISHED". A `waiting` task (paused, or blocked on a
 * request of its own) is still alive in the process, but nothing is moving —
 * its row says paused, and a session badge saying busy over it contradicts
 * the row. An `ambient` task is the provider's housekeeping. Neither is
 * activity. Spelled once so the rail's fold and the composer's "still
 * working" chip count the same tasks.
 */
export function countsAsActivity(task: Pick<Task, "state" | "ambient">): boolean {
  return (task.state === "pending" || task.state === "running") && task.ambient !== true;
}

/**
 * An ending nobody stated: `completed`, with neither a result nor a failure.
 *
 * That is the shape of a row closed because the SDK's level signal stopped
 * listing it — it says the task is gone, not how it went. Its own
 * notification usually follows (the SDK says the level "in practice precedes"
 * the bookends), and when that one states `failed` or `stopped` it is the
 * better account. So "the first ending is the ending" yields for this shape
 * only; an explicit ending, or one that carries a word, is never rewritten.
 */
export function isUnstatedEnding(task: Pick<Task, "state" | "resultText" | "failure">): boolean {
  return task.state === "completed" && task.resultText === undefined && task.failure === undefined;
}

/**
 * Whether a session should read as "still working" when no turn is running.
 *
 * DERIVED HERE, IN THE CONTRACT, for the same reason `autoResolution` is: the
 * sidebar pill, the session list and the notification policy all need the same
 * answer, and three independent folds over task state is three answers that
 * disagree under load.
 *
 * "monitoring" is every live task that OUTLIVES ITS TURN — a watch loop, and a
 * sub-agent launched in the background too. This is only asked when no turn is
 * running, so a backgrounded agent here is one the turn already walked away
 * from: reading it as "working" showed a running clock over a session whose
 * turn had ended. A live agent that is NOT backgrounded outranks it.
 */
export function livenessOf(tasks: readonly Task[]): "working" | "monitoring" | null {
  let monitoring = false;
  for (const task of tasks) {
    if (!countsAsActivity(task)) continue;
    if (!isBackgroundWork(task)) return "working";
    monitoring = true;
  }
  return monitoring ? "monitoring" : null;
}
