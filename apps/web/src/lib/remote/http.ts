import { RemoteStoreError } from "./store";

/** One error mapping for every pairing-store route. */
export function remoteErrorResponse(error: unknown): Response {
  if (error instanceof RemoteStoreError) {
    return Response.json({ error: { code: "engine_unavailable", message: error.message } }, { status: 503 });
  }
  return Response.json({ error: { code: "internal_error", message: "The pairing store failed." } }, { status: 500 });
}
