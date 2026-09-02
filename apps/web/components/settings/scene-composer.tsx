"use client";

/**
 * THE SCENE COMPOSER — arranging several images over a gradient.
 *
 * Rendered by backdrop-section.tsx when Scene says Compose. It is the image
 * picker's idiom taken plural: pick or drop, tune with sliders, and every
 * change is already committed — but where that pane tunes ONE picture with
 * CSS filters, this one builds a whole `background-image` list in
 * lib/scene-composer.ts and hands the resolved lists to the store.
 *
 * THE APP BEHIND THE PANE IS THE PREVIEW. There is no save button and no
 * preview surface, for the reason the gradient editor gives: nothing on this
 * screen is big enough to judge a backdrop against, and the real one is
 * already on the other side of the settings window. So every slider tick
 * recomposes and calls setBackdrop.
 *
 * TWO EXCEPTIONS TO "LIVE", both about cost:
 *
 *   - OPACITY LANDS ON RELEASE. It is the one control that cannot be a CSS
 *     value — it is baked into the layer's pixels (see the lib header) — and
 *     re-encoding a megapixel WebP per pointer sample would turn the drag
 *     into a slideshow. The number tracks the thumb live; the picture updates
 *     when you let go.
 *   - THE IMAGE MAP IS ONLY REWRITTEN WHEN IT CHANGED. Dragging position or
 *     size does not touch the layer data, and re-serialising several
 *     megabytes of data URL forty times a second would be felt.
 *
 * THE ORDER OF WRITES is the store's, same as the image picker's: layer
 * images FIRST, then the scene, then the choice — the composed CSS is what
 * actually paints, but a scene whose images did not fit must not become the
 * live backdrop at all. A refused write leaves the previous backdrop standing
 * and says so in the hint line.
 *
 * REORDERING IS ARRAY ORDER. `layers[0]` paints on top (CSS's own rule), so
 * "up" is towards index 0 and the list reads top-of-the-stack first, like a
 * layers palette anywhere else.
 */

import { useCallback, useRef, useState } from "react";
import { ChevronDownIcon, ChevronUpIcon, ImagePlusIcon, LayersIcon, Trash2Icon, UploadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useBackdrop } from "@/lib/backdrop";
import { BACKDROP_PRESETS } from "@/lib/backdrop-presets";
import { ImageBackdropError } from "@/lib/image-backdrop";
import {
  addSceneLayer,
  bakeLayerOpacity,
  composeScene,
  forgetLayerImages,
  MAX_SCENE_LAYERS,
  moveSceneLayer,
  newLayerId,
  prepareSceneImage,
  readScene,
  readSceneImages,
  removeSceneLayer,
  SCENE_LIMITS,
  updateSceneLayer,
  writeScene,
  writeSceneImages,
  type Scene,
  type SceneLayer,
} from "@/lib/scene-composer";
import { Row } from "./settings-shell";

const QUOTA_MESSAGE = "There is no room left in this browser's storage for that layer — the scene you had is untouched.";

function messageFor(error: unknown): string {
  if (error instanceof ImageBackdropError) return error.message;
  return "That image could not be used.";
}

/** One slider row inside a layer card — the settings sliders' shape, shrunk
 *  to fit four of them beside a thumbnail. */
function LayerSlider({
  label,
  value,
  min,
  max,
  suffix,
  onChange,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  suffix: string;
  onChange: (value: number) => void;
  onCommit?: () => void;
}) {
  return (
    <label className="flex items-center gap-2 text-[11px]">
      <span className="w-10 shrink-0 text-muted-foreground">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        // Release, not change: some values are expensive to land (opacity is
        // a re-encode). Rows without an onCommit simply never use these.
        onPointerUp={onCommit}
        onKeyUp={onCommit}
        onBlur={onCommit}
        className="min-w-0 flex-1 accent-primary"
        aria-label={label}
      />
      <span className="w-10 shrink-0 text-right tabular-nums text-muted-foreground">
        {value}
        {suffix}
      </span>
    </label>
  );
}

