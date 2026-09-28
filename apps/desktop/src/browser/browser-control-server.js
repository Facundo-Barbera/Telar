const http = require("node:http");

const MAX_BODY_BYTES = 1_000_000;

/** Every route this server answers. Anything else is a 404 before a body is
 *  read or a browser host is resolved. */
const ROUTES = new Set(["GET /state", "POST /bind", "POST /tool", "POST /open", "POST /release", "GET /metrics"]);

function json(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Browser control request is too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new Error("Browser control request is not valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

function startBrowserControlServer({ port, token, getBrowserManager, readProcessMetrics }) {
  if (!token) throw new Error("A browser control token is required.");
  const server = http.createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      json(response, 401, { error: "Unauthorized." });
      return;
    }

    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      const route = `${request.method} ${url.pathname}`;
      if (!ROUTES.has(route)) {
        json(response, 404, { error: "Not found." });
        return;
      }
      /**
       * WHAT THIS APP'S PROCESSES ARE DOING — issue #488, and the reason it is
       * answered here rather than over the shell's IPC alone.
       *
       * The Usage page is served by the forked Next child, which is a SIBLING
       * of the Electron main process and so can no more call
       * `app.getAppMetrics()` than any other program on the machine. The shell
       * already exports this server's port and token into that child's
       * environment (`childEnv` in main.js), so this is the wire the cockpit's
       * own route proxies — which is also what makes the figures reachable from
       * a phone or a second browser, where there is no preload bridge at all.
       *
       * ANSWERED BEFORE ANY SCOPE IS RESOLVED: it is a fact about the app, not
       * about a session's tabs, and a shell with no window open is exactly when
       * "what is burning a core" is worth asking.
       */
      if (route === "GET /metrics") {
        if (typeof readProcessMetrics !== "function") {
          json(response, 503, { error: "This Telar shell does not report process metrics." });
          return;
        }
        json(response, 200, await readProcessMetrics());
        return;
      }
      // The body is read BEFORE the host is resolved, because the scope it
      // names is what decides WHICH host answers — see below.
      const input = request.method === "POST" ? await readJson(request) : {};
      const scopeKey = request.method === "GET" ? url.searchParams.get("scopeKey") : input.scopeKey;
      /**
       * THE WINDOW THIS SESSION'S COCKPIT IS IN (issue #311). Every panel
       * request is answered by the window that sent it, but an agent reaches
       * the shell over HTTP and has no window to be recognised by — it names
       * its SCOPE. Resolving that to a single host (the focused window's) sent
       * a second window's session to the first window's native views.
       */
      const manager = getBrowserManager(scopeKey);
      if (!manager) {
        json(response, 503, { error: "The Telar desktop browser host is not ready." });
        return;
      }

      if (route === "GET /state") {
        json(response, 200, await manager.state(scopeKey));
        return;
      }
      // A scope's profile binding — its project — declared by the engine from
      // the claim BEFORE any tool of the turn runs. Idempotent; a change
      // while tabs exist is refused by the manager.
      if (route === "POST /bind") {
        json(response, 200, manager.declareProfile(scopeKey, input.profileKey));
        return;
      }
      if (route === "POST /tool") {
        json(response, 200, await manager.callTool(scopeKey, input.name, input.args || {}));
        return;
      }
      // A HUMAN opening a tab from the cockpit's "open a browser" — routed
      // through the engine, which is why it is not the shell's IPC. Distinct
      // from /tool so the tab is stamped `openedBy: human` without teaching
      // the agent's tool path an opener argument it must never be able to set.
      if (route === "POST /open") {
        json(response, 200, await manager.action(scopeKey, { action: "new", url: input.url || "about:blank" }));
        return;
      }
      /**
       * A SESSION'S BROWSER IS OVER — the engine settled, archived or deleted
       * it (#883). Its pages close, whoever opened them, exactly as closing the
       * panel's Browser tab closes them — except that nobody is told "the
       * person closed it": the session's next turn, if it has one, starts over.
       */
      if (route === "POST /release") {
        manager.releaseScope(scopeKey, true);
        json(response, 200, { released: true });
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
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

module.exports = { startBrowserControlServer };
