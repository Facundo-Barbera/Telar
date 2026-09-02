"use client";

/**
 * THE GRADIENT PICKER — the scene gallery, and the editor for rolling your own.
 *
 * Rendered by backdrop-section.tsx when Scene says Gradient. It sits inside
 * that group's divide-y frame, so it returns a Row plus a body rather than a
 * card of its own — same shape the theme library uses one pane over.
 *
 * WHY EVERY THUMBNAIL SHOWS BOTH HALVES. A backdrop choice is a PAIR: picking
 * Aurora sets the light scene and the dark one at once, and the store keeps
 * both because the scheme can flip under it (system dark mode, at dusk,
 * without a re-pick). Painting only the current scheme would hide half of
 * what the click does. So the tile is split — light left, dark right — which
 * is the theme library's two-orb idea flattened into a rectangle. These
 * halves are NOT separately clickable, unlike the orbs: backdrop.ts has no
 * per-half choice to write, and a control that looks like the orbs but
 * doesn't behave like them would be a worse lie than a plain tile.
 *
 * WHY THE EDITOR COMMITS ON EVERY KEYSTROKE. There is no preview surface big
 * enough to judge a backdrop — the backdrop IS the preview, and it is already
 * on screen behind this pane. So each edit calls setBackdrop and the whole app
 * repaints under you. The swatch in the editor is a courtesy for the half you
 * are NOT currently looking at.
 *
 * REOPENING POPULATED is why lib/backdrop-presets.ts exports a parser: the
 * store holds finished CSS (it has to — the pre-paint script can't run our
 * code), so coming back to a custom gradient means reading our own output
 * back into stops. parseGradient recognises only what composeGradient emits;
 * anything else opens the editor on its defaults, which is why the format is
 * kept dull on purpose.
 */

import { useState } from "react";
import { CheckIcon, MinusIcon, PlusIcon } from "lucide-react";
import { useBackdrop, type Backdrop } from "@/lib/backdrop";
import {
  BACKDROP_PRESETS,
  composeGradient,
  DEFAULT_CUSTOM_GRADIENT,
  MAX_GRADIENT_STOPS,
  MIN_GRADIENT_STOPS,
  parseGradient,
  type BackdropPreset,
  type CustomGradientSpec,
  type CustomGradientType,
} from "@/lib/backdrop-presets";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Row, Segmented } from "./settings-shell";

type Half = "light" | "dark";
type Pair = Record<Half, CustomGradientSpec>;

/** The scene as a card-sized rectangle: light on the left, dark on the right,
 *  seamed down the middle. Both are painted at full size and cropped, so the
 *  thumbnail shows the same corner blobs the real backdrop does rather than a
 *  squashed miniature of them. */
function SceneTile({ light, dark, className }: { light: string; dark: string; className?: string }) {
  return (
    <span className={cn("relative block aspect-video w-full overflow-hidden rounded-lg", className)}>
      <span className="absolute inset-0" style={{ backgroundImage: light, backgroundSize: "cover" }} />
      <span className="absolute inset-y-0 right-0 w-1/2" style={{ backgroundImage: dark, backgroundSize: "cover" }} />
    </span>
  );
}

function PresetCard({ preset, active, onUse }: { preset: BackdropPreset; active: boolean; onUse: () => void }) {
  return (
    <button
      type="button"
      onClick={onUse}
      title={`Use ${preset.label}`}
      aria-pressed={active}
      className={cn(
        "group flex flex-col gap-1.5 rounded-xl p-1.5 text-left ring-1 ring-foreground/10 transition-colors hover:bg-accent/50",
        active && "ring-2 ring-primary",
      )}
    >
      <SceneTile light={preset.light} dark={preset.dark} className="ring-1 ring-inset ring-foreground/10" />
      <span className="flex items-center gap-1 px-0.5 text-[0.6875rem] font-medium">
        <span className="truncate">{preset.label}</span>
        {active && <CheckIcon className="size-3 shrink-0 text-primary" />}
      </span>
    </button>
  );
}

function StopRow({
  color,
  index,
  half,
  removable,
  onChange,
  onRemove,
}: {
  color: string;
  index: number;
  half: Half;
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
        aria-label={`Stop ${index + 1} colour (${half})`}
        className="size-6 shrink-0 cursor-pointer rounded border border-border bg-transparent p-0"
      />
      <code className="flex-1 truncate font-mono text-[0.625rem] text-muted-foreground/70">{color}</code>
      <Button
        size="icon-sm"
        variant="ghost"
        disabled={!removable}
        title="Remove stop"
        aria-label={`Remove stop ${index + 1}`}
        onClick={onRemove}
      >
        <MinusIcon />
      </Button>
    </div>
  );
}

