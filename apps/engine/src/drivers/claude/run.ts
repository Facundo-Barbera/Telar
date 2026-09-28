import crypto from "node:crypto";
import { BROWSER_BRIEFING } from "../../domains/browser";
import { RUN_BRIEFING } from "../../run/briefing";
import { isBackgroundWork, claudeCompactionEnv, type ItemDetail, type TaskSeed } from "@telar/engine-client";
import { claudeEffortFor, claudeWindowTokensOf, requireCli } from "../../domains/providers";
import { pluginBriefings } from "../../plugins/bundled";
import { canonicalEnvPatch, canonicalJson, canonicalServers, changedFields, fieldDigest, fieldDigests, resolveChildEnv } from "./identity";
import { ClaudeRuntimeStore, UNATTENDED_BACKGROUND_WORK_MS } from "./runtime";
import { framedSteerText } from "../../domains/turns";
import { ProviderUnavailableError, requireCwd, type DriverResult, type DriverRun, type TurnDriver } from "../contract";
import { claudeInitialContent, claudeNotificationOrigin, claudeNotificationContent, claudeStreamingInputEnabled, claudeMcpServers, claudeContextEnvForModel, claudeToolSearchEnv, SESSION_STATE_ENV, claudeWindowOf, selectedContextMaxFromModel, claudeEffort, type ClaudeTurnBindings, type ClaudeSdk } from "./sdk";
import { str } from "./mapping";
import { isTerminalTaskState } from "./tasks";
import { providerWaitFrom, RateLimitedError, PROVIDER_SILENCE_MS, END_TURN_GRACE_MS } from "./limits";
import { bindBlocks, type OpenBlock, type StreamingInput } from "./observations";
import { gateFor } from "./permission-gate";
import type { SdkFrame } from "./frames";
import { BACKGROUND_CLAIM_LINGER_MS } from "./background-claims";
import type { TurnState } from "./turn";
import { createEmitter } from "./emitter";
import { bindTasks } from "./task-tracker";
import { bindProviderWait } from "./provider-wait";
import { bindClaims, createBackgroundGate } from "./background-claims";
import { bindSteering } from "./steering";
import { bindRuntime } from "./session-runtime";
import { bindIdlePump } from "./idle-pump";
import type { LoopCtx } from "./loop-ctx";
import { onUserFrame } from "./turn-frames";
import { onAssistantFrame } from "./turn-frames";
import { onStreamFrame } from "./turn-stream";
import { onThinkingTokens } from "./turn-stream";
import { onResultFrame } from "./turn-result";
import { onSessionState } from "./turn-system";
import { onCompactBoundary } from "./turn-system";
import { onStatusFrame } from "./turn-system";
import { onProviderWait } from "./turn-frames";
import { onOwnResult } from "./turn-result";
import { onMessageStart } from "./turn-stream";
import { onEndTurnGrace } from "./turn-result";

