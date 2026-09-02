"use client";

/**
 * THE SCENE EDITOR — arranging gradients and images into one stack, on the
 * DRAFT.
 *
 * This is the settings pane's old scene composer with its storage taken out.
 * The model and the compiler have not moved: lib/scene-composer.ts still owns
 * layers, clamping and the `background-image` lists, and composeScene is still
 * the only thing that turns a stack into CSS. What changed is where the result
 * goes — `sceneBackdrop` folds the composed lists, the stack and its images
 * into one self-contained LookBackdrop, and that value is handed up. Nothing
 * here writes SCENE_KEY, SCENE_IMAGES_KEY or the backdrop store; a scene only
 * reaches storage when the whole draft is applied.
 *
 * THE STACK IS HELD LOCALLY ANYWAY, for one reason: an EMPTY stack is a real
 * state of this editor and not a paintable value. composeScene refuses it (as
 * it must — an empty declaration paints nothing), so emptying the stack to
 * start over keeps the edit here and leaves the draft's backdrop standing
 * until there is something to replace it with. Every stack that DOES compose
 * is handed up immediately. The local copy is resynced whenever a scene
 * arrives from outside — an undo, a Look opened from the shelf — so it can
 * never drift from what is painted.
 *
 * ONE EXCEPTION TO "EVERY CHANGE IS COMMITTED": AN IMAGE'S OPACITY LANDS ON
 * RELEASE. It is the one control that cannot be a CSS value — it is baked into
 * the layer's pixels (see the lib header) — and re-encoding a megapixel WebP
 * per pointer sample would turn the drag into a slideshow. The number tracks
 * the thumb live; the picture updates when you let go. A GRADIENT's opacity is
 * only string surgery, so that slider is live like every other.
 *
 * REORDERING IS ARRAY ORDER. `layers[0]` paints on top (CSS's own rule), so
 * "up" is towards index 0 and the list reads top-of-the-stack first, like a
 * layers palette anywhere else. Rows are addressed BY POSITION rather than by
 * id, because gradient layers have no id to address them with.
 *
 * THE BASE GRID AT THE BOTTOM writes (or removes) the bottom-most gradient
 * layer, and its first tile is None. Choosing None leaves the stack ending in
 * transparency, which is the point inside a translucent window: the desktop
 * becomes the bottom layer.
 */

