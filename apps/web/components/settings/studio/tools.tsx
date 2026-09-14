"use client";

/**
 * THE PALETTE ROWS AND THE TYPE ROWS — writing the live stores, directly.
 *
 * They used to take a whole draft and hand a whole draft back, writing nothing
 * until a masthead's Apply. There is no draft (#471): each of these takes the
 * value it edits and the function that stores it, and the app retints as you
 * drag — which is what every other settings pane in this app has always done,
 * and what Translucency and Glass did on this one all along.
 *
 * THE BACKDROP LIVES NEXT DOOR, in backdrop-tool.tsx, because it is a
 * different shape of thing: a gallery, a gradient editor, a picture and a
 * layer stack, each of which produces a whole self-contained LookBackdrop
 * rather than a patch to anything.
 *
 * THE COLOUR ROWS EDIT ONE HALF — whichever the window is wearing. A pane that
 * wrote both halves from one picker would make the light/dark distinction a
 * decoration, and the whole reason a theme has two halves is that the answer
 * differs. The colour scheme is therefore the mode selector for this tool.
 */

import {
  ACCENTS,
  MAX_FONT_SIZE,
  MAX_MONO_FONT_SIZE,
  MAX_TRANSLUCENCY,
  MIN_FONT_SIZE,
  MIN_MONO_FONT_SIZE,
  MIN_TRANSLUCENCY,
  MONO_FONTS,
  MONOSPACED_FONTS,
  SANS_FONTS,
  type Accent,
  type Appearance,
  type MonoFont,
  type SansFont,
} from "@/lib/appearance";
import {
  cssColorToHex,
  FOREGROUND_SURFACES,
  hexToCssColor,
  THEME_TOKEN_HINTS,
  THEME_TOKEN_LABELS,
  THEME_TOKENS,
  type ThemeHalf,
  type ThemeToken,
} from "@/lib/theme-palettes";
import { contrastRatio, parseVsCodeColor } from "@/lib/vscode-theme-import";
import type { CompositionMode } from "@/lib/composition";
import { cn } from "@/lib/utils";
import { CheckIcon, RotateCcwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Row } from "../settings-shell";
import { HexField } from "./hex-field";
import { CodeSpecimen, InterfaceSpecimen, TerminalSpecimen } from "./type-specimen";

/** What the type rows read and write: the live appearance, and the store's own
 *  patch function. */
export type TypeToolProps = { appearance: Appearance; onChange: (patch: Partial<Appearance>) => void };

// The SAME catalogue in both slots; only the name of the shared `geist` id
// differs, because Geist and Geist Mono are what it has always meant in each.
// EXPORTED because the Looks list names a look's two faces in its summary line
// and must not keep a second table of the same names.
export const SANS_LABEL: Record<SansFont, string> = {
  geist: "Geist",
  inter: "Inter",
  "plex-sans": "IBM Plex Sans",
  "source-sans": "Source Sans 3",
  roboto: "Roboto",
  "noto-sans": "Noto Sans",
  "space-grotesk": "Space Grotesk",
  lato: "Lato",
  jetbrains: "JetBrains Mono",
  "plex-mono": "IBM Plex Mono",
  "fira-code": "Fira Code",
  "geist-mono": "Geist Mono",
  "source-code-pro": "Source Code Pro",
  "roboto-mono": "Roboto Mono",
  "cascadia-code": "Cascadia Code",
  system: "System",
  custom: "Custom…",
};
export const MONO_LABEL: Record<MonoFont, string> = { ...SANS_LABEL, geist: "Geist Mono" };
const ACCENT_LABEL: Record<Accent, string> = {
  indigo: "Indigo",
  sky: "Sky",
  sea: "Sea",
  moss: "Moss",
  amber: "Amber",
  rose: "Rose",
  plum: "Plum",
  violet: "Violet",
};

/**
 * An unlabelled block of tool content.
 *
 * IT OWNS NO HORIZONTAL PADDING AND NO HAIRLINE ANY MORE (#399). Both came from
 * the `Panel` these tools used to be mounted in; they live in a `SettingsGroup`
 * card now, which supplies the inset to its direct children and divides them
 * itself — the same contract `Row` has always had (settings-shell.tsx says so).
 * Keeping the old `px-3` here would simply have added 12px inside the card's 16.
 *
 * The LABELLED form is gone with the panel: a labelled block with a control on
 * the right is a `Row`, which is what Accent and Show-through are now — and a
 * Row is also a search destination, which a hand-rolled strip never was.
 */
