/**
 * WARP RUNNER — turns a compiled script into tasks on the session's own stream.
 *
 * THE STRUCTURAL POINT, and the whole reason this is a rewrite rather than a
 * port: the legacy harness owned storage, a journal, an event bus and a wake
 * loop, and none of it was on the session stream — which is exactly why the
 * frozen cockpit needed a second rail to show a run and a third for ordinary
 * sub-agents. Here a run IS a task and its agents ARE tasks:
 *
 *   · THE RUN is a `background` Task whose id is the warpRunId. That is not a
 *     borrowed shape — the contract defines `background` as "work that continues
 *     after the turn that started it settles. This is why a session can be
 *     'still working' with no active turn", which is a warp run exactly. So
 *     `livenessOf()` reports the session as working while a run is live without
 *     being taught anything about warps.
 *   · EACH AGENT is an `agent` Task with `parentTaskId` pointing at the run and
 *     `warp` linkage on it. One timeline renders sub-agents, warp agents and
 *     background shells alike, and `warp_status`/`warp_inspect` are folds over
 *     the same rows the pane draws — so the directing agent and the human cannot
 *     be looking at different truths.
 *
 * NOTHING HERE SPAWNS ANYTHING ITSELF. `spawn` is injected, so this file is
 * fully testable without a provider, an SDK or a process — which is what lets
 * the concurrency, the phase bookkeeping, the stop semantics and the dead-agent
 * rule be pinned by tests that run in milliseconds and cost nothing.
 */

import type { TaskSeed, TaskState, UsageSnapshot } from "@telar/engine-client";
import type { CompiledWarpScript } from "./sandbox";
import type { WarpAgentOpts, WarpMetaPhase, WarpSurface } from "./surface";

/**
 * THE RUN-LIFETIME BACKSTOP, and it is not a budget.
 *
 * A script is code the model wrote; `while (true) agent(...)` is one typo away
 * at all times. This is the runaway brake — set far above any real fan-out so
 * it never shapes a legitimate run, and low enough that a loop stops before it
 * empties an account.
 */
const LIFETIME_AGENT_CAP = 1000;

/**
 * How many children may be in flight at once.
 *
 * A PLACEHOLDER, DELIBERATELY, and this comment is the honest version of a
 * number that would otherwise look derived. Claude Code's own harness caps at
 * `min(16, cpus - 2)`, but its sub-agents are IN-PROCESS — measured, by watching
 * the process table through a four-agent fan-out: zero new processes appeared.
 * A Warp child is not that. It goes through the Agent SDK, which spawns
 * `pathToClaudeCodeExecutable`, so every concurrent agent is a real `claude`
 * process on the user's machine.
 *
 * Four is a guess pending a measurement of one real child's resident size. When
 * that number exists, this becomes derived; until then it is a number somebody
 * chose, and saying so is better than implying arithmetic that never happened.
 */
const DEFAULT_CONCURRENCY = 4;

/**
 * A control signal, NOT an agent failure.
 *
 * The carve-out this class exists for: `parallel` and `pipeline` swallow an
 * ordinary failure into `null`, so one casualty does not lose a fan-out. A stop
 * and the lifetime backstop must NOT be swallowed — they have to unwind the
 * whole script, or a stopped run would quietly keep spawning the next stage.
 */
export class WarpStopped extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "WarpStopped";
  }
}

export type WarpAgentOutcome = {
  /** The child's final text, when it answered in prose. */
  text?: string;
  /** The validated object, when the call named a `schema`. */
  structured?: unknown;
  usage?: UsageSnapshot;
  /** Present when the child died. Becomes the task's `failure` and the call's
   *  `null` — see the dead-agent rule. */
  failure?: string;
};

