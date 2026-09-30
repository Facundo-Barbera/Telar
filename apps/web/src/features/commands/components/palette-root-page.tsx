"use client";

import { MessageSquareIcon as SessionGlyph, SearchIcon } from "lucide-react";
import { ProjectAvatar, PaletteRow as Row, targetPlace } from "@/features/projects";
import type { SidebarSession } from "@/features/sessions";
import type { ListNav } from "@/ui/hooks/use-list-nav";
import { DialogDescription, DialogTitle } from "@/ui/dialog";
import { KeyHint } from "./key-hint";
import type { PaletteRow as PaletteRowModel, PaletteSection } from "../palette-model";
import { commandIcon, iconByName } from "../command-icons";

type RootRow = PaletteRowModel<SidebarSession>;

function glyphOf(Glyph: ReturnType<typeof iconByName>) {
  return Glyph ? <Glyph className="size-4 text-muted-foreground" /> : null;
}

function RootResult({ row, id, on, onPick, onHover }: { row: RootRow; id: string; on: boolean; onPick: () => void; onHover: () => void }) {
  const shared = { id, on, onPick, onHover };
  if (row.kind === "quick") {
    return (
      <Row
        {...shared}
        glyph={glyphOf(iconByName(row.icon))}
        title={row.label}
        trailing={row.value ? <span className="shrink-0 text-2xs text-muted-foreground">{row.value}</span> : undefined}
      />
    );
  }
  if (row.kind === "action") {
    return <Row {...shared} glyph={glyphOf(commandIcon(row.id))} title={row.label} trailing={<KeyHint command={row.id} always />} />;
  }
  if (row.kind === "project") {
    return (
      <Row
        {...shared}
        glyph={
          <ProjectAvatar
            name={row.target.name}
            projectId={row.target.id}
            {...(row.target.hostId ? { hostId: row.target.hostId } : {})}
            {...(row.target.icon ? { icon: row.target.icon } : {})}
            {...(row.target.iconName ? { iconName: row.target.iconName } : {})}
            size={16}
          />
        }
        title={row.target.name}
        hint={targetPlace(row.target)}
        mono
      />
    );
  }
  return (
    <Row
      {...shared}
      glyph={<SessionGlyph className="size-4 text-muted-foreground" />}
      title={row.session.title}
      hint={[row.session.projectName, row.session.hostName].filter(Boolean).join(" · ")}
    />
  );
}

export function PaletteRootPage({
  query,
  onQuery,
  sections,
  nav,
  notice,
  onTake,
}: {
  query: string;
  onQuery: (query: string) => void;
  sections: readonly PaletteSection<SidebarSession>[];
  nav: ListNav;
  notice: string | undefined;
  onTake: (row: RootRow) => void;
}) {
  const count = sections.reduce((total, section) => total + section.rows.length, 0);
  const offsets = sections.map((_, section) => sections.slice(0, section).reduce((total, before) => total + before.rows.length, 0));
  return (
    <div className="contents" onKeyDown={nav.onKeyDown}>
      <DialogTitle className="sr-only">Command palette</DialogTitle>
      <DialogDescription className="sr-only">
        Search this app&apos;s commands, its projects, and the conversations you were last in.
      </DialogDescription>

      <div className="flex items-center gap-2 border-b px-3 py-2.5">
        <SearchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <input
          autoFocus
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="Search commands, projects and conversations"
          aria-label="Search commands, projects and conversations"
          role="combobox"
          aria-expanded={count > 0}
          aria-controls="command-palette-results"
          aria-activedescendant={nav.activeId}
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>

      <div id="command-palette-results" role="listbox" aria-label="Commands, projects and conversations" className="max-h-80 overflow-y-auto p-1.5">
        {count === 0 && <p className="px-2 py-6 text-center text-xs text-muted-foreground">Nothing matches that.</p>}
        {sections.map((section, sectionAt) => (
          <div key={section.id} role="group" aria-label={section.title}>
            <p aria-hidden className="px-2 pt-1 pb-1.5 text-2xs font-medium text-muted-foreground">{section.title}</p>
            {section.rows.map((row, rowAt) => {
              const position = (offsets[sectionAt] ?? 0) + rowAt;
              return (
                <RootResult
                  key={row.key}
                  row={row}
                  id={nav.optionProps(position).id}
                  on={position === nav.active}
                  onPick={() => onTake(row)}
                  onHover={() => nav.setActive(position)}
                />
              );
            })}
          </div>
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
          <kbd className="font-sans">Esc</kbd> Close
        </span>
      </div>
    </div>
  );
}
