/**
 * THE ENGINE'S END OF THE PTY CHANNEL, AND THE PLACE WHERE `unknown` IS
 * RE-DERIVED RATHER THAN REINVENTED.
 *
 * `manager.ts` can assert today that it never aims a signal at a stale pid
 * because it holds its own `ChildProcess`: "the pid is only ever used while our
 * own handle has not yet fired `exit`". Once the handle lives in Electron main
 * (`apps/desktop/terminal-host.js`), that sentence has to be rebuilt out of
 * three parts, and each one is load-bearing:
 *
 *   1. THE ENGINE NEVER NAMES A PID. Every verb addresses a TERMINAL ID, minted
 *      by the host and never reused. The host honours an id only while it still
 *      holds the handle that id names, which is exactly the property the
 *      `ChildProcess` used to supply. A pid appears in this file only as prose
 *      in a sentence a human will read.
 *   2. ONLY THE HOST MAY SAY `exited`, and it only says it when node-pty's own
 *      exit event fired with a code. Nothing here manufactures one.
 *   3. AND IF THE CHANNEL GOES, EVERYTHING ON IT IS `unknown`. This is the half
 *      that has no analogue in the single-process world, and it is the failure
 *      the whole design is aimed at: a host that dies quietly while something
 *      downstream frees a slot for a dev server that is still listening.
 *
 * SO SILENCE IS NOT HEALTH. A TCP connection survives a process that has
 * stopped answering, so the stream heartbeats and this side runs a watchdog on
 * it. A stream that ends, errors, refuses to attach, or simply goes quiet all
 * land in the same place — `onLost`, with every live terminal reported
 * `unknown` and named. THERE IS NO PATH FROM A LOST CHANNEL TO `exited`.
 *
 * AND LOSS IS NOT UNDONE BY A RECONNECT. A terminal marked `unknown` stays
 * `unknown` even if the stream comes back and the host turns out to have been
 * fine, because `unknown` means "a human has not checked yet" and only
 * `release()` is a human checking. Re-attaching lets NEW runs start; it does
 * not retroactively vouch for an old one.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO IS ASK ABOUT A PROCESS GROUP. That
 * question — is `bun run dev &` still listening behind an exit code of 0 — stays
 * in `manager.ts`, asked with signal 0, which delivers nothing. The pid it asks
 * about was never this process's, and the honest reading of that is written at
 * the call site: the only way the answer can be wrong is by saying "alive" for a
 * pid the kernel has re-handed to a stranger, which holds the slot. Wrong in the
 * direction the singleton exists to be wrong in.
 */

/** How the host describes the end of a terminal. Mirrors `TerminalFate`. */
export type TerminalEnding = {
  id: string;
  pid?: number;
  /** `exited` only ever comes from node-pty's own exit event. */
  fate: "exited" | "failed" | "unknown";
  exitCode?: number;
  signal?: string;
  /** Why it is `unknown`, in a sentence naming the pid. */
  reason?: string;
  /** Why it `failed` — the spawn threw and no process was created. */
  error?: string;
  at?: number;
};

export type TerminalOpenRequest = {
  shell: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols?: number;
  rows?: number;
};

export type TerminalOpened = {
  id: string;
  pid?: number;
  /** Present when the spawn itself threw: there is no terminal to address. */
  ending?: TerminalEnding;
};

/** What one terminal's owner wants to hear. */
export type TerminalSink = {
  data(chunk: string): void;
  ending(ending: TerminalEnding): void;
};

export type RunTerminalClientOptions = {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  /** Overridden by the host's `attached` frame when it names a different one. */
  heartbeatMs?: number;
  /** How many heartbeats may be missed before the channel is called lost. */
  missedBeats?: number;
  now?: () => number;
};

const DEFAULT_HEARTBEAT_MS = 2_000;
/**
 * Three, not one. A single missed beat is a busy event loop on either side —
 * calling a healthy host dead would hold a project's slot until a human
 * released it, which is expensive enough to be worth two more seconds.
 */
