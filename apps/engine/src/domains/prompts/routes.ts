import { HttpError } from "../../platform/http/http";
import { ok, type Route } from "../../platform/http/route";
import type { EngineStore } from "../../state";
import { createPrompt, deletePrompt, getPrompt, readPrompts, updatePrompt } from "./store";

const missing = () => new HttpError(404, "not_found", "no prepared prompt goes by that id on this project's shelf");
const PROMPTS = /^\/v2\/projects\/([^/]+)\/prompts$/;
const PROMPT = /^\/v2\/projects\/([^/]+)\/prompts\/([^/]+)$/;

/** The prompt shelf answers whole; a composer filters it to its own session. */
export function promptsRoutes(store: EngineStore): Route[] {
  // Every route checks the registration first, before an id can become a filename.
  const project = (id: string): string => {
    store.projectRegistry.get(id);
    return id;
  };
  return [
    { method: "GET", path: PROMPTS, auth: "engine", handle: ({ params }) => ok({ prompts: readPrompts(store.paths, project(params[0]!)) }) },
    {
      method: "POST",
      path: PROMPTS,
      auth: "engine",
      handle: ({ body, params }) => ({
        status: 201,
        body: {
          prompt: createPrompt(store.paths, project(params[0]!), {
            title: body.title as string,
            text: (body.text ?? "") as string,
            ...(body.sessionId ? { sessionId: String(body.sessionId) } : {}),
            ...(body.reason !== undefined ? { reason: String(body.reason) } : {}),
            author: body.author === "session" ? "session" : "you",
          }),
        },
      }),
    },
    {
      method: "GET",
      path: PROMPT,
      auth: "engine",
      handle({ params }) {
        const prompt = getPrompt(store.paths, project(params[0]!), params[1]!);
        if (!prompt) throw missing();
        return ok({ prompt });
      },
    },
    {
      method: "PATCH",
      path: PROMPT,
      auth: "engine",
      handle({ body, params }) {
        const prompt = updatePrompt(store.paths, project(params[0]!), params[1]!, body);
        if (!prompt) throw missing();
        return ok({ prompt });
      },
    },
    {
      method: "DELETE",
      path: PROMPT,
      auth: "engine",
      body: "raw",
      // Sending a prompt removes it, maybe from another window, so a missing one answers `deleted: false`.
      handle: ({ params }) => ok({ deleted: deletePrompt(store.paths, project(params[0]!), params[1]!) }),
    },
  ];
}
