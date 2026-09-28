import { HttpError } from "../../platform/http/http";
import { ok, type Route } from "../../platform/http/route";
import type { EngineStore } from "../../state";
import { notesSocketConnectCard } from "./socket";
import { createNote, deleteNote, getNote, readNotes, updateNote } from "./store";

const missing = () => new HttpError(404, "not_found", "no note goes by that id in this project's notebook");

/** `port` is where the engine listens; the connect card's secret is minted on first read. */
export function notesRoutes(store: EngineStore, socket: { port(): number; secret(): string }): Route[] {
  // Every project route checks the registration first, before an id can become a filename.
  const project = (id: string): string => {
    store.projectRegistry.get(id);
    return id;
  };
  return [
    {
      method: "GET",
      path: "/v2/notes/mcp-info",
      auth: "engine",
      handle: () => ok({ mcp: notesSocketConnectCard(`http://127.0.0.1:${socket.port()}/v2/notes/mcp`, socket.secret()) }),
    },
    { method: "GET", path: /^\/v2\/projects\/([^/]+)\/notes$/, auth: "engine", handle: ({ params }) => ok({ notes: readNotes(store.paths, project(params[0]!)) }) },
    {
      method: "POST",
      path: /^\/v2\/projects\/([^/]+)\/notes$/,
      auth: "engine",
      handle: ({ body, params }) => ({
        status: 201,
        body: {
          note: createNote(store.paths, project(params[0]!), {
            title: body.title as string,
            body: (body.body ?? "") as string,
            ...(body.pinned !== undefined ? { pinned: Boolean(body.pinned) } : {}),
            author: body.author === "session" ? "session" : "you",
          }),
        },
      }),
    },
    {
      method: "GET",
      path: /^\/v2\/projects\/([^/]+)\/notes\/([^/]+)$/,
      auth: "engine",
      handle({ params }) {
        const note = getNote(store.paths, project(params[0]!), params[1]!);
        if (!note) throw missing();
        return ok({ note });
      },
    },
    {
      method: "PATCH",
      path: /^\/v2\/projects\/([^/]+)\/notes\/([^/]+)$/,
      auth: "engine",
      handle({ body, params }) {
        const note = updateNote(store.paths, project(params[0]!), params[1]!, body);
        if (!note) throw missing();
        return ok({ note });
      },
    },
    {
      method: "DELETE",
      path: /^\/v2\/projects\/([^/]+)\/notes\/([^/]+)$/,
      auth: "engine",
      body: "raw",
      // A retried delete has reached the state it asked for, so a missing note answers `deleted: false`.
      handle: ({ params }) => ok({ deleted: deleteNote(store.paths, project(params[0]!), params[1]!) }),
    },
    {
      method: "POST",
      path: /^\/v2\/projects\/([^/]+)\/notes\/([^/]+)\/pin$/,
      auth: "engine",
      handle({ body, params }) {
        const note = updateNote(store.paths, project(params[0]!), params[1]!, { pinned: body.pinned === undefined ? true : Boolean(body.pinned) });
        if (!note) throw missing();
        return ok({ note });
      },
    },
  ];
}
