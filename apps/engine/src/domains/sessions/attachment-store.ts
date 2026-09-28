import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TurnAttachment as TurnAttachmentSchema, type TurnAttachment } from "@telar/engine-client";
import { assertId, EngineStateError, STATE_VERSION, type Kernel } from "../../platform/kernel";
import type { EngineStatePaths } from "../../platform/fs/state-paths";
import { sessionDir } from "./metadata";

// Held in memory to be written, so the cap sits here as well as on the HTTP edge.
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

function indexFile(paths: EngineStatePaths, sessionId: string): string {
  return path.join(sessionDir(paths, sessionId), "attachments.json");
}

function bytesFile(paths: EngineStatePaths, sessionId: string, attachmentId: string, name: string): string {
  assertId(attachmentId, "attachment id");
  const extension = /\.([A-Za-z0-9]{1,12})$/.exec(name)?.[1]?.toLowerCase();
  return path.join(sessionDir(paths, sessionId), "attachments", `${attachmentId}${extension ? `.${extension}` : ""}`);
}

export type AttachmentInput = { name: string; mediaType: string; data: Uint8Array; tags?: string[]; producer?: string; title?: string };

/**
 * A session's uploaded files. The id → metadata index is what makes an id
 * resolvable, so a turn never has to take a client-supplied path.
 */
export class SessionAttachments {
  constructor(
    private readonly kernel: Kernel,
    private readonly require: (sessionId: string) => void,
  ) {}

  put(sessionId: string, input: AttachmentInput): TurnAttachment {
    this.require(sessionId);
    if (input.data.byteLength === 0) throw new EngineStateError("invalid_request", "attachment is empty");
    if (input.data.byteLength > MAX_ATTACHMENT_BYTES) throw new EngineStateError("invalid_request", "attachment is larger than the engine accepts");
    const name = input.name.trim().slice(0, 200) || "attachment";
    const mediaType = input.mediaType.trim().slice(0, 120) || "application/octet-stream";
    const id = `att_${crypto.randomUUID().replaceAll("-", "")}`;
    const file = bytesFile(this.kernel.paths, sessionId, id, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, input.data, { mode: 0o600 });
    const attachment: TurnAttachment = {
      id, name, mediaType, bytes: input.data.byteLength, path: file, createdAt: this.kernel.now(),
      ...(input.tags?.length ? { tags: input.tags } : {}),
      ...(input.producer ? { producer: input.producer } : {}),
      ...(input.title?.trim() ? { title: input.title.trim().slice(0, 200) } : {}),
    };
    const index = this.index(sessionId);
    index.set(id, attachment);
    this.write(sessionId, index);
    return structuredClone(attachment);
  }

  /** Newest first, for the plots gallery. */
  list(sessionId: string, options: { tag?: string } = {}): TurnAttachment[] {
    this.require(sessionId);
    const all = [...this.index(sessionId).values()];
    const filtered = options.tag ? all.filter((a) => a.tags?.includes(options.tag!)) : all;
    return structuredClone(filtered.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)));
  }

  bytes(sessionId: string, attachmentId: string): { attachment: TurnAttachment; data: Uint8Array } {
    this.require(sessionId);
    const attachment = this.index(sessionId).get(attachmentId);
    if (!attachment) throw new EngineStateError("not_found", "attachment does not exist");
    return { attachment: structuredClone(attachment), data: new Uint8Array(fs.readFileSync(attachment.path)) };
  }

  /** Replaces the tags; how a plot is pinned and unpinned. */
  tag(sessionId: string, attachmentId: string, tags: string[]): TurnAttachment {
    this.require(sessionId);
    const index = this.index(sessionId);
    const attachment = index.get(attachmentId);
    if (!attachment) throw new EngineStateError("not_found", "attachment does not exist");
    const cleaned = [...new Set(tags.map((t) => t.trim()).filter(Boolean))].slice(0, 16);
    const next = { ...attachment, ...(cleaned.length ? { tags: cleaned } : {}) };
    if (!cleaned.length) delete next.tags;
    index.set(attachmentId, next);
    this.write(sessionId, index);
    return structuredClone(next);
  }

  // A corrupt index costs the ability to reference old attachments, not the session.
  index(sessionId: string): Map<string, TurnAttachment> {
    const stored = this.kernel.readDocument(indexFile(this.kernel.paths, sessionId)) as { attachments?: unknown } | undefined;
    const parsed = TurnAttachmentSchema.array().safeParse(stored?.attachments ?? []);
    return new Map((parsed.success ? parsed.data : []).map((attachment) => [attachment.id, attachment]));
  }

  private write(sessionId: string, index: Map<string, TurnAttachment>): void {
    this.kernel.writeDocument(indexFile(this.kernel.paths, sessionId), { version: STATE_VERSION, attachments: [...index.values()] });
  }
}
