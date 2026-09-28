import { expect, test } from "bun:test";
import type http from "node:http";
import { HttpError } from "../../platform/http/http";
import { matchRoute } from "../../platform/http/router";
import type { RunMount } from "./mount";
import { RunError } from "./types";
import type { EngineStore } from "../../state";
import { runRoutes } from "./run-routes";

const store = {
  getSession: (id: string) => ({ id, projectId: "p1", workspace: { mode: "local", path: "/tmp/checkout" } }),
} as unknown as EngineStore;

const call = async (mount: Partial<RunMount>, method: "GET" | "POST", url: string, body: Record<string, unknown> = {}) => {
  const pathname = new URL(url, "http://127.0.0.1").pathname;
  const { route, params } = matchRoute(runRoutes(store, mount as RunMount, new Set()), method, pathname)!;
  const request = { url } as http.IncomingMessage;
  return route.handle({ body, params, query: new URL(url, "http://127.0.0.1").searchParams, request, response: {} as http.ServerResponse });
};

test("hands the run table the undecoded tail, the query for a GET and the body otherwise", async () => {
  const seen: unknown[] = [];
  const mount: Partial<RunMount> = {
    handle: (method, tail, input, context) => {
      seen.push([method, tail, input, context()]);
      return Promise.resolve(undefined);
    },
  };
  expect(await call(mount, "GET", "/v2/sessions/s1/run/configs/a%20b?x=1")).toEqual({ status: 200, body: {} });
  await call(mount, "POST", "/v2/sessions/s1/run/start", { command: "ls" });
  expect(seen).toEqual([
    ["GET", "/run/configs/a%20b", { x: "1" }, { sessionId: "s1", projectId: "p1", worktreePath: "/tmp/checkout" }],
    ["POST", "/run/start", { command: "ls" }, { sessionId: "s1", projectId: "p1", worktreePath: "/tmp/checkout" }],
  ]);
});

test("a tail the run table does not serve is the engine's 404, and a run refusal keeps its status", async () => {
  await expect(call({ handle: () => undefined }, "GET", "/v2/sessions/s1/run/nope")).rejects.toMatchObject({ status: 404, message: "engine endpoint does not exist" });
  const refused = call({ handle: () => Promise.reject(new RunError("conflict", "that port is taken")) }, "POST", "/v2/sessions/s1/run/start");
  await expect(refused).rejects.toBeInstanceOf(HttpError);
  await expect(refused).rejects.toMatchObject({ status: 409, code: "conflict", message: "that port is taken" });
});