/**
 * The inline editor, on ThemeEditor's model: a header carrying the half
 * Segmented and a Done, then the rows for that half. Every mutation goes
 * through `edit`, which recomposes BOTH halves and hands them to the store —
 * there is no save button because there is no unsaved state.
 */
function CustomGradientEditor({ pair, onEdit, onClose }: { pair: Pair; onEdit: (next: Pair) => void; onClose: () => void }) {
  const [half, setHalf] = useState<Half>("dark");
  const spec = pair[half];
  const patch = (changes: Partial<CustomGradientSpec>) => onEdit({ ...pair, [half]: { ...spec, ...changes } });

  return (
    <div className="mt-3 rounded-xl bg-card ring-1 ring-foreground/10">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Segmented<Half>
          value={half}
          onChange={setHalf}
          options={[
            { value: "light", label: "Light half" },
            { value: "dark", label: "Dark half" },
          ]}
        />
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
                  aria-label={`Gradient angle (${half})`}
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
                half={half}
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
          <span className="text-[0.6875rem] text-muted-foreground">Preview</span>
          <span
            className="block aspect-video w-full rounded-lg ring-1 ring-inset ring-foreground/10"
            style={{ backgroundImage: composeGradient(spec) }}
          />
          <code className="break-all font-mono text-[0.625rem] leading-tight text-muted-foreground/60">{composeGradient(spec)}</code>
        </div>
      </div>
    </div>
  );
}

/** The store holds finished CSS, so a custom choice comes back through the
 *  parser; a preset (or nothing) starts from the defaults. */
function readPair(backdrop: Backdrop): Pair {
  if (backdrop.kind !== "custom-gradient") return DEFAULT_CUSTOM_GRADIENT;
  return {
    light: parseGradient(backdrop.light) ?? DEFAULT_CUSTOM_GRADIENT.light,
    dark: parseGradient(backdrop.dark) ?? DEFAULT_CUSTOM_GRADIENT.dark,
  };
}

export function GradientBackdrop() {
  const { backdrop, setBackdrop } = useBackdrop();
  const custom = backdrop.kind === "custom-gradient";
  const [open, setOpen] = useState(custom);
  // Seeded from the store once; from here on this state is the source and the
  // store is the sink (every edit writes through), so it must not be re-read.
  const [pair, setPair] = useState<Pair>(() => readPair(backdrop));

  const commit = (next: Pair) => {
    setPair(next);
    const layers = { light: composeGradient(next.light), dark: composeGradient(next.dark) };
    setBackdrop({ kind: "custom-gradient", ...layers }, layers);
  };

  return (
    <>
      <Row
        label="Scene"
        hint="Each tile shows both halves — light on the left, dark on the right. The scheme in force picks which one paints."
      />
      <div className="px-4 py-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {BACKDROP_PRESETS.map((preset) => (
            <PresetCard
              key={preset.id}
              preset={preset}
              active={backdrop.kind === "gradient" && backdrop.id === preset.id}
              onUse={() => {
                setOpen(false);
                setBackdrop({ kind: "gradient", id: preset.id }, { light: preset.light, dark: preset.dark });
              }}
            />
          ))}
          <button
            type="button"
            // Choosing Custom IS choosing a backdrop, not just opening a form:
            // it commits the current pair so the app repaints immediately and
            // the editor's edits are all live from the first one.
            onClick={() => {
              setOpen((wasOpen) => !(wasOpen && custom));
              commit(pair);
            }}
            title="Build your own gradient"
            aria-pressed={custom}
            aria-expanded={open}
            className={cn(
              "group flex flex-col gap-1.5 rounded-xl p-1.5 text-left ring-1 ring-foreground/10 transition-colors hover:bg-accent/50",
              custom && "ring-2 ring-primary",
            )}
          >
            <SceneTile
              light={composeGradient(pair.light)}
              dark={composeGradient(pair.dark)}
              className="outline-2 -outline-offset-2 outline-dashed outline-foreground/25"
            />
            <span className="flex items-center gap-1 px-0.5 text-[0.6875rem] font-medium">
              <span className="truncate">Custom&hellip;</span>
              {custom && <CheckIcon className="size-3 shrink-0 text-primary" />}
            </span>
          </button>
        </div>
        {open && <CustomGradientEditor pair={pair} onEdit={commit} onClose={() => setOpen(false)} />}
      </div>
    </>
  );
}
