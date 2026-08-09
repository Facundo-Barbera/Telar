// ONE uploader for a turn's staged attachments, shared rather than copied.
//
// It was session-view.tsx's private helper until the master surface needed the
// same three lines (story 5.7): the composer that "invites all three modes —
// ask, dump, or paste anything" is the same vendored PromptInput, so a pasted
// screenshot arrives on both surfaces identically and must reach the harness
// identically. A second copy is how the two would drift on the failure path,
// which is the half that matters — see the throw below.
//
// THE CAPS AND THE WIRE SHAPE LIVE IN lib/attachment-contract.ts, which both
// sides import; this module is only the POST.

import type { PromptInputMessage } from "@/components/ai-elements/prompt-input";
import type { AttachmentUploadResponse, TurnAttachment } from "@/lib/attachment-contract";

/**
 * Persist a turn's staged attachments and return the ids the wire carries.
 *
 * The urls arriving here are DATA urls, not blob urls: PromptInput converts
 * them before it calls onSubmit precisely so the payload survives the composer
 * clearing (which revokes every blob it created). That conversion is also why
 * this can run after the UI has already reset.
 *
 * Throws on failure, which puts the turn on the caller's existing error path —
 * an attachment that silently failed to upload would produce a turn whose text
 * refers to a screenshot the agent was never given.
 */
export async function uploadAttachments(
  files: PromptInputMessage["files"],
): Promise<Omit<TurnAttachment, "path">[]> {
  const form = new FormData();
  for (const file of files) {
    if (!file.url) continue;
    const blob = await fetch(file.url).then((r) => r.blob());
    form.append("file", blob, file.filename ?? "attachment");
  }
  const res = await fetch("/api/chat/attachments", { method: "POST", body: form });
  if (!res.ok) {
    const detail = await res
      .json()
      .then((b) => (b as { error?: string })?.error)
      .catch(() => null);
    throw new Error(detail ?? `attachment upload failed (HTTP ${res.status})`);
  }
  const body = (await res.json()) as AttachmentUploadResponse;
  return body.attachments;
}
