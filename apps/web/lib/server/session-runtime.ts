// A SESSION'S CLI PROCESS OUTLIVES ITS TURN, AND THIS MODULE IS WHY (#28).
//
// THE KILL-ZONE, MEASURED. With a single-prompt `query()` (the route's old
// shape), the CLI treats the moment the main turn's final result lands as "no
// user is coming back": every tool call issued after it — a background
// sub-agent's, a background Bash wake's, even the CLI's own auto-continuation
// of the MAIN thread — is cancelled in single-digit milliseconds and filled
// with the compiled-in "The user doesn't want to take this action right now"
// sentence, stamped `toolDenialKind: "cancelled"` in the CLI's own transcript.
// Measured 2026-08-07, session 9ec50a2e, matched wrapper/CLI 0.3.224/2.1.224:
// a pre-allowed Glob was among the victims, so no permission surface anywhere
// was consulted. The agents then OBEY the sentence and stand down — that is
// the phantom-decline bug, and it is unfixable per-message because the text
// is compiled into the CLI binary.
//
// THE SAME SCENARIO WITH STREAMING INPUT DOES NOT HAVE A KILL-ZONE. Holding
// the prompt open as an AsyncIterable<SDKUserMessage> (the shape this module
// feeds), the identical spawn-background-agents-and-end-turn script ran to
// completion: sub-agent Bash calls executed AFTER the result, the completion
// notification woke the main agent, and its post-result tool call ran too.
// Zero fillers. The kill-zone is a property of the single-prompt query's
// post-result state, nothing else.
//
// SO: one runtime per session, holding one streaming-input `query()` whose
// input stays open across turns. A POST pushes a user message and consumes
// THIS turn's messages; background work started in a turn keeps its process —
// and its tool execution — after the result. `setMcpPermissionModeOverride`
// (streaming-only, silently a no-op on the old shape) starts working as a
// side effect.
//
// WHAT IS PER-SESSION vs PER-TURN. Everything `query()` is created with —
// model, permission mode, MCP servers, system prompt, cwd — is per-session
// and captured in `fingerprint`; a POST whose fingerprint differs gets a
// fresh runtime (graceful close + `resume`), the same restart-on-change shape
// t3code's adapter uses for runtime-mode switches. Everything wired to a
// LIVE HTTP RESPONSE — the SSE `send`, the interactive canUseTool, the
// compaction notifiers, the turn's runId — is per-turn and installed into
// `slots` for exactly the duration of the POST; query() receives trampolines
// that read the slots at call time (see the route), so the same process can
// serve turn after turn, each with its own response stream.
//
// TURN END IS THE RESULT MESSAGE, FULL STOP. The pump ends a turn's message
// feed the moment `result` lands — regardless of live background tasks. The
// first version of this module instead held the feed open under a resettable
// quiet-grace while tasks were live, and the user's report told the story:
// working agents emit messages continuously, every message re-armed the
// grace, and the UI never got its turn back (nine measured minutes past the
// result). The coupling was rendering: ending the feed used to mean LOSING
// post-turn output. The WINDOW SINK removes that coupling — a turn installs
// one before it begins, and every message that arrives with no turn attached
// is handed to it (the route projects it into the session feed, where the
// client's background tail renders it). When the task roster empties while
// detached, the sink's onSettled closes the window. Tasks visibly BECOME
// background instead of holding the turn hostage.
//
// STOP MEANS STOP, UNCHANGED. stopChatRun's abort maps to `closeNow` — the
// whole runtime dies, background tasks included, exactly what Stop killed
// before. The gentler `interrupt()` refinement is deliberately not taken yet.
//
// globalThis-backed like lib/permissions.ts and lib/chat-runs.ts, for the same
// reason: pendings, runs and runtimes must all survive a Next dev HMR reload
// or every dev-server code change would orphan a live CLI process.

import type {
  CanUseTool,
  HookInput,
  HookJSONOutput,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  normalizeBackgroundTasks,
  type BackgroundTask,
} from "@/lib/background-tasks";

