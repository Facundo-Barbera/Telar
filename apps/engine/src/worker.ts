import crypto from "node:crypto";
import type { EngineClient, ProviderDriverKind, RequestDecision, WorkerClaim } from "@telar/engine-client";
import { EngineClientError, qualifyTelarTool, TELAR_BROWSER_MCP_SERVER } from "@telar/engine-client";
import type { BrowserRunBinding, BrowserSocketLease, BrowserToolSocket } from "./browser/socket";
import { runSecretFill } from "./browser/secret-fill";
import { ProviderUnavailableError, type DriverRequest, type DriverRequestOutcome, type TurnDriver } from "./driver";
import { createOnePasswordSecrets, type SecretsProvider } from "./secrets/onepassword";
import { providerProcessEnv } from "./provider-instances";
import { SteerMailbox } from "./steering";

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
  | "openProviderTurn"
  | "reportSessionTasks"
  | "ackSteer"
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
  // The `sessions` verbs. Same rule as the spool's above: no store handle,
  // everything back over the loopback socket, so the toolkit is identical in
  // the embedded worker and the out-of-process one. See `SessionsCapability`.
  //
  // NOTHING HERE ARCHIVES, DELETES OR MERGES. `EngineClient` has all three, and
  // their absence from this Pick is what makes "the wall cannot land work"
  // true of the worker's own reach and not only of the tool names: a handler
  // that tried would not compile.
  | "liveSessions"
  | "createSession"
  | "submitTurn"
  | "events"
  | "session"
  | "stopTurn"
  | "sessionDiff"
  // Subscriptions and answering a peer's request. `resolveRequest` reaches
  // the same gate a human's answer does; the WALL narrows it — no `cancel`
  // (that is `stopTurn`), no `secret_access` (a vault pick nobody but the
  // person may make) — and stamps `resolvedBy: "session"` so the trail says
  // an agent answered.
  | "subscribe"
  | "unsubscribe"
  | "subscriptions"
  | "resolveRequest"
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

/** Under the browser's scope target (6) with headroom for the machine: four
 *  concurrent provider processes is a laptop's honest ceiling. */
const DEFAULT_WORKER_CONCURRENCY = 4;

/** The deployment knob, read by BOTH worker construction sites so the
 *  embedded and standalone workers cannot drift — same rule as
 *  `createDefaultDrivers`. */
