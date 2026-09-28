import { expect, test } from "bun:test";
import type http from "node:http";
import { Readable } from "node:stream";
import type { PluginEngineModule } from "./contract";
import { matchRoute } from "../../platform/http/router";
import { pluginSessionRoutes } from "./session-routes";

const echo = {
  routes: {
    run: (input: Record<string, unknown>, capability: unknown) => ({ input, capability }),
    fail: () => {
      throw new Error("kernel died");
    },
  },
  resolve: (sessionId: string) => `cap:${sessionId}`,
} as unknown as PluginEngineModule;

const post = (pathname: string, raw: string) => {
  const routes = pluginSessionRoutes((id) => (id === "data-science" || id === "echo" ? echo : undefined));
  const { route, params } = matchRoute(routes, "POST", pathname)!;
  const request = Readable.from([Buffer.from(raw)]) as unknown as http.IncomingMessage;
  return Promise.resolve(route.handle({ body: {}, params, query: new URLSearchParams(), request, response: {} as http.ServerResponse }));
};

test("each door calls the plugin's verb with the session's capability", async () => {
  expect(await post("/v2/sessions/s1/plugins/echo/run", '{"a":1}')).toEqual({ status: 200, body: { input: { a: 1 }, capability: "cap:s1" } });
  expect(await post("/v2/sessions/s1/ds/run", "{}")).toEqual({ status: 200, body: { input: {}, capability: "cap:s1" } });
});

test("an unknown plugin or verb is a 404 before the body is read", async () => {
  await expect(post("/v2/sessions/s1/plugins/nope/run", "not json")).rejects.toMatchObject({ status: 404, message: "no plugin nope" });
  await expect(post("/v2/sessions/s1/plugins/echo/nope", "not json")).rejects.toMatchObject({ status: 404, message: "plugin echo has no nope" });
  await expect(post("/v2/sessions/s1/latex/build", "not json")).rejects.toMatchObject({ status: 404, message: "latex is unavailable" });
  await expect(post("/v2/sessions/s1/ds/nope", "not json")).rejects.toMatchObject({ status: 404, message: "no data-science method nope" });
});

test("a plugin's own failure names the plugin on the generic door and not on the alias", async () => {
  await expect(post("/v2/sessions/s1/plugins/echo/fail", "{}")).rejects.toMatchObject({ status: 400, code: "plugin_error", message: "echo: kernel died" });
  await expect(post("/v2/sessions/s1/ds/fail", "{}")).rejects.toMatchObject({ status: 400, code: "invalid_request", message: "kernel died" });
});