/** What the model is told when a gated tool call arrives while no turn (and
 *  therefore no interactive surface) is attached. Deliberately NOT the CLI's
 *  filler sentence and deliberately not a claim about the user: nobody was
 *  asked, nobody refused, and the agent should keep working with what it has.
 *  (Legitimately reachable only by a background agent that outlived its
 *  turn's quiet-grace and then called a non-pre-approved tool.) */
export const DETACHED_DENY_TEXT =
  "No interactive approval surface is attached between turns, so this call was " +
  "not shown to anyone — nobody refused it. Continue with your pre-approved " +
  "tools and include what you could not do in your report.";

/** How long the window sink lingers after the task roster empties before
 *  settling, re-armed by every further detached message. Catches the CLI's
 *  trailing control-plane messages (a completing agent's task_notification
 *  arrives AFTER the roster update) and the SDK auto-continuation the empty
 *  roster wakes. Costs nothing user-facing: the turn already ended at its
 *  result; only the window's terminal marker waits out the linger. */
const SETTLE_LINGER_MS = 1_500;

/** The linger span while a detached AUTO-CONTINUATION is generating. An
 *  extended-thinking block's silent gap routinely exceeds the short linger
 *  (owner's live find: the window closed mid-thought and the continuation's
 *  final answer was dropped). Long enough to ride out thinking; still a real
 *  watchdog against a wedged CLI, and the continuation's own result always
 *  returns the window to the short span. */
const CONTINUATION_WATCHDOG_MS = 60_000;

/** Idle runtimes (no turn attached, no message traffic) are reaped after this
 *  long. A reaped runtime's next POST recreates it with `resume` — the cost is
 *  a process spawn, the same cost every turn paid before this module. */
const IDLE_REAP_MS = 30 * 60_000;

/** Per-turn wiring, installed by the active POST and cleared in its finally.
 *  Everything here belongs to a live HTTP response; the trampolines handed to
 *  query() read these at call time. */
export type TurnSlots = {
  canUseTool: CanUseTool | null;
  send: ((event: string, data: unknown) => void) | null;
  runId: string | null;
  preCompactNotify: ((input: HookInput) => Promise<HookJSONOutput>) | null;
  postCompactNotify: ((input: HookInput) => Promise<HookJSONOutput>) | null;
};

/** The between-turns rendering surface. Installed by a turn's POST alongside
 *  its slots but NOT cleared by detachTurn — it exists precisely for the
 *  messages that arrive after the turn is gone. The route's implementation
 *  projects into the session feed; onSettled closes the window (terminal
 *  marker + persistence of post-turn output) when the task roster empties
 *  while no turn is attached. Cleared by beginTurn (the new turn's own POST
 *  renders live traffic), by settle, and by close. */
export type WindowSink = {
  onDetachedMessage: (message: SDKMessage) => void;
  onSettled: () => void;
  /** The turn's own canUseTool closure, kept reachable for the window: its
   *  card emission degrades to the log/feed mirror once the POST is gone, and
   *  the pending registry + permission route work without a live response —
   *  so a background agent asking between turns parks a real card instead of
   *  dying on the detached deny. Null only if the installer had none. */
  canUseTool: CanUseTool | null;
};

class AsyncQueue<T> {
  private items: T[] = [];
  private wake: (() => void) | null = null;
  private done = false;

  push(item: T): void {
    if (this.done) return;
    this.items.push(item);
    this.wake?.();
    this.wake = null;
  }

  close(): void {
    this.done = true;
    this.wake?.();
    this.wake = null;
  }

  get closed(): boolean {
    return this.done;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      while (this.items.length) yield this.items.shift() as T;
      if (this.done) return;
      await new Promise<void>((r) => (this.wake = r));
    }
  }
}

