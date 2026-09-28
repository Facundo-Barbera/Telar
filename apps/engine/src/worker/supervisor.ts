export type SupervisedWorker = {
  start(): Promise<void>;
  stop(reason?: "shutdown" | "connection_lost"): Promise<void>;
};

export type WorkerReconnectControllerOptions<Client, Worker extends SupervisedWorker> = {
  connect(): Promise<Client>;
  createWorker(client: Client, onConnectionLost: () => void): Worker | Promise<Worker>;
  pause(ms: number): Promise<void>;
  retryMs?: number;
};

export class WorkerReconnectController<Client, Worker extends SupervisedWorker> {
  private worker: Worker | undefined;
  private connecting: Promise<void> | undefined;
  private stopping = false;
  private reconnectRequestedWhileStarting = false;
  private reconnecting = false;

  constructor(private readonly options: WorkerReconnectControllerOptions<Client, Worker>) {}

  async start(): Promise<void> {
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const previous = this.worker;
    this.worker = undefined;
    await previous?.stop("shutdown");
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
          await candidate.stop("shutdown");
          return;
        }
        await candidate.start();
        if (this.stopping) {
          await candidate.stop("shutdown");
          return;
        }
        if (lostDuringStart || this.reconnectRequestedWhileStarting) {
          this.reconnectRequestedWhileStarting = false;
          await candidate.stop("connection_lost");
          continue;
        }
        this.worker = candidate;
        return;
      } catch {
        await candidate?.stop("connection_lost").catch(() => undefined);
        if (!this.stopping) await this.options.pause(this.options.retryMs ?? 250);
      }
    }
  }

  private requestReconnect(): void {
    if (this.stopping) return;
    if (this.connecting || this.reconnecting) {
      this.reconnectRequestedWhileStarting = true;
      return;
    }
    void this.reconnect();
  }

  private async reconnect(): Promise<void> {
    this.reconnecting = true;
    try {
      const previous = this.worker;
      this.worker = undefined;
      await previous?.stop("connection_lost");
      this.reconnectRequestedWhileStarting = false;
      await this.connect();
    } finally {
      this.reconnecting = false;
    }
  }
}
