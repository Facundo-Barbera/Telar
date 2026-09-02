"use client";

/**
 * THE BACKDROP TOOL — the whole scene editor, writing the DRAFT.
 *
 * This is the old settings-pane backdrop group (the four-way Scene control,
 * the preset gallery, the custom gradient editor, the image picker, the layer
 * composer) brought back with ONE thing changed everywhere: nothing writes a
 * store. Each editor is CONTROLLED — handed a `LookBackdrop`, handing a new
 * one back — and the pane folds that into the draft, which lib/studio-preview
 * paints on the real app. So the app behind this pane is still the preview it
 * always was; the difference is that Discard now takes it all back.
 *
 * WHAT A HANDED-BACK BACKDROP MUST CONTAIN. A LookBackdrop is SELF-CONTAINED
 * by contract (see lib/looks.ts): the choice, the resolved CSS, and any payload
 * that lives nowhere else. That is why an image's data URL goes INTO the value
 * rather than into BACKDROP_IMAGE_KEY, and why a composed scene carries its own
 * layer images: a draft nobody has applied must not have already overwritten
 * what the reader is wearing. The constructors that build those values live in
 * lib/studio-draft.ts, where they can be tested without a DOM.
 *
 * ONE LIGHT/DARK AUTHORITY. These editors used to carry their own half
 * pickers — the gradient editor had a Light/Dark Segmented of its own — which
 * meant two controls disagreeing about what "the dark half" meant. The pane's
 * header toggle is now the only one: `mode` says which half you are looking
 * at, the custom gradient editor edits THAT half, and both halves are still
 * stored because a backdrop choice is a pair and the scheme can flip under it.
 * The preset tiles stay split (light left, dark right) for the same reason:
 * one click sets both, so the tile should show both.
 *
 * THE VIEW IS NOT THE VALUE. Flipping the Scene control to "Gradient" to
 * browse does not blank an image already in place — only "None" writes, and
 * the pickers write when something is actually chosen. The view follows the
 * value when the value changes from outside (undo, the chat drafting a
 * gradient), through the derived-state-during-render idiom rather than an
 * effect.
 */

import { useCallback, useRef, useState, type ReactNode } from "react";
import { CheckIcon, ImageIcon, MinusIcon, PaletteIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { BACKDROP_FITS, MAX_BACKDROP_BLUR, MAX_BACKDROP_DIM, type BackdropFit } from "@/lib/backdrop";
import {
  BACKDROP_PRESETS,
  composeGradient,
  MAX_GRADIENT_STOPS,
  MIN_GRADIENT_STOPS,
  type BackdropPreset,
  type CustomGradientSpec,
  type CustomGradientType,
} from "@/lib/backdrop-presets";
import { compressImageFile, ImageBackdropError } from "@/lib/image-backdrop";
import type { LookBackdrop } from "@/lib/looks";
import { samplePixels, themeFromPixels } from "@/lib/palette-from-image";
import {
  customGradientBackdrop,
  draftGradientPair,
  imageBackdrop,
  patchImageBackdrop,
  presetBackdrop,
  type GradientPair,
  type StudioMode,
} from "@/lib/studio-draft";
import type { ThemeDefinition } from "@/lib/theme-palettes";
import { Panel, PanelBody, PanelDivider, PanelHeader } from "@/components/ui/panel";
import { Row, Segmented } from "../settings-shell";
import { SceneEditor } from "./scene-editor";

/** The contract every editor in this tool shares: a value in, a value out,
 *  and no third place the truth could be hiding. */
export type BackdropEditor = {
  value: LookBackdrop;
  onChange: (next: LookBackdrop) => void;
};

type SceneView = "none" | "gradient" | "image" | "scene";

/** Which picker a stored backdrop belongs to. Both gradient kinds share one:
 *  a custom gradient is a tile in the same gallery. */
function viewOf(backdrop: LookBackdrop): SceneView {
  if (backdrop.kind === "none") return "none";
  if (backdrop.kind === "image") return "image";
  if (backdrop.kind === "scene") return "scene";
  return "gradient";
}

function messageFor(error: unknown): string {
  if (error instanceof ImageBackdropError) return error.message;
  return "That image could not be used.";
}

/* -------------------------------------------------------------- gradients */

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
  half: StudioMode;
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
      <Button size="icon-sm" variant="ghost" disabled={!removable} title="Remove stop" aria-label={`Remove stop ${index + 1}`} onClick={onRemove}>
        <MinusIcon />
      </Button>
    </div>
  );
}