import { useCallback, useRef, useState } from "react";
import { ChevronDownIcon, ChevronUpIcon, ImagePlusIcon, LayersIcon, PaintbrushIcon, Trash2Icon, UploadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { backdropPresetById, BACKDROP_PRESETS } from "@/lib/backdrop-presets";
import { ImageBackdropError } from "@/lib/image-backdrop";
import type { LookBackdrop } from "@/lib/looks";
import {
  addSceneGradientLayer,
  addSceneLayer,
  bakeLayerOpacity,
  countSceneGradients,
  countSceneImages,
  forgetLayerImages,
  MAX_SCENE_GRADIENT_LAYERS,
  MAX_SCENE_LAYERS,
  moveSceneLayerAt,
  newLayerId,
  prepareSceneImage,
  removeSceneLayerAt,
  sceneBasePresetId,
  SCENE_LIMITS,
  setSceneBase,
  updateSceneLayerAt,
  type Scene,
  type SceneGradientLayer,
  type SceneImageLayer,
  type SceneLayerPatch,
} from "@/lib/scene-composer";
import { draftSceneStack, sceneBackdrop } from "@/lib/studio-draft";
import { PanelDivider } from "@/components/ui/panel";

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
    <label className="flex items-center gap-2 text-[0.6875rem]">
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

/** The swatch every gradient is shown as, here and in the grids: the light
 *  half with the dark one folded over its right side, so one tile says what
 *  the pair looks like. */
function PresetSwatch({ presetId }: { presetId: string }) {
  const preset = backdropPresetById(presetId);
  return (
    <span className="relative block size-full overflow-hidden rounded-md ring-1 ring-inset ring-foreground/10">
      <span className="absolute inset-0" style={{ backgroundImage: preset?.light, backgroundSize: "cover" }} />
      <span className="absolute inset-y-0 right-0 w-1/2" style={{ backgroundImage: preset?.dark, backgroundSize: "cover" }} />
    </span>
  );
}

/**
 * The preset chooser, used twice: once as the base ("and under everything,
 * this") where it offers None, and once inside Add gradient where it does
 * not — you cannot add a layer of nothing.
 */
function PresetGrid({ value, onPick, withNone = false }: { value: string | null; onPick: (presetId: string | null) => void; withNone?: boolean }) {
  return (
    <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-6">
      {withNone && (
        <button
          key="none"
          type="button"
          title="Nothing under the stack — the desktop or the theme's own canvas shows through"
          aria-pressed={value === null}
          onClick={() => onPick(null)}
          className={cn(
            "flex flex-col gap-1 rounded-lg p-1 text-left ring-1 ring-foreground/10 transition-colors hover:bg-accent/50",
            value === null && "ring-2 ring-primary",
          )}
        >
          <span
            className="relative block aspect-video w-full overflow-hidden rounded-md ring-1 ring-inset ring-foreground/10"
            // The chequerboard every editor uses for "there is nothing here".
            style={{
              backgroundImage:
                "linear-gradient(45deg, var(--muted) 25%, transparent 25%), linear-gradient(-45deg, var(--muted) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, var(--muted) 75%), linear-gradient(-45deg, transparent 75%, var(--muted) 75%)",
              backgroundSize: "8px 8px",
              backgroundPosition: "0 0, 0 4px, 4px -4px, -4px 0px",
            }}
          />
          <span className="truncate px-0.5 text-[0.625rem] font-medium">None</span>
        </button>
      )}
      {BACKDROP_PRESETS.map((preset) => (
        <button
          key={preset.id}
          type="button"
          title={preset.label}
          aria-pressed={value === preset.id}
          onClick={() => onPick(preset.id)}
          className={cn(
            "flex flex-col gap-1 rounded-lg p-1 text-left ring-1 ring-foreground/10 transition-colors hover:bg-accent/50",
            value === preset.id && "ring-2 ring-primary",
          )}
        >
          <span className="block aspect-video w-full">
            <PresetSwatch presetId={preset.id} />
          </span>
          <span className="truncate px-0.5 text-[0.625rem] font-medium">{preset.label}</span>
        </button>
      ))}
    </div>
  );
}

/** Reorder and remove, identical for both kinds of row — position in the
 *  stack is the one thing every layer has. */
function StackControls({ index, count, onMove, onRemove }: { index: number; count: number; onMove: (delta: number) => void; onRemove: () => void }) {
  return (
    <div className="flex items-center gap-0.5">
      <Button size="icon-sm" variant="ghost" disabled={index === 0} title="Bring forward" aria-label={`Bring layer ${index + 1} forward`} onClick={() => onMove(-1)}>
        <ChevronUpIcon />
      </Button>
      <Button size="icon-sm" variant="ghost" disabled={index === count - 1} title="Send back" aria-label={`Send layer ${index + 1} back`} onClick={() => onMove(1)}>
        <ChevronDownIcon />
      </Button>
      <Button size="icon-sm" variant="ghost" className="text-muted-foreground" title="Remove layer" aria-label={`Remove layer ${index + 1}`} onClick={onRemove}>
        <Trash2Icon />
      </Button>
    </div>
  );
}

/** A gradient row is an image row with everything that needs pixels taken
 *  out: it is full-bleed by definition, so there is no X, Y, size or tile —
 *  only how much of it you want to see. */
function GradientCard({
  layer,
  index,
  count,
  onPatch,
  onMove,
  onRemove,
}: {
  layer: SceneGradientLayer;
  index: number;
  count: number;
  onPatch: (patch: SceneLayerPatch) => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex gap-3 rounded-lg border border-border p-2.5">
      <span className="block size-14 shrink-0 self-start">
        <PresetSwatch presetId={layer.presetId} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-1">
        <span className="truncate text-[0.6875rem] font-medium">{backdropPresetById(layer.presetId)?.label ?? "Gradient"}</span>
        <LayerSlider label="Fade" value={layer.opacity} min={SCENE_LIMITS.opacity.min} max={SCENE_LIMITS.opacity.max} suffix="%" onChange={(opacity) => onPatch({ opacity })} />
        <span className="text-[0.625rem] text-muted-foreground">Fills the window; anything below shows through as it fades.</span>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <StackControls index={index} count={count} onMove={onMove} onRemove={onRemove} />
      </div>
    </div>
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
  layer: SceneImageLayer;
  image: string | undefined;
  index: number;
  count: number;
  onPatch: (patch: SceneLayerPatch) => void;
  onCommitOpacity: () => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex gap-3 rounded-lg border border-border p-2.5">
      {image ? (
        // eslint-disable-next-line @next/next/no-img-element -- a data URL held in the draft; there is nothing for next/image to fetch or optimise
        <img src={image} alt="" className="size-14 shrink-0 self-start rounded-md border border-border object-cover" />
      ) : (
        <span className="flex size-14 shrink-0 items-center justify-center self-start rounded-md border border-dashed border-border text-[0.625rem] text-muted-foreground">
          Missing
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <LayerSlider label="X" value={layer.x} min={SCENE_LIMITS.x.min} max={SCENE_LIMITS.x.max} suffix="%" onChange={(x) => onPatch({ x })} />
        <LayerSlider label="Y" value={layer.y} min={SCENE_LIMITS.y.min} max={SCENE_LIMITS.y.max} suffix="%" onChange={(y) => onPatch({ y })} />
        <LayerSlider label="Size" value={layer.scale} min={SCENE_LIMITS.scale.min} max={SCENE_LIMITS.scale.max} suffix="%" onChange={(scale) => onPatch({ scale })} />
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
        <StackControls index={index} count={count} onMove={onMove} onRemove={onRemove} />
        <Button
          size="sm"
          variant={layer.tiled ? "secondary" : "ghost"}
          aria-pressed={layer.tiled}
          className="text-[0.6875rem]"
          title="Repeat this layer across the whole window"
          onClick={() => onPatch({ tiled: !layer.tiled })}
        >
          {layer.tiled ? "Tiled" : "Tile"}
        </Button>
      </div>
    </div>
  );
}

/** The same controlled contract every editor in this tool takes — restated
 *  rather than imported from the shell, which imports this file. */
export function SceneEditor({ value, onChange }: { value: LookBackdrop; onChange: (next: LookBackdrop) => void }) {
  const fileInput = useRef<HTMLInputElement>(null);
  // The stack and its images move together — every write sets both — so they
  // are one piece of state and the editor can never show layers whose pictures
  // belong to a different arrangement.
  const [stack, setStack] = useState(() => draftSceneStack(value));
  const { scene, images } = stack;
  const [error, setError] = useState<string | false>(false);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [picking, setPicking] = useState(false);

  const live = value.kind === "scene" ? value : undefined;
  // A scene arriving from OUTSIDE (an undo, a Look opened from the shelf)
  // replaces the local copy; our own writes come back with the same identity
  // and are ignored, so a keystroke never round-trips into a reset.
  const [seenScene, setSeenScene] = useState<Scene | undefined>(live?.scene);
  if (seenScene !== live?.scene) {
    setSeenScene(live?.scene);
    if (live && live.scene !== scene) setStack({ scene: live.scene, images: live.images });
  }

  /** The one write path: keep the edit, then hand up a backdrop if the stack
   *  composes to one. Returns false when nothing was PAINTED — which an empty
   *  stack does not, though the arrangement is still kept here. */
  const apply = useCallback(
    (nextScene: Scene, nextImages: Record<string, string>): boolean => {
      setStack({ scene: nextScene, images: nextImages });
      const backdrop = sceneBackdrop(nextScene, nextImages);
      if (!backdrop) {
        setError(
          nextScene.layers.length === 0
            ? "This scene is empty — add a gradient or an image, or choose something under the stack."
            : "That scene could not be composed — one of its gradients is unknown.",
        );
        return false;
      }
      setError(false);
      onChange(backdrop);
      return true;
    },
    [onChange],
  );

  const accept = useCallback(
    async (files: FileList | File[] | undefined) => {
      const picked = files ? Array.from(files) : [];
      if (picked.length === 0) return;
      const room = MAX_SCENE_LAYERS - countSceneImages(scene);
      if (room <= 0) {
        setError(`A scene holds ${MAX_SCENE_LAYERS} images — remove one to add another.`);
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

  /** Position, size and tiling are pure CSS: write them straight through. So
   *  is a GRADIENT's opacity — only an image's needs the re-encode below. */
  const patchAt = useCallback(
    (index: number, changes: SceneLayerPatch) => {
      const next = updateSceneLayerAt(scene, index, changes);
      const image = scene.layers[index]?.type === "image";
      if (image && changes.opacity !== undefined && Object.keys(changes).length === 1) setStack({ scene: next, images });
      else apply(next, images);
    },
    [apply, images, scene],
  );

  const commitOpacity = useCallback(
    async (id: string) => {
      const layer = scene.layers.find((entry) => entry.type === "image" && entry.id === id);
      if (!layer) return;
      setBusy(true);
      const baked = await bakeLayerOpacity(images, id, layer.opacity);
      apply(scene, baked);
      setBusy(false);
    },
    [apply, images, scene],
  );

  const addGradient = useCallback(
    (presetId: string | null) => {
      setPicking(false);
      if (presetId === null) return;
      const next = addSceneGradientLayer(scene, presetId);
      if (next === scene) setError(`A scene holds ${MAX_SCENE_GRADIENT_LAYERS} gradients — remove one to add another.`);
      else apply(next, images);
    },
    [apply, images, scene],
  );

  const layerCount = scene.layers.length;
  const imageCount = countSceneImages(scene);
  const gradientCount = countSceneGradients(scene);
  const baseId = sceneBasePresetId(scene);

  return (
    <>
      {/* A TOOLBAR, NOT A ROW. `Row` puts its label in a flexible column and
          its control in a fixed one — hand it three buttons and the label
          collapses to a ribbon of one word per line. What the stack is gets
          said by the stack; the counters say how much room is left. */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <span className="flex items-center gap-1.5 font-mono text-[0.625rem] tracking-[0.08em] text-muted-foreground uppercase">
          <LayersIcon className="size-3.5" />
          Layers
          <span className="text-muted-foreground/60 tabular-nums">{layerCount}</span>
        </span>
        <div className="ml-auto flex items-center gap-2">
          {!live && layerCount > 0 && (
            <Button size="sm" variant="outline" onClick={() => apply(scene, images)}>
              Use this scene
            </Button>
          )}
          <Button
            size="sm"
            variant={picking ? "secondary" : "outline"}
            aria-expanded={picking}
            title={`Up to ${MAX_SCENE_GRADIENT_LAYERS} gradients — ${gradientCount} used`}
            disabled={busy || gradientCount >= MAX_SCENE_GRADIENT_LAYERS}
            onClick={() => setPicking((open) => !open)}
          >
            <PaintbrushIcon /> Gradient
          </Button>
          <Button
            size="sm"
            variant="outline"
            title={`Up to ${MAX_SCENE_LAYERS} images — ${imageCount} used`}
            disabled={busy || imageCount >= MAX_SCENE_LAYERS}
            onClick={() => fileInput.current?.click()}
          >
            <UploadIcon /> Image…
          </Button>
        </div>
      </div>
      {(error || busy) && <p className={cn("px-3 pt-2 text-xs", error ? "text-warning" : "text-muted-foreground")}>{error || "Working…"}</p>}
      {picking && (
        <div className="px-3 pb-1">
          {/* The same grid the base uses, minus None: adding a layer of
              nothing is what NOT adding a layer already is. */}
          <PresetGrid value={null} onPick={addGradient} />
        </div>
      )}
      <div className="flex flex-col gap-2 p-3">
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
        {scene.layers.map((layer, index) =>
          layer.type === "gradient" ? (
            <GradientCard
              // Gradient layers have no id, so position is the key — and the
              // preset is in it so swapping one re-mounts rather than animating
              // a slider from someone else's value.
              key={`gradient-${index}-${layer.presetId}`}
              layer={layer}
              index={index}
              count={layerCount}
              onPatch={(changes) => patchAt(index, changes)}
              onMove={(delta) => apply(moveSceneLayerAt(scene, index, delta), images)}
              onRemove={() => apply(removeSceneLayerAt(scene, index), images)}
            />
          ) : (
            <LayerCard
              key={layer.id}
              layer={layer}
              image={images[`orig:${layer.id}`] ?? images[layer.id]}
              index={index}
              count={layerCount}
              onPatch={(changes) => patchAt(index, changes)}
              onCommitOpacity={() => void commitOpacity(layer.id)}
              onMove={(delta) => apply(moveSceneLayerAt(scene, index, delta), images)}
              onRemove={() => apply(removeSceneLayerAt(scene, index), forgetLayerImages(images, layer.id))}
            />
          ),
        )}
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
          {busy ? "Working…" : imageCount >= MAX_SCENE_LAYERS ? "The stack is full — remove an image to add another." : "Drop images here to add layers."}
        </div>
      </div>
      <PanelDivider label="Under everything" />
      <div className="px-3 pb-3">
        <PresetGrid value={baseId} withNone onPick={(presetId) => apply(setSceneBase(scene, presetId), images)} />
      </div>
    </>
  );
}