export function workerConcurrencyFromEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.TELAR_WORKER_CONCURRENCY?.trim();
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export type EngineWorkerOptions = {
  client: WorkerClient;
  workerId: string;
  driver: DriverSelector;
  /**
   * The browser, as the worker-hosted MCP socket both drivers are pointed at.
   * Absent means sessions simply have no browser tools — what a test gets,
   * and strictly better than a socket describing a browser that is not there.
   */
  browserSocket?: BrowserToolSocket;
  /**
   * The password-manager read path for `browser_fill_secret`. Defaults to the
   * real `op` CLI adapter; injected by tests so no suite ever spawns one. The
   * default degrades cleanly on a machine without `op` — a sentence, not a
   * crash — so this is safe to construct unconditionally.
   */
  secrets?: SecretsProvider;
  /**
   * HOW MANY TURNS THIS WORKER RUNS AT ONCE. The engine already refuses two
   * concurrent turns of the SAME session (`claimTurn` skips a session with a
   * claimed or running turn), so this cap only decides how many DIFFERENT
   * sessions may progress together — the old hard-coded 1 was why creating
   * three sessions queued them single-file across unrelated projects.
   * Clamped to at least 1; keep it ≤ the browser's scope target
   * (MAX_BROWSER_SCOPES = 6) or concurrent browsing sessions grow Chromiums
   * past what the pool aims to hold.
   */
  concurrency?: number;
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
  /** Lazily built default `op` adapter — one per worker, never per turn. */
  private secrets: SecretsProvider | undefined;
  /**
   * Approvals this worker is blocked on, keyed by request id.
   *
   * A driver sitting inside `canUseTool` is parked on one of these promises.
   * The engine cannot push, so the answer arrives on the next heartbeat and
   * `tick()` settles it — which is why the heartbeat must keep running while a
   * turn is blocked, and therefore why the "one turn at a time" early-return in
   * `tick()` comes AFTER the heartbeat rather than before it.
   */
  private readonly awaiting = new Map<string, (outcome: DriverRequestOutcome) => void>();
  /**
   * Each running turn's steer mailbox plus its unacked deliveries, keyed by
   * claim token like `active`.
   *
   * ACK ON DRAIN, NOT ON PUSH. A pushed message can still be lost — the turn
   * can settle before the driver's next boundary drains it — and an ack at
   * push time would mark that lost message `steered`. A DRAINED message is
   * one the driver holds, so the mailbox's drain hook is where the ack fires;
   * an undrained one leaves the turn `steering`, and the engine's settlement
   * sweep requeues it. A lost ACK still re-carries and re-pushes on a later
   * heartbeat — duplication over loss, the codebase's stated side of that
   * trade; `pushedSteers` narrows it to actually-lost acks.
   */
  private readonly steering = new Map<string, { mailbox: SteerMailbox; pendingAck: Array<{ sessionId: string; steerRunId: string; claimToken: string }> }>();
  private readonly pushedSteers = new Set<string>();
  /**
   * Each session's browser binding, KEPT ACROSS TURNS. The lease's url+token
   * are baked into the Claude session runtime's MCP config at process
   * creation (driver.ts), so a per-turn token would force a new provider
   * process every turn — the exact lifetime this store exists to avoid. The
   * gate and observation sink still belong to a TURN (they ride a claim
   * token), so they delegate through `refs`, re-pointed at the top of every
   * turn. Between turns the stale gate asks the engine against a settled
   * claim and is refused — a browser call from lingering background work is
   * denied rather than approved by a ghost.
   */
  private readonly browserLeases = new Map<
    string,
    {
      lease: BrowserSocketLease;
      refs: {
        gate: NonNullable<BrowserRunBinding["gate"]>;
        onNavigated: NonNullable<BrowserRunBinding["onNavigated"]>;
        /** Per-turn like the gate — its `ask` opens a `secret_access` request
         *  against THIS turn's claim, so a stale one must be refused, not
         *  answered by a ghost. */
        fillSecret: NonNullable<BrowserRunBinding["fillSecret"]>;
      };
    }
  >();

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
    // The session-lived state dies with the WORKER, not with any turn: the
    // browser tokens are revoked and every lingering provider process — the
    // ones deliberately kept alive between turns — is closed.
    for (const { lease } of this.browserLeases.values()) lease.release();
    this.browserLeases.clear();
    const selector = this.options.driver;
    if (typeof selector === "function") {
      try {
        selector("claude")?.dispose?.();
      } catch {
        // A deployment with no Claude driver has nothing to dispose.
      }
    } else {
      selector.dispose?.();
    }
  }

  /** Exposed for deterministic tests and embedded supervisors. */
  async tick(): Promise<void> {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      const status = await this.options.client.workerHeartbeat(this.options.workerId);
      for (const cancellation of status.cancel) this.active.get(cancellation.claimToken)?.abort(new Error("turn stopped"));
      // Settle anything a human answered since the last beat. This must happen
      // even while a turn is active — the turn is what is waiting. KEYED BY
      // RUN AND REQUEST, not request alone: with concurrent turns, two
      // providers could mint the same tool-use id and a request-only key
      // would settle the wrong session's approval.
      for (const resolution of status.resolved) {
        const settle = this.awaiting.get(`${resolution.runId}:${resolution.requestId}`);
        if (!settle) continue;
        this.awaiting.delete(`${resolution.runId}:${resolution.requestId}`);
        // The ANSWERS ride along — a `user_input` request is worthless to the
        // driver as a bare decision.
        settle({ decision: resolution.decision, ...(resolution.answers ? { answers: resolution.answers } : {}) });
      }
      // Stop lingering background tasks the user asked to end. The task lives
      // in the session's live provider process, which this worker's driver
      // holds — no turn, no claim token, just the session and the provider id.
      // Best-effort: the engine has already marked the projection stopped, so
      // a driver that no longer has the runtime (false) simply means the
      // process is gone and the task with it.
      for (const kill of status.stopTask ?? []) {
        const driver = this.driverFor("claude");
        void driver.stopTask?.(kill.sessionId, kill.providerTaskId).catch(() => undefined);
      }
      // Deliver send-now messages into their running turns' mailboxes. The
      // ack fires later, from the mailbox's drain hook — see `steering`.
      for (const delivery of status.steer ?? []) {
        if (this.pushedSteers.has(delivery.steerRunId)) continue;
        const entry = this.steering.get(delivery.claimToken);
        // No mailbox (or closed): this worker cannot deliver — leave the
        // turn `steering`; the engine's settlement sweep requeues it.
        if (!entry?.mailbox.push({ text: delivery.text, ...(delivery.attachments?.length ? { attachments: delivery.attachments } : {}) })) continue;
        this.pushedSteers.add(delivery.steerRunId);
        entry.pendingAck.push({ sessionId: delivery.sessionId, steerRunId: delivery.steerRunId, claimToken: delivery.claimToken });
      }
      // Claim until the cap or the queue runs dry. One claim per call is the
      // engine's shape (`claimNextTurn` hands out the oldest claimable turn),
      // so the loop is what turns a per-tick single claim into real
      // cross-session concurrency.
      const cap = Math.max(1, this.options.concurrency ?? DEFAULT_WORKER_CONCURRENCY);
      while (this.active.size < cap) {
        const { claim } = await this.options.client.claimTurn(this.options.workerId);
        if (!claim) break;
        void this.execute(claim);
      }
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
    // The turn's send-now mailbox, registered before the first heartbeat that
    // could carry a delivery. Closed with the turn — a push after close is
    // refused and the engine's sweep requeues the message instead.
    const steer = new SteerMailbox();
    const steerEntry = { mailbox: steer, pendingAck: [] as Array<{ sessionId: string; steerRunId: string; claimToken: string }> };
    this.steering.set(claimToken, steerEntry);
    steer.onDrain(() => {
      // The driver holds the text now; tell the engine, one ack per delivery.
      // A failed ack leaves `pushedSteers` cleared so a later heartbeat
      // re-carries and re-pushes — the accepted duplicate, never a loss.
      for (const ack of steerEntry.pendingAck.splice(0)) {
        void this.options.client
          .ackSteer(ack.sessionId, ack.steerRunId, ack.claimToken)
          .catch(() => undefined)
          .finally(() => this.pushedSteers.delete(ack.steerRunId));
      }
    });
    /**
     * ONE park/heartbeat implementation for both doors into the engine's gate:
     * the driver's own `onRequest`, and the browser socket's per-call gate.
     * Factored rather than duplicated so an abort settles BOTH the same way.
     */
    /**
     * ONE LINE PER TURN when the engine refuses a tool request because the
     * turn already settled. This is the signature of the premature-completion
     * bug (a `result` consumed while tool calls were still running): every
     * refusal after the first says nothing new, and the driver already turns
     * each into a deny the model can read — but with zero log lines the
     * failure was undiagnosable from the daemon log alone.
     */
    const { askEngine, gate: gateForTurn, onNavigated: onNavigatedForTurn, fillSecret: fillSecretForTurn } = this.bindTurn(sessionId, runId, claimToken, controller);
    let lease: BrowserSocketLease | undefined;
    try {
      // AFTER `markTurnRunning`, NOT BEFORE, and the ordering is load-bearing:
      // `failTurn` only settles a turn that is RUNNING, so a worker with no
      // driver for this provider that threw here first would leave the turn
      // stuck at `claimed` until its lease expired, with nothing recorded.
      // Measured — the test below asserted `failed` and got `claimed`.
      await this.options.client.markTurnRunning(sessionId, runId, claimToken);
      const driver = this.driverFor(driverKind);
      /**
       * THE SESSION'S BROWSER LEASE, one binding per session rather than one
       * per run. The lease's url+token are baked into the provider's live
       * process at creation, and that process now OUTLIVES the turn — a
       * per-run token would invalidate the process's browser access the
       * moment its first turn settled. Per-turn authority still holds: the
       * gate delegates through `refs`, re-pointed here every turn, and a call
       * arriving between turns is asked against a settled claim and refused.
       * Released in `stop()`, when the provider processes die too.
       */
      const cached = this.browserLeases.get(sessionId);
      if (cached) {
        cached.refs.gate = gateForTurn;
        cached.refs.onNavigated = onNavigatedForTurn;
        cached.refs.fillSecret = fillSecretForTurn;
        lease = cached.lease;
      } else if (this.options.browserSocket) {
        const refs = { gate: gateForTurn, onNavigated: onNavigatedForTurn, fillSecret: fillSecretForTurn };
        lease = await this.options.browserSocket.bind({
          // Sessions are the browser's natural boundary: two sessions must not
          // share a tab, and a session's tabs must survive between its turns.
          scopeKey: sessionId,
          gate: (input) => refs.gate(input),
          onNavigated: (state) => refs.onNavigated(state),
          fillSecret: (args, callBrowser) => refs.fillSecret(args, callBrowser),
        });
        this.browserLeases.set(sessionId, { lease, refs });
      }
      const result = await driver.run({
        prompt,
        sessionId,
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
        ...(claim.tasks?.length ? { tasks: claim.tasks } : {}),
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
        // Send-now deliveries land here; how the driver injects them is its
        // own affair (Claude at turn boundaries, Codex mid-turn).
        steer,
        // The browser rides the worker's socket; the driver only learns where
        // and with which credential. Spread on the same absent-means-absent
        // rule as everything above it.
        ...(lease ? { browserSocket: { url: lease.url, token: lease.token } } : {}),
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
        /**
         * THE SESSIONS TOOLKIT — a session's door to OTHER sessions.
         *
         * UNSCOPED, unlike the spool, and that is not an oversight: there is no
         * scope to apply. A session created here is a PEER of the one that
         * asked — no parent, no child, no link recorded anywhere — so there is
         * nothing about this turn for the capability to be narrowed by, and
         * nothing counts how many it creates.
         *
         * EVERY VERB GOES BACK THROUGH THE CLIENT, for the reason the spool's
         * do: the worker holds no store handle, and routing through the same
         * HTTP surface the cockpit uses means there is exactly one
         * implementation of every rule about a session, whichever door
         * reached it.
         *
         * `origin: "session"` IS DECLARED HERE, in this code, and no tool shape
         * on the wall carries it — the same construction as the spool's
         * `source: "session"`.
         */
        sessions: {
          /**
           * THE ONE SCOPED THING ON THIS CAPABILITY: who is asking, so a
           * subscription can name the session to wake. Closed over the claim
           * exactly as the spool's `project` is. The daemon's socket builds
           * this same capability WITHOUT it — a chat client has no session
           * to be woken in — and the wall refuses to subscribe there.
           */
          self: { sessionId },
          list: () => this.options.client.liveSessions(),
          create: async (input) => (await this.options.client.createSession({ ...input, origin: "session" })).session,
          send: async (id, input) => {
            const accepted = await this.options.client.submitTurn(id, input);
            return { turn: accepted.turn, replayed: accepted.replayed };
          },
          read: async (id, after) => (await this.options.client.events(id, after)).events,
          status: async (id) => {
            const snapshot = await this.options.client.session(id);
            return { session: snapshot.session, turns: snapshot.turns };
          },
          stop: (id) => this.options.client.stopTurn(id),
          diff: async (id) => (await this.options.client.sessionDiff(id)).diff,
          subscribe: async (subscriber, input) => (await this.options.client.subscribe(subscriber, input)).subscription,
          unsubscribe: async (id, subscriber) => (await this.options.client.unsubscribe(id, { subscriberSessionId: subscriber })).removed,
          subscriptions: async (subscriber) => (await this.options.client.subscriptions(subscriber)).subscriptions,
          requests: async (id) => (await this.options.client.session(id)).requests,
          resolveRequest: async (id, requestId, input) =>
            (await this.options.client.resolveRequest(id, requestId, { ...input, resolvedBy: "session" })).request,
        },
        onRequest: askEngine,
        onObservations: async (observations) => {
          // A stop is terminal the moment the engine records it, and the
          // driver may still be mid-message when the abort lands. Reporting
          // after that point would append rows to a turn that is already
          // settled, which the store rejects as a conflict — so drop them
          // here rather than turning a clean stop into a failure.
          if (controller.signal.aborted) return;
          await this.options.client.reportObservations(sessionId, runId, claimToken, observations);
        },
        /**
         * THE SESSION'S DOOR FOR WHAT HAPPENS BETWEEN TURNS. The driver keeps
         * reading the provider process after this turn settles; task frames
         * come back through `onTasks` with no claim, and a turn the CLI
         * starts on its own is opened as a PROVIDER TURN — a real turn under
         * a claim this worker holds, with a gate and a sink of its own, so a
         * wake-up's tool calls are decided by a human rather than refused
         * against this turn's settled claim.
         */
        session: {
          onTasks: (observations) =>
            this.options.client.reportSessionTasks(sessionId, this.options.workerId, observations).then(() => undefined),
          onProviderTurn: async ({ input, reason }) => {
            let opened: { turn: { runId: string; claim?: { token: string } } };
            try {
              opened = await this.options.client.openProviderTurn(sessionId, { workerId: this.options.workerId, input, reason });
            } catch (error) {
              // A live turn already has the session: the wake-up's frames
              // are that turn's stream. Anything else is a real failure.
              if (error instanceof EngineClientError && error.code === "conflict") return undefined;
              throw error;
            }
            const providerRunId = opened.turn.runId;
            const providerToken = opened.turn.claim!.token;
            const providerController = new AbortController();
            this.active.set(providerToken, providerController);
            const bound = this.bindTurn(sessionId, providerRunId, providerToken, providerController);
            // The browser's per-turn gate now answers to THIS turn's claim.
            const cached = this.browserLeases.get(sessionId);
            if (cached) {
              cached.refs.gate = bound.gate;
              cached.refs.onNavigated = bound.onNavigated;
              cached.refs.fillSecret = bound.fillSecret;
            }
            return {
              runId: providerRunId,
              onRequest: bound.askEngine,
              onObservations: async (observations) => {
                if (providerController.signal.aborted) return;
                await this.options.client.reportObservations(sessionId, providerRunId, providerToken, observations);
              },
              close: async (result) => {
                this.active.delete(providerToken);
                if (providerController.signal.aborted) return;
                try {
                  if ("failure" in result) {
                    await this.options.client.failTurn(sessionId, providerRunId, providerToken, { code: "driver_failed", message: result.failure });
                  } else {
                    await this.options.client.completeTurn(sessionId, providerRunId, providerToken, {
                      text: result.text,
                      ...(result.providerSessionId ? { providerSessionId: result.providerSessionId } : {}),
                      ...(result.usage ? { usage: result.usage } : {}),
                    });
                  }
                } catch (error) {
                  if (!(error instanceof EngineClientError && error.code === "conflict")) throw error;
                }
              },
            };
          },
        },
      });
      // Drained BEFORE the turn settles. A state read still in flight would
      // otherwise report against a turn the engine has already closed, which
      // it rejects as a conflict — the guarantee the old in-driver queue gave.
      await lease?.drain();
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
      // The lease is deliberately NOT released here — it is the session's
      // now (see the cache above), revoked in `stop()` alongside the
      // provider processes that hold its token.
      steer.close();
      // An undrained delivery was never delivered: forget it here so the
      // heartbeat's re-carry (after the engine's sweep requeues it) is not
      // skipped by the pushed-set.
      for (const ack of steerEntry.pendingAck.splice(0)) this.pushedSteers.delete(ack.steerRunId);
      this.steering.delete(claimToken);
      this.active.delete(claimToken);
    }
  }

  /**
   * EVERYTHING A TURN'S CLAIM BINDS, built once per claim: the engine gate
   * (`askEngine`), and the browser socket's per-turn gate, navigation sink
   * and secret fill on top of it. Extracted so a PROVIDER turn (a wake-up the
   * driver reads between turns) gets exactly the gate a human turn gets —
   * its tool calls decided under its own claim, never refused against a
   * settled one.
   */
  private bindTurn(sessionId: string, runId: string, claimToken: string, controller: AbortController) {
    /**
     * ONE LINE PER TURN when the engine refuses a tool request because the
     * turn already settled. This is the signature of the premature-completion
     * bug (a `result` consumed while tool calls were still running): every
     * refusal after the first says nothing new, and the driver already turns
     * each into a deny the model can read — but with zero log lines the
     * failure was undiagnosable from the daemon log alone.
     */
    let lateRefusalLogged = false;
    const askEngine = async ({ kind, detail, toolUseId }: DriverRequest): Promise<DriverRequestOutcome> => {
      const requestId = `req_${toolUseId.replace(/[^A-Za-z0-9_-]/g, "")}`;
      const opened = await this.options.client.openRequest(sessionId, runId, claimToken, {
        requestId,
        kind,
        detail,
      }).catch((error: unknown) => {
        if (!lateRefusalLogged && error instanceof EngineClientError && error.code === "conflict") {
          lateRefusalLogged = true;
          console.error(`[worker] tool request refused for ${runId}: ${error.message}`);
        }
        throw error;
      });
      // Auto-resolved by the session's runtime mode — no human involved,
      // no wait. This is the common path in a detached session. (`user_input`
      // never auto-resolves — no mode can invent a human's answer.)
      if (opened.state === "resolved") return { decision: opened.decision };

      // Parked. Wait for the heartbeat to carry an answer, or for the turn
      // to be aborted. ABORT MUST SETTLE THIS PROMISE: a stop arriving
      // while a human is deciding would otherwise leave the driver blocked
      // forever inside canUseTool, and the turn would never end.
      return new Promise<DriverRequestOutcome>((resolve) => {
        // The runId in the key mirrors the heartbeat's settle lookup — see
        // `tick()` for why request-only keying breaks under concurrency.
        this.awaiting.set(`${runId}:${requestId}`, resolve);
        const onAbort = () => {
          if (!this.awaiting.delete(`${runId}:${requestId}`)) return;
          resolve({ decision: "cancel" });
        };
        if (controller.signal.aborted) onAbort();
        else controller.signal.addEventListener("abort", onAbort, { once: true });
      });
    };
    /**
     * THIS TURN'S gate and observation sink — swapped into the session's
     * long-lived browser binding. Both close over this turn's claim, which
     * is why the binding itself cannot capture them.
     */
    const gate: NonNullable<BrowserRunBinding["gate"]> = async ({ name, args, readOnly }) => {
      const { decision } = await askEngine({
        // A CLASSIFICATION, NOT A BYPASS — the same rule TELAR_READ_TOOLS
        // states in driver.ts. A read-only browser call changes nothing,
        // so it is declared as a read and the mode ladder's existing
        // auto-accept does its job; a mutation stays `tool_call` and
        // parks where the mode says to park.
        kind: readOnly ? "file_read" : "tool_call",
        // The QUALIFIED name, so the approval and the timeline row name
        // the same tool. A client shortens it for display
        // (`displayToolName`); the data does not lie about which server
        // it belongs to.
        detail: {
          kind: "tool_call",
          call: { name: qualifyTelarTool(name, TELAR_BROWSER_MCP_SERVER), server: TELAR_BROWSER_MCP_SERVER, input: args },
        },
        toolUseId: `${TELAR_BROWSER_MCP_SERVER}_${name}_${crypto.randomUUID().slice(0, 8)}`,
      });
      return decision === "accept" || decision === "acceptForSession";
    };
    const onNavigated: NonNullable<BrowserRunBinding["onNavigated"]> = (state) => {
      // A stop is terminal the moment the engine records it — same guard
      // as `onObservations`, for the same conflict.
      if (controller.signal.aborted) return;
      void this.options.client
        .reportObservations(sessionId, runId, claimToken, [{ kind: "browser.state", provider: state.provider, tabs: state.tabs }])
        .catch(() => undefined);
    };
    /**
     * `browser_fill_secret`, wired per turn like the gate: the orchestrator
     * gets the socket's own scope-bound browser, the `op` adapter, and an
     * `ask` that opens a `secret_access` request through the SAME askEngine
     * as every other gate — so an abort settles it, and the heartbeat
     * carries back the human's item pick in `answers.item`. The values live
     * inside `runSecretFill` and the fill call it makes; nothing of them
     * reaches this closure's return value or the journal.
     */
    const fillSecret: NonNullable<BrowserRunBinding["fillSecret"]> = (args, callBrowser) =>
      runSecretFill(
        {
          callBrowser,
          secrets: this.options.secrets ?? (this.secrets ??= createOnePasswordSecrets()),
          ask: async (secret) => {
            const outcome = await askEngine({
              kind: "secret_access",
              detail: { kind: "secret_access", secret },
              toolUseId: `${TELAR_BROWSER_MCP_SERVER}_fill_secret_${crypto.randomUUID().slice(0, 8)}`,
            });
            const item = outcome.answers?.item;
            return { decision: outcome.decision, ...(typeof item === "string" ? { itemId: item } : {}) };
          },
        },
        args,
      );
    return { askEngine, gate, onNavigated, fillSecret };
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
