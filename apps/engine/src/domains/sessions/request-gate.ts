import {
  autoResolution,
  deadlineResolution,
  defaultAllowed,
  EngineRequest as RequestSchema,
  type EngineEvent,
  type EngineRequest,
  type RequestDecision,
  type RequestDefault,
  type RequestDetail,
  type RequestKind,
  type RequestOpenResult,
  type RequestResolver,
  type Turn,
  type WorkerStatus,
} from "@telar/engine-client";
import { assertId, EngineStateError, type JournalEntry, type Kernel } from "../../platform/kernel";
import type { EngineNotifier } from "../../state";
import type { SessionQueue } from "./queue";
import type { SessionRecords } from "./records";
import type { SessionRequests } from "./requests";

/**
 * What a timed-out request tells the model that asked, via `reason`: without it a declined default reads like a
 * person saying no, and a model that reads it as a failed attempt re-opens the same request in a loop nobody watches.
 */
const TIMEOUT_REASON =
  "Nobody answered before this request's deadline, so the default stated when it was opened was taken. A person did not decide this. Do not re-open the same request — say what happened and carry on, or ask something the person can answer later.";

export function requestTitle(detail: RequestDetail): string {
  switch (detail.kind) {
    case "command_execution":
      return detail.command.command;
    case "file_change":
      return `${detail.change.kind} ${detail.change.path}`;
    case "file_read":
      return detail.read.path;
    case "tool_call":
      return detail.call.name;
    case "user_input":
      return detail.prompt;
    case "secret_access":
      // Origin only: the notification body may land on a lock screen.
      return `Fill login from 1Password — ${detail.secret.origin}`;
  }
}

export type OpenRequestInput = {
  requestId: string;
  kind: RequestKind;
  detail: RequestDetail;
  itemId?: string;
  providerRefs?: EngineRequest["providerRefs"];
  deadlineMs?: number;
  default?: RequestDefault;
};

export type ResolveRequestInput = { decision: RequestDecision; resolvedBy?: RequestResolver; reason?: string; answers?: Record<string, unknown> };

export type RequestGateHost = {
  requireRunningClaim(sessionId: string, runId: string, claimToken: string): Turn;
  /** An open request implies a running claim, so these sessions are the whole candidate set. */
  liveQueueSessionIds(): Iterable<string>;
  scanQueue(sessionId: string): SessionQueue;
  appendEvent(sessionId: string, event: JournalEntry, runId?: string): EngineEvent;
  requestOpened(sessionId: string, turn: Turn, request: EngineRequest): void;
};

/** The permission gate: requests parked for a person, the policy that answers them first, and their deadlines. */
export class RequestGate {
  constructor(
    private readonly kernel: Kernel<EngineNotifier>,
    private readonly records: SessionRecords,
    private readonly requests: SessionRequests,
    private readonly host: RequestGateHost,
  ) {}

  list(sessionId: string): EngineRequest[] {
    this.records.require(sessionId);
    return structuredClone([...this.requests.read(sessionId).values()]);
  }

  /**
   * The engine decides, from the contract's `autoResolution`, so the settings screen and the engine cannot disagree.
   * Idempotent on `requestId`. A deadline and default are the asker's own terms, refused rather than dropped.
   */
  open(sessionId: string, runId: string, claimToken: string, input: OpenRequestInput): RequestOpenResult {
    return this.kernel.command("openRequest", () => {
      assertId(input.requestId, "request id");
      if (input.deadlineMs !== undefined && (!Number.isSafeInteger(input.deadlineMs) || input.deadlineMs <= 0)) {
        throw new EngineStateError("invalid_request", "a request deadline is a positive whole number of milliseconds");
      }
      if (input.default !== undefined && !defaultAllowed(input.kind)) {
        throw new EngineStateError("invalid_request", `a ${input.kind} request may not carry a default — a deadline may not release a secret`);
      }
      if (input.default !== undefined && input.deadlineMs === undefined) {
        throw new EngineStateError("invalid_request", "a request default needs a deadline for anything to take it");
      }
      const turn = this.host.requireRunningClaim(sessionId, runId, claimToken);
      const session = this.records.get(sessionId);
      const requests = this.requests.read(sessionId);

      const known = requests.get(input.requestId);
      if (known) {
        return known.state === "resolved"
          ? { state: "resolved", requestId: known.id, decision: known.decision!, resolvedBy: known.resolvedBy! }
          : { state: "open", requestId: known.id, notified: known.notified ?? false };
      }

      const at = this.kernel.now();
      const automatic = autoResolution(session.runtimeMode, input.kind);
      const request: EngineRequest = {
        id: input.requestId,
        runId: turn.runId,
        sessionId,
        state: automatic ? "resolved" : "open",
        detail: input.detail,
        openedAt: at,
        ...(input.itemId ? { itemId: input.itemId } : {}),
        ...(input.providerRefs ? { providerRefs: input.providerRefs } : {}),
        ...(automatic ? { decision: automatic, resolvedBy: "policy" as const, resolvedAt: at } : {}),
        ...(!automatic && input.deadlineMs !== undefined ? { deadlineMs: input.deadlineMs } : {}),
        ...(!automatic && input.default !== undefined ? { default: input.default } : {}),
      };

      if (!automatic) {
        // Record whether anyone was reached: "stuck and nobody was told" has to be a detectable state.
        const notify = () => this.kernel.notifier?.({ sessionId, runId: turn.runId, requestId: request.id,
          kind: input.kind, title: requestTitle(input.detail) }) ?? false;
        request.notified = false;
        this.kernel.afterCommit(() => {
          // Outside the transaction: a crash here leaves a durable, explicitly unnotified open request.
          try {
            const latest = this.requests.read(sessionId);
            const pending = latest.get(request.id);
            if (pending?.state !== "open") return;
            pending.notified = notify();
            this.requests.write(sessionId, latest);
          } catch { /* retain the unnotified request for the next reader */ }
        });
      }

      const written = RequestSchema.safeParse(request);
      if (!written.success) throw new EngineStateError("invalid_request", "invalid request");
      requests.set(request.id, request);
      this.requests.write(sessionId, requests);
      this.host.appendEvent(sessionId, { type: "request.opened", request }, turn.runId);

      if (automatic) {
        this.host.appendEvent(sessionId, { type: "request.resolved", requestId: request.id, decision: automatic, resolvedBy: "policy" }, turn.runId);
        return { state: "resolved", requestId: request.id, decision: automatic, resolvedBy: "policy" };
      }
      this.records.touch(sessionId, at);
      this.host.requestOpened(sessionId, turn, request);
      return { state: "open", requestId: request.id, notified: request.notified ?? false };
    });
  }

