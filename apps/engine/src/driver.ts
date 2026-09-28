/**
 * Provider code is deliberately a leaf of the engine. It receives an AbortSignal and
 * can only REPORT what it saw; it cannot mutate project or session state. The
 * worker relays those observations to the engine, which owns the durable
 * journal and the terminal transition.
 *
 * WHAT CHANGED IN v2, and it is the whole point of the protocol bump: this file
 * used to read `text_delta` and assistant text blocks and DROP `tool_use`,
 * `tool_result` and `thinking` on the floor. A session therefore rendered as a
 * wall of prose with no tool timeline, no reasoning, and nothing to approve.
 * Every surface the frozen cockpit has and `apps/web` does not was
 * downstream of that one omission.
 */
import crypto from "node:crypto";
import { BROWSER_BRIEFING } from "./domains/browser";
import { RUN_BRIEFING } from "./run/briefing";
import { isBackgroundWork, claudeCompactionEnv, type ItemDetail, type ItemSeed, type TaskSeed } from "@telar/engine-client";
import { claudeEffortFor, claudeWindowTokensOf, requireCli } from "./domains/providers";
import { pluginBriefings } from "./plugins/bundled";
import { canonicalEnvPatch, canonicalJson, canonicalServers, changedFields, fieldDigest, fieldDigests, resolveChildEnv, ClaudeRuntimeStore, UNATTENDED_BACKGROUND_WORK_MS } from "./drivers/claude";
import { framedSteerText } from "./domains/turns";
import { ProviderUnavailableError, requireCwd, type TurnDriver } from "./drivers/contract";
import { claudeInitialContent, claudeNotificationOrigin, claudeNotificationContent, claudeStreamingInputEnabled, claudeMcpServers, claudeContextEnvForModel, claudeToolSearchEnv, SESSION_STATE_ENV, claudeWindowOf, selectedContextMaxFromModel, claudeEffort, type ClaudeTurnBindings, type ClaudeSdk } from "./drivers/claude/sdk";
import { itemId, oneLine, asRecord, contentBlocks, str, itemDetailForToolCall, titleForToolCall } from "./drivers/claude/mapping";
import { isTerminalTaskState, planDetailForTodos } from "./drivers/claude/tasks";
import { usageFrom, turnCostFrom, contextUsedFrom, contextMaxFrom } from "./drivers/claude/usage";
import { providerWaitFrom, takeProviderWait, titleForProviderWait, RateLimitedError, PROVIDER_SILENCE_MS, END_TURN_GRACE_MS } from "./drivers/claude/limits";
import { noteThinkingTokens, streamingToolSeed, streamingInputFor, streamedPathUpdate, openThinkingOf, withToolResult, bindBlocks, type OpenBlock, type StreamingInput } from "./drivers/claude/observations";
import { gateFor } from "./drivers/claude/permission-gate";
import type { SdkFrame } from "./drivers/claude/frames";
import { BACKGROUND_CLAIM_LINGER_MS } from "./drivers/claude/background-claims";
import type { TurnState } from "./drivers/claude/turn";
import { createEmitter } from "./drivers/claude/emitter";
import { bindTasks } from "./drivers/claude/task-tracker";
import { bindProviderWait } from "./drivers/claude/provider-wait";
import { bindClaims, createBackgroundGate } from "./drivers/claude/background-claims";
import { bindSteering } from "./drivers/claude/steering";
import { bindRuntime } from "./drivers/claude/session-runtime";
import { bindIdlePump } from "./drivers/claude/idle-pump";