function defaultClaudeExecutable(binaryPath?: string): string {
  try {
    return requireCli("claude", binaryPath ? { binaryPath } : {});
  } catch (error) {
    throw new ProviderUnavailableError(error instanceof Error ? error.message : String(error));
  }
}
export function createClaudeDriver(
  loadSdk: () => Promise<ClaudeSdk> = () => import("@anthropic-ai/claude-agent-sdk") as Promise<ClaudeSdk>,
  options: {
    resolveExecutable?: (binaryPath?: string) => string | undefined;
    providerSilenceMs?: number;
    /** How long to wait for a `result` after `end_turn` — see
     *  `END_TURN_GRACE_MS`. Injected so a test does not sleep for the real one. */
    endTurnGraceMs?: number;
    unattendedBackgroundWorkMs?: number;
    /** How long a background task's claim is kept after its last decision —
     *  see `BACKGROUND_CLAIM_LINGER_MS`. Injected so a test does not sleep for
     *  the real window. */
    backgroundClaimLingerMs?: number;
  } = {},
): TurnDriver {
  const resolveExecutable = options.resolveExecutable ?? defaultClaudeExecutable;
  const providerSilenceMs = options.providerSilenceMs ?? PROVIDER_SILENCE_MS;
  const endTurnGraceMs = options.endTurnGraceMs ?? END_TURN_GRACE_MS;
  const backgroundClaimLingerMs = options.backgroundClaimLingerMs ?? BACKGROUND_CLAIM_LINGER_MS;
  /** sessionId → live query. Owned per driver instance so every test gets
   *  isolation and each worker deployment owns exactly its own processes. */
  const runtimes = new ClaudeRuntimeStore<ClaudeTurnBindings, TaskSeed>({
    liveBackgroundWork: (seed) => isBackgroundWork(seed) && !isTerminalTaskState(seed.state),
    unattendedAfterMs: options.unattendedBackgroundWorkMs ?? UNATTENDED_BACKGROUND_WORK_MS,
    onUnattended: (stops) => {
      for (const stop of stops) {
        console.error(
          `[claude-runtime] session=${stop.sessionId} stopped background task ${stop.taskId}` +
            `${stop.providerTaskId ? ` (${stop.providerTaskId})` : ""} after ${Math.round(stop.idleForMs / 60_000)} minutes with nobody watching` +
            `${stop.stopped ? "" : "; the provider offered no stop, so the process was ended instead"}`,
        );
      }
    },
  });
  return {
    dispose: () => runtimes.destroyAll(),
    stopTask: (sessionId, providerTaskId) => runtimes.stopTask(sessionId, providerTaskId),
    run: (input) => runClaudeTurn({ loadSdk, resolveExecutable, providerSilenceMs, endTurnGraceMs, backgroundClaimLingerMs, runtimes }, input),
  };
}

type DriverDeps = {
  loadSdk: () => Promise<ClaudeSdk>;
  resolveExecutable: (binaryPath?: string) => string | undefined;
  providerSilenceMs: number;
  endTurnGraceMs: number;
  backgroundClaimLingerMs: number;
  runtimes: ClaudeRuntimeStore<ClaudeTurnBindings, TaskSeed>;
};

type TurnScope = Awaited<ReturnType<typeof openTurn>>;

