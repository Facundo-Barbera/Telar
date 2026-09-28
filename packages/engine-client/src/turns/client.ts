import type { UsageSnapshot } from "../protocol/common";
import type { Turn, WorkerTurnFailure } from "../protocol/entities";
import type { EngineEvent, EventPage, TurnModelSelection, TurnSubmissionResult } from "../protocol/events";
import type { AgentTurnInput, ProviderTurnOpenInput, RequestOpenResult, TurnObservation, WorkerClaim, WorkerStatus } from "../protocol/observations";
import type { EngineRequest, RequestDecision, RequestDefault, RequestDetail, RequestKind } from "../protocol/requests";
import type { EngineTransport } from "../platform/transport";
import { queryOf, sessionPath } from "../sessions/client";
import type { RunItemRead, RunItemsAnswer, TurnAnswerRead } from "./schema";

const turnPath = (sessionId: string, runId: string) => `${sessionPath(sessionId)}/turns/${encodeURIComponent(runId)}`;
const worker = (workerId: string, action: string) => `/v2/workers/${encodeURIComponent(workerId)}/${action}`;

function events(transport: EngineTransport, sessionId: string, after = 0, limit?: number): Promise<EventPage> {
  return transport.request("GET", `${sessionPath(sessionId)}/events${queryOf({ after, limit })}`);
}