function LayerCard({
  layer,
  image,
  index,
  count,
  onPatch,
  onCommitOpacity,
  onMove,
  onRemove,
}: {
  layer: SceneLayer;
  image: string | undefined;
  index: number;
  count: number;
  onPatch: (patch: Partial<Omit<SceneLayer, "id">>) => void;
  onCommitOpacity: () => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex gap-3 rounded-lg border border-border p-2.5">
      {image ? (
        // eslint-disable-next-line @next/next/no-img-element -- a data URL held in localStorage; there is nothing for next/image to fetch or optimise
        <img src={image} alt="" className="size-14 shrink-0 self-start rounded-md border border-border object-cover" />
      ) : (
        <span className="flex size-14 shrink-0 items-center justify-center self-start rounded-md border border-dashed border-border text-[10px] text-muted-foreground">
          Missing
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <LayerSlider label="X" value={layer.x} min={SCENE_LIMITS.x.min} max={SCENE_LIMITS.x.max} suffix="%" onChange={(x) => onPatch({ x })} />
        <LayerSlider label="Y" value={layer.y} min={SCENE_LIMITS.y.min} max={SCENE_LIMITS.y.max} suffix="%" onChange={(y) => onPatch({ y })} />
        <LayerSlider
          label="Size"
          value={layer.scale}
          min={SCENE_LIMITS.scale.min}
          max={SCENE_LIMITS.scale.max}
          suffix="%"
          onChange={(scale) => onPatch({ scale })}
        />
        <LayerSlider
          label="Fade"
          value={layer.opacity}
          min={SCENE_LIMITS.opacity.min}
          max={SCENE_LIMITS.opacity.max}
          suffix="%"
          onChange={(opacity) => onPatch({ opacity })}
          onCommit={onCommitOpacity}
        />
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <div className="flex items-center gap-0.5">
          <Button
            size="icon-sm"
            variant="ghost"
            disabled={index === 0}
            title="Bring forward"
            aria-label={`Bring layer ${index + 1} forward`}
            onClick={() => onMove(-1)}
          >
            <ChevronUpIcon />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            disabled={index === count - 1}
            title="Send back"
            aria-label={`Send layer ${index + 1} back`}
            onClick={() => onMove(1)}
          >
            <ChevronDownIcon />
          </Button>
          <Button size="icon-sm" variant="ghost" className="text-muted-foreground" title="Remove layer" aria-label={`Remove layer ${index + 1}`} onClick={onRemove}>
            <Trash2Icon />
          </Button>
        </div>
        <Button
          size="sm"
          variant={layer.tiled ? "secondary" : "ghost"}
          aria-pressed={layer.tiled}
          className="text-[11px]"
          title="Repeat this layer across the whole window"
          onClick={() => onPatch({ tiled: !layer.tiled })}
        >
          {layer.tiled ? "Tiled" : "Tile"}
        </Button>
      </div>
    </div>
  );
}

export function SceneComposer() {
  const { backdrop, setBackdrop } = useBackdrop();
  const fileInput = useRef<HTMLInputElement>(null);

  // Seeded from storage once; from here on this state is the source and
  // storage is the sink (every edit writes through), exactly like the
  // gradient editor's pair.
  const [scene, setScene] = useState<Scene>(() => readScene());
  const [images, setImages] = useState<Record<string, string>>(() => readSceneImages());
  const [error, setError] = useState<string | false>(false);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  const live = backdrop.kind === "scene";

  /** The one write path: compose, store (images only when they changed), then
   *  make it the backdrop. Returns false when nothing was committed. */
  const apply = useCallback(
    (nextScene: Scene, nextImages: Record<string, string>): boolean => {
      const composed = composeScene(nextScene, nextImages);
      if (!composed) {
        setError("That scene could not be composed — its base gradient is unknown.");
        return false;
      }
      if (nextImages !== images && !writeSceneImages(nextImages)) {
        setError(QUOTA_MESSAGE);
        return false;
      }
      writeScene(nextScene);
      setScene(nextScene);
      setImages(nextImages);
      setError(false);
      // `stamp` is what tells the store this is a NEW composition even though
      // the choice ("a scene is on") did not change.
      setBackdrop({ kind: "scene", stamp: Date.now() }, composed);
      return true;
    },
    [images, setBackdrop],
  );

  const accept = useCallback(
    async (files: FileList | File[] | undefined) => {
      const picked = files ? Array.from(files) : [];
      if (picked.length === 0) return;
      const room = MAX_SCENE_LAYERS - scene.layers.length;
      if (room <= 0) {
        setError(`A scene holds ${MAX_SCENE_LAYERS} layers — remove one to add another.`);
        return;
      }
      setBusy(true);
      setError(false);
      let nextScene = scene;
      let nextImages = images;
      let failure: string | false = false;
      for (const file of picked.slice(0, room)) {
        try {
          const dataUrl = await prepareSceneImage(file);
          const id = newLayerId();
          nextScene = addSceneLayer(nextScene, id);
          // Both keys at once: the baked copy that paints, and the original
          // the opacity slider always re-derives from.
          nextImages = { ...nextImages, [id]: dataUrl, [`orig:${id}`]: dataUrl };
        } catch (thrown) {
          failure = messageFor(thrown);
        }
      }
      if (nextScene !== scene) apply(nextScene, nextImages);
      if (failure) setError(failure);
      else if (picked.length > room) setError(`Only ${room} more layer${room === 1 ? "" : "s"} would fit — the rest were left out.`);
      setBusy(false);
    },
    [apply, images, scene],
  );

  /** Position, size and tiling are pure CSS: write them straight through. */
  const patch = useCallback(
    (id: string, changes: Partial<Omit<SceneLayer, "id">>) => {
      const next = updateSceneLayer(scene, id, changes);
      // Opacity alone changes no CSS — it needs the re-encode below — so the
      // slider only moves the model until the pointer is released.
      if (changes.opacity !== undefined && Object.keys(changes).length === 1) setScene(next);
      else apply(next, images);
    },
    [apply, images, scene],
  );

  const commitOpacity = useCallback(
    async (id: string) => {
      const layer = scene.layers.find((entry) => entry.id === id);
      if (!layer) return;
      setBusy(true);
      const baked = await bakeLayerOpacity(images, id, layer.opacity);
      apply(scene, baked);
      setBusy(false);
    },
    [apply, images, scene],
  );

  const layerCount = scene.layers.length;

  return (
    <>
      <Row
        label="Layers"
        icon={LayersIcon}
        hint={
          error
            ? error
            : busy
              ? "Working…"
              : `Images stacked over the gradient below — up to ${MAX_SCENE_LAYERS}, the top one first. ${layerCount} in this scene. Nothing is uploaded.`
        }
        control={
          <div className="flex items-center gap-2">
            {!live && layerCount > 0 && (
              <Button size="sm" variant="outline" onClick={() => apply(scene, images)}>
                Use this scene
              </Button>
            )}
            <Button size="sm" variant="outline" disabled={busy || layerCount >= MAX_SCENE_LAYERS} onClick={() => fileInput.current?.click()}>
              <UploadIcon /> Add image…
            </Button>
          </div>
        }
      />
      <div className="flex flex-col gap-2 px-4 py-3">
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          aria-hidden
          onChange={(event) => {
            const files = event.target.files;
            const picked = files ? Array.from(files) : [];
            event.target.value = "";
            void accept(picked);
          }}
        />
        {scene.layers.map((layer, index) => (
          <LayerCard
            key={layer.id}
            layer={layer}
            image={images[`orig:${layer.id}`] ?? images[layer.id]}
            index={index}
            count={layerCount}
            onPatch={(changes) => patch(layer.id, changes)}
            onCommitOpacity={() => void commitOpacity(layer.id)}
            onMove={(delta) => apply(moveSceneLayer(scene, layer.id, delta), images)}
            onRemove={() => apply(removeSceneLayer(scene, layer.id), forgetLayerImages(images, layer.id))}
          />
        ))}
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            void accept(event.dataTransfer.files);
          }}
          className={cn(
            "flex items-center justify-center gap-2 rounded-lg border border-dashed p-3 text-xs text-muted-foreground transition-colors",
            dragging ? "border-primary bg-primary/5" : "border-border",
          )}
        >
          <ImagePlusIcon className="size-4 shrink-0" />
          {busy ? "Working…" : layerCount >= MAX_SCENE_LAYERS ? "The stack is full — remove a layer to add another." : "Drop images here to add layers."}
        </div>
      </div>
      <Row label="Base" hint="The gradient underneath the whole stack. Both halves of the pair come with it, light and dark." />
      <div className="px-4 pb-3">
        <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-6">
          {BACKDROP_PRESETS.map((preset) => {
            const on = scene.baseId === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                title={preset.label}
                aria-pressed={on}
                onClick={() => apply({ ...scene, baseId: preset.id }, images)}
                className={cn(
                  "flex flex-col gap-1 rounded-lg p-1 text-left ring-1 ring-foreground/10 transition-colors hover:bg-accent/50",
                  on && "ring-2 ring-primary",
                )}
              >
                <span className="relative block aspect-video w-full overflow-hidden rounded-md ring-1 ring-inset ring-foreground/10">
                  <span className="absolute inset-0" style={{ backgroundImage: preset.light, backgroundSize: "cover" }} />
                  <span className="absolute inset-y-0 right-0 w-1/2" style={{ backgroundImage: preset.dark, backgroundSize: "cover" }} />
                </span>
                <span className="truncate px-0.5 text-[10px] font-medium">{preset.label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}
