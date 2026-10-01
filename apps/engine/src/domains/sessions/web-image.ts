import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { TurnAttachment } from "@telar/engine-client";

const WEB_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp", "image/svg+xml", "image/x-icon", "image/vnd.microsoft.icon"]);
const CONVERT_TIMEOUT_MS = 15_000;
const MAX_CONVERSIONS = 2;

const needsConversion = (attachment: TurnAttachment): boolean => attachment.mediaType.startsWith("image/") && !WEB_IMAGE_TYPES.has(attachment.mediaType);
const jpegFile = (attachment: TurnAttachment): string => path.join(path.dirname(attachment.path), `${attachment.id}.display.jpg`);
const asJpeg = (attachment: TurnAttachment, file: string): TurnAttachment => ({ ...attachment, path: file, mediaType: "image/jpeg" });

/** The attachment as a browser or model can draw it: its cached JPEG when it is HEIC or another non-web image and one exists. */
export function webImageOf(attachment: TurnAttachment): TurnAttachment {
  if (!needsConversion(attachment)) return attachment;
  const file = jpegFile(attachment);
  return fs.existsSync(file) ? asJpeg(attachment, file) : attachment;
}

let free = MAX_CONVERSIONS;
const waiting: Array<() => void> = [];
const acquire = (): Promise<void> => (free > 0 ? (free--, Promise.resolve()) : new Promise((resolve) => waiting.push(resolve)));
const release = (): void => {
  const next = waiting.shift();
  if (next) next();
  else free++;
};
const pending = new Map<string, Promise<TurnAttachment>>();

/** Makes the JPEG once per attachment, whose bytes never change. Off macOS, or when conversion fails, the original. */
export function ensureWebImage(attachment: TurnAttachment): Promise<TurnAttachment> {
  const ready = webImageOf(attachment);
  if (ready !== attachment || !needsConversion(attachment) || process.platform !== "darwin") return Promise.resolve(ready);
  const file = jpegFile(attachment);
  let job = pending.get(file);
  if (!job) {
    job = convert(attachment, file).finally(() => pending.delete(file));
    pending.set(file, job);
  }
  return job;
}

async function convert(attachment: TurnAttachment, file: string): Promise<TurnAttachment> {
  await acquire();
  const scratch = `${file}.${process.pid}.tmp.jpg`;
  try {
    await new Promise<void>((resolve, reject) =>
      execFile("/usr/bin/sips", ["-s", "format", "jpeg", attachment.path, "--out", scratch], { timeout: CONVERT_TIMEOUT_MS }, (error) => (error ? reject(error) : resolve())),
    );
    await fs.promises.chmod(scratch, 0o600);
    await fs.promises.rename(scratch, file);
    return asJpeg(attachment, file);
  } catch {
    await fs.promises.rm(scratch, { force: true });
    return attachment;
  } finally {
    release();
  }
}
