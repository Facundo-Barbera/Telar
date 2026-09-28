import { body } from "../../platform/http/http";
import { ok, type Route } from "../../platform/http/route";

/**
 * An outward MCP socket over streamable HTTP, stateless and tools-only: POST carries one JSON-RPC
 * message, DELETE has no session to end, anything else is 405. It answers only to its own secret (`auth`).
 */
export function mcpSocketRoute(
  path: string,
  auth: "sessions-socket" | "notes-socket",
  name: string,
  handleMessage: (message: Record<string, unknown>) => Promise<unknown>,
): Route {
  return {
    method: "*",
    path,
    auth,
    body: "raw",
    async handle({ request, response }) {
      if (request.method === "DELETE") return ok({});
      if (request.method !== "POST") return { status: 405, body: { error: { code: "invalid_request", message: `the ${name} socket is POST-only — it keeps no stream open` } } };
      const answer = await handleMessage(await body(request));
      if (answer !== undefined) return ok(answer);
      response.writeHead(202).end();
      return undefined;
    },
  };
}
