import {
  enqueueSessionTurn,
  pauseSessionQueue,
  readSessionQueue,
  resumeSessionQueue,
  SessionQueueConflictError,
  type JsonValue,
} from "@telar/core";
import { getChat } from "@/lib/store";
import { kickSessionQueue } from "@/lib/server/session-engine";

export const dynamic = "force-dynamic";

const conflict = (error: unknown) =>
  Response.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status: error instanceof SessionQueueConflictError ? 409 : 400 },
  );

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;
  if (!getChat(sessionId)) return new Response("not found", { status: 404 });
  void kickSessionQueue(sessionId);
  return Response.json(readSessionQueue(sessionId));
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;
  if (!getChat(sessionId)) return new Response("not found", { status: 404 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body.idempotencyKey !== "string" || !body.idempotencyKey) {
    return Response.json({ error: "idempotencyKey is required" }, { status: 400 });
  }
  if (!body.payload || typeof body.payload !== "object" || Array.isArray(body.payload)) {
    return Response.json({ error: "payload must be a complete chat request object" }, { status: 400 });
  }
  const payload = { ...body.payload, sessionId } as JsonValue;
  try {
    const item = enqueueSessionTurn(sessionId, {
      idempotencyKey: body.idempotencyKey,
      payload,
    });
    void kickSessionQueue(sessionId);
    return Response.json({ item, queue: readSessionQueue(sessionId) }, { status: 202 });
  } catch (error) {
    return conflict(error);
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;
  const body = await req.json().catch(() => null);
  if (body?.paused === true) return Response.json(pauseSessionQueue(sessionId));
  if (body?.paused === false) {
    const queue = resumeSessionQueue(sessionId);
    void kickSessionQueue(sessionId);
    return Response.json(queue);
  }
  return Response.json({ error: "paused boolean is required" }, { status: 400 });
}