function ToolBlock({ children }: { children: React.ReactNode }) {
  return <div className="py-2.5">{children}</div>;
}

/* ------------------------------------------------------------- colours */

/** The surface each foreground token is judged against — the designer's own
 *  pairing table, inverted for row lookup. Undefined for surface tokens. */
const SURFACE_OF: Partial<Record<ThemeToken, ThemeToken>> = Object.fromEntries(FOREGROUND_SURFACES);

/** WCAG AA for body copy — the bar the designer and the VS Code importer both
 *  repair to; shown here rather than enforced, because a hand edit is a
 *  decision and the studio's job is to say what it costs. */
const READABLE = 4.5;

function ratioFor(half: ThemeHalf, token: ThemeToken): number | undefined {
  const surfaceToken = SURFACE_OF[token];
  if (!surfaceToken) return undefined;
  const fg = parseVsCodeColor(cssColorToHex(half[token]));
  const bg = parseVsCodeColor(cssColorToHex(half[surfaceToken]));
  if (!fg || !bg) return undefined;
  return contrastRatio(fg, bg);
}

/**
 * THE PALETTE AT A GLANCE — one half, as the surfaces it actually paints.
 *
 * Sixteen swatches in a grid say what the VALUES are and nothing about what
 * they add up to; this says what they add up to, at the size a thumbnail can.
 * It is drawn from the half's own tokens and nothing else — no Tailwind
 * classes, because the whole point is to show a palette the window may not be
 * wearing (the dark half while you are in daylight).
 */
export function PaletteStrip({ half, label, current }: { half: ThemeHalf; label: string; current: boolean }) {
  return (
    <div className="min-w-0 flex-1">
      <div
        className={cn("flex h-14 items-center gap-1.5 overflow-hidden rounded-lg px-2 ring-1 ring-inset", current ? "ring-primary" : "ring-foreground/10")}
        style={{ background: half.background }}
      >
        {/* A card, a chip and the rail — the three surfaces a reader can name
            on sight — each carrying its own text colour so the pairing is
            visible rather than implied. */}
        <span className="flex h-9 flex-1 items-center rounded-md px-1.5 text-3xs" style={{ background: half.card, border: `1px solid ${half.border}`, color: half["card-foreground"] }}>
          Card
        </span>
        <span className="flex h-9 items-center rounded-md px-1.5 text-3xs" style={{ background: half.secondary, color: half["secondary-foreground"] }}>
          Chip
        </span>
        <span className="h-9 w-4 shrink-0 rounded-md" style={{ background: half.sidebar, border: `1px solid ${half.border}` }} />
        <span className="text-3xs" style={{ color: half["muted-foreground"] }}>
          Aa
        </span>
      </div>
      <div className="mt-1 flex items-center gap-1.5 px-0.5 font-mono text-4xs tracking-[0.08em] uppercase">
        <span className={cn("min-w-0 truncate", current ? "text-primary" : "text-muted-foreground/70")}>{label}</span>
        {current && <span className="shrink-0 text-muted-foreground/60">· in front of you</span>}
      </div>
    </div>
  );
}

/**
 * THE BASE — one colour, and the sixteen it decides.
 *
 * "The composer's base is the app colour." It is not the canvas literally: it
 * supplies the HUE and how colourful to be, and Telar's lightness spine is kept
 * underneath, which is what makes every base yield a palette whose text sits
 * readably on its surfaces (lib/palette-from-image.ts says so at length). So
 * the swatch beside it is the colour you picked and the strip under it is what
 * the app becomes — the two together are the whole explanation, and neither
 * alone is.
 */
export function BaseControl({ base, label, onChange }: { base: string; label: string; onChange: (next: string) => void }) {
  const hex = cssColorToHex(base);
  return (
    <div className="flex items-center gap-2">
      <input
        type="color"
        value={hex}
        aria-label={label}
        onChange={(event) => onChange(hexToCssColor(event.target.value))}
        className="size-7 shrink-0 cursor-pointer rounded border border-border bg-transparent p-0"
      />
      <HexField value={hex} label={label} onCommit={(next) => onChange(hexToCssColor(next))} />
    </div>
  );
}

