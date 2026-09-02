"use client";

/**
 * THE INSPECTOR'S DRAFT-WRITING TOOLS.
 *
 * Three small editors that write the DRAFT rather than the live stores — the
 * counterpart to the immediate-mode groups they sit beside (the theme library,
 * the backdrop composer, the window controls), which keep writing through as
 * they always have. The division is the one the page's hint states: anything
 * that changes the app you are sitting in is live; anything that changes the
 * picture on the stage is a draft edit waiting on Apply.
 *
 * THE COLOUR ROWS EDIT ONE HALF — whichever the stage is showing. A studio
 * that wrote both halves from one picker would make the Light/Dark toggle a
 * decoration, and the whole reason a theme has two halves is that the answer
 * differs. The toggle in the page header is therefore the mode selector for
 * this tool as much as it is for the preview.
 *
 * THE SCENE TOOL IS DELIBERATELY THE SHALLOW END: one preset, one fade. Layered
 * images, tiling and positioning are a different kind of work — they need the
 * full composer, which is right there in the same tab and writes the live
 * backdrop. This tool exists so a chat-drafted look can be given a different
 * sky without leaving the draft.
 */

import { ACCENTS, MAX_FONT_SIZE, MAX_TRANSLUCENCY, MIN_FONT_SIZE, MIN_TRANSLUCENCY, MONO_FONTS, SANS_FONTS, type Accent, type MonoFont, type SansFont } from "@/lib/appearance";
import { BACKDROP_PRESETS } from "@/lib/backdrop-presets";
import { SCENE_LIMITS } from "@/lib/scene-composer";
import { cssColorToHex, hexToCssColor, THEME_TOKEN_LABELS, THEME_TOKENS } from "@/lib/theme-palettes";
import {
  draftScenePreset,
  patchDraftAccent,
  patchDraftStrength,
  patchDraftToken,
  patchDraftType,
  replaceDraftBackdrop,
  scenePresetBackdrop,
  type StudioDraft,
  type StudioMode,
} from "@/lib/studio-draft";
import { cn } from "@/lib/utils";
import { CheckIcon } from "lucide-react";
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

function ToolBlock({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="px-4 py-3">
      <div className="text-xs font-medium text-foreground">{title}</div>
      {hint && <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{hint}</p>}
      <div className="mt-2.5">{children}</div>
    </div>
  );
}

/* ------------------------------------------------------------- colours */

export function ColourTool({ draft, onDraft, mode }: DraftTool & { mode: StudioMode }) {
  return (
    <ToolBlock
      title={`Surfaces — ${mode} half`}
      hint="The sixteen tokens the stage paints from. Edits stay on the draft; use the light/dark toggle above to reach the other half."
    >
      <div className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
        {THEME_TOKENS.map((token) => {
          const value = draft.theme[mode][token];
          const hex = cssColorToHex(value);
          return (
            <label key={token} className="flex items-center gap-2 py-0.5 text-xs" title={`--${token}`}>
              <input
                type="color"
                value={hex}
                aria-label={THEME_TOKEN_LABELS[token]}
                onChange={(event) => onDraft(patchDraftToken(draft, mode, token, hexToCssColor(event.target.value)))}
                className="size-5 shrink-0 cursor-pointer rounded border border-border bg-transparent p-0"
              />
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{THEME_TOKEN_LABELS[token]}</span>
              <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/70">{hex}</span>
            </label>
          );
        })}
      </div>
    </ToolBlock>
  );
}

/* --------------------------------------------------------------- scene */

/** A preset's own light gradient as the swatch — the same string the backdrop
 *  would paint, so a chip can never disagree with what choosing it does. */
function PresetSwatch({ css }: { css: string }) {
  return <span className="block h-8 w-full rounded-md ring-1 ring-foreground/10" style={{ backgroundImage: css }} />;
}

