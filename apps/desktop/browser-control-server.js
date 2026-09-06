const http = require("node:http");

const MAX_BODY_BYTES = 1_000_000;

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

function startBrowserControlServer({ port, token, getBrowserManager }) {
  if (!token) throw new Error("A browser control token is required.");
  const server = http.createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      json(response, 401, { error: "Unauthorized." });
      return;
    }

    try {
      const manager = getBrowserManager();
      if (!manager) {
        json(response, 503, { error: "The Telar desktop browser host is not ready." });
        return;
      }

      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/state") {
        json(response, 200, await manager.state(url.searchParams.get("scopeKey")));
        return;
      }
      // A scope's profile binding — its project — declared by the engine from
      // the claim BEFORE any tool of the turn runs. Idempotent; a change
      // while tabs exist is refused by the manager.
      if (request.method === "POST" && url.pathname === "/bind") {
        const input = await readJson(request);
        json(response, 200, manager.declareProfile(input.scopeKey, input.profileKey));
        return;
      }
      if (request.method === "POST" && url.pathname === "/tool") {
        const input = await readJson(request);
        json(response, 200, await manager.callTool(input.scopeKey, input.name, input.args || {}));
        return;
      }
      // A HUMAN opening a tab from the cockpit's "open a browser" — routed
      // through the engine, which is why it is not the shell's IPC. Distinct
      // from /tool so the tab is stamped `openedBy: human` without teaching
      // the agent's tool path an opener argument it must never be able to set.
      if (request.method === "POST" && url.pathname === "/open") {
        const input = await readJson(request);
        json(response, 200, await manager.action(input.scopeKey, { action: "new", url: input.url || "about:blank" }));
        return;
      }
      json(response, 404, { error: "Not found." });
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
