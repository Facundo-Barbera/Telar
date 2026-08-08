// The server-side owner of queued chat execution.
//
// Queue persistence and transition policy live in @telar/core. This adapter
// owns the one web-host concern core cannot: invoking the configured chat turn
// runner. Renderers enqueue commands and observe state; none of them drains it.
//
// It also AUTHORS this session's machinery turns — an Ultra run that reached an
// outcome, a loom watch whose loom reached a trigger state. Both were produced
// by the client's session-injections hook (what remains of it is
// components/session/use-watcher-alerts.ts, which draws cards and authors
// nothing) until this file took them, which made every one of them
// tab-dependent (defect D8 in
// docs/plans/session-loop-graph.html): no open tab, no wake, and a remount reset
// the in-memory latches that were their ONLY dedupe. A server-authored ticket
// keyed per event replaces both halves at once — the durable key is the latch,
// so one terminal event can produce at most one ticket ever.
import {
  claimNextSessionTurn,
  commitSessionTurn,
  dismissFailedSessionTurn,
  enqueueSessionTurn,
  failSessionTurn,
  getLoom,
  getUltraManifest,
  listSessionQueueIds,
  listUltraRuns,
  listWatches,
  markSessionTurnRunning,
  pendingUltraWakes,
  readSessionQueue,
  readUltraWakeRecord,
  recoverSessionQueue,
  sessionTurnKind,
  type JsonValue,
  type SessionQueueItem,
  type UltraManifest,
} from "@telar/core";
import { isSessionRunLive } from "@/lib/chat-runs";
import { consumeSSE } from "@/lib/sse";
import { getChat } from "@/lib/store";
import { ULTRA_WAKE_SENTINEL } from "@/lib/ultra-wake";

type TurnExecutor = (payload: JsonValue) => Promise<void>;

export async function assertQueuedTurnSucceeded(response: Response): Promise<void> {
  if (!response.body) return;
  let terminalError: string | null = null;
  await consumeSSE(response.body.getReader(), (event, payload) => {
    const data = payload && typeof payload === "object"
      ? payload as Record<string, unknown>
      : {};
    if (event === "interrupted") terminalError = "queued turn was interrupted";
    if (event === "error") {
      terminalError = typeof data.message === "string" ? data.message : "queued turn failed";
    }
    if (event === "done" && data.subtype === "aborted") {
      terminalError = "queued turn was aborted";
    }
  });
  if (terminalError) throw new Error(terminalError);
}

async function defaultTurnExecutor(payload: JsonValue): Promise<void> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("queued chat payload is not an object");
  }
  // Lazy so the queue API can boot the engine after a process restart without
  // requiring a renderer to hit POST /api/chat first. The route imports this
  // module too; by the time the dispatcher calls here this module is initialized,
  // so the cycle is runtime-lazy rather than an evaluation cycle.
  const { POST } = await import("@/app/api/chat/route");
  const response = await POST(
    new Request("http://telar.local/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      if (body?.error) detail = body.error;
    } catch {
      // keep status text
    }
    throw new Error(detail);
  }
  await assertQueuedTurnSucceeded(response);
}

type EngineGlobals = {
  executor?: TurnExecutor;
  inFlight?: Map<string, Promise<void>>;
  recovered?: Set<string>;
  heartbeat?: ReturnType<typeof setInterval>;
};

const globals = globalThis as unknown as { __telarSessionEngine?: EngineGlobals };
const engine = (globals.__telarSessionEngine ??= {});
const inFlight = (engine.inFlight ??= new Map());
const recovered = (engine.recovered ??= new Set());

export function registerSessionTurnExecutor(executor: TurnExecutor): void {
  engine.executor = executor;
}

// DISCARD, NEVER RETRY, and always the engine's own call: `failed` and
// `ambiguous` are answered by a human pressing Retry or Discard on the message,
// and a machinery ticket has no line to carry either button (pendingView drops
// it before any state branch). Left alone, an ambiguous one bars every later
// claim in the session — the session stops sending with no visible cause and no
// fix short of hand-editing queue.json — and a failed one keeps the strip's 2s
// poll alive for the life of the tab. Retry is not the engine's to choose:
// `ambiguous` means the turn may already have reached the provider, which is the
// one thing that state exists to say.
function dismissMachineryTicket(sessionId: string, item: SessionQueueItem): void {
  try {
    dismissFailedSessionTurn(sessionId, item.idempotencyKey, item.revision);
  } catch (error) {
    console.error(
      "[session-engine] could not dismiss machinery ticket",
      sessionId,
      item.idempotencyKey,
      error,
    );
  }
}

