// Upload endpoint for composer attachments. One multipart POST per send, made
// by the composer BEFORE it posts the turn itself, so that /api/chat receives
// ids and paths rather than megabytes of base64 inside its JSON body.
//
// See lib/attachments.ts for where the bytes go and how long they live.

import {
  ATTACHMENT_MAX_FILES,
  attachmentCapFor as capFor,
} from "@/lib/attachment-contract";
import { putAttachment, sweepOrphanAttachments, type AttachmentMeta } from "@/lib/attachments";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: "expected multipart/form-data" }, { status: 400 });
  }

  const files = form.getAll("file").filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return Response.json({ error: "no files" }, { status: 400 });
  }
  if (files.length > ATTACHMENT_MAX_FILES) {
    return Response.json(
      { error: `at most ${ATTACHMENT_MAX_FILES} attachments per message` },
      { status: 413 },
    );
  }

  // The client applies the same caps before it ever gets here. This is the
  // enforcing copy: the browser's is an affordance, and a cap that only exists
  // in the composer is not a cap.
  const attachments: AttachmentMeta[] = [];
  for (const file of files) {
    const mediaType = file.type || "application/octet-stream";
    if (file.size > capFor(mediaType)) {
      return Response.json(
        {
          error: `"${file.name}" is ${(file.size / 1024 / 1024).toFixed(1)} MB — over the ${
            capFor(mediaType) / 1024 / 1024
          } MB limit`,
        },
        { status: 413 },
      );
    }
    attachments.push(
      putAttachment({
        bytes: Buffer.from(await file.arrayBuffer()),
        mediaType,
        name: file.name || "attachment",
      }),
    );
  }

  // Opportunistic, and AFTER the write so a slow sweep never delays the upload
  // the user is waiting on. Collects staged-then-abandoned uploads; see
  // lib/attachments.ts.
  sweepOrphanAttachments();

  return Response.json({ attachments });
}
