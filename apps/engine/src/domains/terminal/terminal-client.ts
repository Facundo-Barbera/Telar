export type TerminalEnding = {
  id: string;
  pid?: number;
  fate: "exited" | "failed" | "unknown";
  exitCode?: number;
  signal?: string;
  reason?: string;
  error?: string;
  closed?: "close" | "session" | "quit";
  at?: number;
};

export type TerminalOpenRequest = {
  shell: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols?: number;
  rows?: number;
  sessionId?: string;
  origin?: "run" | "agent";
  title?: string;
};

export type TerminalOpened = {
  id: string;
  pid?: number;
  ending?: TerminalEnding;
};

export type TerminalFacts = {
  id: string;
  pid?: number;
  sessionId?: string;
  origin?: string;
  title?: string;
  cwd?: string;
  startedAt?: number;
};

export type TerminalActivity = {
  id: string;
  sessionId?: string;
  origin?: string;
  title?: string;
  active: boolean;
  processes: number;
  command?: string;
};

export type TerminalSink = {
  data(chunk: string): void;
  ending(ending: TerminalEnding): void;
  gone(reason: string): void;
};

export type RunTerminalClientOptions = {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  heartbeatMs?: number;
  missedBeats?: number;
  reconnectMs?: number;
  reconnectMaxMs?: number;
};

const DEFAULT_HEARTBEAT_MS = 2_000;
const DEFAULT_MISSED_BEATS = 3;
const DEFAULT_RECONNECT_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;

class RunTerminalLost extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunTerminalLost";
  }
}

