/**
 * Compresses a picked photo into a data URL small enough for localStorage, stepping quality
 * down first and then the long edge. The decisions are pure functions; the canvas code only draws.
 */

/** Seen behind frosted glass, usually blurred. */
export const MAX_BACKDROP_EDGE = 2048;

/** Well under localStorage's ~5MB per origin, which other preferences share. */
export const MAX_BACKDROP_IMAGE_BYTES = 3.5 * 1024 * 1024;

export type CompressionStep = { edge: number; quality: number };

/** The ladder starts here and descends only when an encode is too big. */
export const FIRST_STEP: CompressionStep = { edge: MAX_BACKDROP_EDGE, quality: 0.82 };

const MIN_QUALITY = 0.5;
const QUALITY_DROP = 0.12;
/** Fewer pixels buy more quality per byte, so quality resets after a shrink. */
const RESET_QUALITY = 0.72;
const EDGE_SHRINK = 0.75;
/** Below this it would be a thumbnail, so fail instead. */
const MIN_EDGE = 512;

/** Quality first, then size, then give up. Terminates: every branch decreases quality or edge. */
export function stepDown(step: CompressionStep): CompressionStep | undefined {
  const lower = Math.round((step.quality - QUALITY_DROP) * 100) / 100;
  if (lower >= MIN_QUALITY) return { edge: step.edge, quality: lower };
  const edge = Math.round(step.edge * EDGE_SHRINK);
  if (edge < MIN_EDGE) return undefined;
  return { edge, quality: RESET_QUALITY };
}

/** Longest edge capped at `edge`, aspect preserved, never upscaled. */
export function fitWithin(width: number, height: number, edge: number): { width: number; height: number } {
  const w = Number.isFinite(width) ? Math.max(1, Math.round(width)) : 1;
  const h = Number.isFinite(height) ? Math.max(1, Math.round(height)) : 1;
  const longest = Math.max(w, h);
  if (longest <= edge) return { width: w, height: h };
  const scale = edge / longest;
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/** Approximate decoded size of a data URL; non-base64 payloads count their length. */
export function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return dataUrl.length;
  const payload = dataUrl.slice(comma + 1);
  if (!/;base64/i.test(dataUrl.slice(0, comma))) return payload.length;
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

export type ImageBackdropErrorCode = "not-an-image" | "decode-failed" | "too-large";

/** Named so the picker can say which thing went wrong. */
export class ImageBackdropError extends Error {
  readonly code: ImageBackdropErrorCode;

  constructor(code: ImageBackdropErrorCode, message: string) {
    super(message);
    this.name = "ImageBackdropError";
    this.code = code;
  }
}

/** A file the browser will not even try to decode. */
export function isImageFile(file: { type?: string; name?: string }): boolean {
  if (typeof file.type === "string" && file.type.startsWith("image/")) return true;
  // Some drag-and-drop sources give an empty type, so fall back to the extension.
  return typeof file.name === "string" && /\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(file.name);
}

type Drawable = CanvasImageSource & { width: number; height: number };

async function decode(file: File): Promise<Drawable> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file);
    } catch {
      // Fall through: some browsers reject formats <img> still handles.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const element = new Image();
    element.src = url;
    await element.decode();
    return element;
  } catch {
    throw new ImageBackdropError("decode-failed", "That image could not be read.");
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Decode, downscale and encode as JPEG, descending the ladder until it fits. */
export async function compressImageFile(file: File): Promise<string> {
  if (!isImageFile(file)) throw new ImageBackdropError("not-an-image", "That file is not an image.");
  const source = await decode(file);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) throw new ImageBackdropError("decode-failed", "This browser could not draw the image.");

  const close = () => {
    if ("close" in source && typeof source.close === "function") source.close();
  };

  let step: CompressionStep | undefined = FIRST_STEP;
  while (step) {
    const { width, height } = fitWithin(source.width, source.height, step.edge);
    canvas.width = width;
    canvas.height = height;
    context.clearRect(0, 0, width, height);
    context.drawImage(source, 0, 0, width, height);
    const dataUrl = canvas.toDataURL("image/jpeg", step.quality);
    if (!dataUrl.startsWith("data:image/")) {
      close();
      throw new ImageBackdropError("decode-failed", "That image could not be re-encoded.");
    }
    if (dataUrlBytes(dataUrl) <= MAX_BACKDROP_IMAGE_BYTES) {
      close();
      return dataUrl;
    }
    step = stepDown(step);
  }
  close();
  throw new ImageBackdropError("too-large", "That image is too large to store, even shrunk.");
}
