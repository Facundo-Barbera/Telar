// Composer attachments: the bytes a user drops, pastes, or picks with the "+"
// menu, and the one place their lifetime is decided.
//
// WHY THE BYTES LIVE ON DISK AND NOT IN THE TURN. Both harnesses want a PATH,
// not a payload. Codex's `turn/start` input array has first-class `localImage`
// (`{type,path}`) and `mention` (`{type,name,path}`) items; Claude's agent has
// Read, which renders an image file into the conversation as an image block on
// its own. So an attachment reaches either provider by existing at a stable
// absolute path — which also means no base64 ever enters chats.json, a single
// JSON document that holds every transcript in the app.
//
// LIFETIME (owner's call, 2026-08-04): attachments live exactly as long as the
// conversation. Archiving a chat destroys them, and UNARCHIVING DOES NOT BRING
// THEM BACK — the transcript keeps the metadata, so an old message still
// renders a named chip, but the chip is a tombstone with nothing behind it.
// That is why every field the UI needs to draw a chip (name, media type, size)
// is persisted with the MESSAGE and not read back from here.
//
// LAYOUT is flat and id-keyed rather than nested under the chat:
//
//   <stateRoot>/attachments/<id>/blob        the bytes, original name discarded
//   <stateRoot>/attachments/<id>/meta.json   AttachmentMeta below
//
// An upload happens BEFORE the chat exists (a fresh composer has no session id
// until the first `session` event of its first turn), so a chat-nested layout
// would need every new session's directory renamed mid-turn. Flat + a `chatId`
// stamped on later — see `bindAttachments` — has no such window.

import fs from "node:fs";
import path from "node:path";
import { stateRoot } from "./store";

export type AttachmentMeta = {
  id: string;
  /** The user's filename, for display only — never used to build a path. */
  name: string;
  mediaType: string;
  size: number;
  createdAt: number;
  /**
   * The chat these bytes belong to, stamped by `bindAttachments` once the turn
   * that carries them knows its session id. Absent means "uploaded but never
   * sent" — the orphan sweep below is what eventually collects those.
   */
  chatId?: string;
};

const attachmentsRoot = () => path.join(stateRoot(), "attachments");
const dirFor = (id: string) => path.join(attachmentsRoot(), id);

/**
 * Ids are minted here, never accepted from a caller, and every consumer path is
 * built by joining this root with one — so a hostile "../../etc/passwd" cannot
 * become a path. The guard is belt-and-braces for the id that arrives back over
 * the wire on a later turn.
 */
const isSafeId = (id: string): boolean => /^[A-Za-z0-9_-]{8,64}$/.test(id);

const metaPath = (id: string) => path.join(dirFor(id), "meta.json");

/** The bytes. Callers hand this to a harness; it is always absolute. */
export const attachmentPath = (id: string): string | null =>
  isSafeId(id) ? path.join(dirFor(id), "blob") : null;

export function readAttachmentMeta(id: string): AttachmentMeta | null {
  if (!isSafeId(id)) return null;
  try {
    return JSON.parse(fs.readFileSync(metaPath(id), "utf8")) as AttachmentMeta;
  } catch {
    return null;
  }
}

function writeMeta(meta: AttachmentMeta): void {
  fs.writeFileSync(metaPath(meta.id), JSON.stringify(meta, null, 2));
}

/**
 * Persist one uploaded file. Returns the metadata the client echoes back on the
 * turn that sends it.
 */
export function putAttachment(input: {
  name: string;
  mediaType: string;
  bytes: Buffer;
}): AttachmentMeta {
  const id = crypto.randomUUID().replaceAll("-", "");
  const dir = dirFor(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "blob"), input.bytes);
  const meta: AttachmentMeta = {
    id,
    // The name is DISPLAY DATA. It is stored verbatim (so the chip reads the
    // way the user expects) and never joined into a path — `blob` is the only
    // filename this module ever writes.
    name: input.name,
    mediaType: input.mediaType,
    size: input.bytes.byteLength,
    createdAt: Date.now(),
  };
  writeMeta(meta);
  return meta;
}

/**
 * Stamp the owning chat onto attachments once the turn carrying them knows its
 * session id. Idempotent, and silently skips ids that no longer exist — a turn
 * replayed after its attachments were swept must not fail.
 */
export function bindAttachments(ids: readonly string[], chatId: string): void {
  for (const id of ids) {
    const meta = readAttachmentMeta(id);
    if (!meta || meta.chatId === chatId) continue;
    writeMeta({ ...meta, chatId });
  }
}

function removeAttachment(id: string): void {
  try {
    fs.rmSync(dirFor(id), { force: true, recursive: true });
  } catch {
    /* best effort — a failed unlink must never break the write that triggered it */
  }
}

function listAttachmentIds(): string[] {
  try {
    return fs
      .readdirSync(attachmentsRoot(), { withFileTypes: true })
      .filter((e) => e.isDirectory() && isSafeId(e.name))
      .map((e) => e.name);
  } catch {
    return []; // no attachments have ever been written
  }
}

/**
 * Destroy every attachment belonging to a chat. Called when the chat is
 * archived AND when it is deleted — per the lifetime note at the top of this
 * file, archiving is destructive and un-archiving does not restore.
 */
export function deleteAttachmentsForChat(chatId: string): number {
  let removed = 0;
  for (const id of listAttachmentIds()) {
    if (readAttachmentMeta(id)?.chatId !== chatId) continue;
    removeAttachment(id);
    removed++;
  }
  return removed;
}

/** Uploads that were never sent — staged in a composer the user then abandoned. */
const ORPHAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Collect unbound uploads older than a day. Opportunistic: called on upload, so
 * the cost is paid by the next person to attach something rather than by a
 * timer this app would otherwise have no reason to run.
 */
export function sweepOrphanAttachments(now: number = Date.now()): number {
  let removed = 0;
  for (const id of listAttachmentIds()) {
    const meta = readAttachmentMeta(id);
    // A directory with no readable meta.json is itself debris (a crash between
    // mkdir and writeMeta) — collect it on the same schedule.
    const age = now - (meta?.createdAt ?? 0);
    if (meta?.chatId || age < ORPHAN_MAX_AGE_MS) continue;
    removeAttachment(id);
    removed++;
  }
  return removed;
}
