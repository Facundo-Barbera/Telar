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

import { useState } from "react";
import {
  ACCENTS,
  MAX_FONT_SIZE,
  MAX_MONO_FONT_SIZE,
  MAX_TRANSLUCENCY,
  MIN_FONT_SIZE,
  MIN_MONO_FONT_SIZE,
  MIN_TRANSLUCENCY,
  MONO_FONTS,
  SANS_FONTS,
  type Accent,
  type Appearance,
  type MonoFont,
  type SansFont,
} from "@/lib/appearance";
import { cssColorToHex, hexToCssColor, THEME_TOKEN_LABELS, THEME_TOKENS, type ThemeHalf, type ThemeToken } from "@/lib/theme-palettes";
import { FOREGROUND_SURFACES } from "@/lib/theme-designer";
import { contrastRatio, parseVsCodeColor } from "@/lib/vscode-theme-import";
import type { StudioMode } from "@/lib/studio-draft";
import { cn } from "@/lib/utils";
import { CheckIcon, CopyIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Row } from "../settings-shell";
import { CodeSpecimen, InterfaceSpecimen, TerminalSpecimen } from "./type-specimen";

/** What the type rows read and write: the live appearance, and the store's own
 *  patch function. */
export type TypeToolProps = { appearance: Appearance; onChange: (patch: Partial<Appearance>) => void };

// The SAME catalogue in both slots; only the name of the shared `geist` id
// differs, because Geist and Geist Mono are what it has always meant in each.
const SANS_LABEL: Record<SansFont, string> = {
  geist: "Geist",
  inter: "Inter",
  "plex-sans": "IBM Plex Sans",
  jetbrains: "JetBrains Mono",
  "plex-mono": "IBM Plex Mono",
  "fira-code": "Fira Code",
  system: "System",
  custom: "Custom…",
};
const MONO_LABEL: Record<MonoFont, string> = { ...SANS_LABEL, geist: "Geist Mono" };
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
 * The hex, TYPEABLE. `<input type="color">` cannot accept a pasted `#1e1e2e`,
 * and building a palette through 32 OS colour dialogs was the old editor's
 * worst chore. The field holds free text while focused and commits on Enter or
 * blur — only a well-formed hex lands; anything else snaps back.
 */
function HexField({ value, label, onCommit }: { value: string; label: string; onCommit: (hex: string) => void }) {
  // `text` only means anything while focused — display falls back to `value`
  // otherwise, so no effect has to chase external changes.
  const [text, setText] = useState(value);
  const [editing, setEditing] = useState(false);
  const commit = () => {
    setEditing(false);
    const bare = text.trim().replace(/^([0-9a-f]{6}|[0-9a-f]{3})$/i, "#$1");
    if (/^#[0-9a-f]{6}$/i.test(bare)) onCommit(bare.toLowerCase());
    else if (/^#[0-9a-f]{3}$/i.test(bare)) onCommit(`#${[...bare.slice(1)].map((c) => c + c).join("")}`.toLowerCase());
    else setText(value);
  };
  return (
    <Input
      value={editing ? text : value}
      aria-label={`${label} hex value`}
      spellCheck={false}
      className="h-6 w-[4.75rem] shrink-0 px-1.5 font-mono text-3xs tabular-nums"
      onFocus={() => {
        setEditing(true);
        setText(value);
      }}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        }
        if (event.key === "Escape") {
          setEditing(false);
          setText(value);
        }
      }}
    />
  );
}

export function ColourTool({
  half,
  mode,
  onToken,
  onCopyHalf,
}: {
  /** The half being edited, concrete — the palette the window is wearing on
   *  this side, never a draft of one. */
  half: ThemeHalf;
  mode: StudioMode;
  onToken: (token: ThemeToken, value: string) => void;
  /** Replace the OTHER half with a copy of this one. */
  onCopyHalf: () => void;
}) {
  const other: StudioMode = mode === "light" ? "dark" : "light";
  return (
    <ToolBlock>
      {/* TWO COLUMNS IS THE CEILING NOW (#435). The third tier was keyed to the
          VIEWPORT, not to this card — so on a wide window the sixteen rows
          would still split three ways inside the 42rem reading column. A row
          here spends about 130px on things that cannot shrink (the swatch, the
          contrast figure, a hex field wide enough to type into), which left
          each token name under 60px of the 189 a third of the card is: every
          label truncated to a word and a half. Two columns is the narrowest
          split that fits all four parts honestly. */}
      <div className="grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-2">
        {THEME_TOKENS.map((token) => {
          const hex = cssColorToHex(half[token]);
          const ratio = ratioFor(half, token);
          return (
            <label key={token} className="flex items-center gap-1.5 py-0.5 text-xs" title={`--${token}`}>
              <input
                type="color"
                value={hex}
                aria-label={THEME_TOKEN_LABELS[token]}
                onChange={(event) => onToken(token, hexToCssColor(event.target.value))}
                className="size-5 shrink-0 cursor-pointer rounded border border-border bg-transparent p-0"
              />
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{THEME_TOKEN_LABELS[token]}</span>
              {ratio !== undefined && (
                <span
                  className={cn("shrink-0 font-mono text-4xs tabular-nums", ratio < READABLE ? "font-semibold text-destructive" : "text-muted-foreground/60")}
                  title={`${ratio.toFixed(1)}:1 against its surface (4.5:1 reads comfortably)`}
                >
                  {ratio.toFixed(1)}
                </span>
              )}
              <HexField value={hex} label={THEME_TOKEN_LABELS[token]} onCommit={(next) => onToken(token, hexToCssColor(next))} />
            </label>
          );
        })}
      </div>
      <div className="mt-2.5">
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-2xs text-muted-foreground"
          title={`Replace the ${other} half with a copy of the ${mode} half`}
          onClick={onCopyHalf}
        >
          <CopyIcon /> Copy {mode} half → {other}
        </Button>
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

/** The family picker. A select rather than a row of pills: this is a value out
 *  of a list, and the list grows with every custom face. */
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
        {options.map((option) => (
          <SelectItem key={option} value={option}>
            {items[option]}
          </SelectItem>
        ))}
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
