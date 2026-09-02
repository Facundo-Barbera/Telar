"use client";

/**
 * THE THEME LIBRARY — t3 code's theme settings, on Telar's model.
 *
 * A grid of cards, one per theme; each card carries two preview orbs (the
 * light and dark halves, painted from the theme's own canvas/chip/rail
 * values) and clicking the card wears the theme whole. The orbs are also
 * controls: each wears only ITS half, so the pair can be mixed across themes
 * the way t3 code's sun/moon circles do. Built-ins can be duplicated
 * into custom themes; custom themes get an inline editor (one colour row per
 * surface token, per half), export to a JSON file, and delete. Import reads
 * the same file back.
 *
 * Themes own the SURFACES; the accent row above owns --primary. That split is
 * stated in lib/theme-palettes.ts and it is why this pane has no "action
 * colour" — choosing Ember and then rose is supposed to compose.
 */

import { useRef, useState } from "react";
import { CheckIcon, CopyIcon, DownloadIcon, PenLineIcon, Trash2Icon, UploadIcon } from "lucide-react";
import {
  concreteHalf,
  cssColorToHex,
  hexToCssColor,
  serializeTheme,
  THEME_TOKEN_LABELS,
  THEME_TOKENS,
  useThemeLibrary,
  type ThemeDefinition,
  type ThemeToken,
} from "@/lib/theme-palettes";
import { isVsCodeThemeFile, vsCodeThemeToDefinition } from "@/lib/vscode-theme-import";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Row, Segmented, SettingsGroup } from "./settings-shell";

/**
 * The orb: the theme's canvas with its chip and rail breathing at the edges
 * — enough to tell Ember from Tide at a glance, like t3's preview circles.
 *
 * It is also the control for wearing that ONE half, so a pair can be mixed
 * without a second surface: light from here, dark from there.
 */
function ThemeOrb({ theme, mode, active, onUse }: { theme: ThemeDefinition; mode: "light" | "dark"; active: boolean; onUse: () => void }) {
  const half = concreteHalf(theme, mode);
  const label = `Use ${theme.label}'s ${mode} half`;
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
        // The card body wears both halves; this orb must not also fire it.
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
  onEdit,
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
  onEdit?: () => void;
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
      title={`Use ${theme.label} for both halves`}
      aria-label={`Use ${theme.label} for both halves`}
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
        {onEdit && (
          <Button size="icon-sm" variant="ghost" title="Edit" aria-label={`Edit ${theme.label}`} onClick={(event) => (event.stopPropagation(), onEdit())}>
            <PenLineIcon />
          </Button>
        )}
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

function ThemeEditor({ theme, onSave, onClose }: { theme: ThemeDefinition; onSave: (theme: ThemeDefinition) => void; onClose: () => void }) {
  const [mode, setMode] = useState<"light" | "dark">("dark");
  const [label, setLabel] = useState(theme.label);
  const half = concreteHalf(theme, mode);

  const commit = (token: ThemeToken, value: string) => {
    onSave({ ...theme, label, [mode]: { ...half, [token]: value } });
  };

  return (
    <div className="mt-3 rounded-xl bg-card ring-1 ring-foreground/10">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Input value={label} className="h-8 w-44" aria-label="Theme name" onChange={(event) => setLabel(event.target.value)} onBlur={() => onSave({ ...theme, label })} />
        <Segmented<"light" | "dark">
          value={mode}
          onChange={setMode}
          options={[
            { value: "light", label: "Light half" },
            { value: "dark", label: "Dark half" },
          ]}
        />
        <Button size="sm" variant="ghost" className="ml-auto" onClick={onClose}>
          Done
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 px-4 py-3">
        {THEME_TOKENS.map((token) => (
          <label key={token} className="flex items-center justify-between gap-3 text-xs">
            <span className="text-muted-foreground">{THEME_TOKEN_LABELS[token]}</span>
            <span className="flex items-center gap-1.5">
              <code className="max-w-40 truncate font-mono text-[0.625rem] text-muted-foreground/70">{half[token]}</code>
              <input
                type="color"
                // Edits apply LIVE when this theme is the active one — the
                // store recompiles on every write and the provider repaints.
                value={cssColorToHex(half[token])}
                onChange={(event) => commit(token, hexToCssColor(event.target.value))}
                aria-label={`${THEME_TOKEN_LABELS[token]} colour (${mode})`}
                className="size-6 cursor-pointer rounded border border-border bg-transparent p-0"
              />
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

export function ThemeLibrary() {
  const { active, themes, setActive, setHalf, saveCustom, removeCustom, duplicate, importTheme } = useThemeLibrary();
  const [editingId, setEditingId] = useState<string>();
  // The MESSAGE, not a flag: a VS Code file can fail for a reason worth
  // naming ("no editor.background"), and a bare boolean would flatten that
  // into the generic "not a Telar theme".
  const [importError, setImportError] = useState<string | false>(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const editing = themes.find((theme) => theme.id === editingId && !theme.builtIn);

  /**
   * Telar's own format first, then VS Code's. Both are JSON objects, so the
   * order is the tiebreak: an export of ours never carries dotted workbench
   * keys, and a `*-color-theme.json` never carries our two halves.
   */
  const importFile = (raw: string): string | false => {
    if (importTheme(raw) !== undefined) return false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return "That file is not valid JSON.";
    }
    if (!isVsCodeThemeFile(parsed)) return "That file is not a Telar or VS Code theme.";
    try {
      const definition = vsCodeThemeToDefinition(parsed);
      const id = `custom-${Date.now().toString(36)}`;
      saveCustom({ id, ...definition });
      setActive(id);
      return false;
    } catch (error) {
      return error instanceof Error ? error.message : "That VS Code theme could not be read.";
    }
  };

  return (
    <SettingsGroup
      title="Themes"
      description="Surfaces — canvas, cards, chips, the rail. The accent above stays yours across every theme."
    >
      <Row
        label="Library"
        hint={
          importError
            ? importError
            : "Click a theme to wear it, or a single orb to take just that light or dark half. Import also reads a VS Code *-color-theme.json — one file is one half."
        }
        control={
          <Button
            size="sm"
            variant="outline"
            onClick={() => fileInput.current?.click()}
          >
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
              const failure = importFile(raw);
              setImportError(failure);
              if (!failure) setEditingId(undefined);
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
              onUse={() => setActive(theme.id)}
              onUseHalf={(mode) => setHalf(mode, theme.id)}
              onDuplicate={() => {
                const id = duplicate(theme.id);
                if (id) setEditingId(id);
              }}
              {...(theme.builtIn
                ? {}
                : {
                    onEdit: () => setEditingId(editingId === theme.id ? undefined : theme.id),
                    onExport: () => downloadFile(`${theme.label.toLowerCase().replace(/\s+/g, "-")}.telar-theme.json`, serializeTheme(theme)),
                    onRemove: () => {
                      if (editingId === theme.id) setEditingId(undefined);
                      removeCustom(theme.id);
                    },
                  })}
            />
          ))}
        </div>
        {editing && <ThemeEditor theme={editing} onSave={saveCustom} onClose={() => setEditingId(undefined)} />}
      </div>
    </SettingsGroup>
  );
}