/**
 * The stops, the shape and the angle of ONE half — whichever the pane's toggle
 * is showing. The other half is untouched and still stored, so flipping the
 * toggle is how you edit it; there is no second half picker in here, because
 * two controls answering the same question is what this rebuild set out to
 * delete. Every mutation recomposes both halves and hands up a whole backdrop:
 * there is no save button because there is no unsaved state.
 */
function CustomGradientEditor({
  pair,
  mode,
  onEdit,
  onClose,
}: {
  pair: GradientPair;
  mode: StudioMode;
  onEdit: (next: GradientPair) => void;
  onClose: () => void;
}) {
  const spec = pair[mode];
  const other: StudioMode = mode === "light" ? "dark" : "light";
  const patch = (changes: Partial<CustomGradientSpec>) => onEdit({ ...pair, [mode]: { ...spec, ...changes } });

  return (
    <div className="mt-3 rounded-xl bg-card ring-1 ring-foreground/10">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <span className="text-xs font-medium">Editing the {mode} half</span>
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
                  aria-label={`Gradient angle (${mode})`}
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
                half={mode}
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
          {/* The half you are NOT editing, as a courtesy — the one you ARE is
              already painted on the app behind this pane. */}
          <span className="text-[0.6875rem] text-muted-foreground">The {other} half</span>
          <span className="block aspect-video w-full rounded-lg ring-1 ring-inset ring-foreground/10" style={{ backgroundImage: composeGradient(pair[other]) }} />
          <code className="break-all font-mono text-[0.625rem] leading-tight text-muted-foreground/60">{composeGradient(spec)}</code>
        </div>
      </div>
    </div>
  );
}

/**
 * The gallery plus the editor. The pair is held locally because the STOPS are
 * not recoverable from every backdrop — parseGradient only reads back what
 * composeGradient wrote — but it is resynced whenever a custom gradient
 * arrives from somewhere else (undo, or the chat drafting one), so the editor
 * never sits on stops that disagree with what is painted.
 */
function GradientEditor({ value, onChange, mode }: BackdropEditor & { mode: StudioMode }) {
  const custom = value.kind === "custom-gradient";
  const [open, setOpen] = useState(custom);
  const [pair, setPair] = useState<GradientPair>(() => draftGradientPair(value));

  const incoming = custom ? value.light : undefined;
  const [seen, setSeen] = useState(incoming);
  if (seen !== incoming) {
    setSeen(incoming);
    // Only when it is not our own last write coming back around.
    if (incoming !== undefined && incoming !== composeGradient(pair.light)) setPair(draftGradientPair(value));
  }

  const commit = (next: GradientPair) => {
    setPair(next);
    const backdrop = customGradientBackdrop(next);
    if (backdrop) onChange(backdrop);
  };

  return (
    <>
      <PanelDivider label="Presets" />
      <div className="px-3 pb-3">
        <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4 xl:grid-cols-6">
          {BACKDROP_PRESETS.map((preset) => (
            <PresetCard
              key={preset.id}
              preset={preset}
              active={value.kind === "gradient" && value.id === preset.id}
              onUse={() => {
                setOpen(false);
                const backdrop = presetBackdrop(preset.id);
                if (backdrop) onChange(backdrop);
              }}
            />
          ))}
          <button
            type="button"
            // Choosing Custom IS choosing a backdrop, not just opening a form:
            // it commits the current pair so the draft repaints immediately and
            // the editor's edits all land from the first one.
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
        {open && <CustomGradientEditor pair={pair} mode={mode} onEdit={commit} onClose={() => setOpen(false)} />}
      </div>
    </>
  );
}

