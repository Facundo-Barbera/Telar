const { test, expect, afterEach } = require("bun:test");
const { startRunTerminalServer, MAX_BODY_BYTES } = require("./run-terminal-server");

const servers = [];
const streams = [];

afterEach(async () => {
  while (streams.length) {
    try {
      await streams.pop().cancel();
    } catch {
    }
  }
  while (servers.length) await servers.pop().close();
});

function fakeHost() {
  return {
    opened: [],
    killed: [],
    wrote: [],
    resized: [],
    listedAs: [],
    closed: [],
    sessionsClosed: [],
    asked: [],
    open(request) {
      this.opened.push(request);
      return { id: `term_${this.opened.length}`, pid: 4200 + this.opened.length };
    },
    kill(id, signal, owner) {
      this.killed.push({ id, signal, owner });
      return true;
    },
    write(id, data, owner) {
      this.wrote.push({ id, data, owner });
      return true;
    },
    resize(id, cols, rows, owner) {
      this.resized.push({ id, cols, rows, owner });
      return true;
    },
    async close(id, owner) {
      this.closed.push({ id, owner });
      return id === "term_1";
    },
    async killBySession(sessionId) {
      this.sessionsClosed.push(sessionId);
      return 2;
    },
    async activeProcesses(options) {
      this.asked.push(options);
      return [{ id: "term_1", sessionId: "s_1", origin: "run", active: true, processes: 1, command: "bun run dev" }];
    },
    countBySession() {
      return { s_1: 2, s_2: 1 };
    },
    list(owner) {
      this.listedAs.push(owner);
      return this.opened.map((_, index) => ({ id: `term_${index + 1}`, pid: 4200 + index + 1 }));
    },
  };
}

async function serve(options = {}) {
  const host = options.host ?? fakeHost();

  const mirrored = [];
  const server = await startRunTerminalServer({
    port: 0,
    token: "t0ken",
    getTerminalHost: () => (options.noHost ? null : host),
    onMirror: (id, data, cursor) => mirrored.push({ id, data, cursor }),
    ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
  });
  servers.push(server);
  return { host, server, mirrored, url: `http://127.0.0.1:${server.port}` };
}

const auth = { authorization: "Bearer t0ken", "content-type": "application/json" };

function frameReader(response) {
  const reader = response.body.getReader();
  streams.push(reader);
  const decoder = new TextDecoder();
  const pending = [];
  let buffer = "";
  return async function next(want, ms = 3000) {
    const frames = [];
    const deadline = Date.now() + ms;
    while (frames.length < want) {
      if (pending.length) {
        frames.push(pending.shift());
        continue;
      }
      if (Date.now() >= deadline) break;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let at = buffer.indexOf("\n\n");
      while (at !== -1) {
        pending.push(buffer.slice(0, at));
        buffer = buffer.slice(at + 2);
        at = buffer.indexOf("\n\n");
      }
    }
    return frames;
  };
}

test("every route needs the token, and a wrong one is refused before anything runs", async () => {
  const { host, url } = await serve();
  for (const [method, path] of [
    ["POST", "/open"],
    ["POST", "/kill"],
    ["POST", "/close"],
    ["POST", "/close-session"],
    ["POST", "/active"],
    ["POST", "/write"],
    ["POST", "/resize"],
    ["GET", "/events"],
    ["GET", "/state"],
    ["GET", "/sessions"],
  ]) {
    const response = await fetch(`${url}${path}`, { method, headers: { authorization: "Bearer wrong" } });
    expect(response.status).toBe(401);
    await response.body?.cancel();
  }

  expect(host.opened).toHaveLength(0);
  expect(host.killed).toHaveLength(0);
  expect(host.wrote).toHaveLength(0);
  expect(host.closed).toHaveLength(0);
  expect(host.sessionsClosed).toHaveLength(0);
});

test("the route set is closed: a path that is not one of the ten is a 404", async () => {
  const { host, url } = await serve();

  for (const path of ["/", "/exec", "/open/../state", "/writes", "/resize/all", "/mirrors", "/closeall", "/close-sessions"]) {
    const response = await fetch(`${url}${path}`, { method: "POST", headers: auth, body: "{}" });
    expect(response.status).toBe(404);
    await response.body?.cancel();
  }
  expect(host.opened).toHaveLength(0);
});

test("a body past the cap is refused rather than buffered", async () => {
  const { host, url } = await serve();

  let status = "reset";
  try {
    const response = await fetch(`${url}/open`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ shell: "/bin/sh", args: ["-c", "x".repeat(MAX_BODY_BYTES + 1000)] }),
    });
    status = response.status;
    await response.body?.cancel();
  } catch {
  }
  expect(status === "reset" || status === 400).toBe(true);
  expect(host.opened).toHaveLength(0);

  const ok = await fetch(`${url}/open`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ shell: "/bin/sh", args: ["-c", "x".repeat(1000)] }),
  });
  expect(ok.status).toBe(200);
  expect(host.opened).toHaveLength(1);
});