const DEFAULT_MISSED_BEATS = 3;

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
  private heartbeatMs: number;
  /** Terminals this client still vouches for, by id. */
  private readonly sinks = new Map<string, TerminalSink>();
  private attaching?: Promise<void>;
  private attached = false;
  private controller?: AbortController;
  private watchdog?: ReturnType<typeof setTimeout>;
  private closed = false;

  constructor(options: RunTerminalClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.token;
    this.http = options.fetch ?? fetch;
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.missedBeats = options.missedBeats ?? DEFAULT_MISSED_BEATS;
  }

  /**
   * Start a terminal for a run.
   *
   * THE STREAM IS ATTACHED FIRST, ALWAYS. A command that fails instantly —
   * a missing binary exits 127 before this call returns — would otherwise end
   * before anyone was listening, and the run would sit `starting` forever. The
   * host also buffers frames it produced with nobody attached, so the two
   * halves cover each other rather than one of them being relied on.
   */
  async open(request: TerminalOpenRequest, sink: TerminalSink): Promise<TerminalOpened> {
    await this.attach();
    const opened = (await this.post("/open", request)) as TerminalOpened;
    if (!opened || typeof opened.id !== "string") {
      throw new RunTerminalLost("Telar's terminal host did not name the terminal it started, so this run cannot be tracked");
    }
    // A spawn that threw has no terminal to subscribe to, and the host has
    // already said so in the same answer.
    if (opened.ending) return opened;
    this.sinks.set(opened.id, sink);
    return opened;
  }

  /**
   * Signal a terminal's whole tree, BY ID.
   *
   * The pid never crosses this call, which is the point: the host refuses an id
   * whose handle it no longer holds, so a signal cannot be aimed at a number the
   * kernel has since handed to somebody else.
   */
  async kill(id: string, signal: NodeJS.Signals): Promise<boolean> {
    const answer = (await this.post("/kill", { id, signal })) as { signalled?: boolean };
    return answer?.signalled === true;
  }

  /**
   * Keystrokes, BY ID.
   *
   * `false` IS AN ANSWER AND NOT A FAILURE. The host drops a write to a
   * terminal it no longer holds, and it learns of an exit before we do, so a
   * keystroke crossing that gap is the ordinary case rather than an error to
   * raise at a person. A channel that is GONE is a different thing entirely and
   * still throws `RunTerminalLost` out of `post` — there the stream's own
   * `lose()` is already settling every terminal on it `unknown`, so nothing
   * here has to do that bookkeeping a second time.
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
   * (#890).
   *
   * THE ARROW POINTS THE UNUSUAL WAY ON PURPOSE. Everything else on this
   * channel is the engine asking the host to do something; this is the engine
   * telling the host what a run's output looks like ONCE IT HAS BEEN THROUGH
   * `pty-stream.ts`. The host fans RAW node-pty bytes, and a renderer reading
   * those would draw a run's secrets unmasked — so the renderer is given these
   * frames instead, and the raw ones stop at the channel. ONE REDACTOR, ON THIS
   * SIDE: the cockpit sees byte-for-byte what the journal holds.
   *
   * `cursor` IS WHAT MAKES THE SEAM EXACT. A chip attaching to a run that is
   * already going reads its scrollback from `/run/bytes` and follows these
   * frames; without a position it could not tell a frame it has already drawn
   * from a new one, and the join would either duplicate a screen or gap it.
   * This is the reader's cursor AFTER this chunk, in `bytes()`'s own units.
   *
   * IT NEVER FAILS A RUN. A mirror that does not land costs the person a
   * repaint they can get back by reopening the chip; taking the run `unknown`
   * over it would be spending the project's deployment slot on a redraw.
   */
  async mirror(id: string, data: string, cursor: number): Promise<void> {
    await this.post("/mirror", { id, data, cursor });
  }

  /** The surface drawing this terminal says how big it is; SIGWINCH is the
   *  PTY's job. Same `false` rule as `write`. */
  async resize(id: string, cols: number, rows: number): Promise<boolean> {
    const answer = (await this.post("/resize", { id, cols, rows })) as { ok?: boolean };
    return answer?.ok === true;
  }

  /** Stop listening. Kills nothing — that is policy, and policy is the manager's. */
  close(): void {
    this.closed = true;
    this.clearWatchdog();
    this.controller?.abort();
    this.controller = undefined;
    this.attached = false;
    this.sinks.clear();
  }

  /** Is this client still able to vouch for what it holds? */
  get healthy(): boolean {
    return this.attached && !this.closed;
  }

  // ── the wire ─────────────────────────────────────────────────────────────

  private async post(path: string, body: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.http(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
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
    if (this.closed) return Promise.reject(new RunTerminalLost("Telar's terminal channel is closed"));
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
    this.armWatchdog();
    // Deliberately not awaited: the pump runs for the life of the channel and
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
      // The host ended the stream. It did not tell us how any of these
      // terminals finished, so we cannot say they finished.
      this.lose("Telar's terminal host closed the channel this run was started on");
    } catch (error) {
      if (controller.signal.aborted && this.closed) return;
      this.lose(`Telar lost the channel to its terminal host: ${messageOf(error)}`);
    }
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
      // duplicate frame cannot settle the same run twice.
      this.sinks.delete(ending.id);
      sink.ending(ending);
    }
  }

  private armWatchdog(): void {
    this.clearWatchdog();
    if (this.closed) return;
    const timer = setTimeout(() => {
      this.lose(
        `Telar's terminal host went quiet for ${this.heartbeatMs * this.missedBeats}ms — it is no longer reporting whether the processes it started are alive`,
      );
    }, this.heartbeatMs * this.missedBeats);
    timer.unref?.();
    this.watchdog = timer;
  }

  private clearWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = undefined;
  }

  /**
   * THE CHANNEL IS GONE. Every terminal still on it becomes `unknown` — never
   * `exited`, whatever the reason was — and each one is told once.
   */
  private lose(reason: string): void {
    if (!this.attached && this.sinks.size === 0) return;
    this.attached = false;
    this.clearWatchdog();
    const orphans = [...this.sinks.entries()];
    this.sinks.clear();
    for (const [id, sink] of orphans) {
      sink.ending({ id, fate: "unknown", reason });
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