function ensureRecovered(sessionId: string): void {
  if (recovered.has(sessionId)) return;
  const { envelope } = recoverSessionQueue(sessionId);
  // Recovery is the only producer of `ambiguous`, so this is the only place a
  // machinery ticket can acquire the claim barrier. The outcome stays in its
  // mailbox undelivered: a run that later reaches a NEW terminal is keyed anew
  // and announced then.
  for (const item of envelope.items) {
    if (sessionTurnKind(item) === "user") continue;
    if (item.state !== "ambiguous" && item.state !== "failed") continue;
    dismissMachineryTicket(sessionId, item);
  }
  recovered.add(sessionId);
}

// A machinery turn is still an ordinary chat POST, so it runs on the session's
// OWN settings: chats.json is the only server-side record of which project,
// account and profile this session belongs to, and POST /api/chat refuses an
// unknown or missing project before any stream opens. The renderer that used to
// author these turns supplied the same fields off its own state.
//
// Null when the row is gone — a deleted chat has nothing to wake.
function machineryTurnPayload(sessionId: string, text: string, key: string): JsonValue | null {
  const chat = getChat(sessionId);
  if (!chat) return null;
  return {
    message: text,
    sessionId,
    // The ticket's key doubles as the turn's runId, so a retry of the same
    // ticket is the same run to Stop-by-runId and to the feed window.
    runId: key,
    model: chat.model,
    account: chat.account,
    ...(chat.project ? { project: chat.project } : {}),
    ...(chat.effort ? { effort: chat.effort } : {}),
    ...(chat.permissionMode ? { permissionMode: chat.permissionMode } : {}),
    ...(chat.runtimeMode ? { runtimeMode: chat.runtimeMode } : {}),
    ...(chat.fastMode ? { fastMode: true } : {}),
    ...(chat.serviceTier ? { serviceTier: chat.serviceTier } : {}),
    ...(chat.role ? { role: chat.role } : {}),
    ...(chat.loomId ? { loomId: chat.loomId } : {}),
  };
}

// THE WAKE TICKET'S KEY IS THE EVENT — the run, plus the terminal it settled
// at — and it is built and taken apart in one place because the claim-time
// re-validation below has to ask about the run THIS ticket speaks for. A key it
// cannot take apart leaves that check asking about the mailbox as a whole, which
// cannot tell "already delivered" from "could not be read".
const wakeTicketKey = (runId: string, terminalAt: number) => `wake:${runId}:${terminalAt}`;

function parseWakeTicketKey(key: string): { runId: string; terminalAt: number } | null {
  if (!key.startsWith("wake:")) return null;
  // Last colon, not the second: a runId is opaque and may carry its own.
  const cut = key.lastIndexOf(":");
  const runId = key.slice("wake:".length, cut);
  const terminalAt = Number(key.slice(cut + 1));
  if (!runId || !Number.isFinite(terminalAt)) return null;
  return { runId, terminalAt };
}

/**
 * Has the outcome this wake ticket speaks for already been settled?
 *
 * POSITIVE EVIDENCE ONLY, and that is the whole point. This asked
 * `pendingUltraWakes(sessionId).length === 0` and read an empty mailbox as
 * "delivered" — but that projection swallows every read failure it meets
 * (`getUltraManifest` and `readUltraWakeRecord` both return null on an
 * unreadable or half-written file), so a manifest that could not be read for one
 * moment committed the only ticket that terminal would ever have, and the
 * retained key deduped every rescan afterwards: the wake was lost silently and
 * permanently. Both clauses below are things a read has to SAY, so a degraded
 * read falls through to running the turn. Delivered twice is the direction the
 * wake module tolerates; lost is not.
 *
 * The two settled shapes, and T10's collapse is the first of them: the ticket in
 * front acked every wake its appendix carried, which stamps each run's record
 * for that terminal, so the tickets behind it drop without running.
 */
