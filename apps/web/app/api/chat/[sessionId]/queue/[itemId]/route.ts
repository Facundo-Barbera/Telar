import {
  cancelQueuedSessionTurn,
  editQueuedSessionTurn,
  readSessionQueue,
  SessionQueueConflictError,
  type JsonValue,
} from "@telar/core";

const reply = (error: unknown) =>
  Response.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status: error instanceof SessionQueueConflictError ? 409 : 400 },
  );

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ sessionId: string; itemId: string }> },
) {
  const { sessionId, itemId } = await params;
  const body = await req.json().catch(() => null);
  if (!body || !Number.isInteger(body.revision) || typeof body.message !== "string") {
    return Response.json({ error: "revision and message are required" }, { status: 400 });
  }
  try {
    const current = readSessionQueue(sessionId).items.find(
      (item) => item.idempotencyKey === itemId || item.canonicalKey === itemId,
    );
    if (!current || !current.payload || typeof current.payload !== "object" || Array.isArray(current.payload)) {
      throw new SessionQueueConflictError(`unknown queue item ${JSON.stringify(itemId)}`);
    }
    const payload = { ...current.payload, message: body.message } as JsonValue;
    return Response.json(
      editQueuedSessionTurn(sessionId, itemId, payload, body.revision),
    );
  } catch (error) {
    return reply(error);
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ sessionId: string; itemId: string }> },
) {
  const { sessionId, itemId } = await params;
  const body = await req.json().catch(() => null);
  if (!body || !Number.isInteger(body.revision)) {
    return Response.json({ error: "revision is required" }, { status: 400 });
  }
  try {
    return Response.json(cancelQueuedSessionTurn(sessionId, itemId, body.revision));
  } catch (error) {
    return reply(error);
  }
}
