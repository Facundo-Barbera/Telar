"use client";

/**
 * THE THEME LIBRARY — where a palette comes from.
 *
 * A grid of cards, one per theme; each card carries two preview orbs (the
 * light and dark halves, painted from the theme's own canvas/chip/rail
 * values). Clicking a card WEARS the theme on both halves, and clicking one orb
 * wears only that half, so a pair can be mixed across themes (Ember's day over
 * Tide's night) without a second surface.
 *
 * ONE GESTURE, ONE MEANING (#471). There used to be two: a click LOADED the
 * theme into a draft and a hover-revealed Wear button applied it, so the rings
 * marked what you were editing while a separate WORN chip marked what the
 * window had on — two facts the reader had to hold apart, for a draft that no
 * longer exists. The rings mark the worn pair, and that is the only fact here.
 *
 * Editing colours happens in the palette rows above, which write the worn theme
 * directly (`editActiveHalf` in lib/theme-palettes.ts). The library keeps the
 * jobs only a library can do: duplicate, export, delete, import (Telar's format
 * or a VS Code *-color-theme.json).
 */

import { useRef, useState } from "react";
import { CheckIcon, CopyIcon, DownloadIcon, Trash2Icon, UploadIcon } from "lucide-react";
import {
  concreteHalf,
  serializeTheme,
  useThemeLibrary,
  type ThemeDefinition,
} from "@/lib/theme-palettes";
import { isVsCodeThemeFile, vsCodeThemeToDefinition } from "@/lib/vscode-theme-import";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { GroupStrip } from "./studio/tool-strip";

/**
 * The orb: the theme's canvas with its chip and rail breathing at the edges
 * — enough to tell Ember from Tide at a glance. It is also the control for
 * loading that ONE half into the draft.
 */
function ThemeOrb({ theme, mode, active, onUse }: { theme: ThemeDefinition; mode: "light" | "dark"; active: boolean; onUse: () => void }) {
  const half = concreteHalf(theme, mode);
  const label = `Wear ${theme.label}'s ${mode} half`;
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      // z-10 so an active ring is not clipped by the orb overlapping it.
      className={cn("relative size-9 shrink-0 rounded-full ring-1 ring-foreground/15 transition-shadow", active && "z-10 ring-2 ring-primary")}
      style={{
        background: `radial-gradient(circle at 30% 70%, ${half.secondary} 0%, transparent 55%), radial-gradient(circle at 72% 25%, ${half["sidebar-accent"]} 0%, transparent 60%), ${half.background}`,
      }}
      onClick={(event) => {
        // The card body loads both halves; this orb must not also fire it.
        event.stopPropagation();
        onUse();
      }}
    />
  );
}

function downloadFile(filename: string, contents: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // Revoking synchronously can abort the download; give the stream a moment.
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function ThemeCard({
  theme,
  worn,
  lightWorn,
  darkWorn,
  onWear,
  onWearHalf,
  onDuplicate,
  onExport,
  onRemove,
}: {
  theme: ThemeDefinition;
  /** Both halves are wearing this theme. */
  worn: boolean;
  lightWorn: boolean;
  darkWorn: boolean;
  onWear: () => void;
  onWearHalf: (mode: "light" | "dark") => void;
  onDuplicate: () => void;
  onExport?: () => void;
  onRemove?: () => void;
}) {
  return (
    <div
      className={cn(
        "group flex cursor-pointer items-center gap-2.5 rounded-lg p-2 ring-1 transition-colors",
        worn ? "ring-2 ring-primary" : "ring-foreground/10 hover:bg-accent/50",
      )}
      onClick={onWear}
      role="button"
      title={`Wear ${theme.label}`}
      aria-label={`Wear ${theme.label}`}
      aria-pressed={worn}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onWear();
        }
      }}
    >
      <div className="flex shrink-0 -space-x-2">
        <ThemeOrb theme={theme} mode="light" active={lightWorn} onUse={() => onWearHalf("light")} />
        <ThemeOrb theme={theme} mode="dark" active={darkWorn} onUse={() => onWearHalf("dark")} />
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-1.5 text-sm font-medium">
        <span className="truncate">{theme.label}</span>
        {worn && <CheckIcon className="size-3.5 shrink-0 text-primary" />}
      </div>
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <Button size="icon-sm" variant="ghost" title="Duplicate" aria-label={`Duplicate ${theme.label}`} onClick={(event) => (event.stopPropagation(), onDuplicate())}>
          <CopyIcon />
        </Button>
        {onExport && (
          <Button size="icon-sm" variant="ghost" title="Export" aria-label={`Export ${theme.label}`} onClick={(event) => (event.stopPropagation(), onExport())}>
            <DownloadIcon />
          </Button>
        )}
        {onRemove && (
          // WHAT DELETING DOES NOT DESTROY, on the control that does it. A bare
          // "Delete" left the reader to guess whether the window they are
          // looking at goes with it; `dropTheme` puts each half back to Telar's
          // own, and nothing else is touched.
          <Button
            size="icon-sm"
            variant="ghost"
            title="Delete this theme. If it is worn, the window falls back to Telar's own; nothing else changes."
            aria-label={`Delete ${theme.label}`}
            onClick={(event) => (event.stopPropagation(), onRemove())}
          >
            <Trash2Icon />
          </Button>
        )}
      </div>
    </div>
  );
}