/* ----------------------------------------------------------------- images */

const FIT_LABELS: Record<BackdropFit, string> = { cover: "Cover", fill: "Fill", tile: "Tile" };

/** The sample the palette is read from. Large enough that a small accent in
 *  the picture still occupies pixels, small enough to be instant — a hue
 *  histogram over four thousand pixels is the same answer as over four

/** Draw the draft's data URL small and read its pixels. Separate from the
 *  extraction itself so the pure half stays canvas-free and testable. */

/**
 * A photograph under the app, and a theme out of it.
 *
 * The thumbnail is read straight off the draft — the data URL IS the value —
 * so there is no storage round trip and no derived-state dance about whether
 * the picture and the choice agree. Fit, blur and dim are live: the draft is
 * painted on the app behind this pane, and a preview you have to confirm is a
 * worse version of looking at it.
 *
 * "Theme from image" hands the derived halves UP rather than saving a custom
 * theme, because on this pane a palette is something the draft wears, not
 * something the library gains. The row only appears when the pane offered
 * somewhere to put it.
 */
function ImageEditor({ value, onChange, onThemeHalves }: BackdropEditor & { onThemeHalves?: (theme: Omit<ThemeDefinition, "id">) => void }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const image = value.kind === "image" ? value : undefined;
  const [error, setError] = useState<string | false>(false);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  const accept = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      setBusy(true);
      setError(false);
      try {
        const backdrop = imageBackdrop(await compressImageFile(file), value);
        if (backdrop) onChange(backdrop);
        else setError("That file did not decode to an image.");
      } catch (failure) {
        setError(messageFor(failure));
      } finally {
        setBusy(false);
      }
    },
    [onChange, value],
  );

  const makeTheme = useCallback(async () => {
    if (!image || !onThemeHalves) return;
    setBusy(true);
    setError(false);
    try {
      const pixels = await samplePixels(image.image);
      const theme = themeFromPixels(pixels);
      onThemeHalves(theme);
    } catch {
      setError("Could not read colours from that image.");
    } finally {
      setBusy(false);
    }
  }, [image, onThemeHalves]);

  return (
    <>
      {error && <p className="px-3 pt-2.5 text-xs text-warning">{error}</p>}
      <div className="p-3">
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
        {/* THE DROPZONE IS THE BUTTON. There used to be a "Choose image…"
            button in a row above, doing exactly what clicking here does — two
            controls for one act, and a paragraph beside them explaining the
            act. One target, one line. */}
        <div
          role="button"
          tabIndex={0}
          aria-label="Choose a backdrop image"
          onClick={() => !busy && fileInput.current?.click()}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              if (!busy) fileInput.current?.click();
            }
          }}
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
            "flex cursor-pointer items-center gap-3 rounded-lg border border-dashed p-3 transition-colors",
            dragging ? "border-primary bg-primary/5" : "border-border hover:border-primary/40 hover:bg-accent/40",
          )}
        >
          {image ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element -- a data URL held in the draft; there is nothing for next/image to fetch or optimise */}
              <img src={image.image} alt="" className="size-14 shrink-0 rounded-md border border-border object-cover" />
              <div className="min-w-0 flex-1 text-xs text-muted-foreground">{busy ? "Working…" : "Click or drop to replace."}</div>
              <Button
                size="sm"
                variant="ghost"
                className="shrink-0 text-muted-foreground"
                disabled={busy}
                onClick={(event) => {
                  event.stopPropagation();
                  setError(false);
                  onChange({ kind: "none" });
                }}
              >
                <Trash2Icon /> Remove
              </Button>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center gap-2 py-4 text-xs text-muted-foreground">
              <ImageIcon className="size-4" />
              {busy ? "Working…" : "Click, or drop an image here"}
            </div>
          )}
        </div>
      </div>
      {image && (
        <div className="px-3">
          <Row
            label="Fit"
            control={
              <Segmented<BackdropFit>
                value={image.fit}
                onChange={(fit) => onChange(patchImageBackdrop(image, { fit }))}
                options={BACKDROP_FITS.map((fit) => ({ value: fit, label: FIT_LABELS[fit] }))}
              />
            }
          />
          <Row
            label="Blur"
            control={
              <div className="flex items-center gap-2.5">
                <input
                  type="range"
                  min={0}
                  max={MAX_BACKDROP_BLUR}
                  step={1}
                  value={image.blur}
                  onChange={(event) => onChange(patchImageBackdrop(image, { blur: Number(event.target.value) }))}
                  className="w-36 accent-primary"
                  aria-label="Backdrop blur"
                />
                <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">{image.blur}px</span>
              </div>
            }
          />
          <Row
            label="Dim"
            control={
              <div className="flex items-center gap-2.5">
                <input
                  type="range"
                  min={0}
                  max={MAX_BACKDROP_DIM}
                  step={1}
                  value={image.dim}
                  onChange={(event) => onChange(patchImageBackdrop(image, { dim: Number(event.target.value) }))}
                  className="w-36 accent-primary"
                  aria-label="Backdrop dim"
                />
                <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">{image.dim}%</span>
              </div>
            }
          />
          {onThemeHalves && (
            <Row
              label="Palette from image"
              control={
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  title="Tint both halves of the draft with the picture's dominant colour"
                  onClick={() => void makeTheme()}
                >
                  <PaletteIcon /> Take colours
                </Button>
              }
            />
          )}
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ shell */

export function BackdropTool({
  value,
  onChange,
  mode,
  onThemeHalves,
  footer,
}: BackdropEditor & {
  mode: StudioMode;
  onThemeHalves?: (theme: Omit<ThemeDefinition, "id">) => void;
  /** Rows that belong to the scene but are not part of the backdrop VALUE —
   *  today just how much of it washes through the app. */
  footer?: ReactNode;
}) {
  const valueView = viewOf(value);
  // Local so a picker can be opened BEFORE anything is chosen; adjusted during
  // render (React's sanctioned derived-state idiom, not an effect) so a change
  // from outside — undo, the chat drafting a gradient — moves the control.
  const [view, setView] = useState<SceneView>(valueView);
  const [seenView, setSeenView] = useState<SceneView>(valueView);
  if (seenView !== valueView) {
    setSeenView(valueView);
    if (valueView !== "none") setView(valueView);
  }

  return (
    <Panel>
      <PanelHeader
        icon={<ImageIcon />}
        label="Scene"
        actions={
          <Segmented<SceneView>
            value={view}
            onChange={(next) => {
              setView(next);
              // Only None writes on its own; the pickers write when something
              // is actually chosen, so browsing never blanks what is in place.
              if (next === "none") onChange({ kind: "none" });
            }}
            options={[
              { value: "none", label: "None" },
              { value: "gradient", label: "Gradient" },
              { value: "image", label: "Image" },
              { value: "scene", label: "Compose" },
            ]}
          />
        }
      />
      {view === "none" ? (
        <PanelBody className="px-3 py-6 text-center text-xs text-muted-foreground">The canvas paints flat.</PanelBody>
      ) : (
        <PanelBody>
          {view === "gradient" && <GradientEditor value={value} onChange={onChange} mode={mode} />}
          {view === "image" && <ImageEditor value={value} onChange={onChange} onThemeHalves={onThemeHalves} />}
          {view === "scene" && <SceneEditor value={value} onChange={onChange} />}
        </PanelBody>
      )}
      {footer && <div className="shrink-0 border-t border-border">{footer}</div>}
    </Panel>
  );
}