  /** A person, a timeout or a cancellation answering a parked request. */
  resolve(sessionId: string, requestId: string, input: ResolveRequestInput): EngineRequest {
    return this.kernel.command("resolveRequest", () => {
      assertId(requestId, "request id");
      const requests = this.requests.read(sessionId);
      const request = requests.get(requestId);
      if (!request) throw new EngineStateError("not_found", "request does not exist");
      if (request.state === "resolved") throw new EngineStateError("conflict", "request has already been resolved");
      const at = this.kernel.now();
      request.state = "resolved";
      request.decision = input.decision;
      request.resolvedBy = input.resolvedBy ?? "human";
      request.resolvedAt = at;
      if (input.reason !== undefined) request.reason = input.reason;
      if (input.answers !== undefined) request.answers = input.answers;
      requests.set(request.id, request);
      this.requests.write(sessionId, requests);
      this.records.touch(sessionId, at);
      this.host.appendEvent(
        sessionId,
        { type: "request.resolved", requestId: request.id, decision: request.decision, resolvedBy: request.resolvedBy, ...(request.reason ? { reason: request.reason } : {}) },
        request.runId,
      );
      return structuredClone(request);
    });
  }

  /**
   * Answered requests a worker is still blocked on, polled on the heartbeat because the worker has no inbound socket.
   * An index lookup per claimed session, which also trims resolutions no running claim can take any more.
   */
  resolutionsForWorker(workerId: string): WorkerStatus["resolved"] {
    assertId(workerId, "worker id");
    return [...this.host.liveQueueSessionIds()].flatMap((sessionId) => {
      const turns = this.host.scanQueue(sessionId).turns;
      const claimed = new Map(turns.filter((turn) => turn.claim?.workerId === workerId && turn.state === "running").map((turn) => [turn.runId, turn] as const));
      if (claimed.size === 0) return [];
      this.requests.trim(sessionId, turns);
      return [...this.requests.live(sessionId).values()]
        .filter((request) => request.state === "resolved" && request.decision && claimed.has(request.runId))
        .map((request) => ({
          requestId: request.id,
          sessionId,
          runId: request.runId,
          decision: request.decision!,
          ...(request.reason ? { reason: request.reason } : {}),
          ...(request.answers ? { answers: request.answers } : {}),
        }));
    });
  }

  /**
   * Takes the default the asker wrote down for every request past its deadline; `deadlineResolution` is the one rule,
   * and it answers `null` without a default. The worker hears through `resolutionsForWorker`. Answers the ids resolved.
   */
  sweepDeadlines(): string[] {
    const now = this.kernel.now();
    const resolved: string[] = [];
    for (const sessionId of Array.from(this.host.liveQueueSessionIds())) {
      // Snapshot first: each resolution rewrites the index being read.
      let due: Array<{ request: EngineRequest; answer: RequestDefault }>;
      try {
        due = [...this.requests.live(sessionId).values()].flatMap((request) => {
          // `=== null`, not truthiness: a falsy check would be a second copy of the no-default rule and hide a broken contract.
          const answer = deadlineResolution(request, now);
          if (answer === null || request.deadlineMs === undefined) return [];
          return [{ request, answer }];
        });
      } catch {
        // One unreadable session must not stop the sweep for the rest.
        continue;
      }
      for (const { request, answer } of due) {
        try {
          this.resolve(sessionId, request.id, {
            decision: answer.decision,
            resolvedBy: "timeout",
            reason: TIMEOUT_REASON,
            ...(answer.answers ? { answers: answer.answers } : {}),
          });
        } catch {
          // Resolved, cancelled or gone since the snapshot: settled either way.
          continue;
        }
        resolved.push(request.id);
      }
    }
    return resolved;
  }
}
