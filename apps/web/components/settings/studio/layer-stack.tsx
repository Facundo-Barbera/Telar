"use client";

/**
 * THE LAYERS — one colour state's stack, over its base.
 *
 * WHAT THIS REPLACED (#471). There was a BACKDROP TOOL with a four-way mode
 * picker: None, Gradient, Image, Compose. Three of those four were the fourth
 * one with a hole in it — a gradient backdrop is a one-gradient stack, an image
 * backdrop is a one-image stack, and None is an empty stack — and the mode
 * picker's real job was deciding which of four incompatible shapes the store
 * would hold. "Gradients and images are layer types, not modes." So there is
 * one editor, layers are added by kind, and "None" is what an empty list
 * already looks like.
 *
 * IT EDITS ONE STATE, AND THE PANE'S LIGHT/DARK SWITCH SAYS WHICH. The two
 * states have genuinely separate stacks — that is what a composition is — so
 * there is no pair to keep in step here and no second half picker. A gradient
 * layer carries the stops it was built from (#471), which belong to this state
 * and no other; `mode` survives only so a starter chip fills from the half that
 * suits the state you are looking at.
 *
 * NOTHING IS HELD LOCALLY BUT THE EXPENSIVE ONE. Every edit writes the
 * composition, which repaints the window — there is no draft and nothing to
 * apply. The exception is an IMAGE's opacity, which is baked into the layer's
 * pixels (see lib/scene-composer.ts) and cannot be a CSS value: re-encoding a
 * megapixel WebP per pointer sample would turn the drag into a slideshow, so
 * the number tracks the thumb live and the picture lands when you let go.
 *
 * REORDERING IS ARRAY ORDER. `layers[0]` paints on top (CSS's own rule), so
 * "up" is towards index 0 and the list reads top-of-the-stack first, like a
 * layers palette anywhere else. Rows are addressed BY POSITION rather than by
 * id, because gradient layers have no id to address them with.
 */

import { useCallback, useRef, useState } from "react";
import { ChevronDownIcon, ChevronUpIcon, ImagePlusIcon, LayersIcon, PaintbrushIcon, PencilIcon, Trash2Icon, UploadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { composeGradient, DEFAULT_GRADIENT_SPECS } from "@/lib/gradient-starters";
import type { CompositionMode } from "@/lib/composition";
import { ImageBackdropError } from "@/lib/image-backdrop";
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
  SCENE_LIMITS,
  setGradientSpec,
  updateSceneLayerAt,
  type SceneLayerPatch,
} from "@/lib/scene-composer";
import type { SceneGradientLayer, SceneImageLayer, SceneLayer } from "@telar/engine-client";
import { GradientStops } from "./gradient-stops";

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
    <label className="flex items-center gap-2 text-2xs">
      <span className="w-10 shrink-0 text-muted-foreground">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        // Release, not change: some values are expensive to land (an image's
        // opacity is a re-encode). Rows without an onCommit never use these.
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

/** A gradient as a swatch. ONE HALF, because a layer belongs to one state now
 *  — the tile used to be seamed down the middle to show a pair, and there is no
 *  pair here to show. */
function GradientSwatch({ css }: { css: string | undefined }) {
  return (
    <span
      className="block size-full overflow-hidden rounded-md ring-1 ring-inset ring-foreground/10"
      style={{ backgroundImage: css, backgroundSize: "cover" }}
    />
  );
}

/** Reorder and remove, identical for every kind of row — position in the
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
 *  only how much of it you want to see. The name says what the gradient IS
 *  (#471) rather than which preset it came from, because it no longer came
 *  from one: its stops are its own. */
function GradientCard({
  layer,
  index,
  count,
  onPatch,
  onMove,
  onRemove,
  onOpen,
  open,
}: {
  layer: SceneGradientLayer;
  index: number;
  count: number;
  onPatch: (patch: SceneLayerPatch) => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
  onOpen: () => void;
  open: boolean;
}) {
  const stops = layer.spec.stops.length;
  return (
    <div className="flex gap-3 rounded-lg border border-border p-2.5">
      <span className="block size-14 shrink-0 self-start">
        <GradientSwatch css={composeGradient(layer.spec)} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-1">
        <span className="truncate text-2xs font-medium">
          {layer.spec.type === "radial" ? "Radial" : "Linear"} gradient
          <span className="ml-1.5 font-normal text-muted-foreground">
            {stops} stops{layer.spec.type === "linear" ? ` · ${layer.spec.angle}°` : ""}
          </span>
        </span>
        <LayerSlider label="Fade" value={layer.opacity} min={SCENE_LIMITS.opacity.min} max={SCENE_LIMITS.opacity.max} suffix="%" onChange={(opacity) => onPatch({ opacity })} />
        <span className="text-3xs text-muted-foreground">Fills the window; anything below shows through as it fades.</span>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <StackControls index={index} count={count} onMove={onMove} onRemove={onRemove} />
        <Button size="sm" variant={open ? "secondary" : "ghost"} aria-expanded={open} className="text-2xs" title="Edit the stops" onClick={onOpen}>
          <PencilIcon /> Edit
        </Button>
      </div>
    </div>
  );
}

