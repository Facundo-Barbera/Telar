/**
 * THE ENGINE'S DOOR TO THIS PROCESS'S PTYs — the channel #198 W1 left to W4.
 *
 * W1 put real pseudo-terminals in Electron main and gave the RENDERER a way to
 * reach them (`telar:terminal:*` over IPC). The engine is not a renderer: it is
 * a forked sibling with no `ipcRenderer`, and `apps/engine/src/run/` is where
 * the policy lives that decides what a dead PTY means for a project's slot. So
 * it needs a wire, and this is it — shaped after `browser-control-server.js`,
 * which is the same problem solved once already: loopback only, bearer token, a
 * closed route set checked before a body is read.
 *
 * WHY A SECOND SERVER AND NOT FOUR MORE ROUTES ON THE FIRST. The closed route
 * set is the security property, not decoration. Adding "start a process with
 * this command line" to the browser control surface would turn a leaked browser
 * token — which today buys driving a tab — into arbitrary code execution. Two
 * tokens, two ports, two route sets; the cost is the twenty lines of wiring in
 * main.js and it buys that the blast radius of each is what its name says.
 *
 * `unknown` IS NOT A ROUNDING OF `exited`, AND THAT SURVIVES THE WIRE. The host
 * already refuses to report an exit it did not observe; what this adds is the
 * second half, which only exists once there are two processes: IF THE ENGINE
 * LOSES THIS CHANNEL, EVERY RUN ON IT IS `unknown` AND KEEPS ITS SLOT. That is
 * the engine's side of the bargain (`terminal-client.ts`), and this side holds
 * it up by two rules:
 *
 *   - THE EVENT STREAM HEARTBEATS. A TCP connection can stay open through a
 *     process that has stopped answering, so silence must be distinguishable
 *     from health. A comment frame every `heartbeatMs` is what makes a dead
 *     host look dead instead of looking idle.
 *   - A TERMINAL IS ADDRESSED BY ITS ID, NEVER BY ITS PID. The id is minted by
 *     the host and is not reused; a pid is reused by the kernel. That is the
 *     same guarantee `manager.ts` used to get from holding its own
 *     `ChildProcess` — "the pid is only ever used while our own handle has not
 *     fired exit" — re-derived rather than reinvented: the id is only ever
 *     honoured while the host still holds the handle it names.
 *
 * NOTHING HERE LOGS A BODY. A run's environment crosses this wire, and some of
 * those values are secrets the whole of `run/types.ts` exists to keep out of
 * sight. There is no request logging in this file on purpose, and an error is
 * reported by its message rather than with the input that caused it. THAT RULE
 * GOT SHARPER WHEN `/write` LANDED: keystrokes cross this wire too, and
 * redaction only ever covered what a process WRITES — see docs/run-terminal.md
 * §5. A person answering `psql`'s password prompt is sending bytes through
 * here that nothing downstream knows are a secret.
 *
 * WHY `/write` AND `/resize` BELONG ON THIS ROUTE SET AND NOWHERE ELSE. The
 * owner's decision for #198 is that a run's terminal is writable — an installer
 * asking `Proceed (Y/n)`, a dev server waiting on `r`, a migration asking for a
 * passphrase are all things a person must be able to answer without taking the
 * process outside the slot, the journal and the singleton. The bytes cannot go
 * over `telar:terminal:*`, because that channel fans RAW node-pty output and an
 * emulator on it would draw a run's secrets unredacted. So the same closed set
 * that already means "start a process with this command line" gains "send bytes
 * to a process you started", which does not widen what a leaked token buys.
 */
const http = require("node:http");
const { TerminalOwner } = require("./terminal-host");

/**
 * EVERY VERB ON THIS SERVER IS THE ENGINE'S SCOPE.
 *
 * The host refuses an id whose owner is not the caller, so this channel cannot
 * reach a shell a person opened in a Terminal tab — and `telar:terminal:list`
 * cannot see the ones opened here. Two doors, two sets of keys, checked at the
 * handle rather than at either door.
 */
