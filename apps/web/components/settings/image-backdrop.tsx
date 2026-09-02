"use client";

/**
 * THE IMAGE PICKER — a photograph under the app, and a theme out of it.
 *
 * Rendered by backdrop-section.tsx when the Scene control says Image. Three
 * jobs, in the order a person meets them:
 *
 *   1. GET AN IMAGE IN. Drop or pick; lib/image-backdrop.ts compresses it to
 *      something that fits in localStorage. The ORDER here is load-bearing and
 *      set by the store: the image data URL is written FIRST, then the choice
 *      — applyBackdrop and the pre-paint init script both drop the whole scene
 *      when the choice says "image" and the key is empty, so writing the
 *      choice first would flash a bare canvas on the very next launch.
 *      And if storage refuses (quota), the choice is NOT written at all: the
 *      backdrop already in place stays, and a line says why.
 *
 *   2. TUNE IT. Fit / blur / dim write the store LIVE — every drag is a
 *      committed value, because the backdrop is behind the settings window
 *      you are dragging in, and a preview you have to confirm is just a worse
 *      version of looking at it.
 *
 *   3. WEAR IT. "Theme from image" is the point of the whole feature: the
 *      picture's dominant hue becomes the app's surfaces (lib/palette-from-
 *      image.ts), saved as a custom theme and worn immediately. It draws the
 *      stored image at ~64px first — a hue histogram over four thousand
 *      pixels is the same answer as over four million, arriving instantly.
 *
 * FAILURE IS A LINE, NOT A DIALOG — the theme-library idiom: a message in the
 * row's hint slot, holding the SPECIFIC reason ("too large to store") rather
 * than a boolean flattening three different problems into one sentence.
 */

