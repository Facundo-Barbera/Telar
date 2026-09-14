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
 * THE RINGS MARK WHAT YOU ARE EDITING, NOT WHAT YOU ARE WEARING. They used to
 * mark the worn pair, which is the one thing a reader can already see by
 * looking at the app. After loading Ember into the draft the grid went on
 * pointing at Telar, so the only question the grid could answer — "which of
 * these am I working on?" — was the one it got wrong. `holding` is the draft's
 * own provenance (matchThemeHalf); the worn theme keeps a quieter WORN chip,
 * because "installed" and "open in the editor" are different facts and the
 * pane now says both.
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
import { GroupStrip } from "./studio/tool-strip";

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
  worn,
  lightActive,
  darkActive,
  onUse,
  onWear,
  onUseHalf,
  onDuplicate,
  onExport,
  onRemove,
}: {
  theme: ThemeDefinition;
  active: boolean;
  worn: boolean;
  lightActive: boolean;
  darkActive: boolean;
  onUse: () => void;
  /** Wear this palette over the look you have on — Apply, from the card. */
  onWear: () => void;
  onUseHalf: (mode: "light" | "dark") => void;
  onDuplicate: () => void;
  onExport?: () => void;
  onRemove?: () => void;
}) {
  return (
    <div
      className={cn(
        "group flex cursor-pointer items-center gap-2.5 rounded-lg p-2 ring-1 transition-colors",
        active ? "ring-2 ring-primary" : "ring-foreground/10 hover:bg-accent/50",
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
      <div className="flex min-w-0 flex-1 items-center gap-1.5 text-sm font-medium">
        <span className="truncate">{theme.label}</span>
        {active && <CheckIcon className="size-3.5 shrink-0 text-primary" />}
        {worn && (
          <span className="shrink-0 font-mono text-[0.5625rem] tracking-[0.08em] text-muted-foreground/70 uppercase" title="The theme this window is wearing">
            Worn
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        {!worn && (
          <Button size="sm" variant="secondary" className="h-7" title={`Wear ${theme.label}'s colours now`} onClick={(event) => (event.stopPropagation(), onWear())}>
            Wear
          </Button>
        )}
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
  onPick,
  onPickHalf,
  onWear,
  holding,
}: {
  /** Load a whole theme into the draft. */
  onPick: (theme: ThemeDefinition) => void;
  /** Load one half into the draft — the orb click. */
  onPickHalf: (mode: "light" | "dark", theme: ThemeDefinition) => void;
  /** Wear this palette over the current look, without the trip to Apply. */
  onWear: (theme: ThemeDefinition) => void;
  /** Which theme each half of the DRAFT currently holds, if any — what the
   *  rings mark. Undefined halves mean "edited by hand, matching nothing". */
  holding: { light?: string; dark?: string };
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
            if (outcome.theme) onPick(outcome.theme);
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
              active={holding.light === theme.id && holding.dark === theme.id}
              worn={active.light === theme.id && active.dark === theme.id}
              lightActive={holding.light === theme.id}
              darkActive={holding.dark === theme.id}
              onUse={() => onPick(theme)}
              onWear={() => onWear(theme)}
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
    </>
  );
}