export function ThemeLibrary({
  onWear,
  onWearHalf,
}: {
  /** Wear a whole theme — both halves. */
  onWear: (theme: ThemeDefinition) => void;
  /** Wear one half of it — the orb click. */
  onWearHalf: (mode: "light" | "dark", theme: ThemeDefinition) => void;
}) {
  const { active, themes, saveCustom, removeCustom, duplicate, importTheme } = useThemeLibrary();
  // The MESSAGE, not a flag: a VS Code file can fail for a reason worth
  // naming ("no editor.background"), and a bare boolean would flatten that
  // into the generic "not a Telar theme".
  const [importError, setImportError] = useState<string | false>(false);
  const fileInput = useRef<HTMLInputElement>(null);

  /**
   * Telar's own format first, then VS Code's. Both are JSON objects, so the
   * order is the tiebreak: an export of ours never carries dotted workbench
   * keys, and a `*-color-theme.json` never carries our two halves. Either way
   * the theme lands in the LIBRARY and is then worn, which is the one road a
   * palette reaches the window by.
   */
  const importFile = (raw: string): { error: string | false; theme?: ThemeDefinition } => {
    const imported = importTheme(raw);
    if (imported !== undefined) return { error: false, theme: imported };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { error: "That file is not valid JSON." };
    }
    if (!isVsCodeThemeFile(parsed)) return { error: "That file is not a Telar or VS Code theme." };
    try {
      const definition = vsCodeThemeToDefinition(parsed);
      const theme: ThemeDefinition = { id: `custom-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`, ...definition };
      saveCustom(theme);
      return { error: false, theme };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "That VS Code theme could not be read." };
    }
  };

  return (
    // NO PANEL OF ITS OWN (#399). The library is the second half of the Colour
    // group, and a card inside the group's card is the one shape the settings
    // grammar cannot absorb. These are direct children of that card now, so the
    // inset and the hairlines between them come from it.
    <>
      <GroupStrip
        label="Themes"
        count={themes.length}
        actions={
          <Button size="icon-sm" variant="ghost" title="Import a Telar or VS Code theme" aria-label="Import a theme" onClick={() => fileInput.current?.click()}>
            <UploadIcon />
          </Button>
        }
      />
      <input
        ref={fileInput}
        type="file"
        accept="application/json,.json"
        className="hidden"
        aria-hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          void file.text().then((raw) => {
            const outcome = importFile(raw);
            setImportError(outcome.error);
            if (outcome.theme) onWear(outcome.theme);
          });
        }}
      />
      {importError && <p className="py-1.5 text-xs text-warning">{importError}</p>}
      <div className="py-2">
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
          {themes.map((theme) => (
            <ThemeCard
              key={theme.id}
              theme={theme}
              worn={active.light === theme.id && active.dark === theme.id}
              lightWorn={active.light === theme.id}
              darkWorn={active.dark === theme.id}
              onWear={() => onWear(theme)}
              onWearHalf={(mode) => onWearHalf(mode, theme)}
              onDuplicate={() => {
                const copy = duplicate(theme.id);
                if (copy) onWear(copy);
              }}
              {...(theme.builtIn
                ? {}
                : {
                    onExport: () => downloadFile(`${theme.label.toLowerCase().replace(/\s+/g, "-")}.telar-theme.json`, serializeTheme(theme)),
                    onRemove: () => removeCustom(theme.id),
                  })}
            />
          ))}
        </div>
      </div>
    </>
  );
}
