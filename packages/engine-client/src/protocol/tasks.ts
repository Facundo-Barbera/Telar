/**
 * vNext engine protocol v2 — tasks: sub-agents, background work, and Warp.
 *
 * THE STRUCTURAL DECISION THIS FILE EXISTS TO ENCODE: aggregation is a
 * PROJECTION over the session's one event stream, not a parallel universe
 * beside it.
 *
 * Telar's Ultras (renamed Warp — the set of parallel threads held under tension
 * on a loom) own their own storage, journal, event bus, wake loop, sandbox and
 * surface: ten modules under `packages/core/src/ultra/`. None of it is on the
 * session stream, which is exactly why the frozen cockpit needed a whole second
 * rail to display it, plus a third for ordinary sub-agents.
 *
 * t3 code does the opposite and it is the best structural idea in its contract:
 * there is no fleet or workflow entity at all. Fan-out rides the same stream as
 * `task.*` events carrying agent linkage — `agentId`, `parentAgentId`,
 * `workflowName`, `phaseIndex`. Every surface (the roster, the progress tree,
 * the "still working" pill) is a fold over that one stream. One timeline
 * component renders sub-agents, warp agents and background shells alike.
 *
 * The Warp SCRIPT-AUTHORING surface — `agent()`, `parallel()`, `pipeline()`,
 * `phase()` — is genuinely good and does not change. What changes is where its
 * observations go.
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
 * A phase in a Warp run. Declared up front by the script's `meta.phases` so a
 * client can draw the whole progress tree before any agent has finished,
 * instead of growing it row by row and reflowing.
 */
export const WarpPhase = z.object({
  title: z.string().min(1),
  detail: z.string().optional(),
});
export type WarpPhase = z.infer<typeof WarpPhase>;

/**
 * Warp-specific linkage, present only on tasks that belong to a warp run.
 *
 * OPTIONAL AS A BLOCK, and that is the whole point of the design: an ordinary
 * sub-agent carries none of it and is still the same `Task`. Nothing has to
 * know about warps to render one.
 */
export const WarpLinkage = z.object({
  /** The run this task belongs to. Distinct from the script's name so two
   *  concurrent runs of one script do not merge. */
  warpRunId: Id,
  warpName: z.string().min(1),
  /** Position in the declared phase list, and its title repeated so a fold can
   *  label a row without holding the whole run. */
  phaseIndex: z.number().int().nonnegative().optional(),
  phaseTitle: z.string().min(1).optional(),
  /** Ordinal within its phase — the "agent 3 of 8" a progress tree shows. */
  agentIndex: z.number().int().nonnegative().optional(),
  /** Which attempt this is, when the script retries. */
  attempt: z.number().int().nonnegative().optional(),
});
export type WarpLinkage = z.infer<typeof WarpLinkage>;

/**
 * One sub-agent or background job.
 *
 * `kind`, `title`, `model` AND the linkage fields REPEAT ON EVERY task event,
 * not just on `task.started`. That is deliberate and copied from t3 code, whose
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

  warp: WarpLinkage.optional(),

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
 * Whether a session should read as "still working" when no turn is running.
 *
 * DERIVED HERE, IN THE CONTRACT, for the same reason `autoResolution` is: the
 * sidebar pill, the session list and the notification policy all need the same
 * answer, and three independent folds over task state is three answers that
 * disagree under load.
 *
 * "monitoring" is reserved for the case where the ONLY live work is background
 * watching. Any live agent outranks it — a fan-out mid-flight reads as working
 * even if a log tail is also running.
 */
export function livenessOf(tasks: readonly Task[]): "working" | "monitoring" | null {
  let monitoring = false;
  for (const task of tasks) {
    if (task.state !== "pending" && task.state !== "running" && task.state !== "waiting") continue;
    if (task.kind === "agent") return "working";
    monitoring = true;
  }
  return monitoring ? "monitoring" : null;
}
