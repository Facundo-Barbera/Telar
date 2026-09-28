import type { EngineClient, ProviderDriverKind } from "@telar/engine-client";
import type { TelarToolSocket } from "../telar-socket";
import type { BrowserToolSocket, LoginGrantStore, SecretsProvider } from "../domains/browser";
import type { TurnDriver } from "../provider-contract";

// Every verb goes back over the loopback socket, so the embedded and out-of-process workers
// hold the same toolkit. What is absent is absent on purpose: nothing archives, deletes or
// merges; no `updateProjectPrompt`; no `resumeSession`; no `submitTurn` (an agent's message).
export type WorkerClient = Pick<
  EngineClient,
  | "health"
  | "registerWorker"
  | "workerHeartbeat"
  | "claimTurn"
  | "markTurnRunning"
  | "reportObservations"
  | "openRequest"
  | "completeTurn"
  | "failTurn"
  | "openProviderTurn"
  | "reportSessionTasks"
  | "ackSteer"
  | "settleSession"
  | "listProjects"
  | "projectNotes"
  | "projectNote"
  | "createProjectNote"
  | "updateProjectNote"
  | "deleteProjectNote"
  | "projectPrompts"
  | "createProjectPrompt"
  | "deleteProjectPrompt"
  | "liveSessions"
  | "ds"
  | "latex"
  | "runConfigurations"
  | "createRunConfiguration"
  | "updateRunConfiguration"
  | "removeRunConfiguration"
  | "runStatus"
  | "startRun"
  | "openTerminal"
  | "stopRun"
  | "restartRun"
  | "runOutput"
  | "runWait"
  | "runBytes"
  | "writeRun"
  | "resizeRun"
  | "plugin"
  | "createSession"
  | "submitAgentTurn"
  | "events"
  | "session"
  | "stopSession"
  | "sessionDiff"
  | "subscribe"
  | "unsubscribe"
  | "subscriptions"
  | "subscribeCohort"
  | "cohorts"
  | "resolveRequest"
  | "findSessions"
  | "sessionOutline"
  | "runItems"
  | "runItem"
  | "turnAnswer"
  | "grepSession"
>;

/** A bare `TurnDriver` runs every turn; a function picks the driver the claim names. */
export type DriverSelector = TurnDriver | ((driver: ProviderDriverKind) => TurnDriver | undefined);

export class UnsupportedDriverError extends Error {
  constructor(driver: string) {
    super(`this worker has no driver for ${driver}`);
    this.name = "UnsupportedDriverError";
  }
}

export type WorkerDiagnostic = { event: string; operation?: string; code?: string; status?: number; transport?: string; outageMs?: number; elapsedMs?: number };

export type EngineWorkerOptions = {
  client: WorkerClient;
  workerId: string;
  /** Re-reads the plugins folder when a claim names a plugin this worker has no wall for. */
  refreshPlugins?: () => void;
  driver: DriverSelector;
  browserSocket?: BrowserToolSocket;
  /** Serves the `telar` wall to providers that take MCP servers as config (Codex, OpenCode). */
  telarSocket?: TelarToolSocket;
  secrets?: SecretsProvider;
  /** Absent means every secret fill asks. */
  loginGrants?: LoginGrantStore;
  /** Turns run at once, counted over claims only. Absent means `defaultWorkerConcurrency()`. */
  concurrency?: number;
  pollMs?: number;
  /** The interval a quiet worker slows to; 0 never slows. Only safe when someone calls `wake()`. */
  idlePollMs?: number;
  onConnectionLost?: () => void;
  /** Set only by the daemon for its in-process worker, whose registration is never pruned. */
  leaseExempt?: boolean;
  now?: () => number;
  pause?: (ms: number) => Promise<void>;
  /** Test barriers; `starting` fires immediately before the driver runs. */
  onClaimPhase?: (phase: "requested" | "granted" | "starting" | "idle") => void;
  /** Sanitized connectivity diagnostics; never a message, URL, header or token. Defaults to stderr. */
  onDiagnostic?: (fields: { event: string; operation?: string; code?: string; status?: number; transport?: string; outageMs?: number }) => void;
};