function wakeOutcomeSettled(key: string): boolean {
  const parsed = parseWakeTicketKey(key);
  if (!parsed) return false;
  const record = readUltraWakeRecord(parsed.runId);
  if (record?.deliveredAt && record.deliveredTerminalAt === parsed.terminalAt) return true;
  // SUPERSEDED: the run has moved past the terminal this ticket names (a stopped
  // run resumed before its wake drained), so the appendix would carry nothing
  // for it. A new terminal mints its own ticket.
  let manifest: UltraManifest | null = null;
  try {
    manifest = getUltraManifest(parsed.runId);
  } catch {
    return false; // malformed id — never a throw on a turn path
  }
  return !!manifest && manifest.updatedAt !== parsed.terminalAt;
}

/**
 * Enqueue this session's outstanding machinery as durable tickets.
 *
 * IDEMPOTENT BY CONSTRUCTION, and that is the whole point: every key names the
 * EVENT — a run's terminal timestamp, a watch's trigger state — and a settled
 * item keeps its key in the envelope for the life of the session, so
 * enqueueSessionTurn hands back the first ticket rather than minting a second.
 * The client latches this replaces (an announced-runs Set, a lastFired Map) were
 * in-memory and reset on every remount; today's wake-marker loop rode exactly
 * that.
 *
 * NEVER THROWS, and the two producers are isolated from each other. It runs at
 * the top of every drain and on every heartbeat tick, so a corrupt watch file,
 * an unreadable manifest or a missing loom may neither strand a human's queued
 * message behind it nor silence the OTHER producer.
 */
export function scanSessionMachinery(sessionId: string): void {
  if (!sessionId) return;
  try {
    // ONE TICKET PER RUN, and T10's "one turn however many runs" still holds —
    // it is enforced at CLAIM time now (drain's stale-wake drop) instead of by
    // the client's enqueue-time latch. The first ticket's turn acks every wake
    // its appendix carried, so the tickets behind it find an empty mailbox and
    // commit without running. Collapsing these to a single ticket would trade
    // that for a key that names no event, which is what made the client's
    // version loop.
    for (const wake of pendingUltraWakes(sessionId)) {
      // Keyed on the TERMINAL, not the run: a stopped run that is resumed to a
      // new terminal is a new outcome and earns a new ticket, which is the same
      // scoping UltraWakeRecord.deliveredTerminalAt exists for.
      const key = wakeTicketKey(wake.runId, wake.terminalAt);
      // The SENTINEL, never the outcome text — route.ts swaps it for the
      // server-authored instruction and the system-prompt appendix carries the
      // facts. `hidden` marks the ticket as one no renderer should draw as
      // something the human typed; the route's own `hideUserMessage` is what
      // keeps it out of the persisted transcript (two suppressions, both needed).
      const payload = machineryTurnPayload(sessionId, ULTRA_WAKE_SENTINEL, key);
      // `continue`, NOT `return`: a return here exits the whole scan and takes
      // the watch producer below with it, for this tick and every tick the chat
      // row stays missing — the isolation this function's header promises,
      // undone.
      if (!payload) continue;
      enqueueSessionTurn(sessionId, {
        idempotencyKey: key,
        payload,
        kind: "wake",
        hidden: true,
      });
    }
  } catch (error) {
    console.error("[session-engine] ultra wake scan failed", sessionId, error);
  }
  try {
    for (const watch of listWatches(sessionId)) {
      const loom = getLoom(watch.loomId);
      // The client's matching rule, unchanged: an ACTIVE watch (listWatches
      // filters those) whose loom is IN its trigger states.
      if (!loom || !watch.triggerStates.includes(loom.state)) continue;
      // THE IDEMPOTENCY KEY IS THE ONLY DEDUPE, deliberately. core's
      // Watch.lastFiredState and its "fired" status are declared and have never
      // been written by anything; the client's `lastFiredRef` Map was the whole
      // mechanism, and it died with the component.
      //
      // ONCE PER (WATCH, STATE) FOR THE LIFE OF THE SESSION, which is STRICTER
      // than the ref it replaces and deliberately so: the ref held only the LAST
      // state, so a loom oscillating running → blocked → running fired on every
      // return, and the key — retained in the envelope forever — fires on the
      // first. A watcher turn is a "how do you want to proceed?"; asking it twice
      // for the same answer is the failure that matters here.
      const key = `watch:${watch.id}:${loom.state}`;
      const title = typeof loom.title === "string" && loom.title ? loom.title : watch.loomId;
      const payload = machineryTurnPayload(
        sessionId,
        `[watcher] loom ${watch.loomId} (${title}) reached ${loom.state}. How do you want to proceed?`,
        key,
      );
      if (!payload) continue;
      // No `hidden`: a watcher turn is meant to be read. Only the wake's wire
      // text is a sentinel.
      enqueueSessionTurn(sessionId, { idempotencyKey: key, payload, kind: "watch" });
    }
  } catch (error) {
    console.error("[session-engine] loom watch scan failed", sessionId, error);
  }
}

