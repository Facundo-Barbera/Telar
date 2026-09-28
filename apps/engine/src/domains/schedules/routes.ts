import { HttpError } from "../../platform/http/http";
import { ok, type Route } from "../../platform/http/route";
import type { EngineStore } from "../../state";

/** CRUD on the schedule table; the store validates the target session. There is deliberately no "run now". */
export function schedulesRoutes(store: EngineStore): Route[] {
  const one = /^\/v2\/schedules\/(.*)$/;
  return [
    { method: "GET", path: "/v2/schedules", auth: "engine", handle: ({ query }) => ok({ schedules: store.listSchedules(query.get("sessionId") ?? undefined) }) },
    {
      method: "POST",
      path: "/v2/schedules",
      auth: "engine",
      handle: ({ body }) =>
        ok({
          schedule: store.putSchedule({
            ...(typeof body.id === "string" ? { id: body.id } : {}),
            sessionId: String(body.sessionId ?? ""),
            prompt: String(body.prompt ?? ""),
            rule: body.rule as never,
            zone: String(body.zone ?? "UTC"),
            ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
          }),
        }),
    },
    {
      method: "GET",
      path: one,
      auth: "engine",
      handle({ params }) {
        const row = store.readSchedule(params[0]!);
        if (!row) throw new HttpError(404, "not_found", "schedule does not exist");
        return ok({ schedule: row });
      },
    },
    { method: "DELETE", path: one, auth: "engine", handle: ({ params }) => ok({ deleted: store.deleteSchedule(params[0]!) }) },
  ];
}
