const http = require("node:http");

const MAX_BODY_BYTES = 1_000_000;

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

      if (route === "GET /metrics") {
        if (typeof readProcessMetrics !== "function") {
          json(response, 503, { error: "This Telar shell does not report process metrics." });
          return;
        }
        json(response, 200, await readProcessMetrics());
        return;
      }

      const input = request.method === "POST" ? await readJson(request) : {};
      const scopeKey = request.method === "GET" ? url.searchParams.get("scopeKey") : input.scopeKey;

      const manager = getBrowserManager(scopeKey);
      if (!manager) {
        json(response, 503, { error: "The Telar desktop browser host is not ready." });
        return;
      }

      if (route === "GET /state") {
        json(response, 200, await manager.state(scopeKey));
        return;
      }

      if (route === "POST /bind") {
        json(response, 200, manager.declareProfile(scopeKey, input.profileKey));
        return;
      }
      if (route === "POST /tool") {
        json(response, 200, await manager.callTool(scopeKey, input.name, input.args || {}));
        return;
      }

      if (route === "POST /open") {
        json(response, 200, await manager.action(scopeKey, { action: "new", url: input.url || "about:blank" }));
        return;
      }

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
