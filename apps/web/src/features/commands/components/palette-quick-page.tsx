"use client";

import { useListNav } from "@/ui/hooks/use-list-nav";
import { useState } from "react";
import { CheckIcon, SearchIcon } from "lucide-react";
import { PaletteRow as Row } from "@/features/projects";
import { DialogDescription, DialogTitle } from "@/ui/dialog";

export function PaletteQuickPage({
  title,
  placeholder,
  rows,
  notice,
  onPick,
  onBack,
}: {
  title: string;
  placeholder: string;
  rows: readonly { key: string; glyph: React.ReactNode; title: string; hint?: string; on?: boolean }[];
  notice?: string;
  onPick: (key: string) => void;
  onBack: () => void;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLocaleLowerCase();
  const shown = needle ? rows.filter((row) => `${row.title} ${row.hint ?? ""}`.toLocaleLowerCase().includes(needle)) : [...rows];
  const nav = useListNav({ count: shown.length, onPick: (at) => onPick(shown[at]!.key), idPrefix: "command-palette-quick" });

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Backspace" && query === "") {
      event.preventDefault();
      onBack();
      return;
    }
    nav.onKeyDown(event);
  };

  return (
    <div className="contents" onKeyDown={onKeyDown}>
      <DialogTitle className="sr-only">{title}</DialogTitle>
      <DialogDescription className="sr-only">{placeholder}</DialogDescription>
      <div className="flex items-center gap-2 border-b px-3 py-2.5">
        <SearchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <input
          autoFocus
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            nav.setActive(0);
          }}
          placeholder={placeholder}
          aria-label={placeholder}
          role="combobox"
          aria-expanded={shown.length > 0}
          aria-controls="command-palette-quick-results"
          aria-activedescendant={nav.activeId}
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>
      <div id="command-palette-quick-results" role="listbox" aria-label={title} className="max-h-80 overflow-y-auto p-1.5">
        {shown.length === 0 && <p className="px-2 py-6 text-center text-xs text-muted-foreground">Nothing matches that.</p>}
        {shown.map((row, rowAt) => (
          <Row
            key={row.key}
            id={nav.optionProps(rowAt).id}
            on={rowAt === nav.active}
            onPick={() => onPick(row.key)}
            onHover={() => nav.setActive(rowAt)}
            glyph={row.glyph}
            title={row.title}
            {...(row.hint ? { hint: row.hint } : {})}
            {...(row.on ? { trailing: <CheckIcon className="size-3.5 shrink-0 text-muted-foreground" /> } : {})}
          />
        ))}
      </div>
      {notice && <p className="border-t px-3 py-2 text-2xs text-muted-foreground">{notice}</p>}
      <div className="flex items-center gap-4 border-t px-3 py-2 text-2xs text-muted-foreground">
        <span>
          <kbd className="font-sans">↑↓</kbd> Navigate
        </span>
        <span>
          <kbd className="font-sans">Enter</kbd> Select
        </span>
        <span>
          <kbd className="font-sans">Backspace</kbd> Back
        </span>
      </div>
    </div>
  );
}