async function drain(sessionId: string): Promise<void> {
  ensureRecovered(sessionId);
  // Every kick sweeps machinery: a kick is a moment this server is demonstrably
  // awake for this session, and the heartbeat below is the only other one.
  scanSessionMachinery(sessionId);
  for (;;) {
    if (isSessionRunLive(sessionId)) return;
    const executor = engine.executor ?? defaultTurnExecutor;
    const claimed = claimNextSessionTurn(sessionId, `web:${process.pid}`);
    if (!claimed) return;
    const key = claimed.item.idempotencyKey;
    const kind = sessionTurnKind(claimed.item);
    // ONE TRY OVER THE WHOLE CLAIM. The stale-wake drop below used to sit above
    // it, and its own transitions can throw (a concurrent write, an envelope
    // that fails validation): the throw left the ticket `claimed`, and a claimed
    // item makes claimNextSessionTurn return null for EVERY later message, so
    // the session's queue was dead until the process restarted, with no UI
    // trace. Inside, a throw is that message's error like any other.
    try {
      // A WAKE TICKET IS ONLY VALID WHILE ITS OUTCOME IS STILL UNDELIVERED —
      // the server-side form of the client drain's SF-2 stale-drop, and the only
      // surviving one now that the drain is gone (see
      // docs/ultra-wake-delivery.md for what shipped before it existed).
      // Nothing downstream re-validates: `isUltraWakeTrigger` is
      // `!!sessionId && message === ULTRA_WAKE_SENTINEL` and consults no state,
      // so a ticket dispatched after an intervening human turn already acked the
      // wakes would run ULTRA_WAKE_PROMPT — "the COMPLETED ULTRA RUNS block in
      // your context above carries each run's outcome" — against a prompt with
      // no such block, on a turn that renders no user bubble.
      const stale = kind === "wake" && wakeOutcomeSettled(key);
      // From this point the turn may reach a provider. A process death therefore
      // recovers it as ambiguous rather than replaying arbitrary tool effects.
      markSessionTurnRunning(sessionId, key, claimed.claimToken);
      // COMMITTED, not cancelled, and with no executor: the outcome was
      // delivered, by the turn that acked it. The running hop is the transition
      // table's — commit only ever follows running.
      if (!stale) await executor(claimed.item.payload);
      commitSessionTurn(sessionId, key, claimed.claimToken);
    } catch (error) {
      const failed = failSessionTurn(
        sessionId,
        key,
        claimed.claimToken,
        error instanceof Error ? error.message : String(error),
      );
      // One message failing is that MESSAGE's error, never a session mode
      // (feel contract rules 11/12): the failed item keeps its text and its
      // own Retry/Discard, and the loop continues — claimNextSessionTurn
      // only ever picks "queued" items, so the failed one is skipped, not
      // stepped over. This used to pauseSessionQueue and return, which
      // silently disabled sending until a human found the Resume button.
      //
      // A machinery ticket has neither text nor those buttons, so the engine
      // answers for it here instead of leaving an invisible item behind.
      if (kind !== "user") dismissMachineryTicket(sessionId, failed);
      continue;
    }
  }
}

/** Start or join this session's single dispatcher. Safe to call repeatedly. */
export function kickSessionQueue(sessionId: string): Promise<void> {
  const existing = inFlight.get(sessionId);
  if (existing) return existing;
  const promise = drain(sessionId).finally(() => {
    if (inFlight.get(sessionId) === promise) inFlight.delete(sessionId);
  });
  inFlight.set(sessionId, promise);
  return promise;
}

const HEARTBEAT_MS = 20_000;

