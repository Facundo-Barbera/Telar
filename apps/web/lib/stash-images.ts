/**
 * Turning a picked image into something a stash can hold, and back again.
 *
 * SPLIT FROM `prompt-stash.ts` ONLY BECAUSE OF THE CANVAS. That file is pure so
 * `bun test` can import all of it; this one reaches for `createImageBitmap` and
 * a `<canvas>`, which a test runner has neither of. The split is the test
 * boundary, not a layering opinion.
 *
 * A SCREENSHOT IS THREE TO SIX MEGABYTES AS A DATA URL, and the whole origin
 * gets about five. Storing what was picked is not an option that exists, so the
 * question is only whether to re-encode or to refuse — and refusing every
 * screenshot makes the feature look broken on the most common thing anyone
 * stashes. So: cap the long edge, step the quality down until it fits, and hand
 * back anything that still does not.
 */

import type { StashedImage } from "./prompt-stash";

/** Enough to read a screenshot back and know which one it was, which is all a
 *  restored attachment has to do — the model gets the re-encode either way. */
export const IMAGE_LONG_EDGE = 1600;
/** BYTES ON THE BLOB, measured before base64 expands it by a third, so the
 *  ladder below can stop without encoding a data URL to find out. */
export const MAX_IMAGE_BYTES = 450_000;

const QUALITY = [0.82, 0.7, 0.6, 0.5, 0.4];

/** Never upscales: a small image is already small, and stretching it to the cap
 *  would make it bigger to store and no better to look at. */
export function fitLongEdge(width: number, height: number, max: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= max || longest === 0) return { width, height };
  const scale = max / longest;
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/**
 * WHAT DOES NOT FIT COMES BACK, it is not discarded.
 *
 * `kept` is the contract that makes this feature safe to press: an image the
 * browser cannot decode, or one still over budget at the lowest quality, is
 * returned to the caller to put straight back in the composer. A pasted
 * screenshot is exactly as unrecoverable as a typed paragraph, and recording its
 * name in the entry would be a receipt for something already destroyed.
 */
export async function encodeImagesForStash(
  files: readonly File[],
): Promise<{ images: StashedImage[]; kept: File[] }> {
  const images: StashedImage[] = [];
  const kept: File[] = [];
  for (const file of files) {
    const encoded = await encode(file);
    if (encoded) images.push(encoded);
    else kept.push(file);
  }
  return { images, kept };
}

/**
 * ENCODED TO WEBP, NOT JPEG. This cockpit runs on Chromium (the desktop shell
 * and a browser tab), so WebP is always there, and it is the one lossy format
 * that keeps alpha. A macOS window screenshot is a PNG with transparent rounded
 * corners and a soft shadow; JPEG puts black corners on every one of them.
 */
async function encode(file: File): Promise<StashedImage | undefined> {
  try {
    const bitmap = await createImageBitmap(file);
    try {
      const size = fitLongEdge(bitmap.width, bitmap.height, IMAGE_LONG_EDGE);
      const canvas = document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      const context = canvas.getContext("2d");
      if (!context) return undefined;
      context.drawImage(bitmap, 0, 0, size.width, size.height);
      for (const quality of QUALITY) {
        const blob = await toBlob(canvas, quality);
        if (!blob) return undefined;
        if (blob.size > MAX_IMAGE_BYTES) continue;
        return { name: file.name, type: blob.type, dataUrl: await toDataUrl(blob) };
      }
      return undefined;
    } finally {
      bitmap.close();
    }
  } catch {
    // A format Chromium declined to decode. The file goes back to the composer.
    return undefined;
  }
}

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob(
      (blob) => {
        if (blob) return resolve(blob);
        // `toBlob` answers null for a type it will not write. JPEG is the
        // universal floor; the corners lose their transparency and the image
        // survives, which is the right trade at that point.
        canvas.toBlob(resolve, "image/jpeg", quality);
      },
      "image/webp",
      quality,
    );
  });
}

function toDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("unreadable"));
    reader.readAsDataURL(blob);
  });
}

/**
 * Back to a `File`, so a restored image is indistinguishable from a picked one
 * everywhere downstream — the chip, the upload, the submit.
 *
 * THIS ONE IS TESTABLE despite living on the DOM side of the wall: bun ships
 * `File` and `atob`. It is here rather than in `prompt-stash.ts` because it is
 * the exact inverse of `encode` above and splitting a round trip across two
 * files is how the two halves come to disagree. Please leave it.
 */
export function fileFromStashedImage(image: StashedImage): File | undefined {
  try {
    const comma = image.dataUrl.indexOf(",");
    if (comma < 0) return undefined;
    const binary = atob(image.dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
    return new File([bytes], image.name, { type: image.type });
  } catch {
    return undefined;
  }
}

/** Order preserved; anything malformed is skipped rather than thrown over. */
export function filesFromStash(images: readonly StashedImage[]): File[] {
  return images.map(fileFromStashedImage).filter((file): file is File => file !== undefined);
}
