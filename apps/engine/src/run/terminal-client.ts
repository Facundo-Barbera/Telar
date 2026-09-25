/**
 * THE ENGINE'S END OF THE PTY CHANNEL — and, since "Run = a new terminal", a
 * reporter rather than a witness.
 *
 * The desktop host (`apps/desktop/terminal-host.js`) holds every terminal and
 * owns what runs in it. This file forwards what the host says about the
 * engine's terminals — their bytes, their exit, their close — and asks it to
 * open, type into, resize and close them. Two rules survive from before, and
 * one is new:
 *
 *   1. THE ENGINE NEVER NAMES A PID. Every verb addresses a TERMINAL ID, minted
 *      by the host and never reused; the host honours an id only while it
 *      still holds the terminal it names. A pid appears in this file only as a
 *      number the host reported.
 *   2. ONLY THE HOST MAY SAY HOW A TERMINAL ENDED. Nothing here manufactures an
 *      exit code.
 *   3. A CHANNEL THAT DROPS IS NOT A TERMINAL THAT ENDED. This used to settle
 *      every terminal on the channel `unknown`, which held a project's one
 *      deployment slot until a person released it. There is no slot now, and
 *      Telar does not track liveness: a dropped stream says something about the
 *      wire, nothing about the processes. So the client re-attaches, and asks
 *      the host once which terminals it still holds (`GET /state`). One it
 *      still holds carries on; one it no longer holds has ended while we were
 *      not listening, and is reported `gone` — the host is the only thing that
 *      could have ended it.
 *
 * SILENCE IS STILL NOT HEALTH. A TCP connection survives a process that has
 * stopped answering, so the stream heartbeats and a watchdog here notices when
 * it stops. What the watchdog triggers is a reconnect, not a verdict.
 *
 * THE RECONNECT IS A CHANNEL RETRY, NOT A POLL OF ANY PROCESS. It runs only
 * while the engine has terminals on this channel, backs off to half a minute,
 * and asks the host one question per success. Nothing here asks the operating
 * system about a process group.
 */

/**
 * How the host describes the end of a terminal. Mirrors `TerminalFate`.
 *
 * `unknown` can still arrive from a host older than "Run = a new terminal";
 * it is read as `gone` — ended without a code we saw — and holds nothing.
 */
export type TerminalEnding = {
  id: string;
  pid?: number;
  /** `exited` only ever comes from node-pty's own exit event. */
  fate: "exited" | "failed" | "unknown";
  exitCode?: number;
  signal?: string;
  /** A legacy host's sentence for `unknown`. */
  reason?: string;
  /** Why it `failed` — the spawn threw and no process was created. */
  error?: string;
  /**
   * WHY THE HOST WAS ENDING IT, when it was the host that did: a single
   * `close`, a whole `session` being closed, or Telar quitting. Absent for a
   * process that ended by itself — `exit` typed at the prompt, a crash.
   */
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
  /** The session whose panel the terminal lives in. It owns the terminal. */
  sessionId?: string;
  /** Which of the two engine origins this is. The host refuses any other. */
  origin?: "run" | "agent";
  /** What the tab says. */
  title?: string;
};

export type TerminalOpened = {
  id: string;
  pid?: number;
  /** Present when the spawn itself threw: there is no terminal to address. */
  ending?: TerminalEnding;
};

/** What `GET /state` says about one of the engine's terminals. Facts only. */
export type TerminalFacts = {
  id: string;
  pid?: number;
  sessionId?: string;
  origin?: string;
  title?: string;
  cwd?: string;
  startedAt?: number;
};

/** What `POST /active` answers: one `ps` snapshot, taken when asked. */
export type TerminalActivity = {
  id: string;
  sessionId?: string;
  origin?: string;
  title?: string;
  active: boolean;
  processes: number;
  command?: string;
};

/** What one terminal's owner wants to hear. */
export type TerminalSink = {
  data(chunk: string): void;
  ending(ending: TerminalEnding): void;
  /** The host no longer holds it, and we did not hear it end. */
  gone(reason: string): void;
};

