import { workspacePath } from "@telar/engine-client";
import { stringValue } from "../../platform/http/params";
import { HttpError } from "../../platform/http/http";
import { ok, sessionRoute, type Route } from "../../platform/http/route";
import type { EngineStore } from "../../state";
import { readProviderSkillsCached, type LoadProviderCommands } from "./skills";
import { regenerateSessionTitle } from "./textgen";

export type ProviderSkillsOptions = { env?: NodeJS.ProcessEnv; loadProviderCommands?: LoadProviderCommands };

/** `/skills` is read where the session runs and cached per session: the composer asks on a keystroke. */
export function sessionProviderRoutes(store: EngineStore, skills: ProviderSkillsOptions = {}): Route[] {
  return [
    {
      method: "GET",
      path: sessionRoute("/skills"),
      auth: "engine",
      async handle({ params: [sessionId] }) {
        const record = store.records.get(sessionId!);
        const checkout = workspacePath(record.workspace);
        if (checkout === undefined) return ok({ skills: [], commands: [] });
        return ok(
          await readProviderSkillsCached({
            cacheKey: record.id,
            driver: record.driver,
            checkout,
            ...(skills.env ? { env: skills.env } : {}),
            ...(skills.loadProviderCommands ? { loadProviderCommands: skills.loadProviderCommands } : {}),
          }),
        );
      },
    },
    {
      method: "POST",
      path: sessionRoute("/regenerate-title"),
      auth: "engine",
      async handle({ params: [sessionId] }) {
        const regenerated = await regenerateSessionTitle(store, sessionId!);
        if (regenerated === undefined) throw new HttpError(502, "textgen_failed", "the provider did not answer with a title");
        return ok({ session: store.records.get(sessionId!), changed: regenerated.changed });
      },
    },
    {
      method: "POST",
      path: sessionRoute("/adopt"),
      auth: "engine",
      async handle({ params: [sessionId], body }) {
        const cut = body.cut === "since_compact_boundary" || body.cut === "whole" ? body.cut : undefined;
        const sourceSessionId = stringValue(body.sourceSessionId, "source session id")!;
        const sourceCwd = stringValue(body.sourceCwd, "source cwd", true);
        return {
          status: 201,
          body: await store.adoption.adopt(sessionId!, {
            sourceSessionId,
            ...(cut ? { cut } : {}),
            ...(sourceCwd ? { sourceCwd } : {}),
          }),
        };
      },
    },
  ];
}
