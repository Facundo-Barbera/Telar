/**
 * The engine's door to this process's PTYs — the wire, not the policy.
 *
 * WHAT IS ASSERTED HERE IS WHAT ONLY THIS SIDE CAN GET WRONG: the closed route
 * set, the token, the body cap, and the two properties the engine's `unknown`
 * guarantee rests on — that the stream HEARTBEATS, so a wedged host is
 * distinguishable from an idle one, and that frames produced before anyone
 * attached are not dropped, so a command that dies instantly still has its exit
 * delivered.
 *
 * The fate semantics themselves are asserted from the other end, against this
 * server, in `apps/engine/test/run-terminal-channel.test.ts` — two hand-rolled
 * ends of a protocol agree with each other by construction and with nothing
 * else, so neither file re-implements the other.
 */
const { test, expect, afterEach } = require("bun:test");
const { startRunTerminalServer, MAX_BODY_BYTES } = require("./run-terminal-server");

const servers = [];
const streams = [];

/** Nothing this file starts outlives it: every server binds a loopback port. */
afterEach(async () => {
  while (streams.length) {
    try {
      await streams.pop().cancel();
    } catch {
      /* already gone */
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
    list(owner) {
      this.listedAs.push(owner);
      return this.opened.map((_, index) => ({ id: `term_${index + 1}`, pid: 4200 + index + 1 }));
    },
  };
}

async function serve(options = {}) {
  const host = options.host ?? fakeHost();
  /** What `/mirror` handed back — in main.js this is the frame delivered to
   *  whichever renderer adopted that run's terminal (#890). */
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

/**
 * One reader per stream, kept across calls — a `ReadableStream` may only be
 * locked once, so asking for "the next N frames" twice has to be the same
 * reader rather than two.
 */
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

// ── the closed surface ───────────────────────────────────────────────────────

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
  ]) {
    const response = await fetch(`${url}${path}`, { method, headers: { authorization: "Bearer wrong" } });
    expect(response.status).toBe(401);
    await response.body?.cancel();
  }
  // Refused BEFORE the host was touched, which is what "before anything runs"
  // has to mean for a route that starts processes — and, now, for one that
  // types into them.
  expect(host.opened).toHaveLength(0);
  expect(host.killed).toHaveLength(0);
  expect(host.wrote).toHaveLength(0);
  expect(host.closed).toHaveLength(0);
  expect(host.sessionsClosed).toHaveLength(0);
});

test("the route set is closed: a path that is not one of the ten is a 404", async () => {
  const { host, url } = await serve();
  // `/write`, `/resize` and `/mirror` each moved OUT of this list when they
  // were built, so the list is kept adjacent to the positive cases below rather
  // than trusted on its own: a route set that 404'd everything would satisfy
  // this half alone.
  for (const path of ["/", "/exec", "/open/../state", "/writes", "/resize/all", "/mirrors", "/closeall", "/close-sessions"]) {
    const response = await fetch(`${url}${path}`, { method: "POST", headers: auth, body: "{}" });
    expect(response.status).toBe(404);
    await response.body?.cancel();
  }
  expect(host.opened).toHaveLength(0);
});

test("a body past the cap is refused rather than buffered", async () => {
  const { host, url } = await serve();
  // The refusal DESTROYS the request rather than draining it — which is the
  // point of a cap — so a caller sees the connection go rather than a tidy 400.
  // What is asserted is therefore the property that matters: the request did
  // not succeed, and no process was started while the body was being read.
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
    /* the destroyed socket, which is the ordinary outcome here */
  }
  expect(status === "reset" || status === 400).toBe(true);
  expect(host.opened).toHaveLength(0);

  // And the control: one byte under the cap goes through, so the assertion
  // above is about the cap rather than about the route being broken.
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

// ── open and kill ────────────────────────────────────────────────────────────

test("open hands the host what the engine resolved, unsplit", async () => {
  const { host, url } = await serve();
  const response = await fetch(`${url}/open`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ shell: "/bin/zsh", args: ["-lc", "bun run dev && echo ok"], cwd: "/tmp", env: { A: "1" }, cols: 100, rows: 40 }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ id: "term_1", pid: 4201 });
  // The command is ONE argv element: nothing on this side splits a command line.
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
  // No id at all is passed through as the empty string rather than guessed at:
  // the host is the only thing entitled to decide an id means nothing.
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
  // The backward-compatible half: today's engine client sends none of them, and
  // the host is left to default them — the server does not invent values.
  await (await fetch(`${url}/open`, { method: "POST", headers: auth, body: JSON.stringify({ shell: "/bin/sh", args: [] }) })).json();
  expect(host.opened[1].origin).toBeUndefined();
  expect(host.opened[1].sessionId).toBeUndefined();
});

