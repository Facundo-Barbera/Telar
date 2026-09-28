import type { ProviderDriverKind } from "@telar/engine-client";
import type { TelarCapabilities, TelarSocketLease } from "../telar-socket";
import type { BrowserRunBinding, BrowserSocketLease, SecretsProvider } from "../domains/browser";
import type { DriverRequestOutcome, TurnDriver } from "../drivers";
import type { SteerMailbox } from "../domains/turns";
import type { EngineWorkerOptions, WorkerDiagnostic } from "./options";

export type Settlement = {
  sessionId: string;
  runId: string;
  claimToken: string;
  operation: "completeTurn" | "failTurn";
  send: (signal: AbortSignal) => Promise<unknown>;
};

export type PendingSteerAck = { sessionId: string; steerRunId: string; claimToken: string };

export type BrowserRefs = {
  gate: NonNullable<BrowserRunBinding["gate"]>;
  onNavigated: NonNullable<BrowserRunBinding["onNavigated"]>;
  fillSecret: NonNullable<BrowserRunBinding["fillSecret"]>;
};

/** What a running turn needs from the worker that claimed it. */
export type TurnHost = {
  readonly options: EngineWorkerOptions;
  /** Every live turn's abort, by claim token; provider-opened turns included. */
  readonly active: Map<string, AbortController>;
  /** The subset of `active` that came from a claim, which the concurrency cap counts. */
  readonly activeClaims: Set<string>;
  /** Approvals a driver is parked on, keyed `${runId}:${requestId}`; answered by the heartbeat. */
  readonly awaiting: Map<string, (outcome: DriverRequestOutcome) => void>;
  /** Acked on drain, not on push: a pushed message can still be lost when the turn settles first. */
  readonly steering: Map<string, { mailbox: SteerMailbox; pendingAck: PendingSteerAck[] }>;
  readonly pushedSteers: Set<string>;
  /** Kept across turns because the token is baked into the provider process; `refs` follow the live claim. */
  readonly browserLeases: Map<string, { lease: BrowserSocketLease; refs: BrowserRefs }>;
  /** One wall lease per session, keyed by the enabled plugin set; `capabilities` follow the live turn. */
  readonly telarLeases: Map<string, { key: string; lease?: TelarSocketLease; capabilities: { current: TelarCapabilities } }>;
  /** The session's live claim, read when `sessions_send` is called: the capability outlives its turn. */
  readonly liveClaims: Map<string, { runId: string; claimToken: string }>;
  readonly providerTurnsWanted: Map<string, AbortController>;
  readonly stopDeliveredAt: Map<string, number>;
  readonly pluginsLookedFor: Set<string>;
  stopped(): boolean;
  shuttingDown(): boolean;
  settle(entry: Settlement): Promise<"settled" | "pending">;
  recordInterruption(sessionId: string, runId: string, claimToken: string): Promise<void>;
  noteConnectivityFailure(error: unknown): void;
  driverFor(kind: ProviderDriverKind): TurnDriver;
  diagnose(fields: WorkerDiagnostic): void;
  now(): number;
  secrets(): SecretsProvider;
};