import { useCallback, useRef, useState } from "react";
import { ImageIcon, PaletteIcon, Trash2Icon, UploadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { BACKDROP_FITS, MAX_BACKDROP_BLUR, MAX_BACKDROP_DIM, useBackdrop, type BackdropFit } from "@/lib/backdrop";
import { compressImageFile, ImageBackdropError, readBackdropImage, storeBackdropImage } from "@/lib/image-backdrop";
import { dominantHues, themeFromPalette } from "@/lib/palette-from-image";
import { useThemeLibrary } from "@/lib/theme-palettes";
import { Row, Segmented } from "./settings-shell";

/** What a fresh pick looks like. A little dim by default: an untouched photo
 *  behind text is a legibility problem, and 20% is the smallest amount that
 *  reliably is not. */
const DEFAULT_FIT: BackdropFit = "cover";
const DEFAULT_BLUR = 0;
const DEFAULT_DIM = 20;

/** The sample the palette is read from. Large enough that a small accent in
 *  the picture still occupies pixels, small enough to be instant. */
const SAMPLE_EDGE = 64;

const FIT_LABELS: Record<BackdropFit, string> = { cover: "Cover", fill: "Fill", tile: "Tile" };

function messageFor(error: unknown): string {
  if (error instanceof ImageBackdropError) return error.message;
  return "That image could not be used.";
}

/** Draw the stored data URL small and read its pixels. Separate from the
 *  extraction itself so the pure half stays canvas-free and testable. */
async function samplePixels(dataUrl: string): Promise<Uint8ClampedArray> {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  const longest = Math.max(image.naturalWidth || 1, image.naturalHeight || 1);
  const scale = Math.min(1, SAMPLE_EDGE / longest);
  const width = Math.max(1, Math.round((image.naturalWidth || 1) * scale));
  const height = Math.max(1, Math.round((image.naturalHeight || 1) * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("no 2d context");
  context.drawImage(image, 0, 0, width, height);
  return context.getImageData(0, 0, width, height).data;
}

export function ImageBackdrop() {
  const { backdrop, setBackdrop } = useBackdrop();
  const { saveCustom, setActive } = useThemeLibrary();
  const fileInput = useRef<HTMLInputElement>(null);

  const image = backdrop.kind === "image" ? backdrop : undefined;
  // Lazily initialised from storage: mounting while an image backdrop is
  // ALREADY active (a fresh page load, or the Scene control arriving late)
  // must show the thumbnail and the tuning rows, not the empty drop-zone —
  // the render-time sync below only fires on transitions.
  const [preview, setPreview] = useState<string | undefined>(() => (backdrop.kind === "image" ? (readBackdropImage() ?? undefined) : undefined));
  const [error, setError] = useState<string | false>(false);
  const [quotaFull, setQuotaFull] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  // The thumbnail is READ FROM STORAGE, adjusted during render (the derived-
  // state idiom backdrop-section.tsx uses) rather than in an effect — but
  // keyed on WHETHER there is an image, never on the image's settings: a
  // slider drag changes `image` forty times a second, and re-reading a
  // multi-megabyte data URL on each tick would make dragging crawl. A
  // replacement pick sets the thumbnail itself, below.
  const hasImage = image !== undefined;
  const [seenHasImage, setSeenHasImage] = useState(hasImage);
  if (seenHasImage !== hasImage) {
    setSeenHasImage(hasImage);
    setPreview(hasImage ? (readBackdropImage() ?? undefined) : undefined);
  }

  const accept = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      setBusy(true);
      setError(false);
      try {
        const dataUrl = await compressImageFile(file);
        // Image first, THEN the choice — see the header.
        if (!storeBackdropImage(dataUrl)) {
          setQuotaFull(true);
          return;
        }
        setQuotaFull(false);
        setPreview(dataUrl);
        setBackdrop({
          kind: "image",
          fit: image?.fit ?? DEFAULT_FIT,
          blur: image?.blur ?? DEFAULT_BLUR,
          dim: image?.dim ?? DEFAULT_DIM,
        });
      } catch (failure) {
        setError(messageFor(failure));
      } finally {
        setBusy(false);
      }
    },
    [image, setBackdrop],
  );

  const makeTheme = useCallback(async () => {
    const stored = readBackdropImage();
    if (!stored) {
      setError("The image is no longer in storage.");
      return;
    }
    setBusy(true);
    setError(false);
    try {
      const colors = dominantHues(await samplePixels(stored));
      const definition = themeFromPalette(colors);
      const id = `custom-${Date.now().toString(36)}`;
      saveCustom({ id, ...definition });
      setActive(id);
      if (colors.length === 0) setError("That image has no colour to take — the theme is Telar's own.");
    } catch {
      setError("Could not read colours from that image.");
    } finally {
      setBusy(false);
    }
  }, [saveCustom, setActive]);

  return (
    <>
      <Row
        label="Image"
        icon={ImageIcon}
        hint={
          error
            ? error
            : quotaFull
              ? "There is no room left in this browser's storage for that image — the previous backdrop is untouched."
              : "A photo of your own, scaled down and kept in this browser. Nothing is uploaded."
        }
        control={
          <Button size="sm" variant="outline" disabled={busy} onClick={() => fileInput.current?.click()}>
            <UploadIcon /> Choose image…
          </Button>
        }
      />
      <div className="px-4 py-3">
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          className="hidden"
          aria-hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            void accept(file);
          }}
        />
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            void accept(event.dataTransfer.files?.[0]);
          }}
          className={cn(
            "flex items-center gap-3 rounded-lg border border-dashed p-3 transition-colors",
            dragging ? "border-primary bg-primary/5" : "border-border",
          )}
        >
          {preview ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element -- a data URL held in localStorage; there is nothing for next/image to fetch or optimise */}
              <img src={preview} alt="" className="size-14 shrink-0 rounded-md border border-border object-cover" />
              <div className="min-w-0 flex-1 text-xs text-muted-foreground">
                {busy ? "Working…" : "Drop another image here to replace it."}
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="shrink-0 text-muted-foreground"
                disabled={busy}
                onClick={() => {
                  setPreview(undefined);
                  setQuotaFull(false);
                  setError(false);
                  setBackdrop({ kind: "none" });
                }}
              >
                <Trash2Icon /> Remove
              </Button>
            </>
          ) : (
            <div className="flex-1 text-center text-xs text-muted-foreground">
              {busy ? "Working…" : "Drop an image here, or choose one above."}
            </div>
          )}
        </div>
      </div>
      {image && preview && (
        <>
          <Row
            label="Fit"
            hint="How the picture meets the window."
            control={
              <Segmented<BackdropFit>
                value={image.fit}
                onChange={(fit) => setBackdrop({ ...image, fit })}
                options={BACKDROP_FITS.map((fit) => ({ value: fit, label: FIT_LABELS[fit] }))}
              />
            }
          />
          <Row
            label="Blur"
            hint="Softens the picture so the text over it stays the thing you read."
            control={
              <div className="flex items-center gap-2.5">
                <input
                  type="range"
                  min={0}
                  max={MAX_BACKDROP_BLUR}
                  step={1}
                  value={image.blur}
                  onChange={(event) => setBackdrop({ ...image, blur: Number(event.target.value) })}
                  className="w-36 accent-primary"
                  aria-label="Backdrop blur"
                />
                <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">{image.blur}px</span>
              </div>
            }
          />
          <Row
            label="Dim"
            hint="Darkens the picture behind the app without touching its colours."
            control={
              <div className="flex items-center gap-2.5">
                <input
                  type="range"
                  min={0}
                  max={MAX_BACKDROP_DIM}
                  step={1}
                  value={image.dim}
                  onChange={(event) => setBackdrop({ ...image, dim: Number(event.target.value) })}
                  className="w-36 accent-primary"
                  aria-label="Backdrop dim"
                />
                <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">{image.dim}%</span>
              </div>
            }
          />
          <Row
            label="Theme from image"
            hint="Takes the picture's dominant colour and tints the app's surfaces with it — saved as a custom theme you can edit or delete."
            control={
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void makeTheme()}>
                <PaletteIcon /> Make theme
              </Button>
            }
          />
        </>
      )}
    </>
  );
}