/**
 * THE SIXTEEN TOKENS, AS OVERRIDES OVER WHAT THE BASE DERIVED (#471).
 *
 * This was the primary colour control and the owner's complaint about it was
 * exactly that: "you basically need to know how each component of each surface
 * reacts to these and it's complicated to see that." It is an escape hatch now,
 * folded behind a disclosure, and what it edits has changed with it — a value
 * here is a token somebody set BY HAND over the base's own answer, and every
 * token left alone follows the base. Which is why each row can be reverted:
 * clearing an override is a thing you can say, and it was not before.
 *
 * A HAND-SET ROW SAYS SO, and the revert control is the affordance rather than
 * a badge — there is nothing to mark on a row that is merely following, and a
 * row you can put back is self-describing.
 */
export function ColourTool({
  half,
  derived,
  overrides,
  onToken,
}: {
  /** What this state actually paints: the derivation with the hand-set values
   *  over it. */
  half: ThemeHalf;
  /** What the base alone gives — what a revert goes back to. */
  derived: ThemeHalf;
  /** Which tokens are hand-set. Sparse: absent means "follows the base". */
  overrides: Partial<ThemeHalf>;
  mode: CompositionMode;
  /** `undefined` clears the override and hands the token back to the base. */
  onToken: (token: ThemeToken, value: string | undefined) => void;
}) {
  return (
    <ToolBlock>
      {/* ONE COLUMN, BECAUSE EACH ROW NOW CARRIES A SENTENCE (#471). It was two
          columns of name-and-swatch, which fitted only because the name was all
          there was — and a bare name ("Hover", "Rail hover") is legible only to
          somebody who already knows the token. The phrase under it is what
          makes the row answer "where does this paint?", and a phrase needs the
          measure. Sixteen rows are also no longer the first thing on the group:
          they sit behind a disclosure, so their height costs nothing. */}
      <div className="flex flex-col gap-0.5">
        {THEME_TOKENS.map((token) => {
          const hex = cssColorToHex(half[token]);
          const ratio = ratioFor(half, token);
          const set = overrides[token] !== undefined;
          return (
            <label key={token} className="flex items-center gap-2 py-0.5 text-xs" title={`--${token}`}>
              <input
                type="color"
                value={hex}
                aria-label={THEME_TOKEN_LABELS[token]}
                onChange={(event) => onToken(token, hexToCssColor(event.target.value))}
                className="size-6 shrink-0 cursor-pointer rounded border border-border bg-transparent p-0"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{THEME_TOKEN_LABELS[token]}</span>
                <span className="block truncate text-2xs leading-snug text-muted-foreground">{THEME_TOKEN_HINTS[token]}</span>
              </span>
              {ratio !== undefined && (
                <span
                  className={cn("shrink-0 font-mono text-4xs tabular-nums", ratio < READABLE ? "font-semibold text-destructive" : "text-muted-foreground/60")}
                  title={`${ratio.toFixed(1)}:1 against its surface (4.5:1 reads comfortably)`}
                >
                  {ratio.toFixed(1)}
                </span>
              )}
              <HexField value={hex} label={THEME_TOKEN_LABELS[token]} onCommit={(next) => onToken(token, hexToCssColor(next))} />
              <Button
                size="icon-sm"
                variant="ghost"
                className="shrink-0 text-muted-foreground"
                disabled={!set}
                title={set ? `Follow the base again (${cssColorToHex(derived[token])})` : "This one follows the base"}
                aria-label={`Revert ${THEME_TOKEN_LABELS[token]} to the base`}
                onClick={(event) => {
                  // The row is a <label>: without this the click reaches the
                  // colour input and pops the OS picker on every revert.
                  event.preventDefault();
                  onToken(token, undefined);
                }}
              >
                <RotateCcwIcon />
              </Button>
            </label>
          );
        })}
      </div>
    </ToolBlock>
  );
}

/* ------------------------------------------------------------ type & accent */

/**
 * ONE TYPEFACE, ONE FIELD: what it governs, the family, the size, and a
 * specimen underneath. Family and size stay TOGETHER — they are one decision,
 * a face at the wrong size being the wrong face — but they sit on their OWN
 * line, under the caption rather than beside it (#435).
 *
 * WHY THEY MOVED DOWN. The two selects claim a fixed 262px whatever happens,
 * and beside them the caption gets whatever is left. That was ample while this
 * pane ran the full window; in the 42rem reading column every other pane uses
 * it leaves roughly 320px of a 600px card — so both hints sit within a few
 * characters of wrapping, and which of them actually wraps depends on the
 * interface font the reader has chosen. Stacked, the sentence gets the whole
 * measure and the pair gets a line of its own, and neither has to negotiate
 * with the other.
 */
