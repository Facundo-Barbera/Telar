/**
 * IMAGE BACKDROPS — getting a photo small enough to LIVE IN localStorage.
 *
 * The backdrop store paints an image from a data URL (BACKDROP_IMAGE_KEY), and
 * the pre-paint init script reads that key synchronously before first frame.
 * That contract is what makes the size question sharp: the image is not a file
 * reference, it is a STRING sitting in a 5MB-ish origin-wide budget that the
 * theme cache, the session list and every other preference also draw on. A
 * 12MP phone photo is 8MB before base64 adds a third on top. So nothing gets
 * stored as picked — everything goes through the ladder below.
 *
 * THE LADDER, not a single guess: quality 0.82 at 2048px is right for almost
 * every photo, but "almost" is the problem — a noisy image at that setting can
 * still land at 6MB, and a one-shot encode would just fail. So compression
 * RETRIES: quality steps down first (cheap, invisible on a blurred backdrop),
 * and only when quality bottoms out does the long edge shrink. Giving up is a
 * named error, never a silent no-op, because the picker has a line to show.
 *
 * THE DOM PARTS ARE DELIBERATELY THIN. Canvas cannot be unit-tested here, so
 * everything that DECIDES anything — how far to scale, what the next attempt
 * is, how big a data URL actually is — is a pure exported function with tests,
 * and the canvas code is left with nothing but drawing.
 */

import { BACKDROP_IMAGE_KEY } from "./backdrop";

/** The long edge a backdrop is worth storing at. A backdrop is seen behind
 *  frosted glass, usually blurred; past this it is bytes nobody looks at. */
export const MAX_BACKDROP_EDGE = 2048;

/** The byte budget for one stored image. Well under the ~5MB localStorage
 *  gives an origin, because the themes, sessions and prefs live there too. */
export const MAX_BACKDROP_IMAGE_BYTES = 3.5 * 1024 * 1024;

export type CompressionStep = { edge: number; quality: number };

/** What almost every image is stored at — the ladder starts here and only
 *  descends when a real encode came back too big. */
export const FIRST_STEP: CompressionStep = { edge: MAX_BACKDROP_EDGE, quality: 0.82 };

const MIN_QUALITY = 0.5;
const QUALITY_DROP = 0.12;
/** After a shrink, quality resets high-ish: fewer pixels means the same bytes
 *  buy more quality, and re-descending from the floor would waste the shrink. */
const RESET_QUALITY = 0.72;
const EDGE_SHRINK = 0.75;
/** Below this the image is no longer a backdrop, it is a thumbnail — better to
 *  fail loudly than to paint a smear behind the whole app. */
const MIN_EDGE = 512;

/** Quality first (invisible), size second (visible), then give up. Guaranteed
 *  to terminate: every branch strictly decreases quality or edge. */
export function stepDown(step: CompressionStep): CompressionStep | undefined {
  const lower = Math.round((step.quality - QUALITY_DROP) * 100) / 100;
  if (lower >= MIN_QUALITY) return { edge: step.edge, quality: lower };
  const edge = Math.round(step.edge * EDGE_SHRINK);
  if (edge < MIN_EDGE) return undefined;
  return { edge, quality: RESET_QUALITY };
}

/**
 * Longest edge capped at `edge`, aspect preserved, NEVER upscaled — a small
 * image stored bigger than it was born is pure waste, and the CSS `cover` fit
 * stretches it to the window either way.
 */
export function fitWithin(width: number, height: number, edge: number): { width: number; height: number } {
  const w = Number.isFinite(width) ? Math.max(1, Math.round(width)) : 1;
  const h = Number.isFinite(height) ? Math.max(1, Math.round(height)) : 1;
  const longest = Math.max(w, h);
  if (longest <= edge) return { width: w, height: h };
  const scale = edge / longest;
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/**
 * The DECODED size of a data URL — what the ladder is actually judging. Base64
 * carries 3 bytes per 4 characters, minus the "=" padding; a non-base64 data
 * URL (rare, but `toDataURL` is not the only caller) is measured as its
 * payload length. Deliberately an estimate: it is compared against a budget
 * that is itself a safety margin, so being a few bytes out changes nothing.
 */
export function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return dataUrl.length;
  const payload = dataUrl.slice(comma + 1);
  if (!/;base64/i.test(dataUrl.slice(0, comma))) return payload.length;
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

export type ImageBackdropErrorCode = "not-an-image" | "decode-failed" | "too-large";

/** Named so the picker can say WHICH thing went wrong in one line rather than
 *  showing a generic failure for three very different situations. */
export class ImageBackdropError extends Error {
  readonly code: ImageBackdropErrorCode;

  constructor(code: ImageBackdropErrorCode, message: string) {
    super(message);
    this.name = "ImageBackdropError";
    this.code = code;
  }
}

/** A file the browser will not even try to decode — caught before any work. */
export function isImageFile(file: { type?: string; name?: string }): boolean {
  if (typeof file.type === "string" && file.type.startsWith("image/")) return true;
  // Drag-and-drop from some sources arrives with an empty type; fall back to
  // the extension rather than refusing a perfectly good PNG.
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

/**
 * Decode → downscale → encode, descending the ladder until the result fits.
 * JPEG unconditionally: a backdrop is a photographic wash with no transparency
 * to preserve, and PNG on a photo is several times the bytes for nothing.
 */
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

/**
 * Write the image BEFORE the choice (applyBackdrop reads this key and drops
 * the whole scene if it is missing). Returns false rather than throwing on a
 * full quota — and puts the PREVIOUS image back when it does, so a failed
 * replacement leaves the backdrop you already had rather than a blank app.
 */
export function storeBackdropImage(dataUrl: string): boolean {
  if (!dataUrl.startsWith("data:image/")) return false;
  let previous: string | null = null;
  try {
    previous = window.localStorage.getItem(BACKDROP_IMAGE_KEY);
  } catch {
    return false; // Private browsing: nothing can be stored at all.
  }
  try {
    window.localStorage.setItem(BACKDROP_IMAGE_KEY, dataUrl);
    return true;
  } catch {
    try {
      if (previous === null) window.localStorage.removeItem(BACKDROP_IMAGE_KEY);
      else window.localStorage.setItem(BACKDROP_IMAGE_KEY, previous);
    } catch {
      // The restore can fail too (the quota is genuinely gone); the store's own
      // "no image means no scene" guard keeps the app coherent either way.
    }
    return false;
  }
}

/** Read back what is stored, for the preview and for theme extraction. */
export function readBackdropImage(): string | null {
  try {
    const value = window.localStorage.getItem(BACKDROP_IMAGE_KEY);
    return value && value.startsWith("data:image/") ? value : null;
  } catch {
    return null;
  }
}
