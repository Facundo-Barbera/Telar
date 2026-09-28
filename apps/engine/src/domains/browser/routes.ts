import { HttpError } from "../../platform/http/http";
import { stringValue } from "../../platform/http/params";
import { ok, sessionRoute, type Route } from "../../platform/http/route";
import type { EngineStore } from "../../state";
import { createLoginGrantStore } from "./login-grants";

/** Read and revoke only: a login grant is created solely from an approval card. */
export function browserRoutes(root: string): Route[] {
  return [
    { method: "GET", path: "/v2/browser/logins", auth: "engine", handle: () => ok({ logins: createLoginGrantStore(root).list() }) },
    {
      method: "DELETE",
      path: /^\/v2\/browser\/logins\/(.*)$/,
      auth: "engine",
      handle({ params }) {
        if (!createLoginGrantStore(root).revoke(params[0]!)) throw new HttpError(404, "not_found", "no such remembered login");
        return ok({ ok: true });
      },
    },
  ];
}

/** One session's shared browser: its state, a person opening a page, and the shell reporting whose hands are on it. */
export function browserSessionRoutes(store: EngineStore): Route[] {
  return [
    {
      method: "GET",
      path: sessionRoute("/browser"),
      auth: "engine",
      async handle({ params: [sessionId], query }) {
        return ok({ browser: await store.browser.state(sessionId!, { screenshot: query.get("screenshot") === "1", start: query.get("start") === "1" }) });
      },
    },
    {
      method: "POST",
      path: sessionRoute("/browser/open"),
      auth: "engine",
      handle: async ({ params: [sessionId], body }) => ok({ browser: await store.browser.open(sessionId!, stringValue(body.url, "url")!) }),
    },
    {
      method: "POST",
      path: sessionRoute("/browser/control"),
      auth: "engine",
      handle({ params: [sessionId], body }) {
        const controller = stringValue(body.controller, "controller")!;
        if (controller !== "agent" && controller !== "human" && controller !== "idle") {
          throw new HttpError(400, "invalid_request", "controller must be agent, human or idle");
        }
        store.browser.recordControl(sessionId!, controller, stringValue(body.tabId, "tab id", true), body.interrupted === true);
        return ok({});
      },
    },
  ];
}
