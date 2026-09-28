"use client";

import { ChevronDownIcon, ChevronUpIcon, PencilIcon, Trash2Icon } from "lucide-react";
import type { SceneGradientLayer, SceneImageLayer } from "@telar/engine-client";
import { Button } from "@/ui/button";
import { composeGradient } from "../../gradient-starters";
import { SCENE_LIMITS, type SceneLayerPatch } from "../../scene-composer";

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

function GradientSwatch({ css }: { css: string | undefined }) {
  return (
    <span
      className="block size-full overflow-hidden rounded-md ring-1 ring-inset ring-foreground/10"
      style={{ backgroundImage: css, backgroundSize: "cover" }}
    />
  );
}

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

export function GradientCard({
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

export function LayerCard({
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
