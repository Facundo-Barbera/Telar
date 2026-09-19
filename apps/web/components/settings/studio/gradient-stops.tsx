"use client";

/**
 * ONE GRADIENT, AUTHORED — its shape, its direction, and its stops.
 *
 * AUTHORED, NOT PICKED (#471). This used to be the editor for a "custom
 * gradient", a second-class kind you reached past a grid of eleven presets. The
 * presets ARE this now: the chips along the top fill these controls and then
 * get out of the way, so "start from Dusk and make it yours" is one gesture
 * instead of a fork in the model. There is no other way to have a gradient.
 *
 * THE STOP STRIP IS THE CONTROL. A gradient is a thing you look at, so the
 * primary affordance is the gradient itself: click the ramp to add a stop where
 * you clicked, drag a handle to move one. Under it sits a colour input per
 * stop, and under that the colour, position and fade of whichever stop you last
 * touched. The numbers are still there — a slider is how you get a stop to
 * exactly 50% — but nobody has to read them to work.
 *
 * COLOUR IS A CONTROL, NOT A SWATCH YOU HAPPEN TO BE ABLE TO CLICK (#471). The
 * first cut of this editor put an `<input type="color">` behind each stop's
 * swatch and stopped there, which meant the only way to set a colour was to
 * open the operating system's colour dialog and the only way to know that was
 * to try clicking. The selected stop now carries a real field — a large swatch,
 * a hex input that also reads `oklch(...)`, and an eyedropper where the browser
 * has one — and under it the colours already in play, because most stops want a
 * colour this app is wearing rather than a new one.
 *
 * ONE GRADIENT, NOT A PAIR. This carried two specs and a Light/Dark toggle of
 * its own back when a custom gradient was a backdrop KIND answering for both
 * colour schemes at once. A gradient is a LAYER, and a layer belongs to one
 * state of the composition, so there is exactly one spec here and exactly one
 * control deciding which state you are editing: the composer's own switch, one
 * group up.
 *
 * Every change recomposes and hands the whole spec up; the layer it belongs to
 * is rewritten at once. There is no save button because there is no unsaved
 * state.
 */

