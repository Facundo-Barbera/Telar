import type { UsageLimits } from "@telar/engine-client";
import { HttpError } from "../../platform/http/http";
import { ok, type Route } from "../../platform/http/route";
import type { EngineStore } from "../../state";
import { readUsageReport } from "./scan";
import { readUsageLimitSource } from "./limits";
import { usageDigestFor } from "./digest-source";

const LIMITS_TTL_MS = 5 * 60_000;

export function usageRoutes(store: EngineStore): Route[] {
  // In memory only, stale-while-revalidate, one read in flight: a quota figure is true for minutes.
  const limits: { snapshot?: UsageLimits; inFlight?: Promise<UsageLimits> } = {};
  const refreshLimits = (): Promise<UsageLimits> =>
    (limits.inFlight ??= Promise.all(store.usageSources.resolve().map((source) => readUsageLimitSource(source)))
      .then((sources) => (limits.snapshot = { sources, readAt: Date.now() }))
      .finally(() => (limits.inFlight = undefined)));
  const sourcePath = /^\/v2\/usage\/sources\/([A-Za-z][A-Za-z0-9_-]*)$/;
  return [
    {
      method: "GET",
      path: "/v2/usage",
      auth: "engine",
      async handle({ query }) {
        const sinceMs = Number(query.get("since"));
        const untilMs = Number(query.get("until"));
        if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs) || sinceMs >= untilMs) {
          throw new HttpError(400, "invalid_request", "usage needs a since/until window in epoch milliseconds");
        }
        const window = { sinceMs, untilMs, resolution: query.get("resolution") === "hour" ? ("hour" as const) : ("day" as const), timeZone: query.get("tz")?.trim() || "UTC" };
        return ok({ usage: await readUsageReport(window, { ratesCachePath: store.paths.usageModelRates, scanCachePath: store.paths.usageScanCache }) });
      },
    },
    { method: "GET", path: "/v2/usage/digest", auth: "engine", handle: async () => ok({ digest: (await usageDigestFor(store)).digest }) },
    // Management keys are write-only: this list is the redacting read.
    { method: "GET", path: "/v2/usage/sources", auth: "engine", handle: () => ok({ sources: store.usageSources.list() }) },
    {
      method: "DELETE",
      path: sourcePath,
      auth: "engine",
      handle({ params }) {
        limits.snapshot = undefined;
        return ok({ removed: store.usageSources.remove(params[0]!) });
      },
    },
    {
      method: "PUT",
      path: sourcePath,
      auth: "engine",
      // `null` clears the label; an empty key keeps the stored one.
      handle({ params, body }) {
        limits.snapshot = undefined;
        return ok({
          source: store.usageSources.save({
            id: params[0]!,
            ...(body.kind === undefined ? {} : { kind: body.kind }),
            ...(body.label === undefined ? {} : { label: body.label as string | null }),
            ...(body.url === undefined ? {} : { url: body.url }),
            ...(body.managementKey === undefined ? {} : { managementKey: body.managementKey }),
            ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
          }),
        });
      },
    },
    {
      method: "GET",
      path: "/v2/usage/limits",
      auth: "engine",
      async handle({ query }) {
        const cached = limits.snapshot;
        if (query.get("refresh") === "1" || !cached) return ok({ limits: await refreshLimits() });
        if (Date.now() - cached.readAt >= LIMITS_TTL_MS) void refreshLimits().catch(() => undefined);
        return ok({ limits: cached });
      },
    },
  ];
}