export type RunTerminalClientOptions = {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  /** Overridden by the host's `attached` frame when it names a different one. */
  heartbeatMs?: number;
  /** How many heartbeats may be missed before the stream is called dropped. */
  missedBeats?: number;
  /** The first reconnect delay; it doubles up to `reconnectMaxMs`. */
  reconnectMs?: number;
  reconnectMaxMs?: number;
};

const DEFAULT_HEARTBEAT_MS = 2_000;
/** Three, not one: a single missed beat is a busy event loop on either side. */
const DEFAULT_MISSED_BEATS = 3;
const DEFAULT_RECONNECT_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;

export class RunTerminalLost extends Error {
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
  /** The engine's terminals on this channel, by id. */
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

  /**
   * Start a terminal.
   *
   * THE STREAM IS ATTACHED FIRST, ALWAYS. A command that fails instantly —
   * a missing binary exits 127 before this call returns — would otherwise end
   * before anyone was listening. The host also buffers frames it produced with
   * nobody attached, so the two halves cover each other.
   */
  async open(request: TerminalOpenRequest, sink: TerminalSink): Promise<TerminalOpened> {
    await this.attach();
    const opened = (await this.post("/open", request)) as TerminalOpened;
    if (!opened || typeof opened.id !== "string") {
      throw new RunTerminalLost("Telar's terminal host did not name the terminal it started, so it cannot be followed");
    }
    // A spawn that threw has no terminal to subscribe to, and the host has
    // already said so in the same answer.
    if (opened.ending) return opened;
    this.sinks.set(opened.id, sink);
    return opened;
  }

  /**
   * FOLLOW A TERMINAL THIS ENGINE DID NOT OPEN IN THIS LIFE — one a previous
   * engine opened, which the host kept. Attached first for the same reason as
   * `open`: its next bytes must have somewhere to go.
   */
  async adopt(id: string, sink: TerminalSink): Promise<void> {
    await this.attach();
    this.sinks.set(id, sink);
  }

  /** The engine's terminals the host holds right now. One read, no cache. */
  async state(): Promise<TerminalFacts[]> {
    const answer = (await this.request("GET", "/state")) as { terminals?: unknown };
    return Array.isArray(answer?.terminals) ? (answer.terminals as TerminalFacts[]) : [];
  }

  /**
   * One signal to a terminal's whole tree, BY ID — what a Ctrl-C-shaped stop
   * sends before the close (`SIGINT` to a server that traps TERM).
   */
  async kill(id: string, signal: NodeJS.Signals): Promise<boolean> {
    const answer = (await this.post("/kill", { id, signal })) as { signalled?: boolean };
    return answer?.signalled === true;
  }

  /**
   * CLOSE A TERMINAL, WHICH ENDS WHAT RUNS IN IT. The host sends a hangup to
   * the shell, SIGTERM to every group on the terminal and SIGKILL a second
   * later, and answers once that is over. The exit itself arrives on the
   * stream, like every other ending. `false`: not ours, or already gone.
   */
  async close(id: string): Promise<boolean> {
    const answer = (await this.post("/close", { id })) as { closed?: boolean };
    return answer?.closed === true;
  }

  /** Close every terminal a session owns, whoever opened it. How many. */
  async closeSession(sessionId: string): Promise<number> {
    const answer = (await this.post("/close-session", { sessionId })) as { closed?: number };
    return typeof answer?.closed === "number" ? answer.closed : 0;
  }

  /**
   * IS ANYTHING RUNNING IN THESE TERMINALS — asked once, when somebody is about
   * to be asked whether to close them. The host answers from one process table
   * read; nothing here repeats the question.
   */
  async active(ids?: string[]): Promise<TerminalActivity[]> {
    const answer = (await this.post("/active", ids ? { ids } : {})) as { terminals?: unknown };
    return Array.isArray(answer?.terminals) ? (answer.terminals as TerminalActivity[]) : [];
  }

