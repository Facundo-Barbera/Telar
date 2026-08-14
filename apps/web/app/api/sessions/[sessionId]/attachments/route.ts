import { EngineClientError } from "@telar/engine-client";
import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

/**
 * Upload one file for a session, BEFORE the message that refers to it.
 *
 * RAW BYTES, NOT `multipart/form-data`. A multipart parse would buy the ability
 * to send several files in one request and cost a parser, a boundary, and a
 * second place where a filename is interpreted. One file per request is a loop
 * in the client — and it also means one failed upload loses one file rather
 * than the whole selection.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Matches the engine's own ceiling. Checked here too so a browser gets a clear
 *  answer without streaming twenty megabytes to a process that will refuse it. */
const MAX_BYTES = 20 * 1024 * 1024;

type Context = { params: Promise<{ sessionId: string }> };

export async function POST(request: Request, context: Context) {
  try {
    const { sessionId } = await context.params;
    const data = new Uint8Array(await request.arrayBuffer());
    if (data.byteLength === 0) throw new EngineClientError("invalid_request", "The attachment is empty.");
    if (data.byteLength > MAX_BYTES) throw new EngineClientError("invalid_request", "That file is larger than the engine accepts.");
    const header = request.headers.get("x-telar-attachment-name");
    let name = "attachment";
    try {
      if (header) name = decodeURIComponent(header);
    } catch {
      name = header ?? "attachment";
    }
    const result = await (await engineClient()).uploadAttachment(sessionId, {
      name,
      mediaType: (request.headers.get("content-type") ?? "application/octet-stream").split(";")[0]!.trim(),
      data,
    });
    return Response.json(result, { status: 201 });
  } catch (error) {
    return engineErrorResponse(error);
  }
}
