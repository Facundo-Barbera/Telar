// The composer-attachment wire contract, in the one module BOTH sides can
// import. lib/attachments.ts reaches node:fs, so the composer cannot import the
// caps from there without dragging the filesystem into the client bundle; the
// upload route cannot own them either, for the same reason in reverse.

/**
 * Per-kind upload caps. Images get the larger budget because a screenshot is
 * the most common attachment by far and routinely clears 2 MB; everything else
 * is held tighter because a large non-image file is usually a mistake (a build
 * artifact dragged in by accident) rather than context.
 *
 * NOTE ON WHAT THESE COST: attachments reach both harnesses as a PATH, not as
 * inlined bytes, so a cap here bounds DISK and upload time — not the turn's
 * context window. The agent decides what to read.
 */
export const ATTACHMENT_MAX_BYTES = { image: 10 * 1024 * 1024, other: 2 * 1024 * 1024 };
export const ATTACHMENT_MAX_FILES = 10;

export const attachmentCapFor = (mediaType: string): number =>
  mediaType.startsWith("image/") ? ATTACHMENT_MAX_BYTES.image : ATTACHMENT_MAX_BYTES.other;

/**
 * What the composer sends with a turn and what the transcript persists. The
 * PATH is what makes it work on both providers — Codex takes it as a
 * `localImage`/`mention` input item, Claude's agent reads it with Read — and it
 * is absent once the bytes are gone (archived chat), which is precisely the
 * tombstone signal the chip renders from.
 */
export type TurnAttachment = {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  path?: string;
};

export type AttachmentUploadResponse = {
  attachments: { id: string; name: string; mediaType: string; size: number }[];
};

/** Where the UI fetches an attachment's bytes for a thumbnail or preview. */
export const attachmentUrl = (id: string): string =>
  `/api/chat/attachments/${encodeURIComponent(id)}`;
