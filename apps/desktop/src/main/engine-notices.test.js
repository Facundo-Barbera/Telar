const { afterEach, expect, test } = require("bun:test");
const http = require("node:http");
const { createEngineNotices, MESSAGES_PATH, STREAM_PATH } = require("./engine-notices");

function connectEngineNotices({ readDiscovery, ...options }) {
  const notices = createEngineNotices({ ...options, readDiscovery });
  notices.start("engine.json");
  return notices;
}

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fakeEngine() {
  const posted = [];
  const streams = [];
  const auth = [];
  let arrived;
  const postedOne = () => new Promise((resolve) => (arrived = resolve));
  const server = http.createServer((request, response) => {
    auth.push(request.headers.authorization);
    if (request.method === "GET" && request.url === STREAM_PATH) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": open\n\n");
      streams.push(response);
      return;
    }
    if (request.method === "POST" && request.url === MESSAGES_PATH) {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        posted.push(JSON.parse(body));
        response.end("{}");
        arrived?.();
      });
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => { for (const stream of streams) stream.destroy(); server.close(resolve); }));
  const discovery = { host: "127.0.0.1", port: server.address().port, token: "engine-token" };
  const connected = async () => {
    while (streams.length === 0) await new Promise((resolve) => setImmediate(resolve));
    return streams.at(-1);
  };
  return { discovery, posted, postedOne, auth, connected };
}

test("notices on the engine's stream reach the shell, one per data frame", async () => {
  const engine = await fakeEngine();
  const received = [];
  let got;
  const notices = connectEngineNotices({ readDiscovery: () => engine.discovery, onMessage: (message) => { received.push(message); if (received.length === 2) got(); } });
  cleanups.push(() => notices.stop());
  const stream = await engine.connected();
  const done = new Promise((resolve) => (got = resolve));
  stream.write(`data: ${JSON.stringify({ type: "telar:desktop-notification", sessionId: "s1" })}\n\n`);
  stream.write(`data: not json\n\ndata: ${JSON.stringify({ type: "telar:desktop-notification:dismiss", sessionId: "s1" })}\n\n`);
  await done;
  expect(received.map((message) => message.type)).toEqual(["telar:desktop-notification", "telar:desktop-notification:dismiss"]);
  expect(engine.auth[0]).toBe("Bearer engine-token");
});

test("presence and approvals are posted to the engine", async () => {
  const engine = await fakeEngine();
  const notices = connectEngineNotices({ readDiscovery: () => engine.discovery, onMessage: () => {} });
  cleanups.push(() => notices.stop());
  const arrived = engine.postedOne();
  notices.send({ type: "telar:desktop-presence", active: true, viewingPath: null });
  await arrived;
  expect(engine.posted).toEqual([{ type: "telar:desktop-presence", active: true, viewingPath: null }]);
});

test("with no engine to reach it keeps trying and sends nothing", () => {
  let reads = 0;
  const notices = connectEngineNotices({ readDiscovery: () => { reads += 1; return null; }, onMessage: () => {}, retryMs: 60_000 });
  notices.send({ type: "telar:desktop-presence" });
  notices.stop();
  expect(reads).toBe(2);
});

test("a stopped subscription can start again", async () => {
  const engine = await fakeEngine();
  const notices = createEngineNotices({ readDiscovery: () => engine.discovery, onMessage: () => {} });
  cleanups.push(() => notices.stop());
  notices.start("engine.json");
  await engine.connected();
  notices.stop();
  notices.start("engine.json");
  while (engine.auth.length < 2) await new Promise((resolve) => setImmediate(resolve));
  expect(engine.auth).toEqual(["Bearer engine-token", "Bearer engine-token"]);
});