async function openTurn(deps: DriverDeps, input: DriverRun) {
  const { prompt, notification, sessionId, cwd: claimedCwd, model, effort, fastMode, ultracode, attachments, mcpServers: userMcpServers, autoCompact, onObservations, onRequest, providerSessionId, browserSocket, tasks: seededTasks, session: sessionHooks } = input;
  const { loadSdk, providerSilenceMs, backgroundClaimLingerMs, runtimes } = deps;
  const turn = {} as TurnState;
  const { flush, flushSoon, emit } = createEmitter(turn);
  
  try {
    turn.sdk = await loadSdk();
  } catch {
    throw new ProviderUnavailableError(
      "Claude Agent SDK is unavailable; install and configure Claude Code before retrying",
    );
  }
  // The Claude SDK spawns its CLI in a directory; a session with none is a
  // routing mistake and says so before anything starts. See `requireCwd`.
  turn.cwd = requireCwd(claimedCwd, "Claude Code");
  // The manifest maps an effort a model runs under another name (Opus 4.7: xhigh → max).
  turn.sdkEffort = claudeEffort(claudeEffortFor(model, effort));
  turn.userServers = claudeMcpServers(userMcpServers);
  turn.contextEnv = claudeContextEnvForModel(model);
  // The login's per-class limit (#587), for the window this model runs.
  // After the login's own patch, so the setting beats a stale row.
  turn.compactionEnv = claudeCompactionEnv(autoCompact, model ? claudeWindowTokensOf(model) : undefined);
  turn.defaultEnv = { ...SESSION_STATE_ENV, ...claudeToolSearchEnv(process.env) };

  turn.finalText = "";
  turn.receivedPartialText = false;
  
  
  turn.completed = false;
  
  turn.contextMax = selectedContextMaxFromModel(model);
  const { decorateUsage, closeProviderWait, disarmProviderSilence, armProviderSilence } = bindProviderWait({ turn, emit, flush, providerSilenceMs });
  
  /** Our main loop's successful `result` has been read — on a process that
   *  reports session state, that is when an `idle` can be ours. */
  turn.ownResultRead = false;
  
  /** The open "Compacting context" row, when the provider announced one. */
  
  /** `compact_result: "success"` seen; the row waits for its boundary. */
  turn.compactionSucceeded = false;
  /** The open row's `compact_boundary` (the numbers) has arrived. */
  turn.compactionMeasured = false;

  turn.openBlocks = new Map<string, OpenBlock>();
  const { closeBlock } = bindBlocks({ turn });
  /** Tool rows keyed by `tool_use_id`, so a later `tool_result` closes the
   *  row its call opened rather than opening a second one. */
  turn.openTools = new Map<string, { id: string; detail: ItemDetail }>();
  /** File calls whose input is still streaming — see `streamedPathUpdate`. */
  turn.streamingInputs = new Map<string, StreamingInput>();
  turn.openTopLevelTools = new Set<string>();

  /** The turn's single plan row, once TodoWrite has opened one. */
  

  turn.taskIdsBySdkId = new Map();
  /** Last seed per task, so `task_updated`'s PATCH can be folded onto
   *  something rather than sent as a task with no title or kind. */
  turn.knownTasks = new Map();
  /** The SDK's `task_type` per task id — see `TaskMemory.typesBySdkId`. */
  turn.taskTypesBySdkId = new Map();
  turn.suppressedTasks = new Set();
  /** Log paths a backgrounded Bash result stated before its task had a
   *  row, by SDK id — folded in when the row is minted (`emitTask`). */
  turn.pendingOutputFiles = new Map<string, string>();
  
  /** Our reply's first frame has arrived (`user_message_uuid` = ours).
   *  Until then a sender-less turn is not ours; after, it is. */
  turn.ownTurnOpen = false;
  const { liveBackgroundTasks, reportLostBackgroundWork, noteTaskOutput, handleTaskFrame } = bindTasks({ turn, emit });

  turn.sink = onObservations;
  /** The live runtime once claimed or built; `handleTaskFrame` writes the
   *  woken-task id to its memory. */
  

  turn.pending = [];
  turn.flushQueue = Promise.resolve();
  turn.canUseTool = onRequest ? gateFor(onRequest) : undefined;
  
  turn.backgroundClaimChain = Promise.resolve();
  const { acquireBackgroundClaim, closeBackgroundClaim, lingerOnceQuiet, releaseBackgroundClaim } = bindClaims({ turn, backgroundClaimLingerMs, liveBackgroundTasks, runtimes, sessionHooks, sessionId });

  const backgroundGate = createBackgroundGate(turn, acquireBackgroundClaim, releaseBackgroundClaim);
  const { startIdlePump } = bindIdlePump({ turn, backgroundGate, closeBackgroundClaim, closeBlock, decorateUsage, emit, flush, handleTaskFrame, lingerOnceQuiet, reportLostBackgroundWork, runtimes });
  const { onSteered, consumeSteerCut, closeCutTools } = bindSteering({ turn, emit });
  identifyTurn(deps, input, turn);
  const { buildRuntime } = bindRuntime({ turn, attachments, browserSocket, fastMode, model, notification, prompt, providerSessionId, seededTasks, sessionId, ultracode });
  return { turn, emit, flush, flushSoon, decorateUsage, closeProviderWait, disarmProviderSilence, armProviderSilence, closeBlock, liveBackgroundTasks, reportLostBackgroundWork, noteTaskOutput, handleTaskFrame, backgroundGate, startIdlePump, onSteered, consumeSteerCut, closeCutTools, buildRuntime };
}

