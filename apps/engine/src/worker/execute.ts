import { EngineClientError, type WorkerClaim, type WorkerTurnFailure } from "@telar/engine-client";
import { collectTelarWall, type TelarCapabilities, type TelarSocketLease, type TelarToolSocket, telarWall } from "../domains/agent-tools";
import type { BrowserSocketLease, BrowserToolSocket } from "../domains/browser";
import { RateLimitedError } from "../drivers/claude";
import { ProviderUnavailableError, type DriverResult, type DriverRun, type DriverSessionHooks, type ProviderTurnBinding } from "../drivers";
import { providerProcessEnv } from "../domains/providers";
import { webImageOf } from "../domains/sessions";
import { framedTurnInput, SteerMailbox, withTurnNotes } from "../domains/turns";
import { UnsupportedDriverError } from "./options";
import { isConnectivityLoss } from "./lease";
import { assertProjectRoot } from "./project-root";
import { telarCapabilities } from "./capabilities";
import { bindTurn, repointBrowser, type TurnGate } from "./turn-gate";
import type { PendingSteerAck, TurnHost } from "./host";

type Turn = {
  claim: WorkerClaim;
  prompt: string;
  promptFromHuman: boolean;
  sessionId: string;
  runId: string;
  claimToken: string;
  controller: AbortController;
  steer: SteerMailbox;
  pendingAck: PendingSteerAck[];
  gate: TurnGate;
};

const completion = (result: DriverResult) => ({
  text: result.text,
  ...(result.providerSessionId ? { providerSessionId: result.providerSessionId } : {}),
  ...(result.usage ? { usage: result.usage } : {}),
});

/** Runs one claimed turn to a settlement the engine holds. */
export async function executeClaim(host: TurnHost, claim: WorkerClaim): Promise<void> {
  const turn = openTurn(host, claim);
  const { sessionId, runId, claimToken, controller } = turn;
  const { client } = host.options;
  let running = false;
  // A settlement needs a running turn; a fault during setup leaves it `claimed`.
  const ensureRunning = async () => {
    if (running) return;
    running = true;
    await client.markTurnRunning(sessionId, runId, claimToken).catch(() => undefined);
  };
  try {
    if (claim.readOnly && claim.driver !== "claude") throw new ProviderUnavailableError("A usage diagnosis runs on Claude Code for now.");
    const driver = host.driverFor(claim.driver);
    if (claim.projectRoot !== undefined) assertProjectRoot(claim.projectRoot, {}, claim.worktree);
    // No await on the paths that need none: `markTurnRunning` must go out before the pump's next claim.
    const { browserSocket, telarSocket } = host.options;
    const lease = browserSocket && !claim.readOnly ? await bindBrowser(host, browserSocket, turn) : undefined;
    const capabilities = telarCapabilities(host, claim, runId, claimToken);
    const telarLease = (reuseTelarLease(host, claim, capabilities) ?? (await bindTelarLease(host, telarSocket!, claim, capabilities))).lease;
    // Marked only now, so a Stop during setup settles a `claimed` turn instead of a running one.
    await client.markTurnRunning(sessionId, runId, claimToken);
    running = true;
    const result = await driver.run({ ...driverRun(host, turn, lease, telarLease), ...capabilities });
    // Drained before settling, or a late state read reports against a closed turn.
    await lease?.drain();
    if (!controller.signal.aborted) {
      await host.settle({
        sessionId,
        runId,
        claimToken,
        operation: "completeTurn",
        send: (signal) => client.completeTurn(sessionId, runId, claimToken, completion(result), signal),
      });
    } else if (host.shuttingDown()) {
      // A driver that returns cleanly on abort lands here, not in the catch.
      await host.recordInterruption(sessionId, runId, claimToken);
    }
  } catch (error) {
    await settleFault(host, turn, error, ensureRunning);
  } finally {
    closeTurn(host, turn);
  }
}

function openTurn(host: TurnHost, claim: WorkerClaim): Turn {
  const { sessionId } = claim;
  const prompt = withTurnNotes(framedTurnInput(claim.turn), claim.notes);
  const promptFromHuman = claim.turn.sender === undefined && claim.turn.wakeReason === undefined && claim.turn.origin !== "restart";
  const { runId } = claim.turn;
  const claimToken = claim.turn.claim!.token;
  host.liveClaims.set(sessionId, { runId, claimToken });
  const controller = new AbortController();
  host.active.set(claimToken, controller);
  host.activeClaims.add(claimToken);
  // Registered before the first heartbeat that could carry a delivery.
  const steer = new SteerMailbox();
  const pendingAck: PendingSteerAck[] = [];
  host.steering.set(claimToken, { mailbox: steer, pendingAck });
  steer.onDrain(() => {
    for (const ack of pendingAck.splice(0)) {
      void host.options.client
        .ackSteer(ack.sessionId, ack.steerRunId, ack.claimToken)
        .catch(() => undefined)
        .finally(() => host.pushedSteers.delete(ack.steerRunId));
    }
  });
  const gate = bindTurn(host, sessionId, runId, claimToken, controller);
  return { claim, prompt, promptFromHuman, sessionId, runId, claimToken, controller, steer, pendingAck, gate };
}

