"use client";

import { useCallback, useRef, useState } from "react";
import { ImagePlusIcon, LayersIcon, PaintbrushIcon, UploadIcon } from "lucide-react";
import { Button } from "@/ui/button";
import { cn } from "@/ui/utils";
import { DEFAULT_GRADIENT_SPECS } from "../../gradient-starters";
import type { CompositionMode } from "../../composition";
import { ImageBackdropError } from "../../image-backdrop";
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
  setGradientSpec,
  updateSceneLayerAt,
} from "../../scene-composer";
import type { SceneLayer } from "@telar/engine-client";
import { GradientStops } from "./gradient-stops";
import { GradientCard, LayerCard } from "./layer-cards";

function messageFor(error: unknown): string {
  if (error instanceof ImageBackdropError) return error.message;
  return "That image could not be used.";
}

type LayerWriter = (layers: SceneLayer[], images: Record<string, string>) => void;

function useImageImport(layers: readonly SceneLayer[], images: Record<string, string>, onChange: LayerWriter) {
  const [error, setError] = useState<string | false>(false);
  const [busy, setBusy] = useState(false);
  const accept = useCallback(
    async (files: FileList | File[] | undefined) => {
      const scene = { layers: [...layers] };
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
    [images, layers, onChange],
  );
  return { error, setError, busy, setBusy, accept };
}

function LayerDropZone({ busy, full, empty, onFiles }: { busy: boolean; full: boolean; empty: boolean; onFiles: (files: FileList) => void }) {
  const [dragging, setDragging] = useState(false);
  return (
    <div
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        onFiles(event.dataTransfer.files);
      }}
      className={cn(
        "flex items-center justify-center gap-2 rounded-lg border border-dashed p-3 text-xs text-muted-foreground transition-colors",
        dragging ? "border-primary bg-primary/5" : "border-border",
      )}
    >
      <ImagePlusIcon className="size-4 shrink-0" />
      {busy
        ? "Working…"
        : full
          ? "The stack is full — remove an image to add another."
          : empty
            ? "Nothing over the base. Add a gradient or drop an image here."
            : "Drop images here to add layers."}
    </div>
  );
}

function LayerStackToolbar({
  count,
  busy,
  imageCount,
  gradientCount,
  onGradient,
  onImage,
}: {
  count: number;
  busy: boolean;
  imageCount: number;
  gradientCount: number;
  onGradient: () => void;
  onImage: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border py-2">
      <span className="flex items-center gap-1.5 font-mono text-3xs tracking-[0.08em] text-muted-foreground uppercase">
        <LayersIcon className="size-3.5" />
        Layers
        <span className="text-muted-foreground/60 tabular-nums">{count}</span>
      </span>
      <div className="ml-auto flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          title={`Up to ${MAX_SCENE_GRADIENT_LAYERS} gradients — ${gradientCount} used`}
          disabled={busy || gradientCount >= MAX_SCENE_GRADIENT_LAYERS}
          onClick={onGradient}
        >
          <PaintbrushIcon /> Gradient
        </Button>
        <Button
          size="sm"
          variant="outline"
          title={`Up to ${MAX_SCENE_LAYERS} images — ${imageCount} used`}
          disabled={busy || imageCount >= MAX_SCENE_LAYERS}
          onClick={onImage}
        >
          <UploadIcon /> Image…
        </Button>
      </div>
    </div>
  );
}

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
  colours: { light: string; dark: string; accent: string };
  onChange: (layers: SceneLayer[], images: Record<string, string>) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const { error, setError, busy, setBusy, accept } = useImageImport(layers, images, onChange);
  const [open, setOpen] = useState<OpenEditor>(null);
  const [pendingOpacity, setPendingOpacity] = useState<{ index: number; value: number } | null>(null);

  const scene = { layers: [...layers] };
  const write = useCallback(
    (nextLayers: SceneLayer[], nextImages: Record<string, string> = images) => {
      setError(false);
      onChange(nextLayers, nextImages);
    },
    [images, onChange, setError],
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
      <LayerStackToolbar
        count={count}
        busy={busy}
        imageCount={imageCount}
        gradientCount={gradientCount}
        onGradient={() => {
          const next = addSceneGradientLayer(scene, DEFAULT_GRADIENT_SPECS[mode]);
          if (next.layers.length === count) {
            setError(`A state holds ${MAX_SCENE_GRADIENT_LAYERS} gradients — remove one to add another.`);
            return;
          }
          write(next.layers);
          setOpen({ kind: "row", index: 0 });
        }}
        onImage={() => fileInput.current?.click()}
      />
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
        <LayerDropZone busy={busy} full={imageCount >= MAX_SCENE_LAYERS} empty={count === 0} onFiles={(files) => void accept(files)} />
      </div>
    </>
  );
}
