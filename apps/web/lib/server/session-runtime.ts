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
// TURN END IS A POLICY, NOT A STREAM EVENT. The pump ends a turn's message
// feed when a `result` has been seen AND no background tasks are live — the
// common case, identical to the old teardown point. When background tasks ARE
// live, the turn stays open while they produce messages (the user keeps
// watching their agents, exactly as before), and ends after QUIET_GRACE_MS of
// silence — the silent-holder case (a dev server parked in background Bash),
// where the turn's SSE closes but the RUNTIME stays: the process, the dev
// server, and tool execution all survive to the next turn. Messages that
// arrive while no turn is attached are consumed and counted but not rendered
// (v1 limitation, recorded in deferred-work.md — the work itself completes,
// which under the old shape it never did).
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

/** How long a turn's feed stays open after its result while background tasks
 *  hold the session, absent any message traffic. Working agents emit messages
 *  continuously and reset this; only silent holders (a parked dev server) let
 *  it fire. Generous on purpose: firing early costs rendering, never
 *  correctness — the runtime and its tasks live on either way. */
const QUIET_GRACE_MS = 15_000;

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
   *  semantics — the payload is the full set). */
  liveTaskCount: number;
  turnActive: boolean;
  lastActivity: number;
  closed: boolean;
  /** Messages consumed while no turn was attached — the v1 rendering gap,
   *  surfaced as a count so it is at least observable. */
  detachedMessages: number;
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
  _resultSeen: boolean;
  _grace: ReturnType<typeof setTimeout> | null;
  _abort: AbortController;
  _pumpError: unknown;
  _quietGraceMs: number;
};

const g = globalThis as unknown as { __telarSessionRuntimes?: Map<string, RuntimeInternals> };
const runtimes = (g.__telarSessionRuntimes ??= new Map<string, RuntimeInternals>());

function endTurnFeed(rt: RuntimeInternals): void {
  if (rt._grace) clearTimeout(rt._grace);
  rt._grace = null;
  rt._turn?.close();
  rt._turn = null;
  rt.turnActive = false;
  rt._resultSeen = false;
}

function armGrace(rt: RuntimeInternals): void {
  if (rt._grace) clearTimeout(rt._grace);
  rt._grace = setTimeout(() => {
    // Only silent holders reach here: result seen, tasks live, no traffic.
    // The turn's feed closes; the runtime — and the tasks — stay.
    if (rt.turnActive && rt._resultSeen) endTurnFeed(rt);
  }, rt._quietGraceMs);
}

function pumpMessage(rt: RuntimeInternals, msg: SDKMessage): void {
  rt.lastActivity = Date.now();
  const m = msg as { type?: string; subtype?: string; tasks?: unknown[] };
  if (m.type === "system" && m.subtype === "background_tasks_changed") {
    rt.liveTaskCount = Array.isArray(m.tasks) ? m.tasks.length : 0;
  }

  if (rt.turnActive && rt._turn) {
    rt._turn.push(msg);
    if (m.type === "result") rt._resultSeen = true;
    if (rt._resultSeen) {
      if (rt.liveTaskCount === 0) endTurnFeed(rt);
      else armGrace(rt);
    }
    return;
  }
  rt.detachedMessages++;
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
  quietGraceMs?: number;
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
    liveTaskCount: 0,
    turnActive: false,
    lastActivity: Date.now(),
    closed: false,
    detachedMessages: 0,
    _input: inputQueue,
    _turn: null,
    _resultSeen: false,
    _grace: null,
    _abort: abort,
    _pumpError: undefined,
    _quietGraceMs: args.quietGraceMs ?? QUIET_GRACE_MS,

    push(message) {
      inputQueue.push(message);
    },

    beginTurn(runId) {
      if (rt.turnActive) throw new Error("session runtime already has an attached turn");
      const turnQueue = new AsyncQueue<SDKMessage>();
      rt._turn = turnQueue;
      rt._resultSeen = false;
      rt.turnActive = true;
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

/** Test/diagnostic surface. */
export function liveSessionRuntimeCount(): number {
  return runtimes.size;
}