export type SessionRuntime = {
  /** runId of the creating turn until system:init, the session id after. */
  key: string;
  readonly fingerprint: string;
  readonly slots: TurnSlots;
  /** Set at system:init via adoptSession; read by the MCP-server closures. */
  sessionId: string | null;
  query: Query;
  /** Live background tasks per the SDK's `background_tasks_changed` (REPLACE
   *  semantics — the payload is the full set).
   *
   *  THE LIST, NOT A COUNT. This used to be `liveTaskCount: number` and the
   *  descriptions died at the point of receipt — so the pinned environment,
   *  whose whole job is "what is this session touching RIGHT NOW", could not
   *  name a single piece of background work, and the composer called a
   *  backgrounded `bun test` an "agent". Keeping the roster costs one array per
   *  session and is what every surface downstream renders. Claude-only; see
   *  lib/background-tasks.ts on why a Codex session's roster is always empty. */
  liveTasks: readonly BackgroundTask[];
  turnActive: boolean;
  lastActivity: number;
  closed: boolean;
  /** F2: set by interruptSessionRuntime, cleared at the next beginTurn —
   *  how the POST's teardown tells a user's Stop apart from a genuine
   *  mid-turn error when it decides to write "Stopped — kept what
   *  arrived." under the exchange. */
  interruptedTurn: boolean;
  /** Messages consumed while no turn was attached — kept as an observability
   *  counter; with a window sink installed they are rendered, not dropped. */
  detachedMessages: number;
  /** See WindowSink. Installed by the turn's POST, read by the pump. */
  windowSink: WindowSink | null;
  push(message: SDKUserMessage): void;
  /** Single consumer at a time; enforced by chat-runs' single-active-turn
   *  reservation, asserted here as the last line of defence. */
  beginTurn(runId: string): AsyncIterable<SDKMessage>;
  /** Clears every slot and closes a still-open turn feed. Called in the POST's
   *  finally so a late canUseTool call can never reach a dead SSE controller. */
  detachTurn(): void;
  adoptSession(sessionId: string): void;
  /** Graceful: end the input stream and let the CLI finish and exit. Falls
   *  back to a hard abort if the process lingers. */
  close(reason: string): void;
  /** Immediate: abort the query — Stop semantics, background tasks included. */
  closeNow(reason: string): void;
};

type RuntimeInternals = SessionRuntime & {
  _input: AsyncQueue<SDKUserMessage>;
  _turn: AsyncQueue<SDKMessage> | null;
  _abort: AbortController;
  _pumpError: unknown;
  _settle: ReturnType<typeof setTimeout> | null;
  _settleLingerMs: number;
  _continuationWatchdogMs: number;
  /** A detached GENERATION message was seen since the last result — the
   *  SDK's auto-continuation is mid-flight and the linger runs on the
   *  watchdog span until its own result closes the loop. */
  _continuationOpen: boolean;
};

const g = globalThis as unknown as { __telarSessionRuntimes?: Map<string, RuntimeInternals> };
const runtimes = (g.__telarSessionRuntimes ??= new Map<string, RuntimeInternals>());

function endTurnFeed(rt: RuntimeInternals): void {
  rt._turn?.close();
  rt._turn = null;
  rt.turnActive = false;
}