function LayerCard({
  layer,
  image,
  index,
  count,
  opacity,
  onPatch,
  onOpacity,
  onCommitOpacity,
  onMove,
  onRemove,
}: {
  layer: SceneImageLayer;
  image: string | undefined;
  index: number;
  count: number;
  /** What the thumb is showing — the stored value except mid-drag. */
  opacity: number;
  onPatch: (patch: SceneLayerPatch) => void;
  onOpacity: (value: number) => void;
  onCommitOpacity: () => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex gap-3 rounded-lg border border-border p-2.5">
      {image ? (
        // eslint-disable-next-line @next/next/no-img-element -- a data URL held in the composition; there is nothing for next/image to fetch or optimise
        <img src={image} alt="" className="size-14 shrink-0 self-start rounded-md border border-border object-cover" />
      ) : (
        <span className="flex size-14 shrink-0 items-center justify-center self-start rounded-md border border-dashed border-border text-3xs text-muted-foreground">
          Missing
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <LayerSlider label="X" value={layer.x} min={SCENE_LIMITS.x.min} max={SCENE_LIMITS.x.max} suffix="%" onChange={(x) => onPatch({ x })} />
        <LayerSlider label="Y" value={layer.y} min={SCENE_LIMITS.y.min} max={SCENE_LIMITS.y.max} suffix="%" onChange={(y) => onPatch({ y })} />
        <LayerSlider label="Size" value={layer.scale} min={SCENE_LIMITS.scale.min} max={SCENE_LIMITS.scale.max} suffix="%" onChange={(scale) => onPatch({ scale })} />
        <LayerSlider
          label="Fade"
          value={opacity}
          min={SCENE_LIMITS.opacity.min}
          max={SCENE_LIMITS.opacity.max}
          suffix="%"
          onChange={onOpacity}
          onCommit={onCommitOpacity}
        />
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <StackControls index={index} count={count} onMove={onMove} onRemove={onRemove} />
        <Button
          size="sm"
          variant={layer.tiled ? "secondary" : "ghost"}
          aria-pressed={layer.tiled}
          className="text-2xs"
          title="Repeat this layer across the whole window"
          onClick={() => onPatch({ tiled: !layer.tiled })}
        >
          {layer.tiled ? "Tiled" : "Tile"}
        </Button>
      </div>
    </div>
  );
}

/** Which row has its stop editor open, if any. There is no longer an "adding"
 *  state: adding a gradient IS adding a layer and opening its editor, because
 *  there is nothing to choose between first. */
type OpenEditor = { kind: "row"; index: number } | null;

export function LayerStack({
  layers,
  images,
  mode,
  colours,
  onChange,
}: {
  layers: readonly SceneLayer[];
  images: Record<string, string>;
  mode: CompositionMode;
  /** Forwarded to the stop editor, which offers them as stop colours: the base
   *  of each state and the accent. The stack itself has no use for them — it is
   *  the pane that knows the composition, and a gradient row is where they are
   *  needed. */
  colours: { light: string; dark: string; accent: string };
  /** Both together, always: a layer and the picture it names move as one, so
   *  the composition can never hold a stack whose images belong to another
   *  arrangement. */
  onChange: (layers: SceneLayer[], images: Record<string, string>) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | false>(false);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [open, setOpen] = useState<OpenEditor>(null);
  /** The one value that does not land as you drag it — see the header. */
  const [pendingOpacity, setPendingOpacity] = useState<{ index: number; value: number } | null>(null);

  const scene = { layers: [...layers] };
  const write = useCallback(
    (nextLayers: SceneLayer[], nextImages: Record<string, string> = images) => {
      setError(false);
      onChange(nextLayers, nextImages);
    },
    [images, onChange],
  );

  const accept = useCallback(
    async (files: FileList | File[] | undefined) => {
      const picked = files ? Array.from(files) : [];
      if (picked.length === 0) return;
      const room = MAX_SCENE_LAYERS - countSceneImages(scene);
      if (room <= 0) {
        setError(`A state holds ${MAX_SCENE_LAYERS} images — remove one to add another.`);
        return;
      }
      setBusy(true);
      setError(false);
      let next = scene;
      let nextImages = images;
      let failure: string | false = false;
      for (const file of picked.slice(0, room)) {
        try {
          const dataUrl = await prepareSceneImage(file);
          const id = newLayerId();
          next = addSceneLayer(next, id);
          // Both keys at once: the baked copy that paints, and the original the
          // opacity slider always re-derives from.
          nextImages = { ...nextImages, [id]: dataUrl, [`orig:${id}`]: dataUrl };
        } catch (thrown) {
          failure = messageFor(thrown);
        }
      }
      if (next.layers.length !== layers.length) onChange(next.layers, nextImages);
      if (failure) setError(failure);
      else if (picked.length > room) setError(`Only ${room} more layer${room === 1 ? "" : "s"} would fit — the rest were left out.`);
      setBusy(false);
    },
    // `scene` is rebuilt on every render from `layers`; the deps that matter
    // are the array and the map it names.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [images, layers, onChange],
  );

  const commitOpacity = useCallback(
    async (index: number, id: string) => {
      const value = pendingOpacity?.index === index ? pendingOpacity.value : undefined;
      setPendingOpacity(null);
      if (value === undefined) return;
      setBusy(true);
      const next = updateSceneLayerAt(scene, index, { opacity: value });
      const baked = await bakeLayerOpacity(images, id, value);
      onChange(next.layers, baked);
      setBusy(false);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [images, layers, onChange, pendingOpacity],
  );

  const imageCount = countSceneImages(scene);
  const gradientCount = countSceneGradients(scene);
  const count = layers.length;

  return (
    <>
      {/* A TOOLBAR, NOT A ROW. `Row` puts its label in a flexible column and
          its control in a fixed one — hand it three buttons and the label
          collapses to a ribbon of one word per line. What the stack is gets
          said by the stack; the counters say how much room is left. */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border py-2">
        <span className="flex items-center gap-1.5 font-mono text-3xs tracking-[0.08em] text-muted-foreground uppercase">
          <LayersIcon className="size-3.5" />
          Layers
          <span className="text-muted-foreground/60 tabular-nums">{count}</span>
        </span>
        <div className="ml-auto flex items-center gap-2">
          {/* ONE BUTTON, NOT TWO (#471). There used to be "Gradient" (open a
              grid of eleven, pick one) beside "Custom" (build your own) —
              which asked a reader to decide, before they had seen anything,
              whether they were the sort of person who edits gradients. Adding
              one now adds a layer and opens its stops; the presets are chips
              inside that editor. */}
          <Button
            size="sm"
            variant="outline"
            title={`Up to ${MAX_SCENE_GRADIENT_LAYERS} gradients — ${gradientCount} used`}
            disabled={busy || gradientCount >= MAX_SCENE_GRADIENT_LAYERS}
            onClick={() => {
              const next = addSceneGradientLayer(scene, DEFAULT_GRADIENT_SPECS[mode]);
              if (next.layers.length === count) {
                setError(`A state holds ${MAX_SCENE_GRADIENT_LAYERS} gradients — remove one to add another.`);
                return;
              }
              write(next.layers);
              // It landed on top, so its row is index 0 — and it opens, because
              // a gradient nobody has authored yet is the default one.
              setOpen({ kind: "row", index: 0 });
            }}
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
      {(error || busy) && <p className={cn("pt-2 text-xs", error ? "text-warning" : "text-muted-foreground")}>{error || "Working…"}</p>}
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
        {layers.map((layer, index) => {
          const rowOpen = open?.kind === "row" && open.index === index;
          const controls = {
            index,
            count,
            onMove: (delta: number) => {
              setOpen(null);
              write(moveSceneLayerAt(scene, index, delta).layers);
            },
          };
          if (layer.type === "image") {
            const showing = pendingOpacity?.index === index ? pendingOpacity.value : layer.opacity;
            return (
              <LayerCard
                key={layer.id}
                layer={layer}
                image={images[`orig:${layer.id}`] ?? images[layer.id]}
                opacity={showing}
                {...controls}
                onPatch={(patch) => write(updateSceneLayerAt(scene, index, patch).layers)}
                onOpacity={(value) => setPendingOpacity({ index, value })}
                onCommitOpacity={() => void commitOpacity(index, layer.id)}
                onRemove={() => write(removeSceneLayerAt(scene, index).layers, forgetLayerImages(images, layer.id))}
              />
            );
          }
          return (
            // Gradient layers have no id, so position is the key.
            <div key={`gradient-${index}`} className="flex flex-col gap-1.5">
              <GradientCard
                layer={layer}
                {...controls}
                open={rowOpen}
                onOpen={() => setOpen(rowOpen ? null : { kind: "row", index })}
                onPatch={(patch) => write(updateSceneLayerAt(scene, index, patch).layers)}
                onRemove={() => {
                  setOpen(null);
                  write(removeSceneLayerAt(scene, index).layers);
                }}
              />
              {rowOpen && (
                <GradientStops
                  spec={layer.spec}
                  mode={mode}
                  colours={colours}
                  onChange={(spec) => write(setGradientSpec(scene, index, spec).layers)}
                  onClose={() => setOpen(null)}
                />
              )}
            </div>
          );
        })}
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
          {busy
            ? "Working…"
            : imageCount >= MAX_SCENE_LAYERS
              ? "The stack is full — remove an image to add another."
              : count === 0
                ? "Nothing over the base. Add a gradient or drop an image here."
                : "Drop images here to add layers."}
        </div>
      </div>
    </>
  );
}