function TypeField({
  title,
  hint,
  family,
  size,
  custom,
  children,
}: {
  title: string;
  hint: string;
  family: React.ReactNode;
  size: React.ReactNode;
  custom?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    // No inset and no hairline of its own — the group card supplies both (see
    // `ToolBlock`). This is a Row's anatomy with a specimen under it rather than
    // a Row, because the specimen is the point and Row has nowhere to put it.
    <div className="py-3">
      <div className="min-w-0">
        <div className="text-xs font-medium">{title}</div>
        <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{hint}</p>
      </div>
      {/* `flex-wrap` is the floor, not the plan: the pair fits the column at
          every size this shell offers, and wrapping only catches a custom
          font name widening the row beneath them. */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {family}
        {size}
      </div>
      {custom && <div className="mt-2">{custom}</div>}
      {/* `min-w-0` so a specimen's own `overflow-x-auto` is what scrolls a long
          line, rather than the block stretching the card past the measure. */}
      <div className="mt-2.5 flex min-w-0 flex-col gap-2">{children}</div>
    </div>
  );
}

/**
 * The family picker. A select rather than a row of pills: this is a value out
 * of a list, and the list grows with every custom face.
 *
 * GROUPED BY WHAT THE FACE IS, NOT BY WHICH SLOT IT IS FOR (#471). Both slots
 * offer the whole catalogue — a reader who wants the entire interface in
 * JetBrains Mono is not making a mistake — but at fifteen faces an ungrouped
 * list is a wall, and "is this one monospaced?" is the question a reader
 * actually brings to it. `MONOSPACED_FONTS` is the seam; the two that name no
 * webfont at all (System, Custom…) stand apart at the end, because neither is
 * a face this app ships.
 */
const FONT_GROUPS: ReadonlyArray<{ heading: string; belongs: (font: string) => boolean }> = [
  { heading: "Proportional", belongs: (font) => font !== "system" && font !== "custom" && !MONOSPACED_FONTS.has(font) },
  { heading: "Monospaced", belongs: (font) => MONOSPACED_FONTS.has(font) },
  { heading: "Yours", belongs: (font) => font === "system" || font === "custom" },
];

function FontSelect<T extends string>({
  value,
  items,
  options,
  onPick,
  label,
}: {
  value: T;
  items: Record<T, string>;
  options: readonly T[];
  onPick: (next: T) => void;
  label: string;
}) {
  return (
    <Select
      value={value}
      items={items}
      onValueChange={(next) => {
        if (typeof next === "string" && (options as readonly string[]).includes(next)) onPick(next as T);
      }}
    >
      <SelectTrigger size="sm" className="w-40" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {FONT_GROUPS.map(({ heading, belongs }) => {
          const members = options.filter((option) => belongs(option));
          if (members.length === 0) return null;
          return (
            <SelectGroup key={heading}>
              <SelectLabel>{heading}</SelectLabel>
              {members.map((option) => (
                <SelectItem key={option} value={option}>
                  {items[option]}
                </SelectItem>
              ))}
            </SelectGroup>
          );
        })}
      </SelectContent>
    </Select>
  );
}

/** Sizes as a list, not a spinner: the useful range is a handful of integers,
 *  and every one of them is a legible choice rather than a number to type. */
function SizeSelect({ value, min, max, label, onPick }: { value: number; min: number; max: number; label: string; onPick: (next: number) => void }) {
  const sizes = Array.from({ length: max - min + 1 }, (_, index) => min + index);
  const items = Object.fromEntries(sizes.map((size) => [String(size), `${size} px`])) as Record<string, string>;
  return (
    <Select
      value={String(value)}
      items={items}
      onValueChange={(next) => {
        const parsed = Number(next);
        if (Number.isInteger(parsed) && parsed >= min && parsed <= max) onPick(parsed);
      }}
    >
      <SelectTrigger size="sm" className="w-24" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {sizes.map((size) => (
          <SelectItem key={size} value={String(size)}>
            {size} px
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}


function AccentSwatches({ value, onChange }: { value: Accent; onChange: (next: Accent) => void }) {
  return (
    <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Accent colour">
      {ACCENTS.map((accent) => {
        const on = accent === value;
        return (
          <button
            key={accent}
            type="button"
            role="radio"
            aria-checked={on}
            title={ACCENT_LABEL[accent]}
            onClick={() => onChange(accent)}
            className={cn("flex size-6 items-center justify-center rounded-full transition-transform hover:scale-110", on && "ring-2 ring-offset-2 ring-offset-card")}
            // The swatch wears the attribute it sets, so its hue comes from the
            // same globals.css block choosing it would use.
            data-accent={accent}
            style={{ ["--tw-ring-color" as string]: "var(--primary)" }}
          >
            <span data-accent={accent} className="flex size-5 items-center justify-center rounded-full bg-primary">
              {on && <CheckIcon className="size-3 text-primary-foreground" />}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function TypeTool({ appearance, onChange }: TypeToolProps) {
  return (
    <>
      <Row
        label="Accent"
        hint="The one hue that means a person acted — buttons, links, the caret."
        control={<AccentSwatches value={appearance.accent} onChange={(accent) => onChange({ accent })} />}
      />

      <TypeField
        title="Interface font"
        hint="Everything outside code blocks and the terminal."
        family={
          <FontSelect value={appearance.fontSans} items={SANS_LABEL} options={SANS_FONTS} onPick={(fontSans) => onChange({ fontSans })} label="Interface font" />
        }
        size={
          <SizeSelect value={appearance.fontSize} min={MIN_FONT_SIZE} max={MAX_FONT_SIZE} label="Interface text size" onPick={(fontSize) => onChange({ fontSize })} />
        }
        custom={
          appearance.fontSans === "custom" ? (
            <Input
              className="w-full"
              value={appearance.fontSansCustom}
              placeholder="e.g. Helvetica Neue"
              aria-label="Custom interface font"
              onChange={(event) => onChange({ fontSansCustom: event.target.value })}
            />
          ) : undefined
        }
      >
        <InterfaceSpecimen />
      </TypeField>

      <TypeField
        title="Code font"
        hint="Code blocks, diffs, file previews, and the terminal."
        family={
          <FontSelect value={appearance.fontMono} items={MONO_LABEL} options={MONO_FONTS} onPick={(fontMono) => onChange({ fontMono })} label="Code font" />
        }
        size={
          <SizeSelect value={appearance.fontMonoSize} min={MIN_MONO_FONT_SIZE} max={MAX_MONO_FONT_SIZE} label="Code text size" onPick={(fontMonoSize) => onChange({ fontMonoSize })} />
        }
        custom={
          appearance.fontMono === "custom" ? (
            <Input
              className="w-full"
              value={appearance.fontMonoCustom}
              placeholder="e.g. SF Mono"
              aria-label="Custom code font"
              onChange={(event) => onChange({ fontMonoCustom: event.target.value })}
            />
          ) : undefined
        }
      >
        <CodeSpecimen />
        <TerminalSpecimen />
      </TypeField>
    </>
  );
}

/**
 * HOW MUCH BACKDROP COMES THROUGH — filed with the backdrop, where it belongs.
 * It rode in the type tool for no better reason than that both are sliders,
 * and a reader hunting for it under "Type" has already learnt that this pane's
 * grouping means nothing.
 */
export function ShowThroughRow({ level, onChange, anchor }: { level: number; onChange: (next: number) => void; anchor?: string }) {
  return (
    // The SAME field is rendered twice — here under the backdrop it thins, and
    // again in the Window group, which is where search points at "Show-through"
    // (settings-registry.ts). Two rows deriving one id would be two elements
    // claiming one anchor, and `document.getElementById` would answer whichever
    // came first, so the backdrop's copy is stamped by hand. One value, two
    // honest homes, one destination.
    <Row
      {...(anchor ? { id: anchor } : {})}
      label="Show-through"
      hint="How much of the backdrop reaches the canvas and the rail."
      control={
        <div className="flex items-center gap-2.5">
          <input
            type="range"
            min={MIN_TRANSLUCENCY}
            max={MAX_TRANSLUCENCY}
            step={5}
            value={level}
            aria-label="Show-through"
            title="How much of the backdrop shows through the canvas and the rail"
            className="w-36 accent-primary"
            onChange={(event) => onChange(Number(event.target.value))}
          />
          <span className="w-9 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{level}%</span>
        </div>
      }
    />
  );
}
