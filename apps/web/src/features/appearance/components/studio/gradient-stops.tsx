"use client";

import { useRef, useState, useSyncExternalStore } from "react";
import { MinusIcon, PipetteIcon, PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { normaliseColourText } from "../../colour-field";
import {
  colourChips,
  recentColoursSnapshot,
  rememberStopColour,
  serverRecentColoursSnapshot,
  subscribeRecentColours,
  type ColourChip,
} from "../../recent-colours";
import {
  composeGradient,
  GRADIENT_LIMITS,
  GRADIENT_STARTERS,
  MAX_GRADIENT_STOPS,
  MIN_GRADIENT_STOPS,
  type CustomGradientSpec,
  type GradientStop,
  type GradientType,
} from "../../gradient-starters";
import type { CompositionMode } from "../../composition";
import { Segmented } from "@/components/settings/settings-shell";
import { HexField } from "./hex-field";

type EyeDropperApi = { open: (options?: { signal?: AbortSignal }) => Promise<{ sRGBHex: string }> };
declare global {
  interface Window {
    EyeDropper?: new () => EyeDropperApi;
  }
}

const subscribeToNothing = () => () => {};
const eyeDropperIsPresent = () => typeof window !== "undefined" && "EyeDropper" in window;
const noEyeDropperOnTheServer = () => false;

function clamp(value: number, range: { min: number; max: number }): number {
  return Math.min(range.max, Math.max(range.min, Math.round(value)));
}

function sortedForDisplay(stops: readonly GradientStop[]): { stop: GradientStop; index: number }[] {
  return stops.map((stop, index) => ({ stop, index })).sort((a, b) => a.stop.position - b.stop.position);
}

function StopStrip({
  spec,
  selected,
  onSelect,
  onChange,
}: {
  spec: CustomGradientSpec;
  selected: number;
  onSelect: (index: number) => void;
  onChange: (next: CustomGradientSpec) => void;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<number | null>(null);

  const positionAt = (clientX: number): number => {
    const box = strip.current?.getBoundingClientRect();
    if (!box || box.width === 0) return 0;
    return clamp(((clientX - box.left) / box.width) * 100, GRADIENT_LIMITS.position);
  };

  const moveStop = (index: number, position: number) => {
    onChange({ ...spec, stops: spec.stops.map((stop, at) => (at === index ? { ...stop, position } : stop)) });
  };

  const addStopAt = (position: number) => {
    if (spec.stops.length >= MAX_GRADIENT_STOPS) return;
    const nearest = spec.stops.reduce((best, stop) =>
      Math.abs(stop.position - position) < Math.abs(best.position - position) ? stop : best,
    );
    onChange({ ...spec, stops: [...spec.stops, { ...nearest, position }] });
    onSelect(spec.stops.length);
  };

  return (
    <div
      ref={strip}
      className="relative h-9 w-full cursor-copy rounded-lg ring-1 ring-inset ring-foreground/10"
      style={{ backgroundImage: composeGradient({ ...spec, type: "linear", angle: 90 }) }}
      title="Click to add a stop; drag a handle to move one"
      onPointerDown={(event) => {
        if (event.target !== event.currentTarget) return;
        addStopAt(positionAt(event.clientX));
      }}
      onPointerMove={(event) => {
        if (dragging === null) return;
        moveStop(dragging, positionAt(event.clientX));
      }}
      onPointerUp={() => setDragging(null)}
      onPointerCancel={() => setDragging(null)}
    >
      {sortedForDisplay(spec.stops).map(({ stop, index }) => (
        <button
          key={index}
          type="button"
          aria-label={`Stop ${index + 1}, at ${stop.position}%`}
          aria-pressed={selected === index}
          className={cn(
            "absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded-full border-2 border-background shadow-1 ring-1 ring-foreground/30",
            selected === index && "ring-2 ring-primary",
          )}
          style={{ left: `${stop.position}%`, background: stop.color }}
          onPointerDown={(event) => {
            event.stopPropagation();
            event.currentTarget.setPointerCapture?.(event.pointerId);
            onSelect(index);
            setDragging(index);
          }}
          onPointerUp={() => setDragging(null)}
          onPointerMove={(event) => {
            if (dragging !== index) return;
            moveStop(index, positionAt(event.clientX));
          }}
          onKeyDown={(event) => {
            const step = event.shiftKey ? 10 : 1;
            if (event.key === "ArrowLeft") {
              event.preventDefault();
              moveStop(index, clamp(stop.position - step, GRADIENT_LIMITS.position));
            }
            if (event.key === "ArrowRight") {
              event.preventDefault();
              moveStop(index, clamp(stop.position + step, GRADIENT_LIMITS.position));
            }
          }}
          onClick={() => onSelect(index)}
        />
      ))}
    </div>
  );
}

function StopColours({
  stops,
  selected,
  onSelect,
  onColour,
  onSettle,
}: {
  stops: readonly GradientStop[];
  selected: number;
  onSelect: (index: number) => void;
  onColour: (index: number, colour: string) => void;
  onSettle: (colour: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {sortedForDisplay(stops).map(({ stop, index }) => (
        <span
          key={index}
          className={cn("flex items-center gap-1 rounded-md p-0.5 pr-1.5 ring-1 ring-foreground/10", selected === index && "ring-2 ring-primary")}
        >
          <input
            type="color"
            value={/^#[0-9a-fA-F]{6}$/.test(stop.color) ? stop.color : "#000000"}
            onChange={(event) => {
              onSelect(index);
              onColour(index, event.target.value);
            }}
            onFocus={() => onSelect(index)}
            onBlur={(event) => onSettle(event.target.value)}
            aria-label={`Stop ${index + 1} colour`}
            className="size-5 shrink-0 cursor-pointer rounded border border-border bg-transparent p-0"
          />
          <code className="font-mono text-3xs text-muted-foreground/70">{stop.position}%</code>
        </span>
      ))}
    </div>
  );
}

function RecentColours({ chips, onPick }: { chips: readonly ColourChip[]; onPick: (colour: string) => void }) {
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Colours already in play">
      {chips.map((chip) => (
        <button
          key={`${chip.label}-${chip.color}`}
          type="button"
          title={`Use ${chip.label === chip.color ? chip.color : `${chip.label} (${chip.color})`}`}
          aria-label={`Use ${chip.label}`}
          onClick={() => onPick(chip.color)}
          className="size-4 shrink-0 rounded-full ring-1 ring-inset ring-foreground/20 transition-transform hover:scale-110"
          style={{ background: chip.color }}
        />
      ))}
    </div>
  );
}

function StopColourField({
  colour,
  onColour,
  onSettle,
}: {
  colour: string;
  onColour: (colour: string) => void;
  onSettle: (colour: string) => void;
}) {
  const hasEyeDropper = useSyncExternalStore(subscribeToNothing, eyeDropperIsPresent, noEyeDropperOnTheServer);

  const hex = normaliseColourText(colour) ?? "#000000";
  const pick = async () => {
    const EyeDropper = window.EyeDropper;
    if (!EyeDropper) return;
    try {
      const picked = normaliseColourText((await new EyeDropper().open()).sRGBHex);
      if (picked) {
        onColour(picked);
        onSettle(picked);
      }
    } catch {
    }
  };

  return (
    <div className="flex items-center gap-2 text-2xs" onBlur={() => onSettle(colour)}>
      <span className="w-10 shrink-0 text-muted-foreground">Colour</span>
      <input
        type="color"
        value={hex}
        aria-label="Selected stop colour"
        onChange={(event) => onColour(event.target.value)}
        className="size-7 shrink-0 cursor-pointer rounded border border-border bg-transparent p-0"
      />
      <HexField value={hex} label="Selected stop" live className="min-w-0 flex-1" onCommit={onColour} />
      {hasEyeDropper && (
        <Button size="icon-sm" variant="ghost" className="shrink-0 text-muted-foreground" title="Pick a colour from the screen" aria-label="Pick a colour from the screen" onClick={() => void pick()}>
          <PipetteIcon />
        </Button>
      )}
    </div>
  );
}

function StopControls({
  stop,
  index,
  removable,
  chips,
  onChange,
  onColour,
  onSettle,
  onRemove,
}: {
  stop: GradientStop;
  index: number;
  removable: boolean;
  chips: readonly ColourChip[];
  onChange: (next: GradientStop) => void;
  onColour: (colour: string) => void;
  onSettle: (colour: string) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-muted/40 p-2.5">
      <div className="flex items-center gap-2 text-2xs">
        <span className="min-w-0 flex-1 text-muted-foreground">Stop {index + 1}</span>
        <Button size="icon-sm" variant="ghost" disabled={!removable} title="Remove this stop" aria-label={`Remove stop ${index + 1}`} onClick={onRemove}>
          <MinusIcon />
        </Button>
      </div>
      <StopColourField colour={stop.color} onColour={onColour} onSettle={onSettle} />
      <div className="flex pl-12">
        <RecentColours
          chips={chips}
          onPick={(colour) => {
            onColour(colour);
            onSettle(colour);
          }}
        />
      </div>
      <label className="flex items-center gap-2 text-2xs">
        <span className="w-10 shrink-0 text-muted-foreground">At</span>
        <input
          type="range"
          min={GRADIENT_LIMITS.position.min}
          max={GRADIENT_LIMITS.position.max}
          value={stop.position}
          onChange={(event) => onChange({ ...stop, position: Number(event.target.value) })}
          className="min-w-0 flex-1 accent-primary"
          aria-label={`Stop ${index + 1} position`}
        />
        <span className="w-9 shrink-0 text-right tabular-nums text-muted-foreground">{stop.position}%</span>
      </label>
      <label className="flex items-center gap-2 text-2xs">
        <span className="w-10 shrink-0 text-muted-foreground">Fade</span>
        <input
          type="range"
          min={GRADIENT_LIMITS.opacity.min}
          max={GRADIENT_LIMITS.opacity.max}
          value={stop.opacity}
          onChange={(event) => onChange({ ...stop, opacity: Number(event.target.value) })}
          className="min-w-0 flex-1 accent-primary"
          aria-label={`Stop ${index + 1} opacity`}
        />
        <span className="w-9 shrink-0 text-right tabular-nums text-muted-foreground">{stop.opacity}%</span>
      </label>
    </div>
  );
}

export function GradientStops({
  spec,
  mode,
  colours,
  onChange,
  onClose,
}: {
  spec: CustomGradientSpec;
  mode: CompositionMode;
  colours: { light: string; dark: string; accent: string };
  onChange: (next: CustomGradientSpec) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState(0);
  const patch = (changes: Partial<CustomGradientSpec>) => onChange({ ...spec, ...changes });
  const at = Math.min(selected, spec.stops.length - 1);
  const stop = spec.stops[at];

  const recent = useSyncExternalStore(subscribeRecentColours, recentColoursSnapshot, serverRecentColoursSnapshot);
  const chips = colourChips({ ...colours, recent });

  const setColour = (index: number, colour: string) => {
    patch({ stops: spec.stops.map((entry, position) => (position === index ? { ...entry, color: colour } : entry)) });
  };

  const settle = (colour: string) => rememberStopColour(colour);

  return (
    <div className="rounded-xl bg-card ring-1 ring-foreground/10">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <span className="text-xs font-medium">This gradient</span>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={onClose}>
          Done
        </Button>
      </div>
      <div className="flex flex-col gap-3 px-4 py-3">
        <div className="flex flex-col gap-1.5">
          <span className="font-mono text-3xs tracking-[0.08em] text-muted-foreground uppercase">Start from</span>
          <div className="flex flex-wrap gap-1.5">
            {GRADIENT_STARTERS.map((starter) => (
              <button
                key={starter.id}
                type="button"
                title={`Fill these stops with ${starter.label}`}
                onClick={() => {
                  setSelected(0);
                  onChange(starter[mode]);
                }}
                className="flex items-center gap-1.5 rounded-full py-0.5 pr-2 pl-0.5 text-3xs ring-1 ring-foreground/10 transition-colors hover:bg-accent/50"
              >
                <span className="size-4 rounded-full ring-1 ring-inset ring-foreground/10" style={{ backgroundImage: composeGradient(starter[mode]) }} />
                {starter.label}
              </button>
            ))}
          </div>
        </div>

        <StopStrip spec={spec} selected={at} onSelect={setSelected} onChange={onChange} />
        <StopColours stops={spec.stops} selected={at} onSelect={setSelected} onColour={setColour} onSettle={settle} />

        <div className="grid gap-3 sm:grid-cols-[1fr_1fr]">
          <div className="flex flex-col gap-2.5">
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="text-muted-foreground">Shape</span>
              <Segmented<GradientType>
                value={spec.type}
                onChange={(type) => patch({ type })}
                options={[
                  { value: "linear", label: "Linear" },
                  { value: "radial", label: "Radial" },
                ]}
              />
            </div>
            {spec.type === "linear" ? (
              <label className="flex items-center gap-2 text-2xs">
                <span className="w-10 shrink-0 text-muted-foreground">Angle</span>
                <input
                  type="range"
                  min={0}
                  max={359}
                  value={spec.angle}
                  onChange={(event) => patch({ angle: Number(event.target.value) })}
                  className="min-w-0 flex-1 accent-primary"
                  aria-label="Gradient angle"
                />
                <span className="w-9 shrink-0 text-right tabular-nums text-muted-foreground">{spec.angle}&deg;</span>
              </label>
            ) : (
              <>
                <label className="flex items-center gap-2 text-2xs">
                  <span className="w-10 shrink-0 text-muted-foreground">Centre X</span>
                  <input
                    type="range"
                    min={GRADIENT_LIMITS.center.min}
                    max={GRADIENT_LIMITS.center.max}
                    value={spec.centerX}
                    onChange={(event) => patch({ centerX: Number(event.target.value) })}
                    className="min-w-0 flex-1 accent-primary"
                    aria-label="Gradient centre X"
                  />
                  <span className="w-9 shrink-0 text-right tabular-nums text-muted-foreground">{spec.centerX}%</span>
                </label>
                <label className="flex items-center gap-2 text-2xs">
                  <span className="w-10 shrink-0 text-muted-foreground">Centre Y</span>
                  <input
                    type="range"
                    min={GRADIENT_LIMITS.center.min}
                    max={GRADIENT_LIMITS.center.max}
                    value={spec.centerY}
                    onChange={(event) => patch({ centerY: Number(event.target.value) })}
                    className="min-w-0 flex-1 accent-primary"
                    aria-label="Gradient centre Y"
                  />
                  <span className="w-9 shrink-0 text-right tabular-nums text-muted-foreground">{spec.centerY}%</span>
                </label>
              </>
            )}
            <Button
              size="sm"
              variant="outline"
              className="self-start"
              disabled={spec.stops.length >= MAX_GRADIENT_STOPS}
              title={`Up to ${MAX_GRADIENT_STOPS} stops`}
              onClick={() => {
                const last = spec.stops[spec.stops.length - 1];
                patch({ stops: [...spec.stops, { color: last?.color ?? "#ffffff", position: GRADIENT_LIMITS.position.max, opacity: 100 }] });
                setSelected(spec.stops.length);
              }}
            >
              <PlusIcon /> Add stop
            </Button>
          </div>

          {stop && (
            <StopControls
              stop={stop}
              index={at}
              removable={spec.stops.length > MIN_GRADIENT_STOPS}
              chips={chips}
              onColour={(colour) => setColour(at, colour)}
              onSettle={settle}
              onChange={(next) => patch({ stops: spec.stops.map((entry, index) => (index === at ? next : entry)) })}
              onRemove={() => {
                setSelected(Math.max(0, at - 1));
                patch({ stops: spec.stops.filter((_, index) => index !== at) });
              }}
            />
          )}
        </div>

        <code className="break-all font-mono text-3xs leading-tight text-muted-foreground/60">{composeGradient(spec)}</code>
      </div>
    </div>
  );
}
