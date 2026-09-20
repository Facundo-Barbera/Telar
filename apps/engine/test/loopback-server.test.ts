/**
 * THE PROMISE `loopback-server.ts` MAKES, PINNED — issue #610.
 *
 * The whole fix is one word of configuration, and a word is exactly the kind of
 * thing a later edit removes without noticing: dropping the hostname puts the
 * bind back on the wildcard, the bind silently succeeds on a port somebody else
 * is serving, and four tests in two files go back to failing in CI only. So the
 * property is asserted rather than left to the comment.
 */
import { expect, test } from "bun:test";
import http from "node:http";
import { loopbackBase, serveLoopback } from "./loopback-server";

/** A neighbour of the shape this suite actually has around it: the engine's own
 *  sockets and daemon all `listen(0, "127.0.0.1")`, and every one of them
 *  answers a path it does not serve with a 404 rather than ignoring it. */
function neighbour(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((_request, response) => {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "not_found", message: "this socket serves one path" } }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: (server.address() as { port: number }).port,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

test("a stub refuses a port a loopback listener already holds, rather than quietly sharing it", async () => {
  const held = await neighbour();
  try {
    // THE FAILURE THIS REPLACES was silent: the bind succeeded, `server.port`
    // reported the taken port, and the neighbour answered every request the
    // test then made — so the test failed wherever it first read a recorded
    // call, three frames inside a client library and naming nothing.
    expect(() => serveLoopback(() => Response.json({ who: "the stub" }), held.port)).toThrow();

    // AND THE NEIGHBOUR IS STILL THE ONLY ANSWER on that port, which is the
    // half that matters: a refused bind is only good news if it means the stub
    // never believed it owned the port.
    const answer = await fetch(`http://127.0.0.1:${held.port}/anything`);
    expect(await answer.text()).toContain("this socket serves one path");
  } finally {
    await held.close();
  }
});

test("a stub on its own port is the one that answers, and says where it lives", async () => {
  const server = serveLoopback(() => Response.json({ who: "the stub" }));
  try {
    expect(loopbackBase(server)).toBe(`http://127.0.0.1:${server.port}/v1`);
    const answer = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, { method: "POST", body: "{}" });
    expect(await answer.json()).toEqual({ who: "the stub" });
  } finally {
    await server.stop(true);
  }
});