function pumpMessage(rt: RuntimeInternals, msg: SDKMessage): void {
  rt.lastActivity = Date.now();
  const m = msg as { type?: string; subtype?: string; tasks?: unknown[] };
  if (m.type === "system" && m.subtype === "background_tasks_changed") {
    // A LEVEL SIGNAL: swap the roster for the payload, never pair edges (the
    // SDK's own instruction — a missed bookend would otherwise wedge a stale
    // "still working" indicator forever). The message ALSO travels on, to the
    // turn feed or the window sink below, where the projector turns it into
    // the client's "tasks" event; this assignment is the server's own copy,
    // read by the teardown's window decisions and the done payload.
    rt.liveTasks = normalizeBackgroundTasks(m.tasks);
  }

  if (rt.turnActive && rt._turn) {
    rt._turn.push(msg);
    // Turn end IS the result — background tasks keep the RUNTIME, never the
    // feed (see the header: the resettable quiet-grace this replaced held the
    // UI hostage for exactly as long as the agents kept talking).
    if (m.type === "result") endTurnFeed(rt);
    return;
  }

  rt.detachedMessages++;
  const sink = rt.windowSink;
  if (!sink) return;
  try {
    sink.onDetachedMessage(msg);
  } catch {
    // the sink is best-effort rendering — it must never wedge the pump
  }
  // THE CONTINUATION IS GENERATION, NOT CHATTER (owner's live find on
  // nightly .4). A task_notification wakes the SDK's auto-continuation of
  // the main thread — and its first move is often an extended-thinking
  // block whose SILENT gap exceeds the short linger. Measured: the window
  // closed mid-thought ("marker → thinking → closed" in the live log) and
  // the continuation's tool calls and final answer — real gh commands, the
  // whole rundown the user was promised — ran into a sink-less runtime and
  // were dropped. So a detached message that IS generation (assistant
  // output, stream events, tool_result carriers) holds the window on a
  // long watchdog; the continuation's own `result` returns to the short
  // linger, which is the endgame it was designed for. Control-plane
  // chatter alone never extends beyond the short span.
  const parented =
    (msg as { parent_tool_use_id?: string | null }).parent_tool_use_id != null;
  if (m.type === "result") rt._continuationOpen = false;
  else if (
    !parented &&
    (m.type === "assistant" || m.type === "stream_event" || m.type === "user")
  ) {
    // MAIN-THREAD generation only: a subagent's relayed output carries
    // parent_tool_use_id and its lifecycle is the roster's business — the
    // roster emptying IS its end, and holding the watchdog for it would
    // resurrect the quiet-grace this module exists to have killed.
    rt._continuationOpen = true;
  }
  // The roster emptied while no turn was attached: the window is ENDING — but
  // not instantly. The CLI sends trailing control-plane messages AFTER the
  // roster update (measured: a completing agent's task_notification landed
  // post-roster-empty and an immediate settle dropped it — its tab showed
  // "Working" forever), and the roster emptying is also exactly what wakes
  // the SDK's auto-continuation of the main thread. So settle after a short
  // LINGER, re-armed by every further detached message: trailing signals and
  // continuation output keep rendering, and the window closes on true
  // silence. This holds nothing hostage — unlike the deleted quiet-grace,
  // the turn (and the composer) ended at the result long ago; only the
  // window's terminal marker waits.
  if (rt.liveTasks.length === 0) armSettleLinger(rt);
}

function armSettleLinger(rt: RuntimeInternals): void {
  if (rt._settle) clearTimeout(rt._settle);
  const span = rt._continuationOpen ? rt._continuationWatchdogMs : rt._settleLingerMs;
  const t = setTimeout(() => {
    rt._settle = null;
    const sink = rt.windowSink;
    if (!sink || rt.turnActive || rt.liveTasks.length > 0) return;
    rt.windowSink = null;
    rt._continuationOpen = false;
    try {
      sink.onSettled();
    } catch {
      // best-effort, as above
    }
  }, span);
  (t as { unref?: () => void }).unref?.();
  rt._settle = t;
}

async function pump(rt: RuntimeInternals): Promise<void> {
  try {
    for await (const msg of rt.query) pumpMessage(rt, msg);
  } catch (e) {
    // Surface the failure into an attached turn rather than swallowing it —
    // the route's catch turns it into an SSE "error" exactly as it did when it
    // owned the for-await directly.
    if (rt.turnActive && rt._turn) {
      endTurnFeed(rt);
      rt._pumpError = e;
    }
  } finally {
    rt.closed = true;
    endTurnFeed(rt);
    if (runtimes.get(rt.key) === rt) runtimes.delete(rt.key);
  }
}

function reapIdle(now: number): void {
  for (const rt of [...runtimes.values()]) {
    if (!rt.turnActive && now - rt.lastActivity > IDLE_REAP_MS) rt.close("idle");
  }
}

