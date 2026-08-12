import {
  cancelQueuedSessionTurn,
  dismissFailedSessionTurn,
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
    // ONE BUTTON, TWO TRANSITIONS. The row's X means "get this out of my
    // queue", but retracting a message that has not started and acknowledging
    // one that failed are different acts on different states, and core keeps
    // them apart on purpose (see dismissFailedSessionTurn). Reading the state
    // here rather than widening either transition keeps that separation while
    // making the button do what it says for a `failed`/`ambiguous` item, which
    // previously 409'd and left an undismissable row on screen.
    // Not a TOCTOU risk: both transitions re-check the revision under the
    // envelope lock, so a state that moved between this read and the write is
    // a 409 rather than a wrong transition.
    const current = readSessionQueue(sessionId).items.find(
      (item) => item.idempotencyKey === itemId || item.canonicalKey === itemId,
    );
    if (current?.state === "failed" || current?.state === "ambiguous") {
      return Response.json(dismissFailedSessionTurn(sessionId, itemId, body.revision));
    }
    return Response.json(cancelQueuedSessionTurn(sessionId, itemId, body.revision));
  } catch (error) {
    return reply(error);
  }
}
