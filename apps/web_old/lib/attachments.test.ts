// Composer attachments — the LIFETIME claims, which are the destructive ones.
//
// The owner's rule (2026-08-04) is that attachments live exactly as long as the
// conversation and that ARCHIVING DESTROYS THEM ONE-WAY: un-archiving a chat
// does not bring its files back. That is a deliberate data-loss path, so it is
// asserted here rather than left to inspection — a regression that quietly kept
// the bytes would be invisible, and one that quietly deleted the WRONG chat's
// bytes would be invisible until someone lost work.
//
// bun provides "bun:test" at runtime; @types/bun isn't a dependency of this Next
// app, so the web tsconfig (which includes **/*.ts) can't resolve it. Suppress
// just the import — the runtime is `bun test`, not tsc.
// @ts-expect-error no @types/bun in this workspace
import { beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "telar-attachments-"));
process.env.TELAR_HOME = TMP;
// bun test runs all files in one process — re-pin the env before every test.
beforeEach(() => {
  process.env.TELAR_HOME = TMP;
});

const {
  attachmentPath,
  bindAttachments,
  deleteAttachmentsForChat,
  putAttachment,
  readAttachmentMeta,
  sweepOrphanAttachments,
} = await import("./attachments");

const put = (name = "shot.png", mediaType = "image/png") =>
  putAttachment({ bytes: Buffer.from("pretend-png-bytes"), mediaType, name });

describe("composer attachment storage", () => {
  test("an upload round-trips to a readable absolute path", () => {
    const meta = put();
    const file = attachmentPath(meta.id);

    expect(file).toBeTruthy();
    expect(path.isAbsolute(file!)).toBe(true);
    // The absolute path IS the feature: it is what both harnesses receive.
    expect(fs.readFileSync(file!, "utf8")).toBe("pretend-png-bytes");
    expect(readAttachmentMeta(meta.id)).toMatchObject({
      mediaType: "image/png",
      name: "shot.png",
      size: "pretend-png-bytes".length,
    });
  });

  test("a hostile id can never escape the attachments root", () => {
    // Ids are minted internally, but one arrives back over the wire on the turn
    // that sends it, so the guard is load-bearing rather than decorative.
    for (const id of ["../../etc/passwd", "..", "a/b", "", "x".repeat(200)]) {
      expect(attachmentPath(id)).toBeNull();
      expect(readAttachmentMeta(id)).toBeNull();
    }
  });

  test("archiving destroys only the archived chat's attachments", () => {
    const mine = put("mine.png");
    const theirs = put("theirs.png");
    bindAttachments([mine.id], "chat-a");
    bindAttachments([theirs.id], "chat-b");

    expect(deleteAttachmentsForChat("chat-a")).toBe(1);

    expect(fs.existsSync(attachmentPath(mine.id)!)).toBe(false);
    expect(fs.existsSync(attachmentPath(theirs.id)!)).toBe(true);
  });

  test("the delete is one-way — nothing restores a swept attachment", () => {
    const meta = put();
    bindAttachments([meta.id], "chat-c");
    deleteAttachmentsForChat("chat-c");

    // The metadata goes with the bytes; the TRANSCRIPT is what keeps enough to
    // draw a tombstone chip, which is why this returning null is correct rather
    // than a gap. Re-binding must not resurrect anything either.
    expect(readAttachmentMeta(meta.id)).toBeNull();
    bindAttachments([meta.id], "chat-c");
    expect(fs.existsSync(attachmentPath(meta.id)!)).toBe(false);
  });

  test("binding is idempotent and tolerates ids that no longer exist", () => {
    const meta = put();
    bindAttachments([meta.id], "chat-d");
    bindAttachments([meta.id], "chat-d");
    expect(readAttachmentMeta(meta.id)?.chatId).toBe("chat-d");

    // A turn replayed after its attachments were swept must not throw.
    expect(() => bindAttachments(["deadbeefdeadbeef"], "chat-d")).not.toThrow();
  });

  test("the orphan sweep collects unsent uploads and spares bound ones", () => {
    const abandoned = put("abandoned.png");
    const sent = put("sent.png");
    bindAttachments([sent.id], "chat-e");

    const DAY = 24 * 60 * 60 * 1000;
    // A fresh unbound upload is someone's staged-but-unsent composer, not
    // debris. Asserted per-FILE rather than on the sweep's count: this root is
    // shared with the tests above, whose own unbound uploads are legitimately
    // collectable too, and a count would be asserting their bookkeeping.
    sweepOrphanAttachments(Date.now());
    expect(fs.existsSync(attachmentPath(abandoned.id)!)).toBe(true);

    // A day later it is debris — but a BOUND attachment of any age is not.
    sweepOrphanAttachments(Date.now() + DAY + 1000);
    expect(fs.existsSync(attachmentPath(abandoned.id)!)).toBe(false);
    expect(fs.existsSync(attachmentPath(sent.id)!)).toBe(true);
  });
});