// Which sessions a tick has any reason to look at beyond their own queue: one
// named by a loom watch, or by an Ultra run that is still live or whose outcome
// is not yet marked delivered.
//
// A CANDIDATE PRE-FILTER, NOT A SECOND PROJECTION. `pendingUltraWakes` remains
// the authority on what is pending — scanSessionMachinery asks it — and this
// only narrows the set it is asked about, using the identical delivered check
// that projection skips on. It must stay at LEAST as permissive as that check:
// a session dropped here never gets its wake, and "delivered twice" is the
// failure direction the wake module tolerates while "lost" is not.
function machinerySessionIds(): Set<string> {
  const ids = new Set<string>();
  for (const watch of listWatches()) {
    if (watch.sessionId) ids.add(watch.sessionId);
  }
  for (const manifest of listUltraRuns()) {
    if (!manifest.sessionId) continue;
    const record = readUltraWakeRecord(manifest.runId);
    if (record?.deliveredAt && record.deliveredTerminalAt === manifest.updatedAt) continue;
    ids.add(manifest.sessionId);
  }
  return ids;
}

/**
 * ONE PULSE. Exported so its behaviour is pinned by tests rather than by timers.
 *
 * WHY THIS EXISTS AT ALL, since neither reference implementation has one:
 * without it the engine drains only when kicked — turn end, queue traffic, boot
 * — so anything queued while no tab is open waits indefinitely (defect D5), and
 * a machinery ticket has no renderer left to author it. t3code's stale unstarted
 * turns and OpenCode's hangs are the same defect in both neighbours; the
 * deliberate divergence is recorded in docs/plans/session-loop-graph.html
 * (question 2, "the one place we'd deliberately go beyond both").
 *
 * WHAT A TICK COSTS, stated because the shape invites the opposite reading and
 * this comment once claimed it: `machinerySessionIds` reads EVERY ultra manifest
 * and the whole watch file on every tick, on an idle host, and the run set only
 * grows — there is no index over terminal-but-undelivered runs, and building one
 * is a storage change that does not belong to this pulse. What a tick does NOT
 * do is dispatch on spec: a session is kicked only when its queue file actually
 * holds something `queued`, so no turn starts and no dispatcher is entered for a
 * session with nothing to run. HEARTBEAT_MS buys down the scan, not the
 * dispatch.
 */
export function sessionHeartbeatTick(): void {
  // MACHINERY FIRST, so a ticket minted by this tick is already in the queue
  // file the sweep below reads — including for a session whose queue file this
  // scan is what creates. Scanned here as well as inside drain() because a kick
  // JOINS an in-flight dispatcher rather than starting a second one: while a
  // long turn runs, this is the only path that gets the ticket for an outcome
  // that landed mid-turn into the queue behind it.
  for (const sessionId of machinerySessionIds()) {
    scanSessionMachinery(sessionId);
  }
  for (const sessionId of listSessionQueueIds()) {
    let queued = false;
    try {
      queued = readSessionQueue(sessionId).items.some((item) => item.state === "queued");
    } catch (error) {
      // One unreadable queue is that session's problem, never the pulse's.
      console.error("[session-engine] heartbeat could not read queue", sessionId, error);
      continue;
    }
    // A session with a wake it can never clear used to be re-kicked every tick
    // for the life of the process; nothing queued is nothing to dispatch.
    if (!queued) continue;
    void kickSessionQueue(sessionId).catch((error) => {
      console.error("[session-engine] heartbeat kick failed", sessionId, error);
    });
  }
}

/**
 * Start the pulse. globalThis-backed and idempotent because Next re-evaluates
 * this module on HMR: a second interval would outlive the module that could
 * still clear it, and the two would then race the same queues forever. Unref'd —
 * a heartbeat must never be the reason a process stays alive.
 *
 * False when one was already running.
 */
export function startSessionHeartbeat(): boolean {
  if (engine.heartbeat) return false;
  const timer = setInterval(() => {
    try {
      sessionHeartbeatTick();
    } catch (error) {
      // A tick that throws must not kill the interval with it.
      console.error("[session-engine] heartbeat tick failed", error);
    }
  }, HEARTBEAT_MS);
  timer.unref?.();
  engine.heartbeat = timer;
  return true;
}

/**
 * Clear the pulse and its globalThis handle. TEST TEARDOWN is its only caller —
 * there is no HMR dispose hook registered anywhere, so the globalThis guard in
 * startSessionHeartbeat is the ONLY thing making a re-evaluation safe.
 */
export function stopSessionHeartbeat(): void {
  if (!engine.heartbeat) return;
  clearInterval(engine.heartbeat);
  engine.heartbeat = undefined;
}