  /**
   * Keystrokes, BY ID. `false` IS AN ANSWER AND NOT A FAILURE: the host drops a
   * write to a terminal it no longer holds, and it learns of an exit before we
   * do, so a keystroke crossing that gap is ordinary.
   *
   * NOTHING ON THIS PATH IS REDACTED, and that is not an oversight: redaction
   * covers what a PROCESS WRITES (`pty-stream.ts`), and never covered what a
   * person types. docs/run-terminal.md §5 says so where a user will look.
   */
  async write(id: string, data: string): Promise<boolean> {
    const answer = (await this.post("/write", { id, data })) as { ok?: boolean };
    return answer?.ok === true;
  }

  /**
   * THE REDACTED BYTES, HANDED BACK TO THE HOST SO THE COCKPIT MAY DRAW THEM
   * (#890). The host fans RAW node-pty bytes, and a renderer reading those
   * would draw a run's secrets unmasked — so the renderer is given these frames
   * instead. ONE REDACTOR, ON THIS SIDE.
   *
   * `cursor` is the reader's position AFTER this chunk, in `bytes()`'s units,
   * so a chip joining a terminal already going can seam its scrollback onto
   * these frames exactly.
   */
  async mirror(id: string, data: string, cursor: number): Promise<void> {
    await this.post("/mirror", { id, data, cursor });
  }

  /** The surface drawing this terminal says how big it is. Same `false` rule. */
  async resize(id: string, cols: number, rows: number): Promise<boolean> {
    const answer = (await this.post("/resize", { id, cols, rows })) as { ok?: boolean };
    return answer?.ok === true;
  }

  /**
   * STOP LISTENING, AND CLOSE NOTHING. The engine going down is not a reason to
   * end a person's dev server: the host keeps its terminals, and the next
   * engine re-lists them. Quitting Telar is what closes them, and that is the
   * host's to do.
   */
  detach(): void {
    this.detached = true;
    this.clearWatchdog();
    this.clearRetry();
    this.controller?.abort();
    this.controller = undefined;
    this.attached = false;
    this.sinks.clear();
  }

  /** Is the event stream attached right now? */
  get healthy(): boolean {
    return this.attached && !this.detached;
  }

  // ── the wire ─────────────────────────────────────────────────────────────

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

  /** Attach once; concurrent callers share the same attempt. */
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
    // Deliberately not awaited: the pump runs for the life of the stream and
    // resolving `attach()` is what lets the first `open` proceed.
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
        // Any byte at all is proof of life, heartbeat comment included.
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
    // A comment frame is the heartbeat; it has already served its purpose.
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
      // One ending per terminal: the id is dropped before the callback so a
      // duplicate frame cannot settle the same terminal twice.
      this.sinks.delete(ending.id);
      sink.ending(ending);
    }
  }

  private armWatchdog(): void {
    this.clearWatchdog();
    if (this.detached) return;
    const timer = setTimeout(() => {
      // A stream that went quiet is treated exactly like one that ended.
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

  /**
   * THE STREAM IS GONE — and every terminal on it is left exactly as it was.
   * A reconnect is scheduled while there is anything to reconnect for.
   */
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

  /**
   * Back on the stream, then ONE question: which of ours does the host still
   * hold. Asked after the attach, so an exit the host buffered while we were
   * away arrives as the exit it was rather than being guessed at.
   */
  private async reattach(): Promise<void> {
    if (this.detached || this.sinks.size === 0) return;
    try {
      await this.attach();
      const held = new Set((await this.state()).map((terminal) => terminal.id));
      for (const [id, sink] of [...this.sinks]) {
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

/**
 * The channel the desktop shell exported into this process's environment, or
 * nothing.
 *
 * NOTHING IS THE ORDINARY CASE AND NOT A FAULT. The engine also runs under
 * `bun run src/main.ts` with no Electron anywhere, and there a run is spawned
 * with pipes exactly as it was before this existed.
 */
export function terminalChannelFromEnv(env: NodeJS.ProcessEnv = process.env): { baseUrl: string; token: string } | undefined {
  const port = Number(env.TELAR_DESKTOP_RUN_TERMINAL_PORT);
  const token = env.TELAR_DESKTOP_RUN_TERMINAL_TOKEN?.trim();
  if (!Number.isInteger(port) || port <= 0 || !token) return undefined;
  return { baseUrl: `http://127.0.0.1:${port}`, token };
}