export class RunTerminalClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly http: typeof fetch;
  private readonly missedBeats: number;
  private readonly reconnectMs: number;
  private readonly reconnectMaxMs: number;
  private heartbeatMs: number;
  private readonly sinks = new Map<string, TerminalSink>();
  private attaching?: Promise<void>;
  private attached = false;
  private controller?: AbortController;
  private watchdog?: ReturnType<typeof setTimeout>;
  private retry?: ReturnType<typeof setTimeout>;
  private retryDelay: number;
  private detached = false;

  constructor(options: RunTerminalClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.token;
    this.http = options.fetch ?? fetch;
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.missedBeats = options.missedBeats ?? DEFAULT_MISSED_BEATS;
    this.reconnectMs = options.reconnectMs ?? DEFAULT_RECONNECT_MS;
    this.reconnectMaxMs = options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
    this.retryDelay = this.reconnectMs;
  }

  async open(request: TerminalOpenRequest, sink: TerminalSink): Promise<TerminalOpened> {
    await this.attach();
    const opened = (await this.post("/open", request)) as TerminalOpened;
    if (!opened || typeof opened.id !== "string") {
      throw new RunTerminalLost("Telar's terminal host did not name the terminal it started, so it cannot be followed");
    }
    if (opened.ending) return opened;
    this.sinks.set(opened.id, sink);
    return opened;
  }

  async adopt(id: string, sink: TerminalSink): Promise<void> {
    await this.attach();
    this.sinks.set(id, sink);
  }

  async state(): Promise<TerminalFacts[]> {
    const answer = (await this.request("GET", "/state")) as { terminals?: unknown };
    return Array.isArray(answer?.terminals) ? (answer.terminals as TerminalFacts[]) : [];
  }

  async kill(id: string, signal: NodeJS.Signals): Promise<boolean> {
    const answer = (await this.post("/kill", { id, signal })) as { signalled?: boolean };
    return answer?.signalled === true;
  }

  async close(id: string): Promise<boolean> {
    const answer = (await this.post("/close", { id })) as { closed?: boolean };
    return answer?.closed === true;
  }

  async sessionCounts(): Promise<Record<string, number>> {
    const answer = (await this.request("GET", "/sessions")) as { sessions?: unknown };
    const counts: Record<string, number> = {};
    if (answer?.sessions && typeof answer.sessions === "object") {
      for (const [sessionId, count] of Object.entries(answer.sessions)) {
        if (typeof count === "number" && Number.isInteger(count) && count > 0) counts[sessionId] = count;
      }
    }
    return counts;
  }

  async closeSession(sessionId: string): Promise<number> {
    const answer = (await this.post("/close-session", { sessionId })) as { closed?: number };
    return typeof answer?.closed === "number" ? answer.closed : 0;
  }

  async active(ids?: string[]): Promise<TerminalActivity[]> {
    const answer = (await this.post("/active", ids ? { ids } : {})) as { terminals?: unknown };
    return Array.isArray(answer?.terminals) ? (answer.terminals as TerminalActivity[]) : [];
  }

  async write(id: string, data: string): Promise<boolean> {
    const answer = (await this.post("/write", { id, data })) as { ok?: boolean };
    return answer?.ok === true;
  }

  async mirror(id: string, data: string, cursor: number): Promise<void> {
    await this.post("/mirror", { id, data, cursor });
  }

  async resize(id: string, cols: number, rows: number): Promise<boolean> {
    const answer = (await this.post("/resize", { id, cols, rows })) as { ok?: boolean };
    return answer?.ok === true;
  }

  detach(): void {
    this.detached = true;
    this.clearWatchdog();
    this.clearRetry();
    this.controller?.abort();
    this.controller = undefined;
    this.attached = false;
    this.sinks.clear();
  }

  get healthy(): boolean {
    return this.attached && !this.detached;
  }

  private post(path: string, body: unknown): Promise<unknown> {
    return this.request("POST", path, body);
  }

  private async request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.http(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new RunTerminalLost(`Telar could not reach its terminal host: ${messageOf(error)}`);
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new RunTerminalLost(`Telar's terminal host refused this request (${response.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`);
    }
    return await response.json();
  }

  private attach(): Promise<void> {
    if (this.detached) return Promise.reject(new RunTerminalLost("Telar's terminal channel is closed"));
    if (this.attached) return Promise.resolve();
    if (!this.attaching) {
      this.attaching = this.openStream().finally(() => {
        this.attaching = undefined;
      });
    }
    return this.attaching;
  }

  private async openStream(): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    let response: Response;
    try {
      response = await this.http(`${this.baseUrl}/events`, {
        headers: { authorization: `Bearer ${this.token}`, accept: "text/event-stream" },
        signal: controller.signal,
      });
    } catch (error) {
      throw new RunTerminalLost(`Telar could not attach to its terminal host: ${messageOf(error)}`);
    }
    if (!response.ok || !response.body) {
      throw new RunTerminalLost(`Telar's terminal host would not open an event stream (${response.status})`);
    }
    this.attached = true;
    this.retryDelay = this.reconnectMs;
    this.armWatchdog();
    void this.pump(response.body, controller);
  }

  private async pump(body: ReadableStream<Uint8Array>, controller: AbortController): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.armWatchdog();
        buffer += decoder.decode(value, { stream: true });
        let split = buffer.indexOf("\n\n");
        while (split !== -1) {
          this.frame(buffer.slice(0, split));
          buffer = buffer.slice(split + 2);
          split = buffer.indexOf("\n\n");
        }
      }
    } catch {
      if (controller.signal.aborted && this.detached) return;
    }
    if (this.controller === controller) this.drop();
  }

  private frame(raw: string): void {
    if (!raw || raw.startsWith(":")) return;
    let event = "message";
    const data: string[] = [];
    for (const line of raw.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trim());
    }
    if (event === "attached") {
      const payload = parse(data.join("\n")) as { heartbeatMs?: number } | undefined;
      if (typeof payload?.heartbeatMs === "number" && payload.heartbeatMs > 0) {
        this.heartbeatMs = payload.heartbeatMs;
        this.armWatchdog();
      }
      return;
    }
    if (event === "data") {
      const payload = parse(data.join("\n")) as { id?: string; data?: string } | undefined;
      if (typeof payload?.id !== "string" || typeof payload.data !== "string") return;
      this.sinks.get(payload.id)?.data(payload.data);
      return;
    }
    if (event === "exit") {
      const ending = parse(data.join("\n")) as TerminalEnding | undefined;
      if (!ending || typeof ending.id !== "string") return;
      const sink = this.sinks.get(ending.id);
      if (!sink) return;
      this.sinks.delete(ending.id);
      sink.ending(ending);
    }
  }

  private armWatchdog(): void {
    this.clearWatchdog();
    if (this.detached) return;
    const timer = setTimeout(() => {
      this.controller?.abort();
      this.controller = undefined;
      this.drop();
    }, this.heartbeatMs * this.missedBeats);
    timer.unref?.();
    this.watchdog = timer;
  }

  private clearWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = undefined;
  }

  private clearRetry(): void {
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
  }

  private drop(): void {
    this.attached = false;
    this.clearWatchdog();
    this.scheduleReattach();
  }

  private scheduleReattach(): void {
    if (this.detached || this.retry || this.sinks.size === 0) return;
    const delay = this.retryDelay;
    this.retryDelay = Math.min(this.retryDelay * 2, this.reconnectMaxMs);
    const timer = setTimeout(() => {
      this.retry = undefined;
      void this.reattach();
    }, delay);
    timer.unref?.();
    this.retry = timer;
  }

  private async reattach(): Promise<void> {
    if (this.detached || this.sinks.size === 0) return;
    try {
      await this.attach();
      const held = new Set((await this.state()).map((terminal) => terminal.id));
      for (const [id, sink] of this.sinks) {
        if (held.has(id)) continue;
        this.sinks.delete(id);
        sink.gone("Telar's terminal host no longer has this terminal; it ended while the engine was not listening");
      }
    } catch {
      this.attached = false;
      this.scheduleReattach();
    }
  }
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function terminalChannelFromEnv(env: NodeJS.ProcessEnv = process.env): { baseUrl: string; token: string } | undefined {
  const port = Number(env.TELAR_DESKTOP_RUN_TERMINAL_PORT);
  const token = env.TELAR_DESKTOP_RUN_TERMINAL_TOKEN?.trim();
  if (!Number.isInteger(port) || port <= 0 || !token) return undefined;
  return { baseUrl: `http://127.0.0.1:${port}`, token };
}