// The query options and the reuse fingerprint are computed together so they cannot disagree.
function identifyTurn(deps: DriverDeps, input: DriverRun, turn: TurnState): void {
  const { signal, fastMode, ultracode, mcpServers: userMcpServers, env, binaryPath, providerInstanceId, browserSocket, orientation, mainBriefing, run, plugins, sessions, notes, prompts, display } = input;
  const { resolveExecutable } = deps;
  /** The `claude` binary this turn runs on, resolved once: the query below
   *  takes it as `pathToClaudeCodeExecutable`, and the fingerprint records
   *  it so a turn on a different binary does not reuse the query. */
  turn.executable = resolveExecutable(binaryPath);

  /** This turn's half of the runtime, swapped in whole below whether the
   *  runtime is fresh or reused — see `ClaudeTurnBindings`. */
  turn.turnBindings = {
    signal,
    canUseTool: turn.canUseTool,
    sessions,
    notes,
    prompts,
    display,
    run,
    plugins,
  };

  turn.streaming = claudeStreamingInputEnabled();

  turn.briefings = [
    ...(orientation ? [orientation] : []),
    ...(mainBriefing ? [mainBriefing] : []),
    ...(browserSocket ? [BROWSER_BRIEFING] : []),
    ...(run ? [RUN_BRIEFING] : []),
    // Each enabled plugin's own paragraph, from its manifest. Carried by
    // the fingerprint's `plugins` field: the same set, the same words.
    ...pluginBriefings(Object.keys(plugins ?? {})),
  ];

  turn.fingerprintFields = {
    cwd: turn.cwd,
    env: canonicalEnvPatch(turn.defaultEnv, env, turn.contextEnv, turn.compactionEnv),
    effort: turn.sdkEffort ?? null,
    fastMode: fastMode ?? null,
    ultracode: ultracode ?? null,
    executable: turn.executable ?? null,
    servers: canonicalServers(userMcpServers),
    browser: browserSocket ?? null,
    sessions: Boolean(sessions),
    // Same rule: the toolkits are baked into the query at creation, so a
    // project-less session gaining a project must cold-start rather than
    // keep advertising a wall it no longer lacks.
    notes: Boolean(notes),
    // Same rule again: the prompt wall is baked into the query at creation.
    prompts: Boolean(prompts),
    display: Boolean(display),
    /** Same rule, and here it is the system prompt rather than a toolkit:
     *  `RUN_BRIEFING` is appended at creation, so a project-less session
     *  that gains a project must cold-start to be told about it. */
    run: Boolean(run),
    orientation: orientation ?? null,
    mainBriefing: mainBriefing ?? null,
    plugins: Object.keys(plugins ?? {}).sort(),
    gate: Boolean(turn.canUseTool),
    instance: providerInstanceId ?? null,
  };
  /** CANONICAL, not `JSON.stringify`: key order is not identity, and an
   *  explicit deletion is. See ./claude-identity.ts. */
  turn.fingerprint = canonicalJson(turn.fingerprintFields);
  turn.fingerprintDigests = fieldDigests(turn.fingerprintFields);

  /** The child's environment with the patch's deletions APPLIED, resolved
   *  once so the query options and the fingerprint cannot disagree. */
  turn.childEnv = resolveChildEnv(process.env, turn.defaultEnv, env, turn.contextEnv, turn.compactionEnv);
}

async function claimTurnRuntime(deps: DriverDeps, input: DriverRun, scope: TurnScope): Promise<void> {
  const { prompt, promptFromHuman, notification, sessionId, model, attachments } = input;
  const { turn, buildRuntime } = scope;
  const { runtimes } = deps;
  turn.persistent = turn.streaming;
  if (turn.persistent) await runtimes.idle(sessionId);
  turn.outgoing = turn.persistent ? runtimes.peek(sessionId)?.fingerprintDigests : undefined;
  turn.claimed = turn.persistent ? runtimes.claim(sessionId, turn.fingerprint) : undefined;
  if (process.env.TELAR_CLAUDE_RUNTIME_DEBUG === "1") {
    const changed = turn.outgoing ? changedFields(turn.outgoing, turn.fingerprintDigests) : [];
    console.error(
      `[claude-runtime] session=${sessionId} reuse=${Boolean(turn.claimed)} identity=${fieldDigest(turn.fingerprintFields)}` +
        (changed.length > 0 ? ` changed=${changed.join(",")}` : ""),
    );
  }
  if (turn.claimed && turn.claimed.model !== model) {
    const setModel = claudeWindowOf(turn.claimed.model) === claudeWindowOf(model) ? turn.claimed.query.setModel?.bind(turn.claimed.query) : undefined;
    let switched = false;
    if (setModel) {
      try {
        await setModel(model);
        turn.claimed.model = model;
        switched = true;
      } catch {
        switched = false;
      }
    }
    if (!switched) {
      runtimes.destroy(sessionId);
      turn.claimed = undefined;
    }
  }
  turn.runtime = turn.claimed ?? buildRuntime();
  if (turn.persistent && !turn.claimed) runtimes.adopt(turn.runtime);
  turn.runtime.bindings.current = turn.turnBindings;
  turn.runtimeRef = turn.runtime;
  // From here on the turn reads and writes the PROCESS's task memory.
  turn.taskIdsBySdkId = turn.runtime.tasks.bySdkId;
  turn.knownTasks = turn.runtime.tasks.known;
  turn.suppressedTasks = turn.runtime.tasks.suppressed;
  turn.taskTypesBySdkId = turn.runtime.tasks.typesBySdkId;

  turn.turnUuid = crypto.randomUUID();
  turn.ownSends = new Set<string>([turn.turnUuid]);
  turn.steerSent = false;
  if (turn.persistent) {
    turn.runtime.feed.push({
      type: "user",
      message: {
        role: "user",
        // A NOTIFICATION IS NOT THE PROMPT, it is an announcement the turn
        // is being opened ON — so it goes in system-authored and stamped
        // with its real provenance, never as the person's words (#550).
        content: notification
          ? claudeInitialContent(claudeNotificationContent(prompt, notification), attachments ?? [])
          : claudeInitialContent(prompt, attachments ?? []),
      },
      parent_tool_use_id: null,
      uuid: turn.turnUuid,
      ...(notification
        ? { origin: claudeNotificationOrigin(notification) }
        : promptFromHuman
          ? { origin: { kind: "human" as const } }
          : {}),
    });
  }
}

