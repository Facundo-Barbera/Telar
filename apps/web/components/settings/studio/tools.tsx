"use client";

/**
 * THE INSPECTOR'S DRAFT-WRITING TOOLS.
 *
 * The palette rows and the type rows: two editors that take a whole draft and
 * hand a whole draft back, writing no store on the way. They are the pane's
 * one rule in miniature — everything here edits the draft, and the draft is
 * painted on the app itself until Apply makes it the truth.
 *
 * THE BACKDROP LIVES NEXT DOOR, in backdrop-tool.tsx, because it is a
 * different shape of thing: a gallery, a gradient editor, a picture and a
 * layer stack, each of which produces a whole self-contained LookBackdrop
 * rather than a patch to the draft it came from.
 *
 * THE COLOUR ROWS EDIT ONE HALF — whichever the pane is showing. A studio
 * that wrote both halves from one picker would make the Light/Dark toggle a
 * decoration, and the whole reason a theme has two halves is that the answer
 * differs. The toggle in the page header is therefore the mode selector for
 * this tool as much as it is for the preview.
 */

import { useState } from "react";
import { ACCENTS, MAX_FONT_SIZE, MAX_TRANSLUCENCY, MIN_FONT_SIZE, MIN_TRANSLUCENCY, MONO_FONTS, SANS_FONTS, type Accent, type MonoFont, type SansFont } from "@/lib/appearance";
import { cssColorToHex, hexToCssColor, THEME_TOKEN_LABELS, THEME_TOKENS, type ThemeToken } from "@/lib/theme-palettes";
import { FOREGROUND_SURFACES } from "@/lib/theme-designer";
import { contrastRatio, parseVsCodeColor } from "@/lib/vscode-theme-import";
import {
  patchDraftAccent,
  patchDraftHalf,
  patchDraftStrength,
  patchDraftToken,
  patchDraftType,
  type StudioDraft,
  type StudioMode,
} from "@/lib/studio-draft";
import { cn } from "@/lib/utils";
import { CheckIcon, CopyIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export type DraftTool = { draft: StudioDraft; onDraft: (next: StudioDraft) => void };

const SANS_LABEL: Record<SansFont, string> = { geist: "Geist", inter: "Inter", system: "System", custom: "Custom…" };
const MONO_LABEL: Record<MonoFont, string> = { geist: "Geist Mono", jetbrains: "JetBrains Mono", system: "System", custom: "Custom…" };
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

/** A labelled block. The label sits in the left column and the control in the
 *  right, so the tool reads as a list of decisions rather than a wall — and
 *  there is nowhere for a paragraph to grow. What a control does is said by
 *  the control; anything that genuinely needs a sentence gets a `title`. */
function ToolBlock({ title, children }: { title?: string; children: React.ReactNode }) {
  if (!title) return <div className="px-3 py-2.5">{children}</div>;
  return (
    <div className="flex items-center gap-4 border-b border-border px-3 py-2 last:border-b-0">
      <span className="w-32 shrink-0 text-xs font-medium">{title}</span>
      <div className="flex min-w-0 flex-1 justify-end">{children}</div>
    </div>
  );
}

/* ------------------------------------------------------------- colours */

/** The surface each foreground token is judged against — the designer's own
 *  pairing table, inverted for row lookup. Undefined for surface tokens. */
const SURFACE_OF: Partial<Record<ThemeToken, ThemeToken>> = Object.fromEntries(FOREGROUND_SURFACES);

/** WCAG AA for body copy — the bar the designer and the VS Code importer both
 *  repair to; shown here rather than enforced, because a hand edit is a
 *  decision and the studio's job is to say what it costs. */
const READABLE = 4.5;

function ratioFor(draft: StudioDraft, mode: StudioMode, token: ThemeToken): number | undefined {
  const surfaceToken = SURFACE_OF[token];
  if (!surfaceToken) return undefined;
  const fg = parseVsCodeColor(cssColorToHex(draft.theme[mode][token]));
  const bg = parseVsCodeColor(cssColorToHex(draft.theme[mode][surfaceToken]));
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
      className="h-6 w-[4.75rem] shrink-0 px-1.5 font-mono text-[0.625rem] tabular-nums"
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

export function ColourTool({ draft, onDraft, mode }: DraftTool & { mode: StudioMode }) {
  const other: StudioMode = mode === "light" ? "dark" : "light";
  return (
    <ToolBlock>
      <div className="grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-2 xl:grid-cols-3">
        {THEME_TOKENS.map((token) => {
          const value = draft.theme[mode][token];
          const hex = cssColorToHex(value);
          const ratio = ratioFor(draft, mode, token);
          return (
            <label key={token} className="flex items-center gap-1.5 py-0.5 text-xs" title={`--${token}`}>
              <input
                type="color"
                value={hex}
                aria-label={THEME_TOKEN_LABELS[token]}
                onChange={(event) => onDraft(patchDraftToken(draft, mode, token, hexToCssColor(event.target.value)))}
                className="size-5 shrink-0 cursor-pointer rounded border border-border bg-transparent p-0"
              />
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{THEME_TOKEN_LABELS[token]}</span>
              {ratio !== undefined && (
                <span
                  className={cn("shrink-0 font-mono text-[0.5625rem] tabular-nums", ratio < READABLE ? "font-semibold text-destructive" : "text-muted-foreground/60")}
                  title={`${ratio.toFixed(1)}:1 against its surface (4.5:1 reads comfortably)`}
                >
                  {ratio.toFixed(1)}
                </span>
              )}
              <HexField value={hex} label={THEME_TOKEN_LABELS[token]} onCommit={(next) => onDraft(patchDraftToken(draft, mode, token, hexToCssColor(next)))} />
            </label>
          );
        })}
      </div>
      <div className="mt-2.5">
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-[0.6875rem] text-muted-foreground"
          title={`Replace the ${other} half with a copy of the ${mode} half`}
          onClick={() => onDraft(patchDraftHalf(draft, other, { ...draft.theme[mode] }))}
        >
          <CopyIcon /> Copy {mode} half → {other}
        </Button>
      </div>
    </ToolBlock>
  );
}

/* ------------------------------------------------------------ type & accent */

function AccentSwatches({ value, onChange }: { value: Accent; onChange: (next: Accent) => void }) {
  return (
    <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Draft accent colour">
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

export function TypeTool({ draft, onDraft }: DraftTool) {
  return (
    <>
      <ToolBlock title="Accent">
        <AccentSwatches value={draft.accent} onChange={(accent) => onDraft(patchDraftAccent(draft, accent))} />
      </ToolBlock>

      <ToolBlock title="Interface font">
        <div className="flex flex-col items-end gap-2">
        <Select
          value={draft.fontSans}
          items={SANS_LABEL}
          onValueChange={(next) => {
            if (typeof next === "string" && (SANS_FONTS as readonly string[]).includes(next)) onDraft(patchDraftType(draft, { fontSans: next as SansFont }));
          }}
        >
          <SelectTrigger size="sm" className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SANS_FONTS.map((font) => (
              <SelectItem key={font} value={font}>
                {SANS_LABEL[font]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {draft.fontSans === "custom" && (
          <Input
            className="w-48"
            value={draft.fontSansCustom}
            placeholder="e.g. Helvetica Neue"
            aria-label="Custom interface font"
            onChange={(event) => onDraft(patchDraftType(draft, { fontSansCustom: event.target.value }))}
          />
        )}
        </div>
      </ToolBlock>

      <ToolBlock title="Code font">
        <div className="flex flex-col items-end gap-2">
        <Select
          value={draft.fontMono}
          items={MONO_LABEL}
          onValueChange={(next) => {
            if (typeof next === "string" && (MONO_FONTS as readonly string[]).includes(next)) onDraft(patchDraftType(draft, { fontMono: next as MonoFont }));
          }}
        >
          <SelectTrigger size="sm" className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MONO_FONTS.map((font) => (
              <SelectItem key={font} value={font}>
                {MONO_LABEL[font]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {draft.fontMono === "custom" && (
          <Input
            className="w-48"
            value={draft.fontMonoCustom}
            placeholder="e.g. SF Mono"
            aria-label="Custom code font"
            onChange={(event) => onDraft(patchDraftType(draft, { fontMonoCustom: event.target.value }))}
          />
        )}
        </div>
      </ToolBlock>

      <ToolBlock title="Text size">
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={MIN_FONT_SIZE}
            max={MAX_FONT_SIZE}
            step={1}
            value={draft.fontSize}
            aria-label="Draft text size in pixels"
            className="w-20"
            onChange={(event) => {
              const next = Number(event.target.value);
              // Out-of-range keystrokes are ignored rather than clamped, so
              // typing "1" on the way to "14" does not snap to 13.
              if (Number.isFinite(next) && next >= MIN_FONT_SIZE && next <= MAX_FONT_SIZE) onDraft(patchDraftType(draft, { fontSize: next }));
            }}
          />
          <span className="text-xs text-muted-foreground">px</span>
        </div>
      </ToolBlock>
    </>
  );
}

/**
 * HOW MUCH BACKDROP COMES THROUGH — filed with the backdrop, where it belongs.
 * It rode in the type tool for no better reason than that both are sliders,
 * and a reader hunting for it under "Type" has already learnt that this pane's
 * grouping means nothing.
 */
export function ShowThroughTool({ draft, onDraft }: DraftTool) {
  return (
    <ToolBlock title="Show-through">
      <div className="flex items-center gap-2.5">
        <input
          type="range"
          min={MIN_TRANSLUCENCY}
          max={MAX_TRANSLUCENCY}
          step={5}
          value={draft.translucencyLevel}
          aria-label="Draft translucency strength"
          title="How much of the backdrop shows through the canvas and the rail"
          className="w-36 accent-primary"
          onChange={(event) => onDraft(patchDraftStrength(draft, Number(event.target.value)))}
        />
        <span className="w-9 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{draft.translucencyLevel}%</span>
      </div>
    </ToolBlock>
  );
}