const ENGINE = TerminalOwner.ENGINE;

/**
 * A run's environment and command line, and nothing that should ever be large.
 * Smaller than the browser server's cap because nothing legitimate comes close.
 */
const MAX_BODY_BYTES = 256_000;

/** How often the event stream proves it is still there. */
const HEARTBEAT_MS = 2_000;

/** Every route this server answers. Anything else is a 404 before a body is
 *  read or a terminal host is resolved. */
const ROUTES = new Set(["POST /open", "POST /kill", "POST /write", "POST /resize", "POST /mirror", "GET /events", "GET /state"]);

function json(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Run terminal request is too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new Error("Run terminal request is not valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

/**
 * Start the engine-facing terminal channel.
 *
 * `getTerminalHost` is a function rather than a host so that constructing this
 * server does not load node-pty — the same lazy rule `terminal-host.js` states
 * for itself, for the same reason (the desktop unit suite runs on ubuntu, where
 * node-pty has no prebuild).
 *
 * `onMirror` IS THE ONE ARROW THAT POINTS BACK (#890). Every other route is the
 * engine asking this process to do something; `/mirror` is the engine handing
 * over a run's output AFTER its redactor has been through it, so the cockpit can
 * draw that instead of the raw node-pty frames `main.js` fans. It is optional:
 * a shell with no cockpit attached has nowhere to put one, and the run itself
 * does not depend on anybody drawing it.
 */
function startRunTerminalServer({ port, token, getTerminalHost, onMirror, heartbeatMs = HEARTBEAT_MS }) {
  if (!token) throw new Error("A run terminal token is required.");

  /**
   * The engine's open event streams. A Set rather than one connection because
   * a daemon that restarts may briefly overlap with its predecessor, and
   * dropping the old one's frames on the floor would lose an exit.
   */
  const listeners = new Set();

  /** Frames produced before anyone connected, so a race cannot lose an exit.
   *  Bounded: a host running with no engine attached must not grow memory. */
  const backlog = [];
  const MAX_BACKLOG = 1000;

  const broadcast = (event, payload) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    if (listeners.size === 0) {
      backlog.push(frame);
      if (backlog.length > MAX_BACKLOG) backlog.shift();
      return;
    }
    for (const response of listeners) {
      try {
        response.write(frame);
      } catch {
        // A listener that cannot be written to is already gone; its `close`
        // handler removes it. Losing this frame to it is not a reason to lose
        // it for everyone else.
      }
    }
  };

  const server = http.createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      json(response, 401, { error: "Unauthorized." });
      return;
    }
    let url;
    try {
      url = new URL(request.url || "/", "http://127.0.0.1");
    } catch {
      json(response, 400, { error: "Bad request." });
      return;
    }
    const route = `${request.method} ${url.pathname}`;
    if (!ROUTES.has(route)) {
      json(response, 404, { error: "Not found." });
      return;
    }

    /**
     * THE STREAM IS OPENED BEFORE ANY HOST IS TOUCHED. An engine that attached
     * while no terminal had ever been started must still be attached when the
     * first one is, or the exit of that first run has nowhere to go.
     */
    if (route === "GET /events") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      });
      // An immediate frame so the client knows it is attached rather than
      // merely connected — a socket that was accepted and never written to
      // looks identical to a healthy idle one.
      response.write(`event: attached\ndata: {"heartbeatMs":${heartbeatMs}}\n\n`);
      for (const frame of backlog.splice(0)) response.write(frame);
      const beat = setInterval(() => {
        try {
          response.write(": hb\n\n");
        } catch {
          /* the close handler below is what actually cleans up */
        }
      }, heartbeatMs);
      // A heartbeat must never be the reason the app cannot quit.
      if (typeof beat.unref === "function") beat.unref();
      listeners.add(response);
      const drop = () => {
        clearInterval(beat);
        listeners.delete(response);
      };
      request.on("close", drop);
      response.on("close", drop);
      response.on("error", drop);
      return;
    }

    try {
      /**
       * BEFORE ANY HOST IS RESOLVED, because this route touches no handle.
       * It carries bytes the engine has already redacted, addressed to whoever
       * in the cockpit is reading that terminal — so a shell whose host has not
       * been built yet (or has gone) has nothing to refuse here, and answering
       * 503 would make a missing DRAW look like a missing PROCESS.
       *
       * NOTHING IS LOGGED, as everywhere else in this file: these are a run's
       * own bytes, and redacted is not the same as harmless.
       */
      if (route === "POST /mirror") {
        const input = await readJson(request);
        const id = String(input.id ?? "");
        const data = typeof input.data === "string" ? input.data : "";
        const cursor = Number.isFinite(input.cursor) ? Number(input.cursor) : undefined;
        const mirrored = Boolean(id && data);
        if (mirrored) onMirror?.(id, data, cursor);
        json(response, 200, { mirrored });
        return;
      }
      const host = getTerminalHost();
      if (!host) {
        json(response, 503, { error: "This Telar shell has no terminal host." });
        return;
      }
      if (route === "GET /state") {
        // The ENGINE's terminals. A person's Terminal tabs are not this
        // channel's business and are not listed here.
        json(response, 200, { terminals: host.list(ENGINE) });
        return;
      }
      const input = await readJson(request);
      if (route === "POST /open") {
        /**
         * A RUN IS A SHELL LIKE ANY OTHER TERMINAL. The engine has already
         * resolved which program and which argv (`run/shell.ts`), so nothing
         * here splits a command line — this only hands them over.
         */
        const opened = host.open({
          shell: input.shell,
          args: Array.isArray(input.args) ? input.args : [],
          cwd: input.cwd,
          env: input.env && typeof input.env === "object" ? input.env : undefined,
          cols: input.cols,
          rows: input.rows,
          owner: ENGINE,
        });
        json(response, 200, opened);
        return;
      }
      if (route === "POST /kill") {
        // BY ID. The engine never names a pid, which is what keeps a signal
        // from reaching a stranger the kernel handed that number to.
        json(response, 200, { signalled: host.kill(String(input.id ?? ""), input.signal || "SIGTERM", ENGINE) });
        return;
      }
      if (route === "POST /write") {
        /**
         * A KEYSTROKE IS NOT A REQUEST TO START ANYTHING. `false` here means
         * the bytes did not reach a process — an id this channel does not own,
         * or one whose terminal has already ended — and the engine reports
         * that rather than pretending the keys landed. It is NOT an error: the
         * cockpit learns of an exit asynchronously, so a keystroke in flight
         * across that gap is the ordinary case.
         */
        json(response, 200, { ok: host.write(String(input.id ?? ""), typeof input.data === "string" ? input.data : "", ENGINE) });
        return;
      }
      if (route === "POST /resize") {
        // The surface drawing this terminal decides its geometry; SIGWINCH is
        // the PTY's job. Same `false` rule as `/write`.
        json(response, 200, { ok: host.resize(String(input.id ?? ""), input.cols, input.rows, ENGINE) });
        return;
      }
    } catch (error) {
      json(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      resolve({
        port: typeof address === "object" && address ? address.port : port,
        /** Wire the host's callbacks to this, once, when the host is built. */
        onData: (id, data) => broadcast("data", { id, data }),
        onExit: (id, ending) => broadcast("exit", ending),
        close: () => {
          for (const listener of [...listeners]) {
            try {
              listener.end();
            } catch {
              /* already gone */
            }
          }
          listeners.clear();
          return new Promise((done) => server.close(done));
        },
      });
    });
  });
}

module.exports = { startRunTerminalServer, MAX_BODY_BYTES, HEARTBEAT_MS };