export const turnsClient = {
  events(this: EngineTransport, sessionId: string, after = 0, limit?: number): Promise<EventPage> {
    return events(this, sessionId, after, limit);
  },

  async drainEvents(this: EngineTransport, sessionId: string, after = 0, options?: { limit?: number; pages?: number }): Promise<EventPage> {
    let cursor = after;
    let drained: EngineEvent[] = [];
    for (let page = 0; page < (options?.pages ?? 100); page += 1) {
      const read = await events(this, sessionId, cursor, options?.limit);
      drained = drained.length ? [...drained, ...read.events] : read.events;
      cursor = Math.max(cursor, read.cursor);
      if (!read.more) return { events: drained, cursor, more: false };
    }
    return { events: drained, cursor, more: true, next: cursor };
  },

  submitTurn(
    this: EngineTransport,
    sessionId: string,
    input: { runId: string; input: string; kind?: "message" | "compact"; model?: TurnModelSelection; attachments?: string[] },
  ): Promise<TurnSubmissionResult> {
    return this.request("POST", `${sessionPath(sessionId)}/turns`, input);
  },

  submitAgentTurn(this: EngineTransport, sessionId: string, input: AgentTurnInput): Promise<TurnSubmissionResult> {
    return this.request("POST", `${sessionPath(sessionId)}/turns/agent`, input);
  },

  /** What one run did, as a list to choose from. */
  runItems(this: EngineTransport, sessionId: string, runId: string): Promise<RunItemsAnswer> {
    return this.request("GET", `${sessionPath(sessionId)}/runs/${encodeURIComponent(runId)}/items`);
  },

  runItem(this: EngineTransport, sessionId: string, runId: string, step: number | string, options: { maxChars?: number } = {}): Promise<RunItemRead> {
    return this.request("GET", `${sessionPath(sessionId)}/runs/${encodeURIComponent(runId)}/items/${encodeURIComponent(String(step))}${queryOf(options)}`);
  },

  /** The answer alone, sliced, with its true length. */
  turnAnswer(this: EngineTransport, sessionId: string, options: { runId?: string; from?: number; limit?: number } = {}): Promise<TurnAnswerRead> {
    return this.request("GET", `${sessionPath(sessionId)}/answer${queryOf(options)}`);
  },

  stopTurn(this: EngineTransport, sessionId: string, runId?: string): Promise<{ turn?: Turn; stopped: boolean }> {
    return this.request("POST", `${sessionPath(sessionId)}/stop`, { runId });
  },

  /** Runs a message recovery held, after a person has re-read it. */
  releaseHeldTurn(this: EngineTransport, sessionId: string, runId: string): Promise<{ turn: Turn }> {
    return this.request("POST", `${turnPath(sessionId, runId)}/release`, {});
  },

  resumeRateLimitedTurn(this: EngineTransport, sessionId: string, runId: string): Promise<{ turn: Turn }> {
    return this.request("POST", `${turnPath(sessionId, runId)}/resume`, {});
  },

  discardAmbiguousTurn(this: EngineTransport, sessionId: string, runId: string): Promise<{ turn: Turn }> {
    return this.request("POST", `${turnPath(sessionId, runId)}/discard`, {});
  },

  promoteTurn(this: EngineTransport, sessionId: string, runId: string): Promise<{ turn: Turn }> {
    return this.request("POST", `${turnPath(sessionId, runId)}/promote`, {});
  },

  ackSteer(this: EngineTransport, sessionId: string, steerRunId: string, claimToken: string): Promise<{ turn: Turn }> {
    return this.request("POST", `${turnPath(sessionId, steerRunId)}/steer-ack`, { claimToken });
  },

  registerWorker(this: EngineTransport, workerId: string): Promise<{ worker: { workerId: string }; heartbeatIntervalMs?: number }> {
    return this.request("POST", "/v2/workers/register", { workerId }, undefined, "registerWorker");
  },

  /** Idempotent, so re-polling cannot duplicate work; `signal` keeps a hung heartbeat from pinning its loop. */
  workerHeartbeat(this: EngineTransport, workerId: string, signal?: AbortSignal, acknowledgedTaskStops?: string[]): Promise<WorkerStatus> {
    return this.request("POST", worker(workerId, "heartbeat"), { acknowledgedTaskStops }, signal, "workerHeartbeat");
  },

  claimTurn(this: EngineTransport, workerId: string, claimSeq: number, signal?: AbortSignal): Promise<{ claim?: WorkerClaim }> {
    return this.request("POST", worker(workerId, "claim"), { claimSeq }, signal, "claimTurn");
  },

  openProviderTurn(this: EngineTransport, sessionId: string, input: ProviderTurnOpenInput): Promise<{ turn: Turn }> {
    return this.request("POST", `${sessionPath(sessionId)}/turns/provider`, input);
  },

  /** Task reports between turns: no claim, worker-authenticated. */
  reportSessionTasks(this: EngineTransport, sessionId: string, workerId: string, observations: TurnObservation[]): Promise<{ accepted: number }> {
    return this.request("POST", `${sessionPath(sessionId)}/tasks`, { workerId, observations });
  },

  markTurnRunning(this: EngineTransport, sessionId: string, runId: string, claimToken: string): Promise<{ turn: Turn }> {
    return this.request("POST", `${turnPath(sessionId, runId)}/running`, { claimToken });
  },

  /** Batched: one round trip per delta would dominate the cost of streaming. */
  reportObservations(this: EngineTransport, sessionId: string, runId: string, claimToken: string, observations: TurnObservation[]): Promise<{ accepted: number }> {
    return this.request("POST", `${turnPath(sessionId, runId)}/observe`, { claimToken, observations });
  },

  /** Answered at once by the runtime mode, or parked; a parked answer arrives on the heartbeat. */
  openRequest(
    this: EngineTransport,
    sessionId: string,
    runId: string,
    claimToken: string,
    input: { requestId: string; kind: RequestKind; detail: RequestDetail; itemId?: string; deadlineMs?: number; default?: RequestDefault },
  ): Promise<RequestOpenResult> {
    return this.request("POST", `${turnPath(sessionId, runId)}/request`, { claimToken, ...input });
  },

  /** `resolvedBy: "session"` is the only resolver a caller may name; anything else is recorded as a person's. */
  resolveRequest(
    this: EngineTransport,
    sessionId: string,
    requestId: string,
    input: { decision: RequestDecision; reason?: string; answers?: Record<string, unknown>; resolvedBy?: "session" },
  ): Promise<{ request: EngineRequest }> {
    return this.request("POST", `${sessionPath(sessionId)}/requests/${encodeURIComponent(requestId)}`, input);
  },

  /** Idempotent by claim token, so a bounded attempt whose response is lost is safe to repeat. */
  completeTurn(
    this: EngineTransport,
    sessionId: string,
    runId: string,
    claimToken: string,
    result: { text: string; providerSessionId?: string; usage?: UsageSnapshot },
    signal?: AbortSignal,
  ): Promise<{ turn: Turn }> {
    return this.request("POST", `${turnPath(sessionId, runId)}/complete`, { claimToken, ...result }, signal, "completeTurn");
  },

  failTurn(this: EngineTransport, sessionId: string, runId: string, claimToken: string, failure: WorkerTurnFailure, signal?: AbortSignal): Promise<{ turn: Turn }> {
    return this.request("POST", `${turnPath(sessionId, runId)}/fail`, { claimToken, ...failure }, signal, "failTurn");
  },
};