test("an origin the engine may not claim is a 400, not a terminal", async () => {
  // The REAL host this time: the pairing rule lives there, and the wire must
  // surface its refusal rather than swallow it.
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
  // Passed as given: the host is what refuses a missing session id.
  await (await fetch(`${url}/close-session`, { method: "POST", headers: auth, body: "{}" })).json();
  expect(host.sessionsClosed).toEqual(["s_1", undefined]);
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

// ── write and resize: the writable half ──────────────────────────────────────

test("write and resize are real routes, and every verb names the engine's scope", async () => {
  const { host, url } = await serve();
  const wrote = await fetch(`${url}/write`, { method: "POST", headers: auth, body: JSON.stringify({ id: "term_3", data: "y\r" }) });
  expect(wrote.status).toBe(200);
  expect(await wrote.json()).toEqual({ ok: true });
  expect(host.wrote).toEqual([{ id: "term_3", data: "y\r", owner: "engine" }]);

  const resized = await fetch(`${url}/resize`, { method: "POST", headers: auth, body: JSON.stringify({ id: "term_3", cols: 100, rows: 40 }) });
  expect(await resized.json()).toEqual({ ok: true });
  expect(host.resized).toEqual([{ id: "term_3", cols: 100, rows: 40, owner: "engine" }]);

  // AND THE SCOPE IS NOT ONLY ON THE NEW ROUTES. Every verb this channel has
  // has to name it, or the guard is decoration: one route that forgot would
  // let a run's terminal be reached with a renderer's vocabulary.
  await fetch(`${url}/open`, { method: "POST", headers: auth, body: JSON.stringify({ shell: "/bin/sh", args: ["-c", "true"] }) });
  await (await fetch(`${url}/state`, { headers: auth })).json();
  expect(host.opened[0].owner).toBe("engine");
  expect(host.listedAs).toEqual(["engine"]);
});

test("a write the host refuses is reported as not delivered, not as an error", async () => {
  // The host answers `false` for an id it does not hold — a terminal that has
  // already ended, or one belonging to the other scope. That is the ordinary
  // race (the cockpit learns of an exit asynchronously), so it must arrive as
  // an answer the caller can read rather than as a 4xx it has to catch.
  const host = fakeHost();
  host.write = () => false;
  const { url } = await serve({ host });
  const response = await fetch(`${url}/write`, { method: "POST", headers: auth, body: JSON.stringify({ id: "term_gone", data: "x" }) });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: false });
});

test("a write with no data reaches the host as the empty string rather than as undefined", async () => {
  // Same rule as `/kill` with no id: this side does not invent a value and
  // does not guess one. The host is what decides an input means nothing.
  const { host, url } = await serve();
  await (await fetch(`${url}/write`, { method: "POST", headers: auth, body: "{}" })).json();
  expect(host.wrote).toEqual([{ id: "", data: "", owner: "engine" }]);
});

// ── the mirror, which is the one arrow pointing back ─────────────────────────

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

  // NO HANDLE IS TOUCHED. These are bytes on their way to a screen, not a verb:
  // a route that reached the host here would be able to address a terminal
  // while claiming to be describing one.
  expect(host.wrote).toHaveLength(0);
  expect(host.killed).toHaveLength(0);
  expect(host.listedAs).toHaveLength(0);
});

test("a shell with no terminal host still takes a mirror", async () => {
  // 503 is the answer for a verb that needs a handle. A mirror needs none — it
  // is addressed at a renderer — and answering "this shell has no terminal
  // host" would make a missing DRAW look like a missing PROCESS.
  const { mirrored, url } = await serve({ noHost: true });
  const response = await fetch(`${url}/mirror`, { method: "POST", headers: auth, body: JSON.stringify({ id: "term_1", data: "x", cursor: 1 }) });
  expect(response.status).toBe(200);
  expect(mirrored).toEqual([{ id: "term_1", data: "x", cursor: 1 }]);
});

test("a mirror with nothing to draw is answered and dropped rather than fanned", async () => {
  // Same rule as everywhere else on this server: this side does not invent a
  // value. A frame with no id has nowhere to go and a frame with no data has
  // nothing to say, and either one reaching a renderer would be a repaint of
  // whatever it last drew.
  const { mirrored, url } = await serve();
  for (const body of ["{}", JSON.stringify({ id: "term_1" }), JSON.stringify({ data: "x" })]) {
    const response = await fetch(`${url}/mirror`, { method: "POST", headers: auth, body });
    expect(await response.json()).toEqual({ mirrored: false });
  }
  expect(mirrored).toHaveLength(0);
});

// ── the stream, which is what `unknown` rests on ─────────────────────────────

test("the stream heartbeats, so a silent host is distinguishable from an idle one", async () => {
  const { url } = await serve({ heartbeatMs: 40 });
  const response = await fetch(`${url}/events`, { headers: auth });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  // Four frames with nothing happening: the `attached` frame and then beats.
  // A count, not a substring — an idle stream that never wrote would satisfy
  // "no error occurred" and produce zero of these.
  const frames = await frameReader(response)(4);
  expect(frames.length).toBeGreaterThanOrEqual(4);
  expect(frames[0]).toContain("event: attached");
  expect(frames[0]).toContain('"heartbeatMs":40');
  const beats = frames.slice(1).filter((frame) => frame.startsWith(":"));
  expect(beats.length).toBeGreaterThanOrEqual(3);
});

test("frames produced before anyone attached are delivered, not dropped", async () => {
  // A command that dies instantly ends before the engine's stream is up. The
  // exit of that run has nowhere to go unless this is true, and a run whose
  // exit is lost sits `starting` forever holding its project.
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
  // The backlog is only for frames with nobody attached; with a listener the
  // frame goes straight out, so asking for one more must produce the exit
  // rather than a heartbeat — carrying why the host was closing it.
  const more = await next(1);
  expect(more[0]).toContain("event: exit");
  expect(more[0]).toContain('"closed":"close"');
});
