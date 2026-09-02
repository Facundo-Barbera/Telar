"use client";

/**
 * THE THEME LIBRARY — where a palette comes from.
 *
 * A grid of cards, one per theme; each card carries two preview orbs (the
 * light and dark halves, painted from the theme's own canvas/chip/rail
 * values). Clicking a card LOADS THE THEME INTO THE DRAFT — both halves — and
 * clicking one orb loads only that half, so a pair can be mixed across themes
 * (Ember's day over Tide's night) without a second surface. Neither touches
 * the live stores: the studio previews the draft on the app, and Apply is what
 * wears it. The active rings still mark what you are actually WEARING, which
 * is exactly the distinction the rings are for.
 *
 * Editing colours happens in the studio's own palette tool, on the draft —
 * the old inline live editor is gone, because two colour editors with opposite
 * write models was the pane's worst confusion. The library keeps the jobs only
 * a library can do: duplicate, export, delete, import (Telar's format or a VS
 * Code *-color-theme.json).
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
import { Row, SettingsGroup } from "./settings-shell";

/**
 * The orb: the theme's canvas with its chip and rail breathing at the edges
 * — enough to tell Ember from Tide at a glance. It is also the control for
 * loading that ONE half into the draft.
 */
function ThemeOrb({ theme, mode, active, onUse }: { theme: ThemeDefinition; mode: "light" | "dark"; active: boolean; onUse: () => void }) {
  const half = concreteHalf(theme, mode);
  const label = `Load ${theme.label}'s ${mode} half into the draft`;
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
  active,
  lightActive,
  darkActive,
  onUse,
  onUseHalf,
  onDuplicate,
  onExport,
  onRemove,
}: {
  theme: ThemeDefinition;
  active: boolean;
  lightActive: boolean;
  darkActive: boolean;
  onUse: () => void;
  onUseHalf: (mode: "light" | "dark") => void;
  onDuplicate: () => void;
  onExport?: () => void;
  onRemove?: () => void;
}) {
  return (
    <div
      className={cn(
        "group flex cursor-pointer items-center gap-3 rounded-xl bg-card p-3 ring-1 ring-foreground/10 transition-colors hover:bg-accent/50",
        active && "ring-2 ring-primary",
      )}
      onClick={onUse}
      role="button"
      title={`Load ${theme.label} into the draft`}
      aria-label={`Load ${theme.label} into the draft`}
      aria-pressed={active}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onUse();
        }
      }}
    >
      <div className="flex shrink-0 -space-x-2">
        <ThemeOrb theme={theme} mode="light" active={lightActive} onUse={() => onUseHalf("light")} />
        <ThemeOrb theme={theme} mode="dark" active={darkActive} onUse={() => onUseHalf("dark")} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <span className="truncate">{theme.label}</span>
          {active && <CheckIcon className="size-3.5 shrink-0 text-primary" />}
        </div>
        <div className="text-[0.6875rem] text-muted-foreground">{theme.builtIn ? "Built-in" : "Custom"}</div>
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
          <Button size="icon-sm" variant="ghost" title="Delete" aria-label={`Delete ${theme.label}`} onClick={(event) => (event.stopPropagation(), onRemove())}>
            <Trash2Icon />
          </Button>
        )}
      </div>
    </div>
  );
}

export function ThemeLibrary({
  onPick,
  onPickHalf,
}: {
  /** Load a whole theme into the draft. */
  onPick: (theme: ThemeDefinition) => void;
  /** Load one half into the draft — the orb click. */
  onPickHalf: (mode: "light" | "dark", theme: ThemeDefinition) => void;
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
   * the theme lands in the LIBRARY and is loaded into the draft — never worn
   * directly.
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
    <SettingsGroup
      title="Themes"
      description="Surfaces — canvas, cards, chips, the rail. A card loads its palette into the draft; the accent stays yours across every theme."
    >
      <Row
        label="Library"
        hint={
          importError
            ? importError
            : "Click a theme to load it into the draft, or a single orb to take just that light or dark half. Import also reads a VS Code *-color-theme.json — one file is one half."
        }
        control={
          <Button size="sm" variant="outline" onClick={() => fileInput.current?.click()}>
            <UploadIcon /> Import
          </Button>
        }
      />
      <div className="px-4 py-3">
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
              if (outcome.theme) onPick(outcome.theme);
            });
          }}
        />
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {themes.map((theme) => (
            <ThemeCard
              key={theme.id}
              theme={theme}
              active={active.light === theme.id && active.dark === theme.id}
              lightActive={active.light === theme.id}
              darkActive={active.dark === theme.id}
              onUse={() => onPick(theme)}
              onUseHalf={(mode) => onPickHalf(mode, theme)}
              onDuplicate={() => {
                const copy = duplicate(theme.id);
                if (copy) onPick(copy);
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
    </SettingsGroup>
  );
}