import { useRef, useState, useSyncExternalStore } from "react";
import { MinusIcon, PipetteIcon, PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { normaliseColourText } from "@/lib/colour-field";
import {
  colourChips,
  recentColoursSnapshot,
  rememberStopColour,
  serverRecentColoursSnapshot,
  subscribeRecentColours,
  type ColourChip,
} from "@/lib/recent-colours";
import {
  composeGradient,
  GRADIENT_LIMITS,
  GRADIENT_STARTERS,
  MAX_GRADIENT_STOPS,
  MIN_GRADIENT_STOPS,
  type CustomGradientSpec,
  type GradientStop,
  type GradientType,
} from "@/lib/gradient-starters";
import type { CompositionMode } from "@/lib/composition";
import { Segmented } from "../settings-shell";
import { HexField } from "./hex-field";

/**
 * The screen-wide colour picker, where there is one. Chromium has it; nothing
 * else does yet, and the button is hidden rather than disabled where it is
 * missing — a control that explains why it cannot work is worse than no control
 * on a pane this dense.
 */
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

/** Stops in the order they paint. The array is kept in authoring order so a
 *  handle dragged past its neighbour does not renumber everything under the
 *  pointer; CSS is happy either way, since an out-of-order stop simply clamps
 *  to the one before it. */
function sortedForDisplay(stops: readonly GradientStop[]): { stop: GradientStop; index: number }[] {
  return stops.map((stop, index) => ({ stop, index })).sort((a, b) => a.stop.position - b.stop.position);
}

/**
 * THE RAMP — the gradient at size, with a handle per stop.
 *
 * A pointer down on a handle starts a drag; a pointer down anywhere else adds a
 * stop at that position, taking its colour from the ramp it was dropped on so
 * the click does not change the picture. Capture is on the strip itself, so a
 * drag that leaves the element still tracks.
 */
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
    // The new stop takes the colour of its nearest neighbour, so adding one is
    // a no-op on the picture until you change it — an add that recoloured the
    // gradient would make the strip feel like it was fighting you.
    const nearest = spec.stops.reduce((best, stop) =>
      Math.abs(stop.position - position) < Math.abs(best.position - position) ? stop : best,
    );
    onChange({ ...spec, stops: [...spec.stops, { ...nearest, position }] });
    onSelect(spec.stops.length);
  };

  return (
    <div
      ref={strip}
      // A div rather than a button: it CONTAINS the handles, which are the
      // focusable things, and a button holding buttons is not a thing.
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
          // The keyboard path, because a drag is not one: arrows nudge, and
          // the number input below is the exact answer.
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

/**
 * A COLOUR INPUT PER STOP, under the strip and in the strip's own order.
 *
 * The handles cannot be colour inputs themselves — a pointer-down on an
 * `<input type="color">` opens the OS picker, which is the same gesture a drag
 * starts with — so the colours sit in a row beneath, each aligned to the stop it
 * belongs to by position in the list. Touching one also SELECTS that stop, so
 * the sliders below are about whatever you last touched.
 */
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
  /** The drag through the OS dialog is over — see `GradientStops`. */
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

/**
 * THE COLOURS ALREADY IN PLAY, one click each.
 *
 * Fixed chips first and always in the same place, then what this session has
 * touched — lib/recent-colours.ts owns that order and the cap, and the reasons.
 * A chip is a `<button>` rather than a swatch with a handler because it is one:
 * it has a name, it is reachable by keyboard, and its title says what it is.
 */
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

/**
 * THE SELECTED STOP'S COLOUR — the swatch, the value, and the screen.
 *
 * Three ways in, because they answer three different questions. The swatch is
 * the OS dialog, for choosing a colour you have not got yet. The hex field is
 * for a colour you HAVE got, in whatever notation you copied it in — including
 * the `oklch(...)` the token rows one group up are written in. The eyedropper
 * is for a colour that is on your screen and nowhere else: a screenshot, a
 * photograph, another window.
 */
function StopColourField({
  colour,
  onColour,
  onSettle,
}: {
  colour: string;
  onColour: (colour: string) => void;
  onSettle: (colour: string) => void;
}) {
  // Whether the browser has one is an external fact, true before React ran and
  // never changing — the same idiom (and the same reason) as the appearance
  // pane's own "is there a desktop shell?". The server says no, so hydration
  // agrees with it and the button appears on the client's first paint.
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
      // Dismissed with Escape, which is a cancel rather than a failure.
    }
  };

  return (
    <div className="flex items-center gap-2 text-2xs" onBlur={() => onSettle(colour)}>
      <span className="w-10 shrink-0 text-muted-foreground">Colour</span>
      {/* "Selected stop" rather than "Stop 3": the strip above already has a
          `Stop 3 colour` input, and two controls answering to the same name is
          worse for a screen reader than a name that says which one this is.
          Which stop it belongs to is the heading immediately above it. */}
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

/** What the selected stop IS: its colour, where it sits, and how opaque it is.
 *  The numbers are the exact answer the strip's drag approximates — and the
 *  only way to say 50%. */
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
      {/* Under the field it fills, and indented to its column, so the row reads
          as part of the colour control rather than as a fourth thing. */}
      <div className="flex pl-12">
        <RecentColours
          chips={chips}
          onPick={(colour) => {
            // Deliberate, and already a colour — worth remembering at once
            // rather than waiting for a gesture that has already ended.
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
  /** Which colour state this layer belongs to — the half a starter chip fills
   *  from, and the half its swatch shows. */
  mode: CompositionMode;
  /** The app's own colours, which the chip row always offers: the base of each
   *  state and the accent this window is wearing. */
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

  /**
   * REMEMBERED WHEN THE GESTURE ENDS, not while it is happening. A native
   * colour dialog fires `change` continuously as the cursor moves through it,
   * and a hex field that updates the stop live does the same per keystroke —
   * either would fill a list of eight with eight shades of one drag. So the
   * stop moves as you go and the memory takes the colour you stopped on.
   */
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
        {/* START FROM, NOT CHOOSE FROM. The chips fill the controls below and
            nothing about the layer remembers which one was pressed — which is
            the whole difference between a starting point and a kind. */}
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
            {/* A linear gradient has a direction; a radial one has a place it
                comes from. Only ever one of the two is shown, because a control
                that moves nothing is a bug report. */}
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