/**
 * A MAILBOX, NOT A STREAM, and the difference is a deadlock.
 *
 * The obvious shape is an `AsyncIterable` the child awaits — and it cannot work:
 * a child that iterates to exhaustion never returns, the runner only closes the
 * queue after the child returns, and the two wait on each other for ever. Found
 * by writing the test, not by reasoning about it.
 *
 * The layering that does work puts the decision where the knowledge is. Only the
 * spawn implementation knows when a turn has SETTLED — that is the SDK's news,
 * not the runner's — so the runner offers a mailbox and the child drains it at
 * its own turn boundaries: anything pending becomes another turn, nothing
 * pending means finish. Termination stays entirely in the hands of the thing
 * that can observe it.
 */
export type WarpSteer = {
  /** Everything queued right now, removed. Non-blocking, never throws. */
  drain: () => string[];
  /** How many are waiting, for a child that wants to look before it drains. */
  readonly pending: number;
};

/** How a child actually gets run. Injected. */
export type WarpSpawn = (input: {
  taskId: string;
  prompt: string;
  opts: WarpAgentOpts;
  signal: AbortSignal;
  steer: WarpSteer;
}) => Promise<WarpAgentOutcome>;

export type WarpRunnerDeps = {
  spawn: WarpSpawn;
  /** Publishes a task seed. The engine stamps ownership and timestamps — a
   *  worker that minted its own could order two tasks against a clock nobody
   *  else reads. */
  emit: (seed: TaskSeed) => void;
  newId: (prefix: string) => string;
  concurrency?: number;
};

export type WarpAgentRecord = {
  taskId: string;
  label: string;
  phaseTitle?: string;
  phaseIndex?: number;
  agentIndex: number;
  state: TaskState;
  prompt: string;
  opts: WarpAgentOpts;
  resultText?: string;
  failure?: string;
  usage?: UsageSnapshot;
};

export type WarpSnapshot = {
  runId: string;
  name: string;
  state: TaskState;
  phases: WarpMetaPhase[];
  agents: WarpAgentRecord[];
  logs: string[];
  result?: unknown;
  failure?: string;
};

export type WarpRun = {
  runId: string;
  name: string;
  phases: WarpMetaPhase[];
  /** Settles when the script does. Never rejects — a failed run is a snapshot
   *  with a `failure`, because the launcher already ended its turn and has
   *  nowhere to catch a rejection. */
  done: Promise<WarpSnapshot>;
  stop: (reason?: string) => void;
  /** Injects a follow-up into a LIVE child. `false` when that agent has already
   *  settled — refused by name rather than dropped, so a directing agent learns
   *  it was too late instead of believing it landed. */
  send: (taskId: string, message: string) => boolean;
  snapshot: () => WarpSnapshot;
};

/** The runner's side of a child's mailbox. `closed` is what makes a late
 *  `warp_send` a refusal the caller can see rather than a message that goes
 *  nowhere. */
class SteerBox {
  private readonly buffer: string[] = [];
  private closed = false;

  push(message: string): boolean {
    if (this.closed) return false;
    this.buffer.push(message);
    return true;
  }