function closeTurn(host: TurnHost, { claimToken, steer, pendingAck }: Turn): void {
  steer.close();
  // An undrained delivery was never delivered, so the heartbeat's re-carry must not be skipped.
  for (const ack of pendingAck.splice(0)) host.pushedSteers.delete(ack.steerRunId);
  host.steering.delete(claimToken);
  host.active.delete(claimToken);
  host.activeClaims.delete(claimToken);
  const deliveredAt = host.stopDeliveredAt.get(claimToken);
  if (deliveredAt !== undefined) {
    host.stopDeliveredAt.delete(claimToken);
    host.diagnose({ event: "turn_stop_reaped", elapsedMs: host.now() - deliveredAt });
  }
}

/** One browser lease per session, released in `stop()`; the profile is rebound every turn, best-effort. */
async function bindBrowser(host: TurnHost, socket: BrowserToolSocket, { claim, sessionId, gate }: Turn): Promise<BrowserSocketLease> {
  try {
    await socket.bindProfile(sessionId, claim.projectId ?? "none");
  } catch (error) {
    console.error(`[worker] browser profile binding deferred for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const cached = host.browserLeases.get(sessionId);
  if (cached) {
    repointBrowser(host, sessionId, gate);
    return cached.lease;
  }
  const refs = { gate: gate.gate, onNavigated: gate.onNavigated, fillSecret: gate.fillSecret };
  const lease = await socket.bind({
    scopeKey: sessionId,
    ...(claim.projectRoot === undefined ? {} : { workspaceRoot: claim.projectRoot }),
    gate: (input) => refs.gate(input),
    onNavigated: (state) => refs.onNavigated(state),
    fillSecret: (args, callBrowser, profile) => refs.fillSecret(args, callBrowser, profile),
  });
  host.browserLeases.set(sessionId, { lease, refs });
  return lease;
}

type TelarEntry = { lease?: TelarSocketLease };
const telarKey = (claim: WorkerClaim) => [...(claim.plugins ?? [])].sort().join(",");

/** The token is baked into the provider's MCP config, so a lease is reused until the enabled set changes. */
function reuseTelarLease(host: TurnHost, claim: WorkerClaim, capabilities: TelarCapabilities): TelarEntry | undefined {
  const entry = host.telarLeases.get(claim.sessionId);
  if (claim.driver === "claude" || !host.options.telarSocket) return entry ?? {};
  if (entry?.key !== telarKey(claim)) return undefined;
  entry.capabilities.current = capabilities;
  return entry;
}

async function bindTelarLease(host: TurnHost, socket: TelarToolSocket, claim: WorkerClaim, capabilities: TelarCapabilities): Promise<TelarEntry> {
  host.telarLeases.get(claim.sessionId)?.lease?.release();
  const box: { current: TelarCapabilities } = { current: capabilities };
  const lease = await socket.bind(() => collectTelarWall(telarWall(() => box.current)));
  const entry = { key: telarKey(claim), capabilities: box, ...(lease ? { lease } : {}) };
  // A `stop()` during the await already cleared the map.
  if (host.stopped()) lease?.release();
  else host.telarLeases.set(claim.sessionId, entry);
  return entry;
}

function driverRun(
  host: TurnHost,
  { claim, prompt, promptFromHuman, sessionId, runId, claimToken, controller, steer, gate }: Turn,
  lease: BrowserSocketLease | undefined,
  telarLease: TelarSocketLease | undefined,
): DriverRun {
  const { client } = host.options;
  const { model, providerInstance } = claim;
  return {
    runId,
    prompt,
    promptFromHuman,
    ...(claim.turn.notification ? { notification: claim.turn.notification } : {}),
    sessionId,
    ...(claim.projectRoot === undefined ? {} : { cwd: claim.projectRoot }),
    signal: controller.signal,
    ...(model?.model ? { model: model.model } : {}),
    ...(model?.effort ? { effort: model.effort } : {}),
    ...(model?.fastMode === undefined ? {} : { fastMode: model.fastMode }),
    ...(model?.serviceTier ? { serviceTier: model.serviceTier } : {}),
    ...(model?.ultracode === undefined ? {} : { ultracode: model.ultracode }),
    ...(claim.turn.attachments?.length ? { attachments: claim.turn.attachments.map(webImageOf) } : {}),
    ...(claim.mcpServers?.length ? { mcpServers: claim.mcpServers } : {}),
    ...(claim.tasks?.length ? { tasks: claim.tasks } : {}),
    ...(claim.orientation ? { orientation: claim.orientation } : {}),
    ...(claim.readOnly ? { readOnly: true } : {}),
    ...(providerInstance ? { env: providerProcessEnv(providerInstance) } : {}),
    ...(providerInstance?.binaryPath ? { binaryPath: providerInstance.binaryPath } : {}),
    ...(providerInstance?.autoCompact ? { autoCompact: providerInstance.autoCompact } : {}),
    providerInstanceId: claim.providerInstanceId,
    providerSessionId: claim.resumeCursor,
    steer,
    ...(lease ? { browserSocket: { url: lease.url, token: lease.token } } : {}),
    transcript: async (options) => (await client.session(sessionId, { turns: options?.turns ?? 80 })).items,
    ...(telarLease ? { telarSocketLease: { url: telarLease.url, token: telarLease.token, generation: telarLease.generation } } : {}),
    onRequest: gate.askEngine,
    onObservations: async (observations) => {
      // A stop is terminal once recorded; later rows would conflict.
      if (controller.signal.aborted) return;
      await client.reportObservations(sessionId, runId, claimToken, observations);
    },
    session: {
      onTasks: (observations) => client.reportSessionTasks(sessionId, host.options.workerId, observations).then(() => undefined),
      onProviderTurn: (opening) => openProviderTurn(host, sessionId, opening),
    },
  };
}

/** A turn the CLI starts by itself, opened under its own claim so its tool calls get a live gate. */
async function openProviderTurn(
  host: TurnHost,
  sessionId: string,
  { input, reason }: Parameters<DriverSessionHooks["onProviderTurn"]>[0],
): Promise<ProviderTurnBinding | undefined> {
  const { client, workerId } = host.options;
  let opened: { turn: { runId: string; claim?: { token: string } } };
  try {
    opened = await client.openProviderTurn(sessionId, { workerId, input, reason });
  } catch (error) {
    // A live turn already has the session; the wake-up's frames are that turn's stream.
    if (error instanceof EngineClientError && error.code === "conflict") return undefined;
    throw error;
  }
  const runId = opened.turn.runId;
  const claimToken = opened.turn.claim!.token;
  const controller = new AbortController();
  host.active.set(claimToken, controller);
  const wanted = new AbortController();
  host.providerTurnsWanted.set(claimToken, wanted);
  const gate = bindTurn(host, sessionId, runId, claimToken, controller);
  host.liveClaims.set(sessionId, { runId, claimToken });
  repointBrowser(host, sessionId, gate);
  return {
    runId,
    wanted: wanted.signal,
    onRequest: gate.askEngine,
    onObservations: async (observations) => {
      if (controller.signal.aborted) return;
      await client.reportObservations(sessionId, runId, claimToken, observations);
    },
    close: async (result) => {
      host.active.delete(claimToken);
      host.providerTurnsWanted.delete(claimToken);
      if (controller.signal.aborted) return;
      try {
        if ("failure" in result) await client.failTurn(sessionId, runId, claimToken, { code: "driver_failed", message: result.failure });
        else await client.completeTurn(sessionId, runId, claimToken, completion(result));
      } catch (error) {
        if (!(error instanceof EngineClientError && error.code === "conflict")) throw error;
      }
    },
  };
}

/** A shutdown says so; a human Stop stays silent because the engine already recorded `stopped`. */
async function settleFault(host: TurnHost, { sessionId, runId, claimToken, controller }: Turn, error: unknown, ensureRunning: () => Promise<void>): Promise<void> {
  const { client } = host.options;
  if (host.shuttingDown() && controller.signal.aborted) {
    await ensureRunning();
    await host.recordInterruption(sessionId, runId, claimToken);
    return;
  }
  if (controller.signal.aborted || (error instanceof EngineClientError && error.code === "conflict")) return;
  if (isConnectivityLoss(error)) {
    // Classified first, so a revocation revokes this worker even if the settle below lands.
    host.noteConnectivityFailure(error);
    await ensureRunning();
    await host.settle({
      sessionId,
      runId,
      claimToken,
      operation: "failTurn",
      send: (signal) =>
        client.failTurn(
          sessionId,
          runId,
          claimToken,
          {
            code: "interrupted",
            message: "Telar's worker lost contact with the engine before this turn produced a result. What it had already done is above; whether it had finished anything elsewhere is unknown.",
          },
          signal,
        ),
    });
    return;
  }
  // `resumeAt` rides along because the engine schedules the resume from it.
  const failure: WorkerTurnFailure =
    error instanceof RateLimitedError
      ? {
          code: "rate_limited" as const,
          message: error.message,
          resumeAt: error.resumeAt,
          ...(error.limitType === undefined ? {} : { limitType: error.limitType }),
        }
      : error instanceof ProviderUnavailableError || error instanceof UnsupportedDriverError
        ? { code: "provider_unavailable" as const, message: error.message }
        : { code: "driver_failed" as const, message: error instanceof Error ? error.message : "Telar driver failed" };
  await ensureRunning();
  await host.settle({
    sessionId,
    runId,
    claimToken,
    operation: "failTurn",
    send: (signal) => client.failTurn(sessionId, runId, claimToken, failure, signal),
  });
}
