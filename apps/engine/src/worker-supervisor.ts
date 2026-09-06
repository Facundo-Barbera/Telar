/**
 * Keeps the executable worker attached across daemon restarts and lease loss.
 * It is separate from worker-main so the narrow initial-registration race is
 * regression-testable, and shared with the daemon's embedded worker so both
 * deployments recover the same way.
 */
export type SupervisedWorker = {
  start(): Promise<void>;
  stop(): Promise<void>;
};

export type WorkerReconnectControllerOptions<Client, Worker extends SupervisedWorker> = {
  connect(): Promise<Client>;
  /** May be async: a fresh driver per attempt is built here. */
  createWorker(client: Client, onConnectionLost: () => void): Worker | Promise<Worker>;
  pause(ms: number): Promise<void>;
  retryMs?: number;
};

export class WorkerReconnectController<Client, Worker extends SupervisedWorker> {
  private worker: Worker | undefined;
  private connecting: Promise<void> | undefined;
  private stopping = false;
  private reconnectRequestedWhileStarting = false;

  constructor(private readonly options: WorkerReconnectControllerOptions<Client, Worker>) {}

  async start(): Promise<void> {
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const previous = this.worker;
    this.worker = undefined;
    await previous?.stop();
    // A connect loop mid-flight exits on its own; wait for it so no attempt
    // outlives the daemon that owns it.
    await this.connecting?.catch(() => undefined);
  }

  private async connect(): Promise<void> {
    if (this.stopping) return;
    if (this.connecting) return this.connecting;
    const attempt = this.connectLoop();
    this.connecting = attempt;
    try {
      await attempt;
    } finally {
      if (this.connecting === attempt) this.connecting = undefined;
    }
  }

  private async connectLoop(): Promise<void> {
    while (!this.stopping) {
      let lostDuringStart = false;
      let candidate: Worker | undefined;
      try {
        const client = await this.options.connect();
        candidate = await this.options.createWorker(client, () => {
          lostDuringStart = true;
          this.requestReconnect();
        });
        if (this.stopping) {
          await candidate.stop();
          return;
        }
        await candidate.start();
        if (this.stopping) {
          await candidate.stop();
          return;
        }
        // `EngineWorker.start()` can report a connection loss while its first
        // tick is in flight. Do not publish that candidate as healthy: retry
        // in this same loop after it has been stopped.
        if (lostDuringStart || this.reconnectRequestedWhileStarting) {
          this.reconnectRequestedWhileStarting = false;
          await candidate.stop();
          continue;
        }
        this.worker = candidate;
        return;
      } catch {
        // A candidate whose start() threw still holds a driver: dispose it
        // before the next attempt builds another.
        await candidate?.stop().catch(() => undefined);
        if (!this.stopping) await this.options.pause(this.options.retryMs ?? 250);
      }
    }
  }

  private requestReconnect(): void {
    if (this.stopping) return;
    if (this.connecting) {
      this.reconnectRequestedWhileStarting = true;
      return;
    }
    void this.reconnect();
  }

  private async reconnect(): Promise<void> {
    const previous = this.worker;
    this.worker = undefined;
    await previous?.stop();
    await this.connect();
  }
}
