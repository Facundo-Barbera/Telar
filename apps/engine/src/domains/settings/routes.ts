import { EngineStateError } from "../../platform/kernel/errors";
import { ok, type Route } from "../../platform/http/route";
import { TELAR_ORIENTATION } from "../sessions";
import type { EngineStore } from "../../state";

type AgentOrientation = ReturnType<EngineStore["settings"]["orientation"]>;

const present = (input: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> =>
  Object.fromEntries(keys.filter((key) => key in input).map((key) => [key, input[key]]));

/** Machine-wide documents every client reads alike. A PATCH changes only the keys it names; `null` is a value. */
export function settingsRoutes(store: EngineStore, syncOrientationSkill: (policy: AgentOrientation) => Promise<unknown>): Route[] {
  return [
    { method: "GET", path: "/v2/inbox", auth: "engine", handle: () => ok({ inbox: store.settings.inbox() }) },
    {
      method: "PATCH",
      path: "/v2/inbox",
      auth: "engine",
      handle: ({ body }) =>
        ok({ inbox: store.setInboxPolicy(present(body, ["autoSettleAfterHours", "settleDelegatedAfterHours", "settledTerminalLimit"])) }),
    },
    { method: "GET", path: "/v2/orientation", auth: "engine", handle: () => ok({ orientation: store.settings.orientation(), text: TELAR_ORIENTATION }) },
    {
      method: "PATCH",
      path: "/v2/orientation",
      auth: "engine",
      // The skill is re-synced before answering: "off" must mean the file is gone.
      async handle({ body }) {
        const orientation = store.settings.setOrientation(present(body, ["preamble", "skill"]));
        await syncOrientationSkill(orientation);
        return ok({ orientation, text: TELAR_ORIENTATION });
      },
    },
    { method: "GET", path: "/v2/session-defaults", auth: "engine", handle: () => ok({ sessionDefaults: store.settings.sessionDefaults() }) },
    {
      method: "PATCH",
      path: "/v2/session-defaults",
      auth: "engine",
      handle: ({ body }) =>
        ok({ sessionDefaults: store.settings.setSessionDefaults(present(body, ["envMode", "resumeAfterRestart", "runtimeMode", "resumeAfterRateLimit"])) }),
    },
    { method: "GET", path: "/v2/workspace", auth: "engine", handle: () => ok({ machine: store.workspace.machine() }) },
    {
      method: "PUT",
      path: "/v2/workspace",
      auth: "engine",
      handle({ body }) {
        const saved = store.workspace.setMachine(body.machine);
        if (!saved.ok) throw new EngineStateError("invalid_request", saved.message);
        return ok({ machine: saved.value });
      },
    },
    {
      method: "GET",
      path: /^\/v2\/projects\/([^/]+)\/workspace$/,
      auth: "engine",
      handle: async ({ params }) => ok({ workspace: await store.workspace.view(store.projectRegistry.get(params[0]!)) }),
    },
    {
      method: "PUT",
      path: /^\/v2\/projects\/([^/]+)\/workspace$/,
      auth: "engine",
      async handle({ body, params }) {
        const project = store.projectRegistry.get(params[0]!);
        const saved = store.workspace.setOverrides(project.id, body.overrides);
        if (!saved.ok) throw new EngineStateError("invalid_request", saved.message);
        return ok({ workspace: await store.workspace.view(project) });
      },
    },
    { method: "GET", path: "/v2/sidebar-layout", auth: "engine", handle: () => ok({ layout: store.settings.sidebarLayout() }) },
    {
      method: "PATCH",
      path: "/v2/sidebar-layout",
      auth: "engine",
      handle: ({ body }) => ok({ layout: store.settings.setSidebarLayout(present(body, ["projectOrder", "sessionOrder", "pinnedOrder", "mode"])) }),
    },
  ];
}