export function acquireSessionRuntime(args: {
  key: string;
  fingerprint: string;
  /** Builds the streaming query. Receives the runtime-to-be's slots and a
   *  self-reference getter so trampolines and MCP closures can read live
   *  state; MUST pass `abortController` through to query(). */
  create: (ctx: {
    slots: TurnSlots;
    input: AsyncIterable<SDKUserMessage>;
    abort: AbortController;
    self: () => SessionRuntime;
  }) => Query;
  /** Tests only — production callers take the default. */
  settleLingerMs?: number;
  /** Test hook, like settleLingerMs. */
  continuationWatchdogMs?: number;
}): { runtime: SessionRuntime; created: boolean } {
  reapIdle(Date.now());

  const existing = runtimes.get(args.key);
  if (existing && !existing.closed) {
    if (existing.fingerprint === args.fingerprint && !existing.turnActive) {
      return { runtime: existing, created: false };
    }
    // Options changed (or a turn is somehow still attached — chat-runs should
    // have 409'd that upstream): restart-on-change, the t3code shape. Graceful
    // close; the replacement resumes by session id.
    existing.close(
      existing.fingerprint === args.fingerprint ? "stale turn attachment" : "options changed",
    );
  }

  const inputQueue = new AsyncQueue<SDKUserMessage>();
  const abort = new AbortController();
  const slots: TurnSlots = {
    canUseTool: null,
    send: null,
    runId: null,
    preCompactNotify: null,
    postCompactNotify: null,
  };

  const rt: RuntimeInternals = {
    key: args.key,
    fingerprint: args.fingerprint,
    slots,
    sessionId: null,
    query: undefined as unknown as Query,
    liveTasks: [],
    turnActive: false,
    interruptedTurn: false,
    lastActivity: Date.now(),
    closed: false,
    detachedMessages: 0,
    windowSink: null,
    _input: inputQueue,
    _turn: null,
    _abort: abort,
    _pumpError: undefined,
    _settle: null,
    _settleLingerMs: args.settleLingerMs ?? SETTLE_LINGER_MS,
    _continuationWatchdogMs: args.continuationWatchdogMs ?? CONTINUATION_WATCHDOG_MS,
    _continuationOpen: false,

    push(message) {
      inputQueue.push(message);
    },

    beginTurn(runId) {
      if (rt.turnActive) throw new Error("session runtime already has an attached turn");
      const turnQueue = new AsyncQueue<SDKMessage>();
      rt._turn = turnQueue;
      rt.turnActive = true;
      rt.interruptedTurn = false;
      rt._continuationOpen = false;
      // The new turn's POST renders live traffic now — the previous window's
      // sink is done (its still-live tasks' output rides THIS turn's feed),
      // and a pending settle linger with it.
      rt.windowSink = null;
      if (rt._settle) clearTimeout(rt._settle);
      rt._settle = null;
      rt.slots.runId = runId;
      const self = rt;
      return {
        async *[Symbol.asyncIterator]() {
          for await (const msg of turnQueue) yield msg;
          // A pump failure while this turn was attached rethrows HERE, on the
          // consuming POST, matching the old direct for-await's error path.
          if (self._pumpError) {
            const e = self._pumpError;
            self._pumpError = undefined;
            throw e;
          }
        },
      };
    },

    detachTurn() {
      rt.slots.canUseTool = null;
      rt.slots.send = null;
      rt.slots.runId = null;
      rt.slots.preCompactNotify = null;
      rt.slots.postCompactNotify = null;
      if (rt.turnActive) endTurnFeed(rt);
    },

    adoptSession(sessionId) {
      rt.sessionId = sessionId;
      if (rt.key !== sessionId) {
        if (runtimes.get(rt.key) === rt) runtimes.delete(rt.key);
        rt.key = sessionId;
        runtimes.set(sessionId, rt);
      }
    },

    close(reason) {
      void reason; // named for call sites; the runtime does not log (yet)
      if (rt.closed) return;
      inputQueue.close();
      // The CLI exits on its own once input ends and in-flight work settles;
      // the timer is the backstop for a process that lingers anyway. unref so
      // a closing dev server is not held open by backstops.
      const t = setTimeout(() => rt.closeNow("close backstop"), 10_000);
      (t as { unref?: () => void }).unref?.();
    },

    closeNow(reason) {
      void reason; // named for call sites; the runtime does not log (yet)
      if (!rt.closed) {
        rt.closed = true;
        rt.windowSink = null;
        if (rt._settle) clearTimeout(rt._settle);
        rt._settle = null;
        endTurnFeed(rt);
        inputQueue.close();
        abort.abort();
      }
      if (runtimes.get(rt.key) === rt) runtimes.delete(rt.key);
    },
  } as RuntimeInternals;

  rt.query = args.create({
    slots,
    input: inputQueue,
    abort,
    self: () => rt,
  });

  runtimes.set(args.key, rt);
  void pump(rt);
  return { runtime: rt, created: true };
}