export function SceneTool({ draft, onDraft, mode }: DraftTool & { mode: StudioMode }) {
  const current = draftScenePreset(draft);
  const fade = current?.opacity ?? SCENE_LIMITS.opacity.max;

  return (
    <>
      <ToolBlock
        title="Backdrop"
        hint="One gradient under the draft. Layered images, tiling and positioning live in the composer below — that one writes the backdrop you are actually wearing."
      >
        <div className="grid grid-cols-3 gap-1.5">
          <button
            type="button"
            onClick={() => onDraft(replaceDraftBackdrop(draft, { kind: "none" }))}
            className={cn(
              "flex h-8 items-center justify-center rounded-md border border-dashed border-border text-[11px] text-muted-foreground transition-colors hover:text-foreground",
              draft.backdrop.kind === "none" && "border-solid border-primary text-foreground",
            )}
          >
            None
          </button>
          {BACKDROP_PRESETS.map((preset) => {
            const on = current?.presetId === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                title={preset.label}
                aria-label={preset.label}
                aria-pressed={on}
                onClick={() => {
                  const backdrop = scenePresetBackdrop(preset.id, fade);
                  if (backdrop) onDraft(replaceDraftBackdrop(draft, backdrop));
                }}
                className={cn("relative rounded-md p-0.5 ring-1 ring-transparent transition-shadow", on && "ring-2 ring-primary")}
              >
                <PresetSwatch css={mode === "light" ? preset.light : preset.dark} />
                {on && (
                  <span className="absolute right-1 top-1 flex size-3.5 items-center justify-center rounded-full bg-primary">
                    <CheckIcon className="size-2.5 text-primary-foreground" />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </ToolBlock>

      {current && (
        <ToolBlock title="Fade" hint="How much of the gradient survives — written into the colours themselves, so it costs nothing to drag.">
          <div className="flex items-center gap-2.5">
            <input
              type="range"
              min={SCENE_LIMITS.opacity.min}
              max={SCENE_LIMITS.opacity.max}
              step={5}
              value={fade}
              aria-label="Backdrop fade"
              className="w-full accent-primary"
              onChange={(event) => {
                const backdrop = scenePresetBackdrop(current.presetId, Number(event.target.value));
                if (backdrop) onDraft(replaceDraftBackdrop(draft, backdrop));
              }}
            />
            <span className="w-9 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{fade}%</span>
          </div>
        </ToolBlock>
      )}

      {(draft.backdrop.kind === "image" || draft.backdrop.kind === "custom-gradient" || draft.backdrop.kind === "gradient") && (
        <ToolBlock title="This draft's backdrop">
          <p className="text-[11px] leading-snug text-muted-foreground">
            {draft.backdrop.kind === "image"
              ? "A photograph. The stage shows it flat — its blur is a filter on the real backdrop, not something a preview can fake. Choosing a preset above replaces it."
              : "A gradient the designer drew. Choosing a preset above replaces it."}
          </p>
        </ToolBlock>
      )}
    </>
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
      <ToolBlock title="Accent" hint="Buttons, links, the focus ring. Part of the draft — the stage's button follows it.">
        <AccentSwatches value={draft.accent} onChange={(accent) => onDraft(patchDraftAccent(draft, accent))} />
      </ToolBlock>

      <ToolBlock title="Interface font">
        <Select
          value={draft.fontSans}
          items={SANS_LABEL}
          onValueChange={(next) => {
            if (typeof next === "string" && (SANS_FONTS as readonly string[]).includes(next)) onDraft(patchDraftType(draft, { fontSans: next as SansFont }));
          }}
        >
          <SelectTrigger size="sm" className="w-full">
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
            className="mt-2"
            value={draft.fontSansCustom}
            placeholder="e.g. Helvetica Neue"
            aria-label="Custom interface font"
            onChange={(event) => onDraft(patchDraftType(draft, { fontSansCustom: event.target.value }))}
          />
        )}
      </ToolBlock>

      <ToolBlock title="Code font">
        <Select
          value={draft.fontMono}
          items={MONO_LABEL}
          onValueChange={(next) => {
            if (typeof next === "string" && (MONO_FONTS as readonly string[]).includes(next)) onDraft(patchDraftType(draft, { fontMono: next as MonoFont }));
          }}
        >
          <SelectTrigger size="sm" className="w-full">
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
            className="mt-2"
            value={draft.fontMonoCustom}
            placeholder="e.g. SF Mono"
            aria-label="Custom code font"
            onChange={(event) => onDraft(patchDraftType(draft, { fontMonoCustom: event.target.value }))}
          />
        )}
      </ToolBlock>

      <ToolBlock title="Text size" hint="The root size everything is measured from. The stage keeps its own scale — a miniature that grew with it would only rescale the mock.">
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

      <ToolBlock title="Strength" hint="How much of the backdrop shows through the canvas and the rail. Shared with the desktop window's translucency.">
        <div className="flex items-center gap-2.5">
          <input
            type="range"
            min={MIN_TRANSLUCENCY}
            max={MAX_TRANSLUCENCY}
            step={5}
            value={draft.translucencyLevel}
            aria-label="Draft translucency strength"
            className="w-full accent-primary"
            onChange={(event) => onDraft(patchDraftStrength(draft, Number(event.target.value)))}
          />
          <span className="w-9 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{draft.translucencyLevel}%</span>
        </div>
      </ToolBlock>
    </>
  );
}
