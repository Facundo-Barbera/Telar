"use client";

/**
 * THE STOPS OF ONE GRADIENT — shape, direction, colours.
 *
 * ONE GRADIENT, NOT A PAIR (#471). This editor used to carry two specs and a
 * Light/Dark toggle of its own, because a custom gradient was a backdrop KIND
 * that had to answer for both colour schemes at once — and the pane's own
 * scheme control was a second authority on the same question. A custom gradient
 * is a LAYER now, and a layer belongs to one state of the composition, so there
 * is exactly one spec here and exactly one control deciding which state you are
 * editing: the composer's own switch, one group up.
 *
 * Every change recomposes and hands the whole spec up; the layer it belongs to
 * is rewritten at once. There is no save button because there is no unsaved
 * state.
 */

import { MinusIcon, PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { composeGradient, MAX_GRADIENT_STOPS, MIN_GRADIENT_STOPS, type CustomGradientSpec, type CustomGradientType } from "@/lib/backdrop-presets";
import { Segmented } from "../settings-shell";

function StopRow({
  color,
  index,
  removable,
  onChange,
  onRemove,
}: {
  color: string;
  index: number;
  removable: boolean;
  onChange: (value: string) => void;
  onRemove: () => void;
}) {
  // A div, not a label: a label would forward the remove button's click to
  // the colour input and pop the OS picker on every removal.
  return (
    <div className="flex items-center gap-2 text-xs">
      <input
        type="color"
        value={color}
        onChange={(event) => onChange(event.target.value)}
        aria-label={`Stop ${index + 1} colour`}
        className="size-6 shrink-0 cursor-pointer rounded border border-border bg-transparent p-0"
      />
      <code className="flex-1 truncate font-mono text-3xs text-muted-foreground/70">{color}</code>
      <Button size="icon-sm" variant="ghost" disabled={!removable} title="Remove stop" aria-label={`Remove stop ${index + 1}`} onClick={onRemove}>
        <MinusIcon />
      </Button>
    </div>
  );
}

export function GradientStops({
  spec,
  onChange,
  onClose,
}: {
  spec: CustomGradientSpec;
  onChange: (next: CustomGradientSpec) => void;
  onClose: () => void;
}) {
  const patch = (changes: Partial<CustomGradientSpec>) => onChange({ ...spec, ...changes });

  return (
    <div className="rounded-xl bg-card ring-1 ring-foreground/10">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <span className="text-xs font-medium">This gradient</span>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={onClose}>
          Done
        </Button>
      </div>
      <div className="grid gap-4 px-4 py-3 sm:grid-cols-[1fr_9rem]">
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="text-muted-foreground">Shape</span>
            <Segmented<CustomGradientType>
              value={spec.type}
              onChange={(type) => patch({ type })}
              options={[
                { value: "linear", label: "Linear" },
                { value: "radial", label: "Radial" },
              ]}
            />
          </div>
          {/* Only linear has a direction — a radial one is centred by
              construction, and a slider that moves nothing is a bug report. */}
          {spec.type === "linear" && (
            <label className="flex items-center justify-between gap-3 text-xs">
              <span className="text-muted-foreground">Angle</span>
              <span className="flex items-center gap-2.5">
                <input
                  type="range"
                  min={0}
                  max={359}
                  step={1}
                  value={spec.angle}
                  onChange={(event) => patch({ angle: Number(event.target.value) })}
                  className="w-32 accent-primary"
                  aria-label="Gradient angle"
                />
                <span className="w-9 text-right tabular-nums text-muted-foreground">{spec.angle}&deg;</span>
              </span>
            </label>
          )}
          <div className="flex flex-col gap-1.5 border-t border-border pt-2.5">
            {spec.stops.map((color, index) => (
              <StopRow
                key={index}
                color={color}
                index={index}
                removable={spec.stops.length > MIN_GRADIENT_STOPS}
                onChange={(value) => patch({ stops: spec.stops.map((stop, at) => (at === index ? value : stop)) })}
                onRemove={() => patch({ stops: spec.stops.filter((_, at) => at !== index) })}
              />
            ))}
            <Button
              size="sm"
              variant="outline"
              className="self-start"
              disabled={spec.stops.length >= MAX_GRADIENT_STOPS}
              onClick={() => patch({ stops: [...spec.stops, spec.stops[spec.stops.length - 1] ?? "#ffffff"] })}
            >
              <PlusIcon /> Add stop
            </Button>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="block aspect-video w-full rounded-lg ring-1 ring-inset ring-foreground/10" style={{ backgroundImage: composeGradient(spec) }} />
          <code className="break-all font-mono text-3xs leading-tight text-muted-foreground/60">{composeGradient(spec)}</code>
        </div>
      </div>
    </div>
  );
}