test("a shell with no terminal host says so rather than pretending", async () => {
  const { url } = await serve({ noHost: true });
  const response = await fetch(`${url}/state`, { headers: auth });
  expect(response.status).toBe(503);
});

test("open hands the host what the engine resolved, unsplit", async () => {
  const { host, url } = await serve();
  const response = await fetch(`${url}/open`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ shell: "/bin/zsh", args: ["-lc", "bun run dev && echo ok"], cwd: "/tmp", env: { A: "1" }, cols: 100, rows: 40 }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ id: "term_1", pid: 4201 });

  expect(host.opened[0].args).toEqual(["-lc", "bun run dev && echo ok"]);
  expect(host.opened[0].shell).toBe("/bin/zsh");
  expect(host.opened[0].cwd).toBe("/tmp");
  expect(host.opened[0].env).toEqual({ A: "1" });
  expect(host.opened[0].cols).toBe(100);
});

test("kill addresses a terminal id, and the server never invents one", async () => {
  const { host, url } = await serve();
  const response = await fetch(`${url}/kill`, { method: "POST", headers: auth, body: JSON.stringify({ id: "term_9", signal: "SIGKILL" }) });
  expect(await response.json()).toEqual({ signalled: true });
  expect(host.killed).toEqual([{ id: "term_9", signal: "SIGKILL", owner: "engine" }]);

  await (await fetch(`${url}/kill`, { method: "POST", headers: auth, body: "{}" })).json();
  expect(host.killed[1]).toEqual({ id: "", signal: "SIGTERM", owner: "engine" });
});

test("open passes the session, origin and title through, and an old engine that sends none still opens", async () => {
  const { host, url } = await serve();
  await (
    await fetch(`${url}/open`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ shell: "/bin/sh", args: [], sessionId: "s_1", origin: "agent", title: "web dev" }),
    })
  ).json();
  expect(host.opened[0]).toEqual(expect.objectContaining({ owner: "engine", sessionId: "s_1", origin: "agent", title: "web dev" }));

  await (await fetch(`${url}/open`, { method: "POST", headers: auth, body: JSON.stringify({ shell: "/bin/sh", args: [] }) })).json();
  expect(host.opened[1].origin).toBeUndefined();
  expect(host.opened[1].sessionId).toBeUndefined();
});

test("an origin the engine may not claim is a 400, not a terminal", async () => {
  const { TerminalHost } = require("./terminal-host");
  let spawned = 0;
  const host = new TerminalHost({
    platform: "darwin",
    version: "9.9.9",
    spawnPty: () => {
      spawned += 1;
      return { pid: 1, onData: () => {}, onExit: () => {}, write: () => {}, resize: () => {} };
    },
    killTree: () => {},
  });
  const { url } = await serve({ host });
  const response = await fetch(`${url}/open`, { method: "POST", headers: auth, body: JSON.stringify({ shell: "/bin/sh", origin: "user" }) });
  expect(response.status).toBe(400);
  expect((await response.json()).error).toContain("origin");
  expect(spawned).toBe(0);
});

test("close is the escalating verb, by id, in the engine's scope", async () => {
  const { host, url } = await serve();
  expect(await (await fetch(`${url}/close`, { method: "POST", headers: auth, body: JSON.stringify({ id: "term_1" }) })).json()).toEqual({ closed: true });
  expect(await (await fetch(`${url}/close`, { method: "POST", headers: auth, body: "{}" })).json()).toEqual({ closed: false });
  expect(host.closed).toEqual([
    { id: "term_1", owner: "engine" },
    { id: "", owner: "engine" },
  ]);
});

test("close-session closes a whole session and answers how many", async () => {
  const { host, url } = await serve();
  const response = await fetch(`${url}/close-session`, { method: "POST", headers: auth, body: JSON.stringify({ sessionId: "s_1" }) });
  expect(await response.json()).toEqual({ closed: 2 });

  await (await fetch(`${url}/close-session`, { method: "POST", headers: auth, body: "{}" })).json();
  expect(host.sessionsClosed).toEqual(["s_1", undefined]);
});

test("sessions answers each session's terminal count, whoever opened them (#883)", async () => {
  const { url } = await serve();
  const response = await fetch(`${url}/sessions`, { headers: auth });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ sessions: { s_1: 2, s_2: 1 } });
});

test("active answers for the engine's own terminals, narrowed by ids", async () => {
  const { host, url } = await serve();
  const answer = await (await fetch(`${url}/active`, { method: "POST", headers: auth, body: JSON.stringify({ ids: ["term_1"] }) })).json();
  expect(answer.terminals[0]).toEqual(expect.objectContaining({ id: "term_1", active: true, command: "bun run dev" }));
  await (await fetch(`${url}/active`, { method: "POST", headers: auth, body: JSON.stringify({ ids: "term_1" }) })).json();
  expect(host.asked).toEqual([
    { owner: "engine", ids: ["term_1"] },
    { owner: "engine", ids: undefined },
  ]);
});

