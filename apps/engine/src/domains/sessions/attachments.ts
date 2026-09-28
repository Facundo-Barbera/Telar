import { readTaskOutput, resolveTaskOutputFile } from "../../drivers/claude";
import { HttpError, rawBody } from "../../platform/http/http";
import { ok, sessionRoute, type Route } from "../../platform/http/route";
import type { EngineStore } from "../../state";

/** The HTTP edge's ceiling; the store enforces the same number again for in-process callers. */
const MAX_ATTACHMENT_UPLOAD_BYTES = 20 * 1024 * 1024;

const attachmentName = (header: string | string[] | undefined): string => {
  const encoded = Array.isArray(header) ? header[0] : header;
  // Encoded by the client because a filename may hold bytes a header may not; one that won't decode is kept as sent.
  try {
    return encoded ? decodeURIComponent(encoded) : "attachment";
  } catch {
    return encoded ?? "attachment";
  }
};

/** A background task's log by byte cursor, and the session's attachments: index, bytes, tags and upload. */
export function sessionAttachmentRoutes(store: EngineStore): Route[] {
  return [
    {
      method: "GET",
      path: sessionRoute("/tasks/([A-Za-z0-9_-]+)/output"),
      auth: "engine",
      async handle({ params: [sessionId, taskId], query }) {
        const task = store.tasks(sessionId!).find((one) => one.id === taskId);
        if (!task) throw new HttpError(404, "not_found", "task not found");
        const file = task.kind === "background" && task.outputFile ? resolveTaskOutputFile(task.outputFile, task.providerTaskId) : undefined;
        if (!file) throw new HttpError(404, "not_found", "this task has no log");
        const raw = query.get("after");
        const after = raw === null ? undefined : Number(raw);
        if (after !== undefined && (!Number.isSafeInteger(after) || after < 0)) throw new HttpError(400, "invalid_request", "after must be a byte offset");
        return ok(await readTaskOutput(file, after));
      },
    },
    {
      method: "GET",
      path: sessionRoute("/attachments"),
      auth: "engine",
      handle({ params: [sessionId], query }) {
        const tag = query.get("tag") ?? undefined;
        return ok({ attachments: store.listAttachments(sessionId!, tag ? { tag } : {}) });
      },
    },
    {
      method: "GET",
      path: sessionRoute("/attachments/([A-Za-z0-9_-]+)"),
      auth: "engine",
      handle({ params: [sessionId, attachmentId] }) {
        const { attachment, data } = store.attachmentBytes(sessionId!, attachmentId!);
        return {
          status: 200,
          body: null,
          bytes: data,
          // The id is minted per write, so the bytes behind it never change.
          headers: { "content-type": attachment.mediaType, "content-length": String(data.byteLength), "cache-control": "private, max-age=31536000, immutable" },
        };
      },
    },
    {
      method: "PATCH",
      path: sessionRoute("/attachments/([A-Za-z0-9_-]+)"),
      auth: "engine",
      handle({ params: [sessionId, attachmentId], body }) {
        const tags = Array.isArray(body.tags) ? body.tags.filter((tag): tag is string => typeof tag === "string") : [];
        return ok({ attachment: store.tagAttachment(sessionId!, attachmentId!, tags) });
      },
    },
    {
      method: "POST",
      path: sessionRoute("/attachments"),
      auth: "engine",
      body: "raw",
      async handle({ params: [sessionId], request }) {
        const data = await rawBody(request, MAX_ATTACHMENT_UPLOAD_BYTES);
        const mediaType = (request.headers["content-type"] ?? "application/octet-stream").split(";")[0]!.trim();
        return { status: 201, body: { attachment: store.putAttachment(sessionId!, { name: attachmentName(request.headers["x-telar-attachment-name"]), mediaType, data }) } };
      },
    },
  ];
}
