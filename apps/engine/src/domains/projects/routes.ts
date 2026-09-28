import { pluginEnabled, readProjectPlugins } from "@telar/engine-client";
import { HttpError } from "../../platform/http/http";
import { stringValue } from "../../platform/http/params";
import { ok, type Route } from "../../platform/http/route";
import type { PluginHost } from "../plugins";
import type { EngineStore } from "../../state";

type ProjectPatch = Parameters<EngineStore["projectRegistry"]["update"]>[1];
type ProjectPlugins = Pick<PluginHost, "ready" | "cancelDrain" | "drainProject">;

const nullableObject = (value: unknown) => value === null || (typeof value === "object" && !Array.isArray(value));

/** Refuses the wrong shape with a sentence naming the field; the store re-validates the values. */
function readPatch(input: Record<string, unknown>, plugins: ProjectPlugins): ProjectPatch {
  const patch: ProjectPatch = {};
  if ("name" in input) {
    if (typeof input.name !== "string" || input.name.trim() === "") throw new HttpError(400, "invalid_request", "name must be a non-empty string");
    patch.name = input.name;
  }
  if ("iconName" in input) {
    if (input.iconName !== null && typeof input.iconName !== "string") throw new HttpError(400, "invalid_request", "iconName must be a string or null");
    patch.iconName = input.iconName as string | null;
  }
  if ("iconEmoji" in input) {
    if (input.iconEmoji !== null && typeof input.iconEmoji !== "string") throw new HttpError(400, "invalid_request", "iconEmoji must be a string or null");
    patch.iconEmoji = input.iconEmoji as string | null;
  }
  if ("defaultModel" in input) {
    if (!nullableObject(input.defaultModel)) throw new HttpError(400, "invalid_request", "defaultModel must be an object or null");
    patch.defaultModel = input.defaultModel as ProjectPatch["defaultModel"];
  }
  if ("envMode" in input) {
    if (input.envMode !== null && input.envMode !== "local" && input.envMode !== "worktree") {
      throw new HttpError(400, "invalid_request", "envMode must be local, worktree or null");
    }
    patch.envMode = input.envMode as ProjectPatch["envMode"];
  }
  if ("dataScience" in input) {
    if (!nullableObject(input.dataScience)) throw new HttpError(400, "invalid_request", "dataScience must be an object or null");
    patch.dataScience = input.dataScience as ProjectPatch["dataScience"];
  }
  if ("latex" in input) {
    if (!nullableObject(input.latex)) throw new HttpError(400, "invalid_request", "latex must be an object or null");
    patch.latex = input.latex as ProjectPatch["latex"];
  }
  if ("plugins" in input) {
    if (!input.plugins || typeof input.plugins !== "object" || Array.isArray(input.plugins)) {
      throw new HttpError(400, "invalid_request", "plugins must be an object");
    }
    const entries = input.plugins as Record<string, unknown>;
    for (const [id, value] of Object.entries(entries)) {
      if (value === null) continue;
      if (typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "invalid_request", `plugins.${id} must be an object or null`);
      const config = value as { enabled?: unknown; settings?: unknown };
      if (typeof config.enabled !== "boolean") throw new HttpError(400, "invalid_request", `plugins.${id}.enabled must be a boolean`);
      const schema = plugins.ready(id)?.settingsSchema;
      if (schema && config.settings !== undefined && !schema.safeParse(config.settings).success) {
        throw new HttpError(400, "invalid_request", `plugins.${id}.settings is not valid for ${id}`);
      }
    }
    patch.plugins = entries as ProjectPatch["plugins"];
  }
  return patch;
}

/** Registering, cloning, editing, removing and restoring projects. */
export function projectRoutes(store: EngineStore, plugins: ProjectPlugins): Route[] {
  return [
    {
      method: "GET",
      path: "/v2/projects",
      auth: "engine",
      handle: ({ query }) => ok({ projects: store.projectRegistry.list({ includeRemoved: query.get("includeRemoved") === "1" }) }),
    },
    // Re-probes every project's disk; the poll in `projectMetadata` is the floor, this only makes it sooner.
    { method: "POST", path: "/v2/projects/reprobe", auth: "engine", body: "raw", handle: () => ok(store.remounts.reprobe()) },
    {
      method: "POST",
      path: "/v2/projects/clone",
      auth: "engine",
      handle: async ({ body }) => ({
        status: 201,
        body: {
          project: await store.sessionGit.cloneProject({
            url: stringValue(body.url, "repository url")!,
            parent: stringValue(body.parent, "parent folder")!,
            ...(body.name === undefined ? {} : { name: stringValue(body.name, "project name")! }),
          }),
        },
      }),
    },
    {
      method: "POST",
      path: "/v2/projects",
      auth: "engine",
      handle: ({ body }) => ({
        status: 201,
        body: {
          project: store.projectRegistry.register({
            id: stringValue(body.id, "project id", true),
            name: stringValue(body.name, "project name")!,
            root: stringValue(body.root, "project root")!,
          }),
        },
      }),
    },
    {
      method: "PATCH",
      path: /^\/v2\/projects\/([^/]+)$/,
      auth: "engine",
      // A plugin the write turned off drains: new work is refused, running work finishes.
      handle({ body, params }) {
        const patch = readPatch(body, plugins);
        const project = store.projectRegistry.update(params[0]!, patch);
        if (patch.plugins) {
          const { plugins: after } = readProjectPlugins(project);
          for (const pluginId of Object.keys(patch.plugins)) {
            if (pluginEnabled(after, pluginId)) plugins.cancelDrain(pluginId, project.id);
            else void plugins.drainProject(pluginId, project.id);
          }
        }
        return ok({ project });
      },
    },
    // Unregisters only: the checkout, worktrees and journals stay, and restoring gives back the same id.
    { method: "DELETE", path: /^\/v2\/projects\/([^/]+)$/, auth: "engine", body: "raw", handle: ({ params }) => ok(store.projectRegistry.unregister(params[0]!)) },
    {
      method: "POST",
      path: /^\/v2\/projects\/([^/]+)\/restore$/,
      auth: "engine",
      body: "raw",
      handle: ({ params }) => ok({ project: store.projectRegistry.restore(params[0]!) }),
    },
    {
      method: "POST",
      path: /^\/v2\/projects\/([^/]+)\/gitignore$/,
      auth: "engine",
      body: "raw",
      handle: ({ params }) => ok({ gitignore: store.sessionGit.gitignore(params[0]!) }),
    },
    {
      method: "DELETE",
      path: /^\/v2\/projects\/([^/]+)\/gitignore$/,
      auth: "engine",
      body: "raw",
      handle: ({ params }) => ok({ gitignore: store.sessionGit.undoGitignore(params[0]!) }),
    },
  ];
}