test("write and resize are real routes, and every verb names the engine's scope", async () => {
  const { host, url } = await serve();
  const wrote = await fetch(`${url}/write`, { method: "POST", headers: auth, body: JSON.stringify({ id: "term_3", data: "y\r" }) });
  expect(wrote.status).toBe(200);
  expect(await wrote.json()).toEqual({ ok: true });
  expect(host.wrote).toEqual([{ id: "term_3", data: "y\r", owner: "engine" }]);

  const resized = await fetch(`${url}/resize`, { method: "POST", headers: auth, body: JSON.stringify({ id: "term_3", cols: 100, rows: 40 }) });
  expect(await resized.json()).toEqual({ ok: true });
  expect(host.resized).toEqual([{ id: "term_3", cols: 100, rows: 40, owner: "engine" }]);

  await fetch(`${url}/open`, { method: "POST", headers: auth, body: JSON.stringify({ shell: "/bin/sh", args: ["-c", "true"] }) });
  await (await fetch(`${url}/state`, { headers: auth })).json();
  expect(host.opened[0].owner).toBe("engine");
  expect(host.listedAs).toEqual(["engine"]);
});

test("a write the host refuses is reported as not delivered, not as an error", async () => {
  const host = fakeHost();
  host.write = () => false;
  const { url } = await serve({ host });
  const response = await fetch(`${url}/write`, { method: "POST", headers: auth, body: JSON.stringify({ id: "term_gone", data: "x" }) });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: false });
});

test("a write with no data reaches the host as the empty string rather than as undefined", async () => {
  const { host, url } = await serve();
  await (await fetch(`${url}/write`, { method: "POST", headers: auth, body: "{}" })).json();
  expect(host.wrote).toEqual([{ id: "", data: "", owner: "engine" }]);
});

test("a mirrored frame is handed on with its id and its cursor, and touches no terminal", async () => {
  const { host, mirrored, url } = await serve();
  const response = await fetch(`${url}/mirror`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ id: "term_9", data: "[32mup[0m", cursor: 12 }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ mirrored: true });
  expect(mirrored).toEqual([{ id: "term_9", data: "[32mup[0m", cursor: 12 }]);

  expect(host.wrote).toHaveLength(0);
  expect(host.killed).toHaveLength(0);
  expect(host.listedAs).toHaveLength(0);
});

test("a shell with no terminal host still takes a mirror", async () => {
  const { mirrored, url } = await serve({ noHost: true });
  const response = await fetch(`${url}/mirror`, { method: "POST", headers: auth, body: JSON.stringify({ id: "term_1", data: "x", cursor: 1 }) });
  expect(response.status).toBe(200);
  expect(mirrored).toEqual([{ id: "term_1", data: "x", cursor: 1 }]);
});

test("a mirror with nothing to draw is answered and dropped rather than fanned", async () => {
  const { mirrored, url } = await serve();
  for (const body of ["{}", JSON.stringify({ id: "term_1" }), JSON.stringify({ data: "x" })]) {
    const response = await fetch(`${url}/mirror`, { method: "POST", headers: auth, body });
    expect(await response.json()).toEqual({ mirrored: false });
  }
  expect(mirrored).toHaveLength(0);
});

test("the stream heartbeats, so a silent host is distinguishable from an idle one", async () => {
  const { url } = await serve({ heartbeatMs: 40 });
  const response = await fetch(`${url}/events`, { headers: auth });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");

  const frames = await frameReader(response)(4);
  expect(frames.length).toBeGreaterThanOrEqual(4);
  expect(frames[0]).toContain("event: attached");
  expect(frames[0]).toContain('"heartbeatMs":40');
  const beats = frames.slice(1).filter((frame) => frame.startsWith(":"));
  expect(beats.length).toBeGreaterThanOrEqual(3);
});

test("frames produced before anyone attached are delivered, not dropped", async () => {
  const { server, url } = await serve({ heartbeatMs: 1000 });
  server.onData("term_1", "hello");
  server.onExit("term_1", { id: "term_1", fate: "exited", exitCode: 0 });

  const response = await fetch(`${url}/events`, { headers: auth });
  const frames = await frameReader(response)(3);
  expect(frames[0]).toContain("event: attached");
  expect(frames[1]).toContain("event: data");
  expect(frames[1]).toContain("hello");
  expect(frames[2]).toContain("event: exit");
  expect(JSON.parse(frames[2].split("data: ")[1])).toEqual({ id: "term_1", fate: "exited", exitCode: 0 });
});

test("a live frame reaches an attached listener", async () => {
  const { server, url } = await serve({ heartbeatMs: 1000 });
  const response = await fetch(`${url}/events`, { headers: auth });
  const next = frameReader(response);
  const first = await next(1);
  expect(first[0]).toContain("event: attached");
  server.onExit("term_7", { id: "term_7", fate: "exited", exitCode: 0, signal: "1", closed: "close" });

  const more = await next(1);
  expect(more[0]).toContain("event: exit");
  expect(more[0]).toContain('"closed":"close"');
});
