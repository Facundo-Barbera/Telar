import type { EngineClient, ProviderDriverKind, RequestDecision, WorkerClaim } from "@telar/engine-client";
import { EngineClientError } from "@telar/engine-client";
import { ProviderUnavailableError, type TurnDriver } from "./driver";
import { providerProcessEnv } from "./provider-instances";

type WorkerClient = Pick<
  EngineClient,
  | "registerWorker"
  | "workerHeartbeat"
  | "claimTurn"
  | "markTurnRunning"
  | "reportObservations"
  | "openRequest"
  | "completeTurn"
  | "failTurn"
  // The spool's verbs. THE WORKER STILL HOLDS NO STORE HANDLE — these go
  // back over the same loopback socket as everything else here, which is what
  // makes the toolkit identical in the embedded worker and the out-of-process
  // one. See `SpoolCapability`.
  | "spool"
  | "spoolItem"
  | "createSpoolItem"
  | "updateSpoolItem"
  | "consultSpoolExpert"
  | "spoolMap"
  | "openSpoolThread"
  | "setSpoolThreadWaiting"
  | "settleSpoolThread"
  | "answerSpoolQuestion"
  | "spoolFocus"
  | "openSpoolFocus"
  | "closeSpoolFocus"
  | "reconcileSpoolLook"
  | "setSpoolSubjectTerrain"
  | "setSpoolSubjectIdentity"
  | "setSpoolAperture"
  | "setSpoolAreaCeiling"
  | "spoolNotes"
  | "createSpoolNote"
  | "updateSpoolNote"
  | "spoolSearch"
>;

/**
 * Which driver runs a claimed turn.
 *
 * A FUNCTION OF THE CLAIM, not a field set once at construction. The engine
 * decides which provider a session belongs to and says so in `claim.driver`; a
 * worker that captured one driver would happily run a Codex session through the
 * Claude SDK and produce a plausible, wrong transcript. Passing a bare
 * `TurnDriver` is still allowed and means "every turn, regardless of provider",
 * which is what the tests want and what a single-provider deployment is.
 */
export type DriverSelector = TurnDriver | ((driver: ProviderDriverKind) => TurnDriver | undefined);

export class UnsupportedDriverError extends Error {
  constructor(driver: string) {
    super(`this worker has no driver for ${driver}`);
    this.name = "UnsupportedDriverError";
  }
}

export type EngineWorkerOptions = {
  client: WorkerClient;
  workerId: string;
  driver: DriverSelector;
  /** Short testable polling loop; production process supervision is outside this leaf. */
  pollMs?: number;
  /** Used by the process supervisor to rediscover a restarted daemon. */
  onConnectionLost?: () => void;
};

/** A worker is an executor only: every observable lifecycle event travels back through the engine API. */
export class EngineWorker {
  private readonly pollMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  private stopped = false;
  private readonly active = new Map<string, AbortController>();
  private connectionLost = false;
  /**
   * Approvals this worker is blocked on, keyed by request id.
   *
   * A driver sitting inside `canUseTool` is parked on one of these promises.
   * The engine cannot push, so the answer arrives on the next heartbeat and
   * `tick()` settles it — which is why the heartbeat must keep running while a
   * turn is blocked, and therefore why the "one turn at a time" early-return in
   * `tick()` comes AFTER the heartbeat rather than before it.
   */
  private readonly awaiting = new Map<string, (decision: RequestDecision) => void>();

  constructor(private readonly options: EngineWorkerOptions) {
    this.pollMs = options.pollMs ?? 100;
  }

  async start(): Promise<void> {
    await this.options.client.registerWorker(this.options.workerId);
    await this.tick();
    this.timer = setInterval(() => void this.tick(), this.pollMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const controller of this.active.values()) controller.abort(new Error("worker stopped"));
  }