  close(): void {
    this.closed = true;
    this.buffer.length = 0;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** The view handed to the child: it may read, never close. Bound to the box
   *  explicitly — inside the returned literal `this` is the literal, and a
   *  getter that read it would have reported an empty mailbox for ever. */
  view(): WarpSteer {
    const box = this;
    return {
      drain: () => box.buffer.splice(0, box.buffer.length),
      get pending() {
        return box.buffer.length;
      },
    };
  }
}

/** Admits `limit` at a time. FIFO, so a fan-out's rows settle in roughly the
 *  order a reader watched them queue. */
function gate(limit: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async function admit<T>(work: () => Promise<T>): Promise<T> {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await work();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

const labelFor = (prompt: string, opts: WarpAgentOpts): string =>
  opts.label ?? (prompt.length <= 48 ? prompt : `${prompt.slice(0, 47)}…`);

export function createWarpRunner(deps: WarpRunnerDeps) {
  const admit = gate(Math.max(1, deps.concurrency ?? DEFAULT_CONCURRENCY));

  return function start(
    script: CompiledWarpScript,
    /**
     * `instanceId` IS REQUIRED, and that is the contract talking rather than
     * ceremony: a Task's `model` is a `ModelSelection`, which is "which login,
     * and which model on it" — not a bare string. A warp child runs as the
     * session's own login, so the caller always knows it, and a row that named a
     * model without naming whose account ran it would be unattributable.
     */
    options: { instanceId: string; args?: unknown; runId?: string },
  ): WarpRun {
    const runId = options.runId ?? deps.newId("warp");
    const name = script.meta.name;
    const phases = script.meta.phases ?? [];
    const agents: WarpAgentRecord[] = [];
    const logs: string[] = [];
    const steers = new Map<string, SteerBox>();
    const controller = new AbortController();

    let runState: TaskState = "running";
    let stopReason: string | null = null;
    let currentPhase: string | undefined;
    let result: unknown;
    let failure: string | undefined;

    const snapshot = (): WarpSnapshot => ({
      runId,
      name,
      state: runState,
      phases,
      agents: agents.map((agent) => ({ ...agent })),
      logs: [...logs],
      ...(result === undefined ? {} : { result }),
      ...(failure ? { failure } : {}),
    });

    /** The run's own row. `background` because it outlives the turn that started
     *  it, which is the contract's own definition of the kind. */
    const emitRun = (state: TaskState, extra: Partial<TaskSeed> = {}): void => {
      deps.emit({ id: runId, kind: "background", state, title: name, ...extra });
    };

    const phaseIndexOf = (title: string | undefined): number | undefined => {
      if (!title) return undefined;
      const index = phases.findIndex((phase) => phase.title === title);
      return index >= 0 ? index : undefined;
    };

    const emitAgent = (record: WarpAgentRecord, state: TaskState): void => {
      /**
       * THE LINKAGE REPEATS ON EVERY EMISSION, not just the first. The contract
       * says why, copied from t3 code's own hard-won comment: a client that
       * joined a late row to its start row could not once the start row aged out
       * of retention, and the agent silently vanished from the roster.
       */
      deps.emit({
        id: record.taskId,
        kind: "agent",
        state,
        title: record.label,
        parentTaskId: runId,
        // ALWAYS PRESENT, because the login is always known even when the
        // script named no model — absent `model` inside it is the honest
        // "inherited the session's", not "unknown".
        model: {
          instanceId: options.instanceId,
          ...(record.opts.model ? { model: record.opts.model } : {}),
          ...(record.opts.effort ? { effort: record.opts.effort } : {}),
        },
        ...(record.opts.effort ? { effort: record.opts.effort } : {}),
        ...(record.usage ? { usage: record.usage } : {}),
        ...(record.resultText ? { resultText: record.resultText } : {}),
        ...(record.failure ? { failure: record.failure } : {}),
        warp: {
          warpRunId: runId,
          warpName: name,
          agentIndex: record.agentIndex,
          ...(record.phaseIndex === undefined ? {} : { phaseIndex: record.phaseIndex }),
          ...(record.phaseTitle ? { phaseTitle: record.phaseTitle } : {}),
        },
      });
    };

    const guardLive = (): void => {
      if (stopReason) throw new WarpStopped(stopReason);
    };

    const agent = async (prompt: string, opts: WarpAgentOpts = {}): Promise<unknown> => {
      guardLive();
      if (agents.length >= LIFETIME_AGENT_CAP) {
        throw new WarpStopped(`this run reached the ${LIFETIME_AGENT_CAP}-agent lifetime backstop and was stopped`);
      }

      const phaseTitle = opts.phase ?? currentPhase;
      const record: WarpAgentRecord = {
        taskId: deps.newId("task"),
        label: labelFor(prompt, opts),
        agentIndex: agents.length,
        state: "pending",
        prompt,
        opts,
        ...(phaseTitle ? { phaseTitle } : {}),
        ...(phaseIndexOf(phaseTitle) === undefined ? {} : { phaseIndex: phaseIndexOf(phaseTitle) }),
      };
      agents.push(record);
      // ANNOUNCED AS `pending` BEFORE THE GATE, so a reader sees the queue depth
      // rather than a fan-out that appears four rows at a time.
      emitAgent(record, "pending");

      return admit(async () => {
        // Re-checked inside the gate: a stop that arrives while this was queued
        // must not spawn the child it was waiting to spawn.
        if (stopReason) {
          record.state = "stopped";
          emitAgent(record, "stopped");
          throw new WarpStopped(stopReason);
        }
        record.state = "running";
        emitAgent(record, "running");

        const steer = new SteerBox();
        steers.set(record.taskId, steer);
        try {
          const outcome = await deps.spawn({
            taskId: record.taskId,
            prompt,
            opts,
            signal: controller.signal,
            steer: steer.view(),
          });
          if (outcome.usage) record.usage = outcome.usage;
          if (outcome.failure) {
            record.state = "failed";
            record.failure = outcome.failure;
            emitAgent(record, "failed");
            // THE DEAD-AGENT RULE: `null`, not a throw. One casualty must not
            // lose a fan-out, and `.filter(Boolean)` is the documented idiom.
            return null;
          }
          record.state = "completed";
          if (outcome.text) record.resultText = outcome.text;
          emitAgent(record, "completed");
          return outcome.structured !== undefined ? outcome.structured : (outcome.text ?? null);
        } catch (error) {
          if (error instanceof WarpStopped) {
            record.state = "stopped";
            emitAgent(record, "stopped");
            throw error;
          }
          record.state = "failed";
          record.failure = error instanceof Error ? error.message : String(error);
          emitAgent(record, "failed");
          return null;
        } finally {
          // CLOSED HERE, ALWAYS. A child whose steer queue stayed open would
          // wait for input that can no longer arrive; this is what keeps
          // termination deterministic once steering exists.
          steer.close();
          steers.delete(record.taskId);
        }
      });
    };

    const surface: WarpSurface = {
      agent,
      parallel: async (thunks) =>
        Promise.all(
          thunks.map(async (thunk) => {
            try {
              return await thunk();
            } catch (error) {
              if (error instanceof WarpStopped) throw error;
              return null;
            }
          }),
        ),
      pipeline: async (items, ...stages) =>
        Promise.all(
          items.map(async (item, index) => {
            let carried: unknown = item;
            for (const stage of stages) {
              try {
                carried = await (stage as (a: unknown, b: unknown, c: number) => unknown)(carried, item, index);
              } catch (error) {
                if (error instanceof WarpStopped) throw error;
                // A throwing stage drops THIS item and skips its remaining
                // stages; the other items keep flowing.
                return null;
              }
            }
            return carried;
          }),
        ),
      phase: (title) => {
        currentPhase = title;
      },
      log: (message) => {
        logs.push(message);
      },
      args: options.args,
    };

    emitRun("running");

    const done = script
      .run(surface)
      .then((value) => {
        result = value;
        runState = stopReason ? "stopped" : "completed";
      })
      .catch((error: unknown) => {
        if (error instanceof WarpStopped) {
          runState = "stopped";
          failure = error.reason;
        } else {
          runState = "failed";
          failure = error instanceof Error ? error.message : String(error);
        }
      })
      .then(() => {
        for (const queue of steers.values()) queue.close();
        steers.clear();
        emitRun(runState, {
          ...(failure ? { failure } : {}),
          ...(typeof result === "string" ? { resultText: result } : {}),
        });
        return snapshot();
      });

    return {
      runId,
      name,
      phases,
      done,
      snapshot,
      stop: (reason = "stopped by request") => {
        if (stopReason) return;
        stopReason = reason;
        controller.abort(reason);
        for (const queue of steers.values()) queue.close();
      },
      send: (taskId, message) => {
        const queue = steers.get(taskId);
        if (!queue || queue.isClosed) return false;
        return queue.push(message);
      },
    };
  };
}
