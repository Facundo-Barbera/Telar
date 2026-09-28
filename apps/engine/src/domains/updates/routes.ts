import fs from "node:fs";
import pkg from "../../../package.json" with { type: "json" };
import { ok, type Route, type RouteAnswer } from "../../platform/http/route";
import { buildIdentity } from "./identity";

export function aboutRoutes(stateRoot: string, identity = () => buildIdentity()): Route[] {
  return [
    {
      method: "GET",
      path: "/v2/about",
      auth: "engine",
      handle() {
        const { appName, channel, icon } = identity();
        return ok({ appVersion: pkg.version, appName, channel, ...(icon ? { iconUrl: `/api/about/icon?v=${icon.key}` } : {}), stateRoot });
      },
    },
    {
      method: "GET",
      path: "/v2/about/icon",
      auth: "engine",
      handle(): RouteAnswer {
        const { icon } = identity();
        try {
          if (!icon) throw new Error("no icon on this layout");
          return { status: 200, body: null, bytes: new Uint8Array(fs.readFileSync(icon.path)), headers: { "content-type": "image/png", "cache-control": "public, max-age=31536000, immutable" } };
        } catch {
          return { status: 404, body: null, bytes: new Uint8Array(), headers: { "cache-control": "no-store" } };
        }
      },
    },
  ];
}
