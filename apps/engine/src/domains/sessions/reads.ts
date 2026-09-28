import { HttpError, matchesETag } from "../../platform/http/http";
import { positiveParam } from "../../platform/http/params";
import { notModified, ok, sessionRoute, type Route } from "../../platform/http/route";
import type { EngineStore } from "../../state";
import { sessionBootstrap, sessionSnapshot, type SessionBootstrapWindow } from "./bootstrap";


// Ceilings, not suggestions: these answers land in a model's context, so a caller pages for the rest.
const EVENT_PAGE_DEFAULT = 200;
const EVENT_PAGE_MAX = 1000;
const OUTLINE_PAGE = [20, 100] as const;
const GREP_PAGE = [20, 100] as const;
const ITEM_CHARS = [8_000, 64_000] as const;
const ANSWER_SLICE = [8_000, 64_000] as const;
const ANY = Number.MAX_SAFE_INTEGER;

// Cursor and window together: two asks at one cursor with a different `after` or `limit` are different answers.
const sessionEventsETag = (cursor: number, after: number, limit: number): string => `W/"events-${cursor}-${after}-${limit}"`;

function eventPageLimit(raw: string | null): number {
  if (raw === null) return EVENT_PAGE_DEFAULT;
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 1) throw new HttpError(400, "invalid_request", "limit must be a positive integer");
  return Math.min(limit, EVENT_PAGE_MAX);
}

/** `?turns=N[&before=runId]`: the newest N settled turns plus everything unsettled; absent is the whole session. */
function snapshotWindow(query: URLSearchParams): SessionBootstrapWindow | undefined {
  const raw = query.get("turns");
  const before = query.get("before") ?? undefined;
  if (raw === null) {
    if (before !== undefined) throw new HttpError(400, "invalid_request", "before needs turns");
    return undefined;
  }
  const turns = Number(raw);
  if (!Number.isSafeInteger(turns) || turns < 1) throw new HttpError(400, "invalid_request", "turns must be a positive integer");
  return { turns, ...(before === undefined ? {} : { before }) };
}

const before = (query: URLSearchParams) => (query.get("before") === null ? {} : { before: positiveParam(query.get("before"), 0, ANY, "before") });

export function sessionReadRoutes(store: EngineStore): Route[] {
  return [
    { method: "GET", path: sessionRoute(""), auth: "engine", handle: ({ params, query }) => ok(sessionSnapshot(store, params[0]!, snapshotWindow(query))) },
    // The snapshot and the journal from its cursor in one answer, through the same fold as the snapshot.
    { method: "GET", path: sessionRoute("/bootstrap"), auth: "engine", handle: ({ params, query }) => ok(sessionBootstrap(store, params[0]!, snapshotWindow(query))) },
    {
      method: "GET",
      path: sessionRoute("/events"),
      auth: "engine",
      // Keyset paging from `after`; one row over the limit is read so `more` is exact.
      handle({ params: [sessionId], query, request }) {
        const raw = Number(query.get("after") ?? "0");
        const after = Number.isSafeInteger(raw) ? raw : 0;
        const limit = eventPageLimit(query.get("limit"));
        const etag = sessionEventsETag(store.eventCursor(sessionId!), after, limit);
        if (matchesETag(request.headers["if-none-match"], etag)) return notModified(etag);
        const read = store.readEvents(sessionId!, raw, limit + 1);
        const events = read.length > limit ? read.slice(0, limit) : read;
        const cursor = events.at(-1)?.id ?? after;
        const more = read.length > limit;
        return { status: 200, body: { events, cursor, more, ...(more ? { next: cursor } : {}) }, headers: { etag } };
      },
    },
    {
      method: "GET",
      path: sessionRoute("/outline"),
      auth: "engine",
      handle: ({ params, query }) =>
        ok(store.turnOutline(params[0]!, { limit: positiveParam(query.get("limit"), OUTLINE_PAGE[0], OUTLINE_PAGE[1], "limit"), ...before(query) })),
    },
    { method: "GET", path: sessionRoute("/runs/([A-Za-z0-9_-]+)/items"), auth: "engine", handle: ({ params }) => ok({ items: store.runItems(params[0]!, params[1]!) }) },
    {
      method: "GET",
      path: sessionRoute("/runs/([A-Za-z0-9_-]+)/items/([A-Za-z0-9_-]+)"),
      auth: "engine",
      // A number is a position in the list; anything else is an item id.
      handle({ params: [sessionId, runId, raw], query }) {
        const index = Number(raw);
        const step = Number.isSafeInteger(index) && index >= 0 ? index : raw!;
        return ok(store.runItem(sessionId!, runId!, step, positiveParam(query.get("maxChars"), ITEM_CHARS[0], ITEM_CHARS[1], "maxChars")));
      },
    },
    {
      method: "GET",
      path: sessionRoute("/answer"),
      auth: "engine",
      handle: ({ params, query }) =>
        ok(
          store.turnAnswer(params[0]!, {
            ...(query.get("runId") ? { runId: query.get("runId")! } : {}),
            from: positiveParam(query.get("from"), 0, ANY, "from"),
            limit: positiveParam(query.get("limit"), ANSWER_SLICE[0], ANSWER_SLICE[1], "limit"),
          }),
        ),
    },
    {
      method: "GET",
      path: sessionRoute("/grep"),
      auth: "engine",
      handle({ params, query }) {
        const pattern = query.get("pattern");
        if (!pattern) throw new HttpError(400, "invalid_request", "pattern is required");
        return ok(store.grepSession(params[0]!, pattern, { limit: positiveParam(query.get("limit"), GREP_PAGE[0], GREP_PAGE[1], "limit"), ...before(query) }));
      },
    },
  ];
}