function pumpSteering(input: DriverRun, scope: TurnScope): void {
  const { steer } = input;
  const { turn, flush, onSteered } = scope;
  turn.turnDone = false;
  turn.outstandingSteerCuts = new Set<symbol>();
  if (turn.persistent && steer) {
    void (async () => {
      for (;;) {
        await steer.wake();
        if (turn.turnDone) return;
        const queued = steer.drain();
        if (queued.length > 0) {
          for (const message of queued) onSteered(message);
          const text = queued.map((message) => framedSteerText(message)).join("\n\n");
          const attachments = queued.flatMap((message) => message.attachments ?? []);
          const typedByAPerson = queued.some((message) => message.sender === undefined && message.wakeReason === undefined);
          const notifications = queued.map((message) => message.notification).filter((detail) => detail !== undefined);
          const allNotifications = !typedByAPerson && notifications.length === queued.length && notifications[0] !== undefined;
          const steerUuid = crypto.randomUUID();
          turn.ownSends.add(steerUuid);
          turn.steerSent = true;
          turn.runtime.feed.push({
            type: "user",
            message: { role: "user", content: claudeInitialContent(allNotifications ? claudeNotificationContent(text, notifications[0]!) : text, attachments) },
            parent_tool_use_id: null,
            uuid: steerUuid,
            ...(allNotifications
              ? { origin: claudeNotificationOrigin(notifications[0]!) }
              : typedByAPerson
                ? { origin: { kind: "human" as const } }
                : {}),
          });
          if (typedByAPerson && turn.runtime.query.interrupt) {
            // Armed BEFORE the await: the pump is concurrent and the result
            // can land first. Disarmed only if the call itself refuses, which
            // leaves the message queued — late rather than lost.
            const cut = Symbol("steer-cut");
            turn.outstandingSteerCuts.add(cut);
            try {
              await turn.runtime.query.interrupt();
            } catch {
              // Removes only ITS OWN arm, and only if a result has not
              // already consumed it — a refused cut leaves the message
              // queued, which is late rather than lost.
              turn.outstandingSteerCuts.delete(cut);
            }
          }
          await flush();
        }
        if (steer.isClosed) return;
      }
    })().catch(() => undefined);
  }
}

