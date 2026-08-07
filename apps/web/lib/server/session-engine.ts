// The server-side owner of queued chat execution.
//
// Queue persistence and transition policy live in @telar/core. This adapter
// owns the one web-host concern core cannot: invoking the configured chat turn
// runner. Renderers enqueue commands and observe state; none of them drains it.
import {
  claimNextSessionTurn,
  commitSessionTurn,
  failSessionTurn,
  markSessionTurnRunning,
  recoverSessionQueue,
  type JsonValue,
} from "@telar/core";
import { isSessionRunLive } from "@/lib/chat-runs";
import { consumeSSE } from "@/lib/sse";

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
};

const globals = globalThis as unknown as { __telarSessionEngine?: EngineGlobals };
const engine = (globals.__telarSessionEngine ??= {});
const inFlight = (engine.inFlight ??= new Map());
const recovered = (engine.recovered ??= new Set());

export function registerSessionTurnExecutor(executor: TurnExecutor): void {
  engine.executor = executor;
}

function ensureRecovered(sessionId: string): void {
  if (recovered.has(sessionId)) return;
  recoverSessionQueue(sessionId);
  recovered.add(sessionId);
}

async function drain(sessionId: string): Promise<void> {
  ensureRecovered(sessionId);
  for (;;) {
    if (isSessionRunLive(sessionId)) return;
    const executor = engine.executor ?? defaultTurnExecutor;
    const claimed = claimNextSessionTurn(sessionId, `web:${process.pid}`);
    if (!claimed) return;
    const key = claimed.item.idempotencyKey;
    try {
      // From this point the turn may reach a provider. A process death therefore
      // recovers it as ambiguous rather than replaying arbitrary tool effects.
      markSessionTurnRunning(sessionId, key, claimed.claimToken);
      await executor(claimed.item.payload);
      commitSessionTurn(sessionId, key, claimed.claimToken);
    } catch (error) {
      failSessionTurn(
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
