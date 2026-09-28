const http = require("node:http");
const { TerminalOwner } = require("./terminal-host");

const ENGINE = TerminalOwner.ENGINE;

const MAX_BODY_BYTES = 256_000;

const HEARTBEAT_MS = 2_000;

const ROUTES = new Set([
  "POST /open",
  "POST /kill",
  "POST /close",
  "POST /close-session",
  "POST /active",
  "POST /write",
  "POST /resize",
  "POST /mirror",
  "GET /events",
  "GET /state",
  "GET /sessions",
]);

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

function createEventStream(heartbeatMs) {
  const listeners = new Set();

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
      }
    }
  };

  const attach = (request, response) => {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });

    response.write(`event: attached\ndata: {"heartbeatMs":${heartbeatMs}}\n\n`);
    for (const frame of backlog.splice(0)) response.write(frame);
    const beat = setInterval(() => {
      try {
        response.write(": hb\n\n");
      } catch {
      }
    }, heartbeatMs);

    if (typeof beat.unref === "function") beat.unref();
    listeners.add(response);
    const drop = () => {
      clearInterval(beat);
      listeners.delete(response);
    };
    request.on("close", drop);
    response.on("close", drop);
    response.on("error", drop);
  };

  const endAll = () => {
    for (const listener of listeners) {
      try {
        listener.end();
      } catch {
      }
    }
    listeners.clear();
  };

  return { broadcast, attach, endAll };
}

async function runHostRoute(route, request, host) {
  if (route === "GET /state") return { terminals: host.list(ENGINE) };
  if (route === "GET /sessions") return { sessions: host.countBySession() };
  const input = await readJson(request);
  if (route === "POST /open") {
    return host.open({
      shell: input.shell,
      args: Array.isArray(input.args) ? input.args : [],
      cwd: input.cwd,
      env: input.env && typeof input.env === "object" ? input.env : undefined,
      cols: input.cols,
      rows: input.rows,
      owner: ENGINE,

      origin: input.origin ?? undefined,
      sessionId: input.sessionId,
      title: input.title,
    });
  }
  if (route === "POST /kill") return { signalled: host.kill(String(input.id ?? ""), input.signal || "SIGTERM", ENGINE) };
  if (route === "POST /close") return { closed: await host.close(String(input.id ?? ""), ENGINE) };
  if (route === "POST /close-session") return { closed: await host.killBySession(input.sessionId) };
  if (route === "POST /active") {
    return { terminals: await host.activeProcesses({ owner: ENGINE, ids: Array.isArray(input.ids) ? input.ids : undefined }) };
  }
  if (route === "POST /write") return { ok: host.write(String(input.id ?? ""), typeof input.data === "string" ? input.data : "", ENGINE) };
  if (route === "POST /resize") return { ok: host.resize(String(input.id ?? ""), input.cols, input.rows, ENGINE) };
  return undefined;
}

async function mirror(request, onMirror) {
  const input = await readJson(request);
  const id = String(input.id ?? "");
  const data = typeof input.data === "string" ? input.data : "";
  const cursor = Number.isFinite(input.cursor) ? Number(input.cursor) : undefined;
  const mirrored = Boolean(id && data);
  if (mirrored) onMirror?.(id, data, cursor);
  return { mirrored };
}

function startRunTerminalServer({ port, token, getTerminalHost, onMirror, heartbeatMs = HEARTBEAT_MS }) {
  if (!token) throw new Error("A run terminal token is required.");

  const events = createEventStream(heartbeatMs);

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

    if (route === "GET /events") {
      events.attach(request, response);
      return;
    }

    try {
      if (route === "POST /mirror") {
        json(response, 200, await mirror(request, onMirror));
        return;
      }
      const host = getTerminalHost();
      if (!host) {
        json(response, 503, { error: "This Telar shell has no terminal host." });
        return;
      }
      const body = await runHostRoute(route, request, host);
      if (body !== undefined) json(response, 200, body);
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

        onData: (id, data) => events.broadcast("data", { id, data }),
        onExit: (id, ending) => events.broadcast("exit", ending),
        close: () => {
          events.endAll();
          return new Promise((done) => server.close(done));
        },
      });
    });
  });
}

module.exports = { startRunTerminalServer, MAX_BODY_BYTES };