function armAbort(deps: DriverDeps, input: DriverRun, turn: TurnState): () => void {
  const { sessionId, signal } = input;
  const { runtimes } = deps;
  turn.streamEnded = false;
  
  const onAbort = () => {
    if (!turn.persistent) {
      turn.runtime.destroy();
      return;
    }
    const interrupted = turn.runtime.query.interrupt?.();
    if (!interrupted) {
      runtimes.destroy(sessionId);
      return;
    }
    interrupted.catch(() => runtimes.destroy(sessionId));
    // The grace is named and shared now — see STOP_REAP_GRACE_MS for what
    // it does and does not bound (#409).
    turn.cancelReap = runtimes.reapAfter(sessionId);
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  return onAbort;
}

async function raceEndTurnGrace<S>(turn: TurnState, endTurnGraceMs: number, read: Promise<S>): Promise<S | "end-turn-grace"> {
  if (turn.endTurnSeenAt === undefined || !turn.persistent) return read;
  const remaining = Math.max(0, turn.endTurnSeenAt + endTurnGraceMs - Date.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const grace = new Promise<"end-turn-grace">((resolve) => {
    timer = setTimeout(() => resolve("end-turn-grace"), remaining);
    timer.unref?.();
  });
  try {
    return await Promise.race([read, grace]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function readTurn(loopCtx: LoopCtx, scope: TurnScope): Promise<void> {
  const { turn, emit, flush, closeProviderWait, disarmProviderSilence, reportLostBackgroundWork, handleTaskFrame } = scope;
  for (;;) {
    const step = turn.runtime.parked.length > 0
      ? { done: false as const, value: turn.runtime.parked.shift()! }
      : await raceEndTurnGrace(turn, loopCtx.endTurnGraceMs, ClaudeRuntimeStore.takeStep(turn.runtime));
    if (step === "end-turn-grace") {
      if ((await onEndTurnGrace(loopCtx)) === "break") return;
      continue;
    }
    if (step.done) {
      turn.streamEnded = true;
      turn.runtime.streamEnded = true;
      reportLostBackgroundWork();
      await flush();
      return;
    }
    const message = step.value;
    const item = message as SdkFrame;

    if (str(item.session_id) && item.session_id !== turn.reportedSessionId) {
      turn.reportedSessionId = item.session_id;
      emit({ kind: "provider.session", providerSessionId: item.session_id! });
    }

    const parentToolUseId = str(item.parent_tool_use_id ?? undefined);
    onMessageStart(loopCtx, item, parentToolUseId);
    {
      const flow = await onOwnResult(loopCtx, item, parentToolUseId);
      if (flow === "continue") continue;
    }

    const ownerTaskId = parentToolUseId ? `task_${parentToolUseId}` : turn.foreignTurn?.taskId;
    const ours = !parentToolUseId && turn.foreignTurn === undefined;

    // ── the provider made the turn wait, and said why ─────────────
    const waited = providerWaitFrom(item);
    {
      const flow = await onProviderWait(loopCtx, waited);
      if (flow === "continue") continue;
    }
    const ourLoopSpoke =
      ours && (item.type === "stream_event" || item.type === "assistant" || item.type === "user" || item.type === "result");
    if (ourLoopSpoke) disarmProviderSilence();
    if (
      ourLoopSpoke &&
      (item.type === "user" || item.type === "result" || (item.type === "stream_event" && item.event?.type === "message_start"))
    ) {
      turn.endTurnSeenAt = undefined;
    }
    if (turn.waitItemId && ourLoopSpoke) {
      closeProviderWait();
      if (item.type !== "result") turn.standingLimit = undefined;
    }
    {
      const flow = await onStatusFrame(loopCtx, item);
      if (flow === "continue") continue;
    }
    {
      const flow = await onCompactBoundary(loopCtx, item);
      if (flow === "continue") continue;
    }

    // ── sub-agents and background work ────────────────────────────
    // One handler, shared with the idle pump — the frames are the same
    // whether a turn is reading or the session is between turns.
    if (await handleTaskFrame(item)) {
      await flush();
      continue;
    }
    {
      const flow = await onSessionState(loopCtx, item);
      if (flow === "continue") continue;
      if (flow === "break") return;
    }
    {
      const flow = await onResultFrame(loopCtx, item, parentToolUseId);
      if (flow === "continue") continue;
      if (flow === "break") return;
    }
    {
      const flow = onThinkingTokens(loopCtx, item, parentToolUseId);
      if (flow === "continue") continue;
    }
    {
      const flow = await onStreamFrame(loopCtx, item, parentToolUseId, ownerTaskId, ours);
      if (flow === "continue") continue;
    }
    {
      const flow = await onAssistantFrame(loopCtx, item, ours, ownerTaskId);
      if (flow === "continue") continue;
    }
    await onUserFrame(loopCtx, item);
  }
}

async function finishTurn(input: DriverRun, scope: TurnScope): Promise<DriverResult> {
  const { signal } = input;
  const { turn, emit, flush, closeProviderWait, disarmProviderSilence, closeBlock } = scope;
  if (signal.aborted) throw signal.reason ?? new Error("driver cancelled");
  if (!turn.completed && turn.standingLimit) throw new RateLimitedError(turn.standingLimit.resumeAt, turn.standingLimit.limitType);
  if (!turn.completed) throw new Error("Claude ended without a successful result");

  // A tool whose result never arrived (the stream ended first) would
  // otherwise sit spinning in the UI forever.
  for (const [, open] of turn.openTools) {
    emit({ kind: "item.completed", itemId: open.id, status: "failed" });
  }
  // A block the provider never closed still gets its accumulated text,
  // for the same reason: the projection has no other source for it.
  for (const [, open] of turn.openBlocks) emit(closeBlock(open));
  // The plan is turn-scoped and has no tool_result to close it.
  if (turn.planItemId) emit({ kind: "item.completed", itemId: turn.planItemId, status: "completed" });
  closeProviderWait();
  disarmProviderSilence();
  // A compaction the stream ended inside is over: finished if the CLI
  // said so and only the boundary never came, failed otherwise.
  if (turn.compactionItemId) emit({ kind: "item.completed", itemId: turn.compactionItemId, status: turn.compactionSucceeded ? "completed" : "failed" });
  for (const [id, task] of turn.knownTasks) {
    if (isBackgroundWork(task)) continue;
    if (task.state === "completed" || task.state === "failed" || task.state === "stopped") continue;
    emit({ kind: "task.completed", task: { ...task, id, state: "failed", failure: "the turn ended before this agent reported back" } });
  }
  await flush();

  return {
    text: turn.finalText,
    ...(turn.reportedSessionId ? { providerSessionId: turn.reportedSessionId } : {}),
    ...(turn.usage ? { usage: turn.usage } : {}),
  };
}

async function runClaudeTurn(deps: DriverDeps, input: DriverRun): Promise<DriverResult> {
  const { sessionId, signal, session: sessionHooks } = input;
  const scope = await openTurn(deps, input);
  const { turn, backgroundGate, startIdlePump } = scope;
  await claimTurnRuntime(deps, input, scope);
  pumpSteering(input, scope);
  turn.streamEnded = false;
  const onAbort = armAbort(deps, input, turn);
  const loopCtx: LoopCtx = { turn, noteTaskOutput: scope.noteTaskOutput, emit: scope.emit, flush: scope.flush, decorateUsage: scope.decorateUsage, flushSoon: scope.flushSoon, closeBlock: scope.closeBlock, sessionId, signal, consumeSteerCut: scope.consumeSteerCut, closeCutTools: scope.closeCutTools, armProviderSilence: scope.armProviderSilence, disarmProviderSilence: scope.disarmProviderSilence, closeProviderWait: scope.closeProviderWait, endTurnGraceMs: deps.endTurnGraceMs };
  const { runtimes } = deps;
  try {
    await readTurn(loopCtx, scope);
    return await finishTurn(input, scope);
  } catch (error) {
    if (turn.persistent && (!signal.aborted || turn.streamEnded)) runtimes.destroy(sessionId);
    throw error;
  } finally {
    turn.turnDone = true;
    turn.cancelReap?.();
    signal.removeEventListener("abort", onAbort);
    if (turn.persistent) {
      runtimes.release(sessionId);
      turn.runtime.tasks.lastWokenTaskId = undefined;
      // A turn that ran with no gate (full-access) leaves none behind.
      turn.runtime.bindings.current = { ...turn.runtime.bindings.current, canUseTool: turn.canUseTool ? backgroundGate : undefined };
      // The turn is over; the process is not. Keep reading it.
      if (sessionHooks && !turn.runtime.streamEnded) startIdlePump(turn.runtime, sessionHooks);
    } else turn.runtime.destroy();
  }
}