  /** Exposed for deterministic tests and embedded supervisors. */
  async tick(): Promise<void> {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      const status = await this.options.client.workerHeartbeat(this.options.workerId);
      for (const cancellation of status.cancel) this.active.get(cancellation.claimToken)?.abort(new Error("turn stopped"));
      // Settle anything a human answered since the last beat. This must happen
      // even while a turn is active — the turn is what is waiting.
      for (const resolution of status.resolved) {
        const settle = this.awaiting.get(resolution.requestId);
        if (!settle) continue;
        this.awaiting.delete(resolution.requestId);
        settle(resolution.decision);
      }
      if (this.active.size !== 0) return;
      const { claim } = await this.options.client.claimTurn(this.options.workerId);
      if (claim) void this.execute(claim);
    } catch (error) {
      if (isConnectivityLoss(error)) this.loseConnection(error);
      else throw error;
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Takes the CLAIM rather than seven positional fields.
   *
   * The claim is already the engine's complete answer to "what should this
   * worker run" — unpacking it at the call site meant every new field on the
   * contract (the model, most recently) had to be threaded through another
   * positional parameter, in the right order, with nothing to catch a swap of
   * two adjacent strings.
   */
  private async execute(claim: WorkerClaim): Promise<void> {
    const { sessionId, projectRoot: cwd, resumeCursor: providerSessionId, driver: driverKind, model } = claim;
    const { runId, input: prompt } = claim.turn;
    const claimToken = claim.turn.claim!.token;
    const controller = new AbortController();
    this.active.set(claimToken, controller);
    try {
      // AFTER `markTurnRunning`, NOT BEFORE, and the ordering is load-bearing:
      // `failTurn` only settles a turn that is RUNNING, so a worker with no
      // driver for this provider that threw here first would leave the turn
      // stuck at `claimed` until its lease expired, with nothing recorded.
      // Measured — the test below asserted `failed` and got `claimed`.
      await this.options.client.markTurnRunning(sessionId, runId, claimToken);
      const driver = this.driverFor(driverKind);
      const result = await driver.run({
        prompt,
        cwd,
        signal: controller.signal,
        // Spread rather than passed as possibly-undefined: `exactOptionalPropertyTypes`
        // distinguishes "absent" from "present and undefined", and the drivers
        // read absence as "use the provider's own default".
        ...(model?.model ? { model: model.model } : {}),
        ...(model?.effort ? { effort: model.effort } : {}),
        ...(model?.fastMode === undefined ? {} : { fastMode: model.fastMode }),
        // Both arrive ON THE CLAIM, resolved by the engine, for the same reason
        // everything else here does: the worker holds no store handle and must
        // not look anything up between claim and execution.
        ...(claim.turn.attachments?.length ? { attachments: claim.turn.attachments } : {}),
        ...(claim.mcpServers?.length ? { mcpServers: claim.mcpServers } : {}),
        // WHICH LOGIN THIS RUNS AS. Derived here rather than on the claim
        // because it is a fact about spawning a process, and the worker is the
        // process that spawns one — the engine's job was to resolve WHICH
        // instance, which it did. An older engine sends no instance at all, and
        // absence means "run exactly as this worker's own environment does",
        // which is what every session did before the registry existed.
        ...(claim.providerInstance ? { env: providerProcessEnv(claim.providerInstance) } : {}),
        // WHICH BINARY, as opposed to what it inherits. A login may pin its own
        // — a beta build, a second install — and the driver must spawn that one
        // rather than the driver's default, or the settings pane would be
        // describing an executable no turn ever runs.
        ...(claim.providerInstance?.binaryPath ? { binaryPath: claim.providerInstance.binaryPath } : {}),
        // WHICH LOGIN, by id. Not spent on spawning anything — it is what lets a
        // warp agent's task row name whose account ran it, which the contract
        // requires of any row that names a model at all.
        providerInstanceId: claim.providerInstanceId,
        providerSessionId,
        // Sessions are the browser's natural boundary: two sessions must not
        // share a tab, and a session's tabs must survive between its turns.
        browserScopeKey: sessionId,
        /**
         * THE SPOOL, SCOPED TO THIS TURN'S PROJECT.
         *
         * Assembled here, per run, because the scope IS the run's: `claim.project`
         * is the project's own label, and it is what a spool item's `project`
         * field is compared against. Absent leaves the capability unscoped, which
         * is the project-less master's view — and the claim's own comment says
         * why absence means that rather than "no items".
         *
         * EVERY VERB GOES BACK THROUGH THE CLIENT, so the toolkit exercises the
         * same routes the queue does and there is exactly one implementation of
         * every rule about an item.
         */
        spool: {
          ...(claim.project ? { project: claim.project } : {}),
          snapshot: () => this.options.client.spool(),
          item: (id) =>
            this.options.client.spoolItem(id).catch(() => null),
          create: async (input) => (await this.options.client.createSpoolItem(input)).item,
          update: async (id, patch) => (await this.options.client.updateSpoolItem(id, patch)).item,
          consult: (id) => this.options.client.consultSpoolExpert(id),
          // The work-state verbs, through the same client for the same reason:
          // one implementation of every rule, already under test.
          map: () => this.options.client.spoolMap(),
          openThread: async (subject, input) => (await this.options.client.openSpoolThread(subject, input)).thread,
          setWaiting: async (subject, threadId, waiting) =>
            (await this.options.client.setSpoolThreadWaiting(subject, threadId, waiting)).thread,
          settle: async (subject, threadId, answer) =>
            (await this.options.client.settleSpoolThread(subject, threadId, answer)).thread,
          answer: async (itemId, question, answer) =>
            (await this.options.client.answerSpoolQuestion(itemId, question, answer)).item,
          focus: () => this.options.client.spoolFocus(),
          setFocus: async (input) => (await this.options.client.openSpoolFocus(input)).focus,
          endFocus: async (id, end) => (await this.options.client.closeSpoolFocus(id, end)).focus,
          // Loop 1's verbs reach every session the same way the rest do. The
          // reconcile itself is the engine's — deterministic, pull-only — so a
          // scoped session glancing at its own subject spends nothing and can
          // start nothing.
          look: async (subjectKey) => (await this.options.client.reconcileSpoolLook(subjectKey)).look,
          setTerrain: async (subjectKey, terrain) =>
            (await this.options.client.setSpoolSubjectTerrain(subjectKey, terrain)).subject,
          setIdentity: async (subjectKey, patch) =>
            (await this.options.client.setSpoolSubjectIdentity(subjectKey, patch)).subject,
          // Chat and hand share one slot / one record: both of these go through
          // the same routes the room's own controls PUT and PATCH, so there is
          // exactly one implementation of the view and of the clamp.
          setAperture: async (view) => (await this.options.client.setSpoolAperture(view)).aperture,
          setAreaPermits: async (name, ceiling) =>
            (await this.options.client.setSpoolAreaCeiling(name, ceiling)).area,
          // The shelf and the search, through the same client for the same
          // reason as everything above: one implementation of every rule.
          // The toolkit's own handler declares `author: "session"` on create;
          // the capability forwards it verbatim, exactly as `create.source`.
          notes: async () => (await this.options.client.spoolNotes()).notes,
          createNote: async (input) => (await this.options.client.createSpoolNote(input)).note,
          updateNote: async (id, patch) => (await this.options.client.updateSpoolNote(id, patch)).note,
          search: async (query, subject) =>
            (await this.options.client.spoolSearch(query, subject ? { subject } : {})).hits,
        },
        onRequest: async ({ kind, detail, toolUseId }) => {
          const requestId = `req_${toolUseId.replace(/[^A-Za-z0-9_-]/g, "")}`;
          const opened = await this.options.client.openRequest(sessionId, runId, claimToken, {
            requestId,
            kind,
            detail,
          });
          // Auto-resolved by the session's runtime mode — no human involved,
          // no wait. This is the common path in a detached session.
          if (opened.state === "resolved") return opened.decision;

          // Parked. Wait for the heartbeat to carry an answer, or for the turn
          // to be aborted. ABORT MUST SETTLE THIS PROMISE: a stop arriving
          // while a human is deciding would otherwise leave the driver blocked
          // forever inside canUseTool, and the turn would never end.
          return new Promise<RequestDecision>((resolve) => {
            this.awaiting.set(requestId, resolve);
            const onAbort = () => {
              if (!this.awaiting.delete(requestId)) return;
              resolve("cancel");
            };
            if (controller.signal.aborted) onAbort();
            else controller.signal.addEventListener("abort", onAbort, { once: true });
          });
        },
        onObservations: async (observations) => {
          // A stop is terminal the moment the engine records it, and the
          // driver may still be mid-message when the abort lands. Reporting
          // after that point would append rows to a turn that is already
          // settled, which the store rejects as a conflict — so drop them
          // here rather than turning a clean stop into a failure.
          if (controller.signal.aborted) return;
          await this.options.client.reportObservations(sessionId, runId, claimToken, observations);
        },
      });
      if (!controller.signal.aborted) {
        await this.options.client.completeTurn(sessionId, runId, claimToken, {
          text: result.text,
          ...(result.providerSessionId ? { providerSessionId: result.providerSessionId } : {}),
          ...(result.usage ? { usage: result.usage } : {}),
        });
      }
    } catch (error) {
      // Stop is terminal before a worker sees the heartbeat. Never overwrite it with an error.
      if (controller.signal.aborted || (error instanceof EngineClientError && error.code === "conflict")) return;
      if (isConnectivityLoss(error)) {
        this.loseConnection(error);
        return;
      }
      const failure =
        error instanceof ProviderUnavailableError || error instanceof UnsupportedDriverError
          ? { code: "provider_unavailable" as const, message: error.message }
          : { code: "driver_failed" as const, message: error instanceof Error ? error.message : "Telar driver failed" };
      try {
        await this.options.client.failTurn(sessionId, runId, claimToken, failure);
      } catch (settleError) {
        if (!(settleError instanceof EngineClientError && settleError.code === "conflict")) throw settleError;
      }
    } finally {
      this.active.delete(claimToken);
    }
  }

  private driverFor(kind: ProviderDriverKind): TurnDriver {
    const selector = this.options.driver;
    if (typeof selector !== "function") return selector;
    const driver = selector(kind);
    if (!driver) throw new UnsupportedDriverError(kind);
    return driver;
  }

  private loseConnection(reason: unknown): void {
    if (this.connectionLost) return;
    this.connectionLost = true;
    for (const controller of this.active.values()) controller.abort(reason instanceof Error ? reason : new Error("engine connectivity lost"));
    this.options.onConnectionLost?.();
  }
}

function isConnectivityLoss(error: unknown): boolean {
  // A restarted daemon can reuse a port (old capability becomes unauthorized)
  // or forget this worker registration; neither permits stale provider work to
  // continue under the old control-plane lease.
  return (
    error instanceof EngineClientError &&
    (error.code === "engine_unavailable" || error.code === "engine_unauthorized" || error.code === "worker_unavailable")
  );
}
