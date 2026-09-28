"use client";

import {
  ACCENTS,
  MAX_FONT_SIZE,
  MAX_MONO_FONT_SIZE,
  MAX_TRANSLUCENCY,
  MIN_FONT_SIZE,
  MIN_MONO_FONT_SIZE,
  MIN_TRANSLUCENCY,
  APP_FONTS,
  MONOSPACED_FONTS,
  type Accent,
  type Appearance,
  type AppFont,
} from "../../appearance";
import {
  cssColorToHex,
  FOREGROUND_SURFACES,
  hexToCssColor,
  THEME_TOKEN_HINTS,
  THEME_TOKEN_LABELS,
  THEME_TOKENS,
  type ThemeHalf,
  type ThemeToken,
} from "../../theme-palettes";
import { contrastRatio, parseVsCodeColor } from "../../vscode-theme-import";
import { STATE_INK, TINT_FLOOR, tintCost } from "../../tint-separation";
import type { CompositionMode } from "../../composition";
import { cn } from "@/ui/utils";
import { CheckIcon, RotateCcwIcon } from "lucide-react";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/ui/select";
import { Row } from "@/features/settings";
import { HexField } from "./hex-field";
import { CodeSpecimen, InterfaceSpecimen, TerminalSpecimen } from "./type-specimen";

export type TypeToolProps = { appearance: Appearance; onChange: (patch: Partial<Appearance>) => void };

export const SANS_LABEL: Record<AppFont, string> = {
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
export const MONO_LABEL: Record<AppFont, string> = { ...SANS_LABEL, geist: "Geist Mono" };
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

function ToolBlock({ children }: { children: React.ReactNode }) {
  return <div className="py-2.5">{children}</div>;
}

const SURFACE_OF: Partial<Record<ThemeToken, ThemeToken>> = Object.fromEntries(FOREGROUND_SURFACES);

const READABLE = 4.5;

type RowRatio = { value: number; about: string };

function ratioFor(half: ThemeHalf, token: ThemeToken, mode: CompositionMode): RowRatio | undefined {
  if (token === "card") {
    const { readability, tone } = tintCost(half.card, STATE_INK[mode], TINT_FLOOR);
    return { value: readability, about: `for text-${tone} on .tint-${tone}, the worst of the three semantic tints on this card` };
  }
  const surfaceToken = SURFACE_OF[token];
  if (!surfaceToken) return undefined;
  const fg = parseVsCodeColor(cssColorToHex(half[token]));
  const bg = parseVsCodeColor(cssColorToHex(half[surfaceToken]));
  if (!fg || !bg) return undefined;
  return { value: contrastRatio(fg, bg), about: `against ${THEME_TOKEN_LABELS[surfaceToken].toLowerCase()}` };
}

export function PaletteStrip({ half, label, current }: { half: ThemeHalf; label: string; current: boolean }) {
  return (
    <div className="min-w-0 flex-1">
      <div
        className={cn("flex h-14 items-center gap-1.5 overflow-hidden rounded-lg px-2 ring-1 ring-inset", current ? "ring-primary" : "ring-foreground/10")}
        style={{ background: half.background }}
      >
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

export function ColourTool({
  half,
  derived,
  overrides,
  mode,
  onToken,
}: {
  half: ThemeHalf;
  derived: ThemeHalf;
  overrides: Partial<ThemeHalf>;
  mode: CompositionMode;
  onToken: (token: ThemeToken, value: string | undefined) => void;
}) {
  return (
    <ToolBlock>
      <div className="flex flex-col gap-0.5">
        {THEME_TOKENS.map((token) => {
          const hex = cssColorToHex(half[token]);
          const ratio = ratioFor(half, token, mode);
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
                  className={cn("shrink-0 font-mono text-4xs tabular-nums", ratio.value < READABLE ? "font-semibold text-destructive" : "text-muted-foreground/60")}
                  title={`${ratio.value.toFixed(1)}:1 ${ratio.about} (4.5:1 reads comfortably)`}
                >
                  {ratio.value.toFixed(1)}
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
    <div className="py-3">
      <div className="min-w-0">
        <div className="text-xs font-medium">{title}</div>
        <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{hint}</p>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {family}
        {size}
      </div>
      {custom && <div className="mt-2">{custom}</div>}
      <div className="mt-2.5 flex min-w-0 flex-col gap-2">{children}</div>
    </div>
  );
}

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
          <FontSelect value={appearance.fontSans} items={SANS_LABEL} options={APP_FONTS} onPick={(fontSans) => onChange({ fontSans })} label="Interface font" />
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
          <FontSelect value={appearance.fontMono} items={MONO_LABEL} options={APP_FONTS} onPick={(fontMono) => onChange({ fontMono })} label="Code font" />
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

export function ShowThroughRow({ level, onChange, anchor }: { level: number; onChange: (next: number) => void; anchor?: string }) {
  return (
    <Row
      {...(anchor ? { id: anchor } : {})}
      label="Layers through canvas and rail"
      info="With Translucency on, this also sets how much of the desktop shows behind the window."
      control={
        <div className="flex items-center gap-2.5">
          <input
            type="range"
            min={MIN_TRANSLUCENCY}
            max={MAX_TRANSLUCENCY}
            step={5}
            value={level}
            aria-label="Layers through canvas and rail"
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
