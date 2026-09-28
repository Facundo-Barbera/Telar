import crypto from "node:crypto";
import { EngineClientError, type EngineDiscovery } from "@telar/engine-client";
import type { HttpError } from "../platform/http/http";
import type { StoppedClaim } from "../domains/turns";
import type { EngineStore } from "../state";
import { withDirectExecution, type ExecutionPort } from "./execution-port";
import type { DriverSelector } from "./options";
import type { createWorkerRegistry } from "./registry";

export type EmbeddedWorkerConfig = { workerId?: string; pollMs?: number; idlePollMs?: number; createDriver?: () => Promise<DriverSelector> | DriverSelector };

/** How the store reaches whichever embedded generation is current; empty when none is. */
export type EmbeddedDoorbell = { wake?: () => void; cancel?: (cancellations: StoppedClaim[]) => void };

type EmbeddedDeps = {
  store: EngineStore;
  discovery: EngineDiscovery;
  execution: ExecutionPort;
  workers: ReturnType<typeof createWorkerRegistry>;
  doorbell: EmbeddedDoorbell;
  errorFor: (error: unknown) => HttpError;
};

// The idle poll only paces true idleness: the store rings `wake()` whenever a queue moves.
const DEFAULT_IDLE_POLL_MS = 1_000;

/**
 * Runs a worker inside the engine, with the browser and `telar` sockets it owns. Everything heavy is imported
 * here lazily, so an engine started without an embedded worker never loads a provider SDK.
 */
export async function startEmbeddedWorker(config: EmbeddedWorkerConfig, { store, discovery, execution, workers, doorbell, errorFor }: EmbeddedDeps) {
  const { EngineClient } = await import("@telar/engine-client");
  const { EngineWorker, workerConcurrencyFromEnv } = await import("./index");
  const { BrowserRouter, BrowserRuntime, createLoginGrantStore, desktopBrowserFromEnv } = await import("../domains/browser");
  const { createBrowserToolSocket, createDefaultDrivers } = await import("../drivers");
  const { TelarToolSocket } = await import("../domains/agent-tools");
  const { WorkerReconnectController } = await import("./supervisor");
  const { createWorkerDiagnostics } = await import("./diagnostics");
  // The engine owns the browser and both sockets: they outlive any turn and close exactly once.
  const browser = new BrowserRuntime({ profileRoot: store.paths.browserProfiles });
  const routed = new BrowserRouter(browser, desktopBrowserFromEnv());
  store.browser.attach(routed);
  const browserSocket = createBrowserToolSocket(routed);
  const telarSocket = new TelarToolSocket();
  const createDriver = config.createDriver ?? (() => createDefaultDrivers());
  const concurrency = workerConcurrencyFromEnv();
  // Built up front so a driver that cannot be constructed fails the boot, not a retry loop.
  let initialDriver: DriverSelector | undefined = await createDriver();
  const freshWorkerId = () => `worker_embedded_${crypto.randomUUID().replaceAll("-", "")}`;
  let workerId = config.workerId ?? freshWorkerId();
  let generation = 0;
  const supervisor = new WorkerReconnectController<InstanceType<typeof EngineClient>, InstanceType<typeof EngineWorker>>({
    connect: async () =>
      withDirectExecution(
        new EngineClient(discovery),
        {
          ...execution,
          registerWorker: async (id) => {
            const result = await execution.registerWorker(id);
            workers.setEmbedded(id);
            return result;
          },
        },
        (error) => {
          const normalized = errorFor(error);
          return new EngineClientError(normalized.code, normalized.message, normalized.status);
        },
      ),
    createWorker: async (client, onConnectionLost) => {
      generation += 1;
      if (generation > 1) {
        workerId = freshWorkerId();
        process.stderr.write(`[telar] embedded worker lost its connection; re-registering as ${workerId}\n`);
      }
      const driver = initialDriver ?? (await createDriver());
      initialDriver = undefined;
      const worker = new EngineWorker({
        client,
        workerId,
        driver,
        browserSocket,
        loginGrants: createLoginGrantStore(store.paths.root),
        telarSocket,
        ...(concurrency === undefined ? {} : { concurrency }),
        // In-process and trusted: the registry exempts this registration from the lease, so the worker must not expire itself.
        leaseExempt: true,
        // Persisted, because the packaged app's stderr is /dev/null.
        onDiagnostic: createWorkerDiagnostics(store.paths.root, workerId),
        ...(config.pollMs === undefined ? {} : { pollMs: config.pollMs }),
        idlePollMs: config.idlePollMs ?? DEFAULT_IDLE_POLL_MS,
        onConnectionLost,
      });
      const wake = () => worker.wake();
      const cancel = (cancellations: StoppedClaim[]) => worker.cancelClaims(cancellations);
      doorbell.wake = wake;
      doorbell.cancel = cancel;
      const stop = worker.stop.bind(worker);
      const ownedWorkerId = workerId;
      // A retired generation hands back only what is still its own, then retires its registration: the fence that
      // refuses a late request carrying the dead id. What becomes of its claimed turns is the stop lifecycle's call.
      worker.stop = async (reason) => {
        if (workers.embeddedId() === ownedWorkerId) workers.setEmbedded(undefined);
        if (doorbell.wake === wake) doorbell.wake = undefined;
        if (doorbell.cancel === cancel) doorbell.cancel = undefined;
        workers.retire(ownedWorkerId);
        await stop(reason);
      };
      return worker;
    },
    pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    ...(config.pollMs === undefined ? {} : { retryMs: config.pollMs }),
  });
  await supervisor.start();
  return {
    /** A getter: the id changes when the supervisor re-registers. */
    get workerId() {
      return workerId;
    },
    stop: () => supervisor.stop(),
    /** After the worker has stopped: the sockets before the browser they front. */
    async closeResources(): Promise<void> {
      await browserSocket.close();
      await telarSocket.close();
    },
    closeBrowser: () => browser.close("engine shutting down"),
  };
}
