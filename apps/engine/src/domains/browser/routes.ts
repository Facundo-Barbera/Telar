import { HttpError } from "../../platform/http/http";
import { ok, type Route } from "../../platform/http/route";
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
