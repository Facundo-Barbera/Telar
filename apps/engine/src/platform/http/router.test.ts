import { afterEach, expect, test } from "bun:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { errorFor, HttpError } from "./http";
import { notModified, ok, type Route } from "./route";
import { matchRoute, router } from "./router";

const sessionPattern: Route = { method: "GET", path: /^\/v2\/sessions\/([^/]+)$/, auth: "engine", handle: ({ params }) => ok({ session: params[0] }) };
const socket: Route = { method: "GET", path: "/v2/sessions/mcp", auth: "engine", handle: () => ok({ socket: true }) };

test("a literal path beats a pattern declared before it", () => {
  expect(matchRoute([sessionPattern, socket], "GET", "/v2/sessions/mcp")?.route).toBe(socket);
  expect(matchRoute([sessionPattern, socket], "GET", "/v2/sessions/abc")).toEqual({ route: sessionPattern, params: ["abc"] });
});

test("an optional group that did not match stays undefined", () => {
  const items: Route = { method: "GET", path: /^\/v2\/runs\/([a-z]+)\/items(?:\/([a-z]+))?$/, auth: "engine", handle: () => ok({}) };
  expect(matchRoute([items], "GET", "/v2/runs/abc/items")?.params).toEqual(["abc", undefined] as unknown as string[]);
  expect(matchRoute([items], "GET", "/v2/runs/abc/items/xy")?.params).toEqual(["abc", "xy"]);
});

test("patterns are tried in declaration order and a method mismatch does not match", () => {
  const tail: Route = { method: "GET", path: /^\/v2\/sessions\/(.+)$/, auth: "engine", handle: () => ok({}) };
  expect(matchRoute([tail, sessionPattern], "GET", "/v2/sessions/abc")?.route).toBe(tail);
  expect(matchRoute([socket], "POST", "/v2/sessions/mcp")).toBeUndefined();
});

let server: http.Server | undefined;
afterEach(() => server?.close());

async function serve(routes: Route[], fallback?: Parameters<typeof router>[1]["fallback"]): Promise<string> {
  server = http.createServer(
    router(routes, {
      authorize: (_auth, request) => {
        if (request.headers.authorization !== "Bearer ok") throw new HttpError(401, "engine_unauthorized", "no");
      },
      errorFor: (error) => errorFor(error),
      ...(fallback ? { fallback } : {}),
    }),
  );
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

test("serves a matched route, refuses without auth and answers an unknown path with an authenticated 404", async () => {
  const echo: Route = { method: "POST", path: "/v2/echo", auth: "engine", handle: ({ body }) => ({ status: 201, body }) };
  const base = await serve([sessionPattern, socket, echo]);
  const get = (path: string, auth = "Bearer ok") => fetch(base + path, { headers: { authorization: auth } });

  const literal = await get("/v2/sessions/mcp");
  expect(await literal.json()).toEqual({ socket: true });
  const posted = await fetch(`${base}/v2/echo`, { method: "POST", headers: { authorization: "Bearer ok" }, body: JSON.stringify({ a: 1 }) });
  expect([posted.status, await posted.json()]).toEqual([201, { a: 1 }]);
  const bad = await fetch(`${base}/v2/echo`, { method: "POST", headers: { authorization: "Bearer ok" }, body: "[" });
  expect([bad.status, await bad.json()]).toEqual([400, { error: { code: "invalid_request", message: "request body is invalid JSON" } }]);

  expect((await get("/v2/sessions/mcp", "Bearer no")).status).toBe(401);
  expect((await get("/v2/nowhere", "Bearer no")).status).toBe(401);
  const missing = await get("/v2/nowhere");
  expect([missing.status, await missing.json()]).toEqual([404, { error: { code: "not_found", message: "engine endpoint does not exist" } }]);
});

test("a route answering with bytes is sent raw with its own headers", async () => {
  const icon: Route = { method: "GET", path: "/v2/icon", auth: "engine", handle: () => ({ status: 200, body: undefined, bytes: new Uint8Array([1, 2, 3]), headers: { "content-type": "image/png" } }) };
  const answer = await fetch(`${await serve([icon])}/v2/icon`, { headers: { authorization: "Bearer ok" } });
  expect([answer.headers.get("content-type"), [...new Uint8Array(await answer.arrayBuffer())]]).toEqual(["image/png", [1, 2, 3]]);
});

test("a raw route reads its own body and may write the response itself; a 304 carries no body", async () => {
  const upload: Route = {
    method: "POST",
    path: "/v2/upload",
    auth: "engine",
    body: "raw",
    async handle({ request, response }) {
      let size = 0;
      for await (const chunk of request) size += (chunk as Buffer).length;
      response.writeHead(207).end(String(size));
      return undefined;
    },
  };
  const tagged: Route = { method: "GET", path: "/v2/tagged", auth: "engine", handle: () => notModified('W/"x"') };
  const base = await serve([upload, tagged]);
  const sent = await fetch(`${base}/v2/upload`, { method: "POST", headers: { authorization: "Bearer ok" }, body: "not json at all" });
  expect([sent.status, await sent.text()]).toEqual([207, "15"]);
  const cached = await fetch(`${base}/v2/tagged`, { headers: { authorization: "Bearer ok" } });
  expect([cached.status, cached.headers.get("etag"), await cached.text()]).toEqual([304, 'W/"x"', ""]);
});

test("an unmatched request goes to the fallback, whose throw becomes the error answer", async () => {
  const base = await serve([socket], async (_request, _response, url) => {
    throw new HttpError(409, "conflict", `fell through ${url.pathname}`);
  });
  const answer = await fetch(`${base}/v2/other`);
  expect([answer.status, await answer.json()]).toEqual([409, { error: { code: "conflict", message: "fell through /v2/other" } }]);
});

test("a handler that fails after its headers went out drops the connection instead of rejecting", async () => {
  const handled: Promise<unknown>[] = [];
  const handler = router(
    [
      { method: "GET", path: "/v2/half", auth: "engine", handle: ({ response }) => {
        response.writeHead(200, { "content-type": "text/plain" });
        response.write("partial");
        throw new Error("failed mid-answer");
      } },
      { method: "GET", path: "/v2/unserialisable", auth: "engine", handle: () => ok({ big: 1n }) },
    ],
    { authorize: () => {}, errorFor: (error) => errorFor(error) },
  );
  server = http.createServer((request, response) => void handled.push(Promise.resolve(handler(request, response) as unknown)));
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;

  await expect(fetch(`${base}/v2/half`).then((answer) => answer.text())).rejects.toThrow();
  const unserialisable = await fetch(`${base}/v2/unserialisable`);
  expect(unserialisable.status).toBe(500);
  expect((await Promise.allSettled(handled)).map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled"]);
});