/** Stop-button semantics: kill the session's runtime if one is live. Keyed by
 *  either the session id or a creating turn's runId (pre-init). */
export function closeSessionRuntime(key: string): boolean {
  const rt = runtimes.get(key);
  if (!rt) return false;
  rt.closeNow("stopped");
  return true;
}

// F2's watchdog (message-lifecycle STEP 2): an interrupt that produces no
// receipt within this window is treated as unsupported/wedged and escalates
// to the kill the Stop button has always meant. 5s is generous for a control
// round-trip and short enough that Stop still feels like Stop.
const INTERRUPT_WATCHDOG_MS = 5_000;

/** Stop the TURN and keep the runtime (message-lifecycle F2): the warm
 *  process, its context, and its background agents all survive — measured,
 *  not assumed (rewind probe (e): the same streaming query accepted and
 *  answered a new turn after its interrupt).
 *
 *  Three outcomes, and the caller treats only the first as "the session
 *  lives": "interrupted" (receipt arrived, nothing left queued),
 *  "escalated" (no receipt in 5s, the receipt reported still-queued input,
 *  or the call threw — the runtime is closed hard, exactly what Stop meant
 *  before this function existed), "no-runtime" (nothing to stop here; the
 *  caller falls through to stopChatRun's abort for run-only turns).
 *
 *  The capability CANNOT be gated on initializationResult(): probe finding
 *  (d) — this CLI build advertises no capabilities field at all. Attempting
 *  the interrupt IS the detection; the watchdog is the guard. */
export async function interruptSessionRuntime(
  key: string,
): Promise<"interrupted" | "escalated" | "no-runtime"> {
  const rt =
    runtimes.get(key) ?? [...runtimes.values()].find((r) => !r.closed && r.sessionId === key);
  if (!rt || rt.closed) return "no-runtime";
  // Only an ACTIVE TURN is interruptible. The presence line's Stop targets
  // the whole session between turns — background agents and all — and that
  // is the caller's kill-fallback, not an interrupt; swallowing it here
  // would make "Stop the background work" a no-op.
  if (!rt.turnActive) return "no-runtime";
  rt.interruptedTurn = true;
  try {
    const receipt = await Promise.race([
      rt.query.interrupt(),
      new Promise<never>((_, reject) => {
        const t = setTimeout(
          () => reject(new Error("interrupt watchdog")),
          INTERRUPT_WATCHDOG_MS,
        );
        (t as { unref?: () => void }).unref?.();
      }),
    ]);
    const stillQueued = (receipt as { still_queued?: unknown[] } | undefined)?.still_queued;
    if (Array.isArray(stillQueued) && stillQueued.length > 0) {
      // Input the interrupt could not cancel would run as a phantom turn the
      // moment we walk away — that is not "stopped" by any honest reading.
      rt.closeNow("interrupt left queued input");
      return "escalated";
    }
    rt.lastActivity = Date.now();
    return "interrupted";
  } catch {
    rt.closeNow("interrupt failed");
    return "escalated";
  }
}

/** Whether this session's ACTIVITY WINDOW is still open — a turn attached, a
 *  background task live, or a sink still awaiting settle. The events route's
 *  liveness gate reads this alongside chat-runs' isSessionRunLive: a session
 *  whose POST ended at `result` but whose agents are still working is LIVE to
 *  a tail subscriber, which is what makes the work visibly background. */
export function isSessionWindowLive(key: string): boolean {
  const rt = runtimes.get(key);
  if (!rt || rt.closed) return false;
  return rt.turnActive || rt.liveTasks.length > 0 || rt.windowSink !== null;
}

/** Test/diagnostic surface. */
export function liveSessionRuntimeCount(): number {
  return runtimes.size;
}