/**
 * The user's own Claude Code, or a refusal naming what to install.
 *
 * `requireCli` throws a plain Error carrying the actionable message; it becomes
 * a `ProviderUnavailableError` here so the turn fails the same way a missing
 * Codex does, rather than as an internal error with a good message attached to
 * the wrong shape.
 */
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
    /**
     * INJECTED so a test never depends on which CLIs the machine running it
     * happens to have installed. The default resolves the user's own Claude
     * Code and refuses the turn when there is none — see `cli-resolution.ts`.
     * Returning `undefined` means "say nothing", which leaves the SDK's own
     * lookup exactly as it was.
     *
     * TAKES THE TURN'S OWN BINARY PATH, because which binary to run is a fact
     * about the LOGIN this turn runs as, not about the driver. Without the
     * argument a login pinned to a beta build would be probed as the beta and
     * then run on the default — the pane describing one binary while another
     * answers, which is the failure `cli-resolution.ts` exists to prevent.
     */
    resolveExecutable?: (binaryPath?: string) => string | undefined;
    /**
     * How long a request may be out with nothing back before the turn says so
     * — see `PROVIDER_SILENCE_MS`. Injected only so a test does not have to
     * sleep for the real threshold.
     */
    providerSilenceMs?: number;
    /** How long to wait for a `result` after `end_turn` — see
     *  `END_TURN_GRACE_MS`. Injected so a test does not sleep for the real one. */
    endTurnGraceMs?: number;
    /**
     * How long background work may run with nobody watching before it is
     * stopped — see `UNATTENDED_BACKGROUND_WORK_MS`. Injected only so a test
     * does not have to wait half an hour for the real ceiling.
     */
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
    /**
     * WHAT THE POOL MUST NOT DESTROY. A backgrounded shell, monitor or
     * detached agent lives inside the process and reports through it; evicting
     * that process to honour an idle cap kills the work silently, which is
     * exactly what the #201 fixtures reproduced.
     */
    liveBackgroundWork: (seed) => isBackgroundWork(seed) && !isTerminalTaskState(seed.state),
    /**
     * AND HOW LONG IT MAY RUN WITH NOBODY WATCHING — #807. The clause above
     * says a process holding live background work is never evicted TO HONOUR A
     * COUNT, which is right and stays. This says the work does not run forever
     * unattended, which is a different trade and does not cost the same thing.
     */
    unattendedAfterMs: options.unattendedBackgroundWorkMs ?? UNATTENDED_BACKGROUND_WORK_MS,
    /**
     * SAID OUT LOUD. The rows already report it — every task goes through
     * `stopTask`, which the CLI answers with a `task_notification` the idle
     * pump folds onto the row — and this is the operator's half of the same
     * fact, in the place a long-running daemon's other surprises are logged.
     */
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
    async run({
      prompt,
      promptFromHuman,
      notification,
      sessionId,
      cwd: claimedCwd,
      signal,
      model,
      effort,
      fastMode,
      ultracode,
      attachments,
      mcpServers: userMcpServers,
      env,
      autoCompact,
      binaryPath,
      onObservations,
      onRequest,
      providerSessionId,
      providerInstanceId,
      browserSocket,
      orientation,
      mainBriefing,
      run,
      plugins,
      sessions,
      notes,
      prompts,
      display,
      steer,
      tasks: seededTasks,
      session: sessionHooks,
    }) {
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
      /**
       * The context meter's two halves, tracked run-scoped: `contextUsed` from
       * the newest assistant message (see `contextUsedFrom`), `contextMax`
       * from each result's `modelUsage` — a constant per model, carried
       * forward because a slash-command result can arrive with an empty table.
       */
      
      turn.contextMax = selectedContextMaxFromModel(model);
      const { decorateUsage, closeProviderWait, disarmProviderSilence, armProviderSilence } = bindProviderWait({ turn, emit, flush, providerSilenceMs });
      /**
       * THE SILENCE WATCH — a request that is out and has not answered (#263).
       *
       * A TIMER RATHER THAN A CHECK IN THE LOOP, because the loop is exactly
       * what a stall stops: the pump is parked on `takeStep` awaiting a frame
       * that never comes, so nothing inside it runs to notice. `emit` and
       * `flush` are already called from a timer (see `flushSoon`), so the row
       * reaches the sink the same way a delta does.
       *
       * Armed by `requesting`, disarmed by our own main loop speaking again. If
       * it fires first it opens the standing wait row, which the same frame
       * then closes through `closeProviderWait` — one row with a beginning and
       * an end, never a marker floating in silence.
       */
      /**
       * THE END-TURN GRACE (#465): set when our main loop's assistant envelope
       * says `end_turn` with no top-level tool still open — the model is done
       * and only the CLI's `result` is owed. Cleared by any later frame of
       * ours. While it stands, the pump's read is raced against it; if the
       * grace wins, the turn settles here with a warning row instead of
       * waiting forever on a `result` that measurably does not always come.
       */
      
      /** Our main loop's successful `result` has been read — on a process that
       *  reports session state, that is when an `idle` can be ours. */
      turn.ownResultRead = false;
      /**
       * THE LAST REJECTED LIMIT THAT IS STILL STANDING — the evidence that, if
       * this turn now ends without succeeding, it ended because of a limit.
       *
       * SET only by a `rejected` rate-limit frame that named a reset time: a
       * warning is not a rejection, and a rejection with no reset time gives
       * the engine nothing to schedule, so both leave this alone and the turn
       * fails the ordinary way.
       *
       * CLEARED WHEN OUR OWN MAIN LOOP SPEAKS AGAIN, and only then. That frame
       * is proof the request went through — the limit was survived, and a
       * failure arriving later is a different failure that must not be dressed
       * up as a wait. Deliberately NOT cleared when a new wait row opens over
       * it: an `api_retry` that follows a rejected limit is the same limit
       * still biting.
       */
      
      /** The open "Compacting context" row, when the provider announced one. */
      
      /** `compact_result: "success"` seen; the row waits for its boundary. */
      turn.compactionSucceeded = false;
      /** The open row's `compact_boundary` (the numbers) has arrived. */
      turn.compactionMeasured = false;

      /**
       * Streaming blocks keyed by the provider's content-block index.
       *
       * `text` ACCUMULATES, and that is not redundant with the deltas already
       * sent. Deltas are appends the engine journals but deliberately does NOT
       * fold into `items.json` — rewriting the whole projection per token would
       * be absurd — so the closing `item.completed` is the ONLY chance to give
       * the stored item its final text. Without it a live client looked right
       * (it folds deltas itself) while a client OPENING the session later got
       * empty reasoning and empty assistant messages from the snapshot. Found
       * by running it, not by a test; the test now exists.
       */
      turn.openBlocks = new Map<string, OpenBlock>();
      const { closeBlock } = bindBlocks({ turn });
      /** Tool rows keyed by `tool_use_id`, so a later `tool_result` closes the
       *  row its call opened rather than opening a second one. */
      turn.openTools = new Map<string, { id: string; detail: ItemDetail }>();
      /** File calls whose input is still streaming — see `streamedPathUpdate`. */
      turn.streamingInputs = new Map<string, StreamingInput>();
      /**
       * The MAIN LOOP'S tool calls whose `tool_result` has not arrived yet — a
       * subset of `openTools` (which also tracks sub-agent tools). Kept apart
       * because this set is an END-OF-TURN signal: a `result` that arrives
       * while it is non-empty and states no stop reason is the CLI pausing
       * around in-flight tool work, not the turn ending (see the result arm).
       * Sub-agent tools must not hold the turn — a backgrounded agent's rows
       * legitimately outlive it.
       */
      turn.openTopLevelTools = new Set<string>();

      /**
       * Sub-agents, keyed by the SDK's own `task_id`.
       *
       * THE CONTRACT ID IS DERIVED FROM `tool_use_id` WHEN THERE IS ONE, not
       * from `task_id`, and that is what makes filing work without a lookup:
       * every message produced inside a sub-agent carries `parent_tool_use_id`
       * — the id of the `Task` call that launched it — so an item can name its
       * task from the message alone. `task_updated` is the one SDK message that
       * carries `task_id` and no `tool_use_id`, which is the only reason this
       * map exists.
       */
      /** The turn's single plan row, once TodoWrite has opened one. */
      

      /**
       * THE PROCESS'S TASK MEMORY, NOT THE TURN'S. Assigned once the runtime
       * is claimed or built below; declared here because `emitTask` closes over
       * it. Held on the runtime because a task launched
       * in one turn reports in a later one under its SDK id alone — see
       * `TaskMemory` in ./claude-runtime.ts for the measured ghost rows.
       */
      turn.taskIdsBySdkId = new Map();
      /** Last seed per task, so `task_updated`'s PATCH can be folded onto
       *  something rather than sent as a task with no title or kind. */
      turn.knownTasks = new Map();
      /** The SDK's `task_type` per task id — see `TaskMemory.typesBySdkId`. */
      turn.taskTypesBySdkId = new Map();
      /** SDK task ids that are not rows: `ambient` housekeeping, and shells
       *  that block their turn (`isForegroundShell`). Remembered, so the
       *  progress/notification edges of the same task cannot re-create the row
       *  through `emitTask`'s fold-or-invent path. A foreground shell leaves
       *  the set the moment the CLI backgrounds it (Ctrl+B). On the runtime's
       *  memory like the rows — see `TaskMemory`. */
      turn.suppressedTasks = new Set();
      /** Log paths a backgrounded Bash result stated before its task had a
       *  row, by SDK id — folded in when the row is minted (`emitTask`). */
      turn.pendingOutputFiles = new Map<string, string>();
      /** The turn the pump is reading is one the CLI started on its own (a
       *  background task's wake-up), not this engine turn — see the
       *  `message_start` check in the loop. Its rows are filed under the task
       *  that fired it; its result ends nothing. */
      
      /** Our reply's first frame has arrived (`user_message_uuid` = ours).
       *  Until then a sender-less turn is not ours; after, it is. */
      turn.ownTurnOpen = false;
      const { liveBackgroundTasks, reportLostBackgroundWork, noteTaskOutput, handleTaskFrame } = bindTasks({ turn, emit });

      /**
       * WHERE OBSERVATIONS GO. A turn's own go to its `onObservations`; a
       * PROVIDER turn's (a wake-up the pump is reading) go to the binding the
       * engine opened for it; and task frames read BETWEEN turns go to the
       * session's `onTasks`. Swapped by the pump, read by `emit`/`flush`.
       */
      turn.sink = onObservations;
      /** The live runtime once claimed or built; `handleTaskFrame` writes the
       *  woken-task id to its memory. */
      

      turn.pending = [];
      /**
       * FLUSHES ARE SERIALISED, and that is load-bearing the moment anything
       * flushes off the main loop.
       *
       * The main loop only ever ran `emit(); await flush();` in sequence, so
       * nothing overlapped and a plain async function was enough. A deferred
       * flush is different in kind: `flushSoon` runs from a timer, so a batch can
       * be in flight when the loop starts the next one. Left unchained, two
       * in-flight `onObservations` calls can resolve
       * in the opposite order to the one they were spliced in, and the engine
       * folds a `running` over a `completed` it has already stored. The task then
       * reads as live for ever, with nothing left in the stream to correct it.
       *
       * Same failure mode the browser socket's state queue avoids, for the
       * same reason; this generalises it to every observation.
       */
      turn.flushQueue = Promise.resolve();
      turn.canUseTool = onRequest ? gateFor(onRequest) : undefined;
      
      /**
       * OPENS AND CLOSES ARE SERIALISED. Two of these racing would ask the
       * engine for a second live turn — the invariant above — and a close
       * racing an open would hand a child a claim that is being given up. A
       * request in flight does NOT hold this chain: a parked approval waits for
       * a human, and holding it would make one child's card block another
       * child's question.
       */
      turn.backgroundClaimChain = Promise.resolve();
      const { acquireBackgroundClaim, closeBackgroundClaim, lingerOnceQuiet, releaseBackgroundClaim } = bindClaims({ turn, backgroundClaimLingerMs, liveBackgroundTasks, runtimes, sessionHooks, sessionId });

      const backgroundGate = createBackgroundGate(turn, acquireBackgroundClaim, releaseBackgroundClaim);
      const { startIdlePump } = bindIdlePump({ turn, backgroundGate, closeBackgroundClaim, closeBlock, decorateUsage, emit, flush, handleTaskFrame, lingerOnceQuiet, reportLostBackgroundWork, runtimes });
      const { onSteered, consumeSteerCut, closeCutTools } = bindSteering({ turn, emit });

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

      /**
       * WHAT THIS SESSION IS TOLD ABOUT ITS OWN SURFACES, one paragraph per
       * capability it actually has. Each is gated on the capability being
       * bound rather than appended always: a session with no browser told how
       * to drive tabs, or a project-less one told to save a run
       * configuration, spends a turn discovering the tool is not there.
       * Baked in at query creation, so the fingerprint below carries `run`
       * for the same reason it carries `browser`.
       */
      /**
       * THE ORIENTATION GOES FIRST, and it is the one paragraph here that is
       * not gated on a capability: where the agent is is true of every session,
       * with a browser or without one. It is gated on the PERSON instead — the
       * engine resolves `AgentOrientation.preamble` at claim time and sends the
       * words or nothing (see ./orientation.ts). First because it teaches the
       * vocabulary the briefings under it are written in: "this session's
       * integrated browser" lands differently once "the browser" has a
       * referent.
       *
       * ONCE PER TURN, NOT ONCE PER MESSAGE. `briefings` is baked into the
       * query at creation and carried in the fingerprint below, so a reused
       * runtime keeps the paragraph it started with rather than accumulating
       * one per turn — and a session whose orientation was switched off
       * mid-conversation cold-starts, which is exactly what "off means nothing
       * Telar-authored is injected" requires.
       */
      /**
       * THEN WHAT THIS SESSION IS FOR, if this machine has named it Main. Gated
       * on the SESSION rather than on a capability or a person, and resolved at
       * claim time like the paragraph above it — so switching Main off takes
       * effect on the next turn, and the fingerprint below carries it for the
       * same reason it carries `orientation`. Before the capability briefings
       * because it says what this conversation is, not how to drive a tool.
       */
      turn.briefings = [
        ...(orientation ? [orientation] : []),
        ...(mainBriefing ? [mainBriefing] : []),
        ...(browserSocket ? [BROWSER_BRIEFING] : []),
        ...(run ? [RUN_BRIEFING] : []),
        // Each enabled plugin's own paragraph, from its manifest. Carried by
        // the fingerprint's `plugins` field: the same set, the same words.
        ...pluginBriefings(Object.keys(plugins ?? {})),
      ];

      /**
       * EVERYTHING THE QUERY BAKES IN AT CREATION. A turn whose fingerprint
       * differs from the live runtime's cannot reuse it — the options below
       * are fixed for the life of the process — so the store destroys the old
       * one and this turn cold-starts. `model` is deliberately absent: it is
       * the one knob a live query can turn (`setModel`).
       */
      turn.fingerprintFields = {
        cwd: turn.cwd,
        /**
         * THE PATCH, NOT THE RESOLVED ENVIRONMENT, and with a deletion spelled
         * as one — see `canonicalEnvPatch`. `{}` and `{ KEY: undefined }` are
         * opposite instructions that `JSON.stringify` rendered identically.
         */
        env: canonicalEnvPatch(turn.defaultEnv, env, turn.contextEnv, turn.compactionEnv),
        effort: turn.sdkEffort ?? null,
        fastMode: fastMode ?? null,
        ultracode: ultracode ?? null,
        executable: turn.executable ?? null,
        /**
         * ID AND SPEC ONLY, deduplicated and sorted — never the whole record.
         * Measured on the dev app: the auto-registered Computer Use server is
         * re-stamped (`createdAt`/`updatedAt`) on every turn, and hashing those
         * timestamps cold-started a new process per turn — killing the very
         * background work this runtime exists to keep alive. Only what shapes
         * the spawned process belongs here.
         */
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
        /**
         * Same rule again, and the reason the toggle means anything mid-session:
         * the orientation is appended at creation, so switching it off must
         * cold-start rather than leave a live query still carrying the
         * paragraph. The TEXT, not a boolean — a reworded preamble is a
         * different system prompt.
         */
        orientation: orientation ?? null,
        /**
         * Same rule once more, and here it is what makes "disable removes the
         * briefing" true rather than aspirational: the paragraph is appended at
         * query creation, so a session that stops being Main must cold-start
         * rather than keep a live query that is still carrying it.
         */
        mainBriefing: mainBriefing ?? null,
        /**
         * THE ENABLED PLUGIN SET — Data Science and LaTeX among them. The wall
         * re-collects per request, so dispatch is already honest — but a reused
         * query keeps advertising the catalog (and the briefings) it was started
         * with, so a plugin toggled on or off must cold-start it. Sorted: a
         * map's key order is not a decision anybody made.
         */
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
      const { buildRuntime } = bindRuntime({ turn, attachments, browserSocket, fastMode, model, notification, prompt, providerSessionId, seededTasks, sessionId, ultracode });

      /**
       * THE RUNTIME: with streaming input, ONE LIVE QUERY PER SESSION — the
       * whole point of ./claude-runtime.ts. Background shells, monitors and
       * backgrounded sub-agents live inside that process, so a turn ending
       * must not end it. The kill switch restores a process per turn, at the
       * cost of send-now and of anything outliving its turn.
       */
      turn.persistent = turn.streaming;
      /**
       * ONE PUMP PER SESSION, EVER. Measured (session_7657b2ef…, turns
       * 112–113): a stopped turn's pump can stay parked on the iterator for up
       * to the interrupt escalation (10 s). A turn claimed in that window
       * pushed its prompt into the SAME runtime, and the escalation then
       * destroyed the process under it — "Claude ended without a successful
       * result" four seconds after the user typed. Wait for the previous
       * turn to let go; a runtime destroyed meanwhile just cold-starts below.
       */
      if (turn.persistent) await runtimes.idle(sessionId);
      /**
       * WHICH FIELD BROKE REUSE — read BEFORE the claim, because a mismatched
       * claim destroys the runtime whose identity the answer needs.
       *
       * NAMES AND DIGESTS ONLY. Its predecessor printed the whole fingerprint
       * string, which carries the login's env patch, the browser socket's
       * bearer token and every user MCP server's headers — so the one
       * diagnostic worth turning on during a live latency investigation was the
       * one that could not safely be turned on.
       */
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
        // The one knob a live query can turn. A query that cannot (a fake
        // SDK, an older CLI) is replaced instead of patched.
        //
        // A WINDOW CHANGE IS NOT A MODEL SWITCH. `opus` → `opus[1m]` asks for
        // a different context size, and whether a live process honours the
        // suffix through `setModel` is not something this driver can verify
        // — so it is a cold start, where the id is baked into the query and
        // the provider's first result reports the window it actually got.
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

      /**
       * THIS TURN'S JOIN KEY. The CLI echoes it as `user_message_uuid` on the
       * first stream frame of the reply and on the `result` that ends it — and
       * on nothing it starts by itself. That last part is what the pump below
       * needs: a background task finishing between turns wakes the model for a
       * turn of the CLI's own, whose frames sit buffered on the shared iterator
       * until the next engine turn pumps them out.
       */
      turn.turnUuid = crypto.randomUUID();
      /**
       * EVERY SEND OF THIS TURN IS OURS, not only the first. A person's steer
       * interrupts, and when it lands before the reply's first frame the CLI
       * never answers `turnUuid` at all: it answers the steer. Keyed only on
       * the first send, that reply (and every one after it) read as the CLI's
       * own turn, its `result` was skipped as a stranger's, and the turn ran
       * until someone pressed Stop — 7m46s on the Delta coordinator, with nine
       * messages steered into a turn that could no longer end.
       */
      turn.ownSends = new Set<string>([turn.turnUuid]);
      turn.steerSent = false;
      if (turn.persistent) {
        // The turn begins as one message pushed into the open stream. Stamped
        // as the person's only when it IS the person's — see `promptFromHuman`
        // on the contract, and `FeedMessage.origin` for why `human` is the only
        // kind the CLI keeps.
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

      /**
       * SEND NOW, DELIVERED THE MOMENT IT ARRIVES. The old shape drained the
       * mailbox at the turn's END — a delivery window of effectively zero,
       * which is why every steer silently degraded into a requeued turn. With
       * the stream open for the session there is nothing to wait for: the
       * text goes straight in, mid-turn, exactly as typing at a running
       * Claude Code does. After the turn's result the pump stops taking;
       * anything later is the engine sweep's to requeue.
       */
      turn.turnDone = false;
      /**
       * Interrupts issued to deliver a person's steer, still unanswered — one
       * token each, not a count.
       *
       * IDENTITY, BECAUSE THE TWO EVENTS RACE. The SDK writes the interrupt
       * receipt before the interrupted result on a clean cut, but a turn that
       * crashes during interrupt handling emits its error result on a direct
       * path that may PRECEDE the receipt (sdk.d.ts, SDKControlInterruptResponse).
       * So a result can consume a token before that same call settles; with a
       * counter a late rejection would then decrement someone else's arm and
       * drive it negative. A token can only ever remove itself.
       *
       * Consumed by the next result whatever its subtype — the CLI emits
       * exactly one result per turn — so a cut that raced a finishing answer
       * leaves nothing behind to swallow an unrelated failure later.
       */
      turn.outstandingSteerCuts = new Set<symbol>();
      if (turn.persistent && steer) {
        void (async () => {
          for (;;) {
            await steer.wake();
            if (turn.turnDone) return;
            const queued = steer.drain();
            if (queued.length > 0) {
              // ONE ROW PER MESSAGE, ONE PUSH FOR THE BATCH. The transcript
              // keeps every message's own sender and attachments — a batch
              // of a person's words and an agent's used to draw as one agent
              // bubble holding both, with the attachments' ownership lost.
              // The provider still gets them as one interruption, in order,
              // each agent message individually framed and a person's bare.
              for (const message of queued) onSteered(message);
              const text = queued.map((message) => framedSteerText(message)).join("\n\n");
              const attachments = queued.flatMap((message) => message.attachments ?? []);
              /**
               * WHETHER A PERSON IS IN THIS BATCH — read BEFORE the push,
               * because the push now carries it and the interrupt below reads
               * the same answer. A batch that mixes a person's words with an
               * agent's is the person's: the reason to honour it — someone
               * typed, mid-turn — is present either way, and it is the same
               * reading the interrupt has always taken.
               */
              const typedByAPerson = queued.some((message) => message.sender === undefined && message.wakeReason === undefined);
              /**
               * A BATCH OF NOTIFICATIONS AND NOTHING ELSE IS A NOTIFICATION
               * (#550). Mixed with a person's words it is the person's — same
               * reading `typedByAPerson` already takes, and for the same reason:
               * someone typed, mid-turn, and that is what the turn should
               * honour. A batch that is ONLY notifications has no such claim on
               * the person's channel, so it goes system-authored and stamped
               * with the provenance of the first one in it.
               */
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
              /**
               * PUSHING IS NOT INTERRUPTING: the provider reads no further input
               * while it generates, so a pushed message waits out the old answer.
               * Interrupt as Esc does — the generation stops, the process and
               * session survive. Ordered AFTER the push so the words are already
               * in the feed when the provider comes back for input.
               *
               * Only for words a PERSON typed: an agent report or engine wake is
               * a notice, not a change of direction.
               */
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

      /**
       * STOP ENDS THE TURN, NOT THE PROCESS. `interrupt()` is what pressing
       * Esc does in Claude Code: the current work stops, the process — and
       * everything backgrounded inside it — survives. The escalation below is
       * for an interrupt the CLI never answers: this worker runs one turn at
       * a time, so a pump parked forever would park the whole worker.
       */
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

      /**
       * A read raced against the end-turn grace. The read itself is NOT
       * abandoned on a grace win: `takeStep` leaves it on `pendingStep`, and
       * the next pump (idle or the next turn) awaits that same promise, so
       * the frame it eventually yields is read exactly once.
       */
      const raceEndTurnGrace = async <S,>(read: Promise<S>): Promise<S | "end-turn-grace"> => {
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
      };

      try {
        for (;;) {
          /**
           * FRAMES THE IDLE PUMP PARKED COME FIRST. A wake-up's opening frame
           * that arrived between turns, right as this turn was claimed, was
           * read by the idle pump and could not be handled idly (the engine
           * refused the provider turn because THIS turn had the session). It
           * is this turn's stream now; nothing is lost.
           */
          const step = turn.runtime.parked.length > 0
            ? { done: false as const, value: turn.runtime.parked.shift()! }
            : await raceEndTurnGrace(ClaudeRuntimeStore.takeStep(turn.runtime));
          if (step === "end-turn-grace") {
            /**
             * THE MODEL SAID IT WAS DONE AND THE RESULT NEVER CAME (#465).
             * Settle as the result would have: the turn completes, the
             * process stays alive with its pending read parked on
             * `pendingStep` for the next pump, and the transcript says why.
             */
            // SILENT ON THE TRANSCRIPT. The first cut wrote a row here
            // ("Settled without the provider's result") and the owner read it
            // as noise: from the person's side the turn simply ended, and a
            // sentence about a frame they never see is a bad fit. The fact
            // goes to the opt-in diagnostic channel instead, where the person
            // chasing a missing result will look.
            if (process.env.TELAR_CLAUDE_RUNTIME_DEBUG === "1") {
              console.error(`[claude-runtime] session=${sessionId} settled on the end-turn grace after ${endTurnGraceMs}ms; no result frame arrived`);
            }
            turn.completed = true;
            await flush();
            if (turn.persistent) break;
            continue;
          }
          if (step.done) {
            turn.streamEnded = true;
            turn.runtime.streamEnded = true;
            // The process took its background work with it — see
            // `reportLostBackgroundWork`. Flushed HERE rather than left to the
            // post-loop flush, because a turn that ends this way usually ends
            // by throwing and everything still in `pending` would go with it.
            reportLostBackgroundWork();
            await flush();
            break;
          }
          const message = step.value;
          const item = message as SdkFrame;

          if (str(item.session_id) && item.session_id !== turn.reportedSessionId) {
            turn.reportedSessionId = item.session_id;
            // REPORTED THE MOMENT IT IS KNOWN, not only in the result: a turn
            // that is stopped never completes, and without this the session
            // would lose its resume cursor — the next turn starting a fresh
            // provider session with all context silently gone.
            emit({ kind: "provider.session", providerSessionId: item.session_id! });
          }

          /**
           * Whose work is this?
           *
           * A SUB-AGENT'S OUTPUT MUST NOT BECOME THE TURN'S RESULT, which is
           * the trap `forwardSubagentText` opens: with it on, every sub-agent's
           * prose arrives as an ordinary `assistant` message, and appending it
           * to `finalText` would make the turn's summary the concatenation of
           * five agents talking at once instead of the main loop's answer.
           */
          const parentToolUseId = str(item.parent_tool_use_id ?? undefined);

          /**
           * A TURN THE CLI STARTED BY ITSELF IS NOT THIS TURN.
           *
           * MEASURED (session_7657b2ef…, turns 96–98, and reproduced against
           * CLI 2.1.259): a background shell or monitor that fires between
           * engine turns makes the CLI inject its own `task-notification` user
           * message and run a whole model turn on it — assistant text, tool
           * calls, a `result` — into the shared iterator, where it sits until
           * the next engine turn pumps. That next turn then read the wake-up's
           * prose as its own answer, its `result` as its own end (a `/compact`
           * turn "answered" with "Tick 1 arrived"), and the real reply landed
           * on the turn after. The CLI marks its own turns two ways: the
           * frames that answer OUR send carry `user_message_uuid` = the key we
           * pushed, and a CLI-originated result carries `origin`. A frame is
           * foreign from the first frame that names a different sender until
           * the result that closes it. Its rows are filed under the task that
           * fired it (the last notification, or the wake-up itself) so they
           * appear beside the shell that spoke, not as the assistant's reply.
           */
          if (item.type === "stream_event" && item.event?.type === "message_start" && !parentToolUseId) {
            const sender = str(item.user_message_uuid);
            if (sender !== undefined && turn.ownSends.has(sender)) {
              // Our reply has begun. Later message_starts INSIDE it (the
              // continuation after a tool round) carry no uuid — measured —
              // and are ours by position.
              turn.ownTurnOpen = true;
              turn.foreignTurn = undefined;
              turn.runtime.echoesUserMessageUuid = true;
            } else if (sender !== undefined || (turn.runtime.echoesUserMessageUuid && !turn.ownTurnOpen && !turn.steerSent)) {
              // (A senderless reply after a steer is the steer's answer: a
              // steer can cut our first send before its reply began, and a
              // turn that disowns the answer to its own message never ends.)
              // Another sender's turn, or — on a producer known to echo the
              // key — a turn with no sender at all before ours has begun:
              // the CLI's own. Its message_start carries no uuid (measured).
              // Filed under the shell that spoke; a wake-up with no task to
              // name still keeps its rows, under no owner, rather than being
              // dropped — the idle pump is the path that gives it a turn of
              // its own, and this one is merely the fallback for a wake-up
              // that landed in a human turn's window.
              turn.foreignTurn = { taskId: turn.runtime.tasks.lastWokenTaskId };
            }
          }
          if (item.type === "result" && !parentToolUseId) {
            /**
             * A RESULT WITH NO SENDER IS OURS unless something already said
             * otherwise. Measured (CLI 2.1.259): a `/compact` turn — and any
             * local command — answers with NO `message_start` and a `result`
             * carrying neither `user_message_uuid` nor `origin`. Treating that
             * as a stranger's parked the pump for 35 minutes on a compaction
             * that had finished in one second. The CLI's own turns are caught
             * by their `message_start` (above) or their `origin` (here).
             */
            /**
             * `origin` IS NOT A FOREIGN MARK ANY MORE — #465's whole cause.
             *
             * This used to treat ANY `origin` on a result as the CLI's own
             * turn. That was true while Telar stamped no origin on its sends.
             * #241 (1cf9b1c8, 2026-09-13 20:42) began stamping a person's
             * message `origin: {kind: "human"}`, and MEASURED on CLI 2.1.270
             * the result ECHOES that origin back — so from that commit on
             * every result answering a human's message was discarded here as
             * a stranger's, `completed` was never set, and the turn sat
             * `running` until the person pressed Stop. First stall: 23:36
             * the same evening, on the first nightly carrying #241.
             *
             * A result is foreign when a foreign turn is OPEN, or when it
             * names a DIFFERENT sender. An origin whose sender is ours (or
             * absent, on a CLI-started turn caught by its message_start) says
             * nothing about ownership.
             */
            const sender = str(item.user_message_uuid);
            const foreignResult =
              turn.foreignTurn !== undefined ||
              (sender !== undefined && !turn.ownSends.has(sender)) ||
              // A CLI-originated turn that produced no message_start (a
              // notification answered without streaming) is still caught
              // by an origin that is NOT a person's — `human` is the one
              // kind Telar itself stamps, and the CLI echoes it back.
              (str(item.origin?.kind) !== undefined && item.origin?.kind !== "human");
            if (foreignResult) {
              turn.foreignTurn = undefined;
              turn.runtime.tasks.lastWokenTaskId = undefined;
              await flush();
              continue;
            }
          }

          const ownerTaskId = parentToolUseId ? `task_${parentToolUseId}` : turn.foreignTurn?.taskId;
          /** The MAIN LOOP OF OUR TURN — not a sub-agent's, not the CLI's own
           *  turn. Only this contributes to `finalText`, holds the turn open
           *  through `openTopLevelTools`, and moves the usage meter. A foreign
           *  turn with no task to name still shows its rows, but never as
           *  the answer to a question nobody asked. */
          const ours = !parentToolUseId && turn.foreignTurn === undefined;

          // ── the provider made the turn wait, and said why ─────────────
          /**
           * WHAT THE SILENCE WAS. Before this, an SDK backoff and a rejected
           * rate limit produced no observation at all: the #201 sample has
           * nineteen quiet gaps totalling 36 minutes and nothing in the
           * journal can say which of them were provider waits. A blocking
           * wait opens an in-progress row; the next frame closes it, so the
           * pause is bounded rather than a marker floating in silence.
           */
          const waited = providerWaitFrom(item);
          if (waited) {
            const taken = takeProviderWait(waited.detail, turn.lastLimitWarning);
            turn.lastLimitWarning = taken.seen;
            // DROPPED BEFORE `closeProviderWait`: a frame that says nothing new
            // is not an event, so it must not close a standing wait row either.
            if (!taken.emit) continue;
            closeProviderWait();
            const id = itemId();
            const detail: ItemDetail = { type: "provider_wait", wait: waited.detail };
            emit({ kind: "item.started", item: { id, detail, title: titleForProviderWait(waited.detail) } });
            if (waited.blocking) turn.waitItemId = id;
            else emit({ kind: "item.completed", itemId: id, status: "completed", detail });
            // SECONDS TO MILLISECONDS, the one place it happens: the row above
            // keeps the provider's own units, and everything downstream of here
            // is a time the engine schedules against. See `TurnFailure.resumeAt`.
            if (waited.blocking && waited.detail.kind === "rate_limit" && waited.detail.resetsAt !== undefined) {
              turn.standingLimit = {
                resumeAt: waited.detail.resetsAt * 1_000,
                ...(waited.detail.limitType === undefined ? {} : { limitType: waited.detail.limitType }),
              };
            }
            await flush();
            continue;
          }
          /**
           * ONLY OUR OWN MAIN LOOP RESUMING ENDS THE WAIT.
           *
           * The first version closed on the NEXT FRAME OF ANY KIND, which is
           * wrong twice over: a background shell's `task_notification` or the
           * CLI's own housekeeping arrives on the same iterator and proves
           * nothing about the request we are waiting on, and a sub-agent's
           * output proves even less — its model call is a different request
           * that was never retried. So the row closed on unrelated traffic and
           * reported a resumption that had not happened.
           *
           * Model output for THIS turn's main loop is the evidence: the request
           * went through. Anything else leaves the row open, and the turn's own
           * end closes it if nothing ever does.
           */
          const ourLoopSpoke =
            ours && (item.type === "stream_event" || item.type === "assistant" || item.type === "user" || item.type === "result");
          // THE REQUEST LANDED — whether or not the watch ever fired. Disarmed
          // unconditionally, because the common case is the happy one: a reply
          // that arrives in two seconds must not leave a timer standing to open
          // a row about a silence that ended twenty-eight seconds ago.
          if (ourLoopSpoke) disarmProviderSilence();
          /**
           * WHICH FRAMES DISARM THE END-TURN GRACE — and which do not.
           *
           * MEASURED on CLI 2.1.270 through the SDK: after the model finishes,
           * the frames arrive as `assistant` (envelope, `stop_reason: end_turn`),
           * then `stream_event/message_delta` (carrying the same end_turn), then
           * `stream_event/message_stop`, then `result`. The first cut of #465
           * disarmed on ANY frame of ours, so the two trailing stream frames of
           * the SAME message disarmed the grace every time and the settle never
           * fired — the nightly that shipped it still stalled (2026-09-14 10:15).
           *
           * Only frames that mean MORE IS COMING disarm it: a new message
           * beginning (`message_start`), a tool result (`user`) the model will
           * answer, or a `result` (which ends the turn on its own path). A
           * message's own trailing delta and stop are the end being spelled
           * out, not a continuation.
           */
          if (
            ourLoopSpoke &&
            (item.type === "user" || item.type === "result" || (item.type === "stream_event" && item.event?.type === "message_start"))
          ) {
            turn.endTurnSeenAt = undefined;
          }
          if (turn.waitItemId && ourLoopSpoke) {
            closeProviderWait();
            /**
             * MODEL OUTPUT CLEARS THE LIMIT; A `result` DOES NOT.
             *
             * A result ENDS the wait row either way, but it is not evidence the
             * request went through — a non-success result is the CLI giving up,
             * which is precisely the case this whole branch exists to catch. It
             * is in the set above because the row must close; it is excluded
             * here because clearing on it made every limit that ended a turn
             * fail as `driver_failed` (both mapping tests caught it). A
             * SUCCESSFUL result never reaches the throw, so the standing limit
             * is moot there.
             */
            if (item.type !== "result") turn.standingLimit = undefined;
          }

          // ── compaction, announced then bounded ────────────────────────
          if (item.type === "system" && item.subtype === "status") {
            /**
             * A REQUEST JUST WENT OUT. From here until our own main loop speaks
             * the CLI reports nothing whatever happens, so this is where the
             * engine starts counting — see `armProviderSilence` and #263.
             *
             * Re-armed on every `requesting`, which is what makes it per
             * REQUEST rather than per turn: a turn with four tool rounds sends
             * four, and each gets its own clock.
             */
            if (str(item.status) === "requesting") armProviderSilence();
            /**
             * `status: "compacting"` opens the row; a later status carrying
             * `compact_result` closes it. Measured against CLI 2.1.246: a
             * `/compact` prompt produces exactly this pair (then a fresh
             * `init`). These messages were silently discarded before, which
             * is why compaction looked like the agent hanging and then
             * forgetting things.
             */
            if (str(item.status) === "compacting" && !turn.compactionItemId) {
              // The silence watch belongs to a request; a compaction is not one.
              disarmProviderSilence();
              turn.compactionItemId = itemId();
              turn.compactionSucceeded = false;
              turn.compactionMeasured = false;
              emit({
                kind: "item.started",
                item: { id: turn.compactionItemId, detail: { type: "context_compaction" }, title: "Compacting context" },
              });
              await flush();
            } else if (item.compact_result !== undefined && turn.compactionItemId) {
              if (item.compact_result === "success") {
                // NOT CLOSED YET unless the numbers are already in. On CLI
                // 2.1.259 the `compact_boundary` — the one message with the
                // numbers — arrives AFTER this, and a row already closed made
                // the boundary open a second one ("Compacted context" twice,
                // measured). Whichever of the boundary and this comes last
                // closes the row; the turn's end closes it if neither does.
                turn.compactionSucceeded = true;
                if (turn.compactionMeasured) {
                  emit({ kind: "item.completed", itemId: turn.compactionItemId, status: "completed" });
                  turn.compactionItemId = undefined;
                }
              } else {
                emit({ kind: "item.completed", itemId: turn.compactionItemId, status: "failed" });
                turn.compactionItemId = undefined;
              }
              await flush();
            }
            continue;
          }
          if (item.type === "system" && item.subtype === "compact_boundary") {
            /**
             * The boundary carries the numbers: trigger and window occupancy
             * either side. An AUTO compaction may produce a boundary with no
             * `status` announcement first, so the row is opened here when
             * needed — a boundary alone still deserves a transcript row.
             */
            const metadata = asRecord(item.compact_metadata);
            const detail: ItemDetail = {
              type: "context_compaction",
              ...(str(metadata.trigger) ? { reason: str(metadata.trigger)! } : {}),
              ...(typeof metadata.pre_tokens === "number" ? { preTokens: metadata.pre_tokens } : {}),
              ...(typeof metadata.post_tokens === "number" ? { postTokens: metadata.post_tokens } : {}),
            };
            if (turn.compactionItemId) {
              emit({ kind: "item.updated", item: { id: turn.compactionItemId, detail, title: "Compacting context" } });
              turn.compactionMeasured = true;
              if (turn.compactionSucceeded) {
                emit({ kind: "item.completed", itemId: turn.compactionItemId, status: "completed", detail });
                turn.compactionItemId = undefined;
              }
            } else {
              const id = itemId();
              emit({ kind: "item.started", item: { id, detail, title: "Compacted context" } });
              emit({ kind: "item.completed", itemId: id, status: "completed", detail });
            }
            await flush();
            continue;
          }

          // ── sub-agents and background work ────────────────────────────
          // One handler, shared with the idle pump — the frames are the same
          // whether a turn is reading or the session is between turns.
          if (await handleTaskFrame(item)) {
            await flush();
            continue;
          }

          // ── the CLI's own word on whether the turn is over ────────────
          if (item.type === "system" && item.subtype === "session_state_changed") {
            turn.runtime.reportsSessionState = true;
            /**
             * `idle` ENDS THE TURN — once the turn is demonstrably ours: our
             * reply has begun, or our result was read (a `/compact` answers
             * with a result and no message start). An `idle` read before
             * either is the tail of something earlier, such as the CLI's own
             * wake-up, and ends nothing. Nor does one while a person's steer
             * is unanswered: interrupting to deliver it can idle the CLI for
             * a moment before it takes the steer, so once a steer went in,
             * only an `idle` after a result counts.
             *
             * It comes after the result, so usage and text are already in.
             * With the input stream open (as it always is here) the CLI sends
             * it while BACKGROUNDED agents still run — read off the CLI: its
             * "waiting_for_agents" phase notifies idle — and they are the
             * tasks' business, not the turn's.
             *
             * `running` and `requires_action` change nothing here: the first
             * is what the turn already is, and the second is a permission
             * request the engine already holds as an open request.
             */
            if (str(item.state) === "idle" && turn.foreignTurn === undefined && turn.outstandingSteerCuts.size === 0 && (turn.ownResultRead || (turn.ownTurnOpen && !turn.steerSent))) {
              turn.completed = true;
              await flush();
              if (turn.persistent) break;
            }
            continue;
          }

          if (item.type === "result") {
            /**
             * A SUB-AGENT'S RESULT IS THE SUB-AGENT'S, NEVER THE TURN'S. The
             * SDK types say results are main-loop only, but this pump takes
             * whatever arrives — and a result carrying `parent_tool_use_id`
             * completing the PARENT turn (or, worse, a child's non-success
             * result FAILING it) would end a turn whose main loop is still
             * mid-thought. Discriminate before touching usage or completion.
             */
            if (parentToolUseId) {
              await flush();
              continue;
            }
            // THE PROVIDER'S WORD WINS OVER THE ASSUMPTION, in both directions.
            // The old `Math.max` let a selected 1M row override a reported
            // 200k window, which is exactly the meter that lied on the
            // dogfood app. A result with no table keeps the last known value.
            const reportedContextMax = contextMaxFrom(item.modelUsage);
            turn.contextMax = reportedContextMax ?? turn.contextMax;
            /**
             * THE LIFECYCLE SCALARS, TO THE GATED LOG AND NOWHERE ELSE.
             *
             * The #201 audit could not tell hidden thinking from provider
             * queueing from network wait, because the result's own timings were
             * read and discarded. These are whitelisted numbers — no prompt, no
             * header, no error text, no identifier — and they go to the same
             * opt-in diagnostic channel as the runtime line rather than into
             * the durable journal, which is not a performance ledger.
             */
            if (process.env.TELAR_CLAUDE_RUNTIME_DEBUG === "1") {
              const scalar = (candidate: unknown): number | undefined => (typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined);
              console.error(
                `[claude-timing] session=${sessionId} ` +
                  JSON.stringify({
                    durationMs: scalar(item.duration_ms),
                    apiMs: scalar(item.duration_api_ms),
                    ttftMs: scalar(item.ttft_ms),
                    turns: scalar(item.num_turns),
                    stopReason: str(item.stop_reason ?? undefined) ?? null,
                    subtype: item.subtype ?? null,
                  }),
              );
            }
            // THIS TURN'S SPEND, not the query's running total — see `turnCostFrom`.
            turn.usage = decorateUsage(usageFrom(item.usage, turnCostFrom(item.total_cost_usd, turn.runtime)) ?? turn.usage);
            if (turn.usage) emit({ kind: "usage", usage: turn.usage });
            if (item.subtype !== "success") {
              // An interrupt surfaces as a non-success result; the human's
              // stop must read as a stop, never as a provider failure.
              if (signal.aborted) throw signal.reason ?? new Error("driver cancelled");
              // OUR OWN CUT, ANSWERING A STEER: not a failure and not the turn's
              // end. The words that caused it are already in the feed, so keep
              // pumping; the text streamed before the cut stays journalled.
              if (consumeSteerCut()) {
                // …but the calls the interrupt killed ARE over, and leaving
                // them open is what wedged every steered turn — see
                // `closeCutTools`.
                closeCutTools();
                await flush();
                continue;
              }
              /**
               * THE CLI GAVE UP WITH A LIMIT STILL STANDING — so say which
               * thing happened. `driver_failed` sends a person looking for a
               * fault that is not there; this one is a wait with an end, and
               * the engine can sit it out on its own.
               */
              if (turn.standingLimit) throw new RateLimitedError(turn.standingLimit.resumeAt, turn.standingLimit.limitType);
              throw new Error(`Claude did not complete successfully${item.subtype ? ` (${item.subtype})` : ""}`);
            }
            /**
             * AND AN ERRORED RESULT CAN STILL SAY `success` (#779). The CLI's
             * own safeguards report `subtype: "success"` with `is_error: true`
             * — `[reasoning_extraction]` is the one we have seen — so the guard
             * above, which reads the subtype alone, is blind to exactly the
             * shape it looks like it catches. Today the SDK throws out of the
             * iterator before this line runs, which is why such a turn already
             * fails; this is what answers when it does not.
             *
             * SEPARATE from that branch on purpose, rather than widened into
             * it. A non-success subtype is how an interrupt, our own steer cut
             * and a standing limit arrive; an errored success is none of the
             * three, and routing it through `consumeSteerCut()` would spend the
             * cut token on a provider failure and pump on as if the turn were
             * still alive.
             */
            if (item.is_error === true) {
              // Same rule as above: the human's stop reads as a stop.
              if (signal.aborted) throw signal.reason ?? new Error("driver cancelled");
              throw new Error("Claude did not complete successfully (the result was flagged as an error)");
            }
            /**
             * IS THE QUERY ACTUALLY DONE? Reproduced on a live orchestration
             * session (session_7657b2ef…, events 15479–15560): the CLI can
             * emit a `result` for the assistant's text while tool_use blocks
             * from that same response are STILL EXECUTING — their tool_results
             * arrive afterwards and the model continues. Completing the engine
             * turn here settled the worker's claim, so every subsequent tool
             * call in the same response hit "turn is not running under this
             * worker claim" until the daemon was restarted.
             *
             * The result's own `stop_reason` is the discriminator the SDK
             * gives us: `"tool_use"` means the model stopped to run tools and
             * WILL continue — keep pumping to the next result. A `null` stop
             * reason with main-loop tool calls still unresolved is the same
             * situation stated less clearly (older CLIs), so it holds too. An
             * ABSENT field is an older producer (or a fake SDK) that never
             * says: for those the result stays what it always was, the end of
             * the turn — which also keeps a tool whose result never arrives
             * closing as failed rather than parking the pump forever.
             */
            const stopReason = "stop_reason" in item ? (item.stop_reason ?? null) : undefined;
            const toolsStillRunning = turn.openTopLevelTools.size > 0 && (stopReason === "tool_use" || stopReason === null);
            if (turn.persistent && toolsStillRunning) {
              await flush();
              continue;
            }
            /**
             * A SUCCESS ALSO ANSWERS AN OUTSTANDING CUT: the answer finished
             * before the interrupt landed. Consumed here so no token survives.
             *
             * AND THE PERSON'S WORDS ARE STILL OWED AN ANSWER. They are in the
             * CLI's command queue, which an interrupt spares — `queued_turn_count`
             * above zero is the SDK saying another turn follows with no further
             * input (sdk.d.ts). Completing here would end the engine turn with
             * the message already acked as delivered and nothing answering it,
             * so keep pumping until it has been. At zero it was already absorbed
             * into the answer just read; absent (older CLI) keeps the previous
             * behaviour, where the next turn's pump picks it up.
             */
            if (consumeSteerCut()) {
              const queuedTurns = "queued_turn_count" in item ? item.queued_turn_count : undefined;
              if (typeof queuedTurns === "number" && queuedTurns > 0) {
                await flush();
                continue;
              }
            }
            /**
             * ON A PROCESS THAT REPORTS SESSION STATE, THE RESULT IS NOT THE END.
             * `idle` is ("authoritative turn-over signal"), and it follows the
             * result at once when the turn is really over. So the result only
             * arms the end-turn grace: our main loop speaking again (a tool
             * result, a new message) disarms it and the turn goes on, and
             * `idle` ends it. If `idle` never comes — the CLI may hold it while
             * background agents run — the grace settles the turn as a result
             * always did, so this can end a turn later but never hold one.
             */
            if (turn.persistent && turn.runtime.reportsSessionState) {
              turn.ownResultRead = true;
              // Steering stops here, as it did when the result ended the turn:
              // a message arriving after it is the engine's to requeue.
              turn.turnDone = true;
              turn.endTurnSeenAt = Date.now();
              await flush();
              continue;
            }
            turn.completed = true;
            await flush();
            /**
             * A FINAL RESULT ENDS THE TURN AND NOTHING ELSE. The pump stops
             * HERE, with the stream open and the process alive — that is the
             * whole design (see ./claude-runtime.ts); the next turn resumes
             * pumping this same iterator. On the kill-switch path the input
             * stream is already exhausted, so the loop instead runs on to the
             * stream's natural close, exactly as it always did.
             */
            if (turn.persistent) break;
            continue;
          }

          // ── a silent thought, still going ─────────────────────────────
          // The CLI's own running estimate for the open thinking block, sent
          // when it withholds the text. Names no block, so the owner's newest
          // open thought is the one it is about.
          if (item.type === "system" && item.subtype === "thinking_tokens") {
            const open = openThinkingOf(turn.openBlocks, parentToolUseId);
            const progress = open ? noteThinkingTokens(open, item.estimated_tokens) : undefined;
            if (progress) {
              emit(progress);
              flushSoon();
            }
            continue;
          }

          // ── streaming text and reasoning ───────────────────────────────
          if (item.type === "stream_event") {
            const event = item.event ?? {};
            /**
             * KEYED BY OWNER AND INDEX, NOT BY INDEX ALONE.
             *
             * Content-block indices restart at 0 in every agent, so with
             * sub-agent text forwarded a child's block 0 and the main loop's
             * block 0 are two different blocks with one key — the child's
             * `content_block_start` would silently overwrite the parent's open
             * row and the parent's deltas would then append to the child's
             * item. Concurrent agents make this the common case, not an edge.
             */
            const index = `${parentToolUseId ?? ""}#${typeof event.index === "number" ? event.index : -1}`;

            if (event.type === "content_block_start") {
              const blockType = event.content_block?.type;
              if (blockType === "text" || blockType === "thinking") {
                const id = itemId();
                turn.openBlocks.set(index, { id, kind: blockType, text: "", ...(ownerTaskId ? { taskId: ownerTaskId } : {}) });
                emit({
                  kind: "item.started",
                  item: {
                    id,
                    detail: blockType === "text" ? { type: "assistant_message", text: "" } : { type: "reasoning", text: "" },
                    ...(ownerTaskId ? { taskId: ownerTaskId } : {}),
                  },
                });
                // FLUSHED NOW, not with the first delta. A thought whose text
                // the CLI omits has no text deltas at all, and waiting for one
                // left minutes of a turn with nothing but `turn.started`.
                await flush();
                continue;
              }
              /**
               * A TOOL ROW OPENS WHEN THE MODEL STARTS WRITING THE CALL, not
               * when it has finished. The input streams as `input_json_delta`
               * fragments and the assistant envelope only repeats the call once
               * the WHOLE input exists — so a long Write was invisible for as
               * long as the model spent writing it, and a response of eighteen
               * of them arrived as one burst. Opened here with no input, under
               * the id the envelope derives (`item_${id}`); the envelope then
               * UPDATES the row rather than opening a second one.
               *
               * TodoWrite stays with the envelope: it is the plan row, keyed by
               * turn, not a tool row keyed by call.
               */
              const useId = str(event.content_block?.id);
              const name = str(event.content_block?.name);
              if (blockType === "tool_use" && useId && name && name !== "TodoWrite" && !turn.openTools.has(useId)) {
                const seed = streamingToolSeed(useId, name, ownerTaskId);
                turn.openTools.set(useId, { id: seed.id, detail: seed.detail });
                const input = streamingInputFor(useId, name, ownerTaskId);
                if (input) turn.streamingInputs.set(index, input);
                if (ours) turn.openTopLevelTools.add(useId);
                emit({ kind: "item.started", item: seed });
                await flush();
              }
              continue;
            }

            if (event.type === "content_block_delta") {
              const pathUpdate = streamedPathUpdate(turn.streamingInputs, turn.openTools, index, event.delta);
              if (pathUpdate) {
                emit(pathUpdate);
                await flush();
                continue;
              }
              const open = turn.openBlocks.get(index);
              if (!open) continue;
              const progress = noteThinkingTokens(open, event.delta?.estimated_tokens);
              if (progress) {
                emit(progress);
                flushSoon();
              }
              const text = event.delta?.type === "text_delta" ? event.delta.text : event.delta?.thinking;
              if (typeof text !== "string" || text.length === 0) continue;
              open.text += text;
              // The producer streams, whoever the text belongs to: the
              // envelope's own text is a repeat and must not become a row.
              if (open.kind === "text") turn.receivedPartialText = true;
              if (open.kind === "text" && ours) turn.finalText += text;
              emit({
                kind: "content.delta",
                itemId: open.id,
                stream: open.kind === "text" ? "assistant_text" : "reasoning_text",
                text,
              });
              // Coalesced for a frame rather than flushed per chunk — see
              // `flushSoon`. Every terminal frame below still flushes at once.
              flushSoon();
              continue;
            }

            if (event.type === "content_block_stop") {
              turn.streamingInputs.delete(index);
              const open = turn.openBlocks.get(index);
              if (!open) continue;
              turn.openBlocks.delete(index);
              emit(closeBlock(open));
              await flush();
              continue;
            }

            /**
             * THE FINAL OUTPUT COUNT, which nothing else in the stream carries.
             *
             * Every earlier report of `output_tokens` for a response is a
             * placeholder: the SDK says so of the streamed assistant envelopes
             * ("message.usage is not final"), and the #201 sample shows it —
             * a 41-minute journal whose observations reported outputs of 6, 3
             * and 2 tokens. `message_delta` is the one frame that states the
             * response's real output, so it is folded onto the envelope's own
             * usage and the occupancy recomputed from the pair.
             *
             * Read only for OUR main loop: a sub-agent's output is reported on
             * its own task, never against the parent's meter.
             */
            /**
             * THE MODEL'S "I AM DONE", WHERE THE REAL SDK ACTUALLY SAYS IT
             * (#465). Probed on CLI 2.1.270: the `assistant` envelope the SDK
             * streams carries NO `stop_reason` (its own doc says so — "the
             * turn's stop reason arrives on the result message"); the on-disk
             * transcript does, which is what the envelope arm below was written
             * against, and why nightlies .2 and .3 never armed the grace on a
             * single real turn. On the wire, `end_turn` rides the closing
             * `message_delta`'s `delta.stop_reason`. Same conditions as the
             * envelope arm; both stay so either producer shape arms it.
             */
            if (
              event.type === "message_delta" &&
              ours &&
              str(asRecord(event.delta).stop_reason) === "end_turn" &&
              turn.openTopLevelTools.size === 0
            ) {
              turn.endTurnSeenAt = Date.now();
            }
            if (event.type === "message_delta" && ours && turn.lastEnvelopeUsage) {
              const output = asRecord(event.usage).output_tokens;
              if (typeof output !== "number" || output < 0) continue;
              turn.lastEnvelopeUsage = { ...asRecord(turn.lastEnvelopeUsage), output_tokens: output };
              turn.contextUsed = contextUsedFrom(turn.lastEnvelopeUsage) ?? turn.contextUsed;
              const snapshot = usageFrom(turn.lastEnvelopeUsage, undefined);
              if (!snapshot) continue;
              // The cost already recorded for this turn is kept: this frame
              // says nothing about price, and dropping it would read as free.
              turn.usage = decorateUsage({ ...snapshot, ...(turn.usage?.costUsd === undefined ? {} : { costUsd: turn.usage.costUsd }) });
              emit({ kind: "usage", usage: turn.usage! });
              await flush();
            }
            continue;
          }

          // ── tool calls, from the complete envelope ─────────────────────
          if (item.type === "assistant") {
            // A sub-agent's usage is reported on its own task, not folded into
            // the parent's running total, or the turn would double-count it
            // against the `result` message's authoritative figure.
            if (ours) {
              const snapshot = usageFrom(item.message?.usage, undefined);
              if (snapshot) {
                // Kept raw so the response's closing `message_delta` can
                // correct its placeholder output count against it.
                turn.lastEnvelopeUsage = item.message?.usage;
                turn.contextUsed = contextUsedFrom(item.message?.usage) ?? turn.contextUsed;
                turn.usage = decorateUsage(snapshot);
                /**
                 * EMITTED PER ENVELOPE, not held until the result — this is
                 * what makes the context ring move DURING a Claude turn, the
                 * way `thread/tokenUsage/updated` already moves it on Codex.
                 * Before this the local variable updated and nothing left the
                 * driver until the turn ended.
                 */
                emit({ kind: "usage", usage: turn.usage! });
              }
            }
            for (const raw of contentBlocks(item.message?.content)) {
              const block = asRecord(raw);
              if (block.type === "tool_use") {
                const name = str(block.name) ?? "tool";
                const useId = str(block.id) ?? itemId();
                /**
                 * ONE PLAN ROW PER TURN, UPDATED IN PLACE.
                 *
                 * TodoWrite is called repeatedly with the WHOLE list, so a row
                 * per call leaves the transcript full of near-identical
                 * checklists — the exact failure the Codex seam already avoids,
                 * and the reason `plan` says "updated in place across a turn".
                 * The call is deliberately not registered in `openTools`, so
                 * its `tool_result` closes nothing; the plan closes with the
                 * turn.
                 */
                const plan = name === "TodoWrite" ? planDetailForTodos(block.input) : undefined;
                if (plan) {
                  const detail: ItemDetail = { type: "plan", plan };
                  if (turn.planItemId) emit({ kind: "item.updated", item: { id: turn.planItemId, detail, title: "Plan" } });
                  else {
                    turn.planItemId = `item_plan_${crypto.randomUUID().replaceAll("-", "")}`;
                    emit({ kind: "item.started", item: { id: turn.planItemId, detail, title: "Plan" } });
                  }
                  continue;
                }
                /**
                 * A `Task` call is a HANDLE, not a tool row.
                 *
                 * items.ts defines `task` as "the row is a handle; the detail
                 * is on the task events", and the id is derived from the
                 * tool_use id — the same derivation every message inside the
                 * sub-agent will produce from its `parent_tool_use_id`. That is
                 * what joins the handle to the work without a lookup table.
                 */
                const isTask = name === "Task" || name === "Agent";
                const detail: ItemDetail = isTask
                  ? { type: "task", taskId: `task_${useId}` }
                  : itemDetailForToolCall(name, block.input);
                const title = isTask
                  ? oneLine(str(asRecord(block.input).description) ?? str(asRecord(block.input).subagent_type) ?? name)
                  : titleForToolCall(name, detail);
                const seed: ItemSeed = {
                  id: `item_${useId}`,
                  detail,
                  title,
                  ...(ownerTaskId ? { taskId: ownerTaskId } : {}),
                  providerRefs: { itemId: useId },
                };
                // Already opened by its `content_block_start`: this is the
                // same row, now with its input — an update, never a second row.
                const streamed = turn.openTools.has(useId);
                turn.openTools.set(useId, { id: seed.id, detail });
                if (ours) turn.openTopLevelTools.add(useId);
                emit({ kind: streamed ? "item.updated" : "item.started", item: seed });
                continue;
              }
              // With partial messages enabled the envelope REPEATS its text.
              // Emitting it again would double both the transcript and the
              // final result, so this is only the compatibility fallback for
              // an SDK that produced no stream events at all.
              if (block.type === "text" && !turn.receivedPartialText) {
                const text = str(block.text);
                if (!text) continue;
                if (ours) turn.finalText += text;
                const id = itemId();
                emit({
                  kind: "item.started",
                  item: { id, detail: { type: "assistant_message", text }, ...(ownerTaskId ? { taskId: ownerTaskId } : {}) },
                });
                emit({ kind: "item.completed", itemId: id, status: "completed" });
              }
            }
            /**
             * THE MODEL'S OWN "I AM DONE" (#465). With no top-level tool left
             * open there is nothing more this turn can wait for except the
             * CLI's `result`; arm the grace so a missing result cannot hold
             * the turn forever. A `tool_use` stop reason, or an open tool,
             * means more is coming and the grace stays down.
             */
            if (ours && item.message?.stop_reason === "end_turn" && turn.openTopLevelTools.size === 0) turn.endTurnSeenAt = Date.now();
            await flush();
            continue;
          }

          // ── tool results ──────────────────────────────────────────────
          if (item.type === "user") {
            const results = contentBlocks(item.message?.content).map(asRecord).filter((block) => block.type === "tool_result");
            /**
             * `tool_use_result` IS PER MESSAGE, NOT PER BLOCK.
             *
             * It carries the tool's full structured Output — for a file edit,
             * the `structuredPatch` this whole diff feature depends on. But the
             * SDK hangs it off the message rather than off the block, so with
             * two results in one message there is no way to know which it
             * describes. Attaching it anyway would put one file's diff on
             * another file's row, which is worse than having no diff at all.
             */
            const structured = results.length === 1 ? item.tool_use_result : undefined;
            for (const block of results) {
              const useId = str(block.tool_use_id);
              const open = useId ? turn.openTools.get(useId) : undefined;
              if (!open || !useId) continue;
              turn.openTools.delete(useId);
              turn.openTopLevelTools.delete(useId);
              const failed = block.is_error === true;
              const output = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? null);
              if (!failed && structured) noteTaskOutput(structured, output);
              emit({
                kind: "item.completed",
                itemId: open.id,
                status: failed ? "failed" : "completed",
                detail: withToolResult(open.detail, output, structured),
              });
            }
            await flush();
          }
        }

        if (signal.aborted) throw signal.reason ?? new Error("driver cancelled");
        // THE OTHER WAY A LIMIT ENDS A TURN: the stream stops without a result
        // frame at all. Measured on the retry path, the CLI does not always get
        // as far as saying it failed — so the same evidence answers here, or a
        // rate-limited turn would fail as `driver_failed` purely because the
        // provider hung up quietly rather than loudly.
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
        // A wait the stream ended inside is over — the turn is not waiting for
        // anything any more, whatever the reason it stopped. The watch goes
        // with it: a timer left armed past the turn would open a row on a sink
        // that has stopped taking.
        closeProviderWait();
        disarmProviderSilence();
        // A compaction the stream ended inside is over: finished if the CLI
        // said so and only the boundary never came, failed otherwise.
        if (turn.compactionItemId) emit({ kind: "item.completed", itemId: turn.compactionItemId, status: turn.compactionSucceeded ? "completed" : "failed" });
        /**
         * A task left running when the turn ended is closed as failed.
         *
         * THIS MATTERS MORE THAN THE TOOL CASE ABOVE. `livenessOf()` reads task
         * state to answer "is this session still working", and a sub-agent
         * stuck at `running` makes a finished detached session claim it is
         * still busy — forever, with no live stream to correct it and nothing
         * for a human to stop. BACKGROUND WORK is left alone: outliving its
         * turn is what background means — and that includes an agent that was
         * launched detached, which is still running inside the live process
         * and will report through the next turn's pump.
         */
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
      } catch (error) {
        /**
         * DOES THE PROCESS SURVIVE THE FAILED TURN? Only for a stop that
         * interrupted cleanly — the stream is still open and ALIGNED, because
         * the interrupted turn's own result was consumed above (or never
         * will arrive, in which case the escalation already destroyed the
         * runtime and `streamEnded` says so). Anything else — stream death, a
         * non-success result, an SDK throw — leaves a process this driver
         * cannot vouch for, so the next turn cold-starts from `resume`.
         */
        if (turn.persistent && (!signal.aborted || turn.streamEnded)) runtimes.destroy(sessionId);
        throw error;
      } finally {
        turn.turnDone = true;
        turn.cancelReap?.();
        signal.removeEventListener("abort", onAbort);
        if (turn.persistent) {
          runtimes.release(sessionId);
          // Only what the CLI says BETWEEN turns names a wake-up. A task that
          // spoke inside this turn (its own `task_started`) is not what woke
          // the model — measured: two monitor ticks both attributed to a
          // shell that had merely been launched in the same turn.
          turn.runtime.tasks.lastWokenTaskId = undefined;
          /**
           * AND THE GATE STOPS POINTING AT THIS TURN (#891). Nothing used to
           * clear it, so the work this turn deliberately left alive kept asking
           * a claim that had just settled. From here it asks through
           * `backgroundGate`, which opens a claim of its own — and, when there
           * is nothing alive to open one for, says so honestly instead.
           */
          // A turn that ran with NO gate (the `full-access` shape) leaves none:
          // opening a claim to decide what nobody was going to be asked about
          // would write a turn per tool call for nothing.
          turn.runtime.bindings.current = { ...turn.runtime.bindings.current, canUseTool: turn.canUseTool ? backgroundGate : undefined };
          // The turn is over; the process is not. Keep reading it.
          if (sessionHooks && !turn.runtime.streamEnded) startIdlePump(turn.runtime, sessionHooks);
        } else turn.runtime.destroy();
      }
    },
  };
}
