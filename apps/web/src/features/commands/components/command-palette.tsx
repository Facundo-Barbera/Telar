"use client";

import { useListNav } from "@/ui/hooks/use-list-nav";
import { useState } from "react";
import { CheckIcon, MessageSquareIcon as SessionGlyph, SearchIcon, ShirtIcon } from "lucide-react";
import {
  ProjectAvatar,
  PaletteRow as Row,
  ProjectPalettePages,
  RegisteredToast,
  targetPlace,
  type NewConversationTarget,
  type PalettePage,
  type Registered,
} from "@/features/projects";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { KeyHint } from "./key-hint";
import {
  PALETTE_QUICK_COMMANDS,
  paletteActions,
  paletteRows,
  paletteSections,
  type PaletteQuickPage,
  type PaletteSubPage,
} from "../palette-model";
import { commandIcon, iconByName } from "../command-icons";
import { commandDestination } from "../command-keys";
import { COMMANDS, commandHandler, type CommandId } from "../commands";
import { ACCENTS, ACCENT_LABELS, useQuickSettings } from "../quick-settings";
import { useKeymap } from "../use-command-keys";
import type { SidebarSession } from "@/features/sessions";

export type CommandPalettePage = "root" | PalettePage | PaletteQuickPage;

const SUB_PAGE: Record<PaletteSubPage, PalettePage> = { projects: "projects", sources: "sources" };

export function CommandPalette({
  open,
  page: openOn = "root",
  query: seed = "",
  onOpenChange,
  targets,
  sessions,
  railOpen,
  onRun,
  onChooseProject,
  onOpenSession,
  onRegistered,
}: {
  open: boolean;
  page?: CommandPalettePage;
  query?: string;
  onOpenChange: (open: boolean) => void;
  targets: readonly NewConversationTarget[];
  sessions: readonly SidebarSession[];
  railOpen: boolean;
  onRun: (id: CommandId) => void;
  onChooseProject: (target: NewConversationTarget) => void;
  onOpenSession: (session: SidebarSession) => void;
  onRegistered: () => void;
}) {
  const keymap = useKeymap();
  const quick = useQuickSettings({ railOpen });
  const [page, setPage] = useState<CommandPalettePage>(openOn);
  const [query, setQuery] = useState(seed);
  const [index, setIndex] = useState(0);
  const [toast, setToast] = useState<Registered>();
  const [notice, setNotice] = useState<string>();

  const [wasOpen, setWasOpen] = useState(open);
  const [wasPage, setWasPage] = useState(openOn);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setPage(openOn);
      setWasPage(openOn);
      setQuery(seed);
      setIndex(0);
      setNotice(undefined);
    }
  } else if (open && openOn !== wasPage) {
    setWasPage(openOn);
    setPage(openOn);
    setQuery("");
    setIndex(0);
    setNotice(undefined);
  }

  const actions = paletteActions(
    COMMANDS,
    keymap,
    (id) => Boolean(commandHandler(id)) || commandDestination(id, []).kind !== "noop",
    ["search-sessions", ...PALETTE_QUICK_COMMANDS],
  );
  const sections = paletteSections({ actions, quick: quick.rows, targets, sessions, query });
  const rows = paletteRows(sections);
  const at = rows.length === 0 ? -1 : Math.min(index, rows.length - 1);
  const offsets = sections.map((_, section) => sections.slice(0, section).reduce((total, before) => total + before.rows.length, 0));

  const walk = (to: CommandPalettePage) => {
    setPage(to);
    setQuery("");
    setIndex(0);
    setNotice(undefined);
  };

  const take = (row: (typeof rows)[number] | undefined) => {
    if (!row) return;
    if (row.kind === "project") {
      onOpenChange(false);
      onChooseProject(row.target);
      return;
    }
    if (row.kind === "session") {
      onOpenChange(false);
      onOpenSession(row.session);
      return;
    }
    if (row.kind === "quick") {
      if (row.page) {
        walk(row.page);
        return;
      }
      setNotice(quick.apply(row.id));
      return;
    }
    if (row.page) {
      walk(SUB_PAGE[row.page]);
      return;
    }
    onOpenChange(false);
    onRun(row.id);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (rows.length === 0) return;
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setIndex(((at < 0 ? 0 : at) + delta + rows.length) % rows.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      take(rows[at]);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent showCloseButton={false} className="top-[18%] max-w-lg translate-y-0 gap-0 p-0 sm:max-w-lg">
          {page === "root" ? (
            <div className="contents" onKeyDown={onKeyDown}>
              <DialogTitle className="sr-only">Command palette</DialogTitle>
              <DialogDescription className="sr-only">
                Search this app&apos;s commands, its projects, and the conversations you were last in.
              </DialogDescription>

              <div className="flex items-center gap-2 border-b px-3 py-2.5">
                <SearchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <input
                  autoFocus
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setIndex(0);
                  }}
                  placeholder="Search commands, projects and conversations"
                  aria-label="Search commands, projects and conversations"
                  role="combobox"
                  aria-expanded={rows.length > 0}
                  aria-controls="command-palette-results"
                  aria-activedescendant={at >= 0 ? `command-palette-${at}` : undefined}
                  className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                />
              </div>

              <div id="command-palette-results" role="listbox" aria-label="Commands, projects and conversations" className="max-h-80 overflow-y-auto p-1.5">
                {rows.length === 0 && <p className="px-2 py-6 text-center text-xs text-muted-foreground">Nothing matches that.</p>}
                {sections.map((section, sectionAt) => (
                  <div key={section.id} role="group" aria-label={section.title}>
                    <p aria-hidden className="px-2 pt-1 pb-1.5 text-2xs font-medium text-muted-foreground">{section.title}</p>
                    {section.rows.map((row, rowAt) => {
                      const position = (offsets[sectionAt] ?? 0) + rowAt;
                      const on = position === at;
                      const id = `command-palette-${position}`;
                      const onHover = () => setIndex(position);
                      if (row.kind === "quick") {
                        const Glyph = iconByName(row.icon);
                        return (
                          <Row
                            key={row.key}
                            id={id}
                            on={on}
                            onPick={() => take(row)}
                            onHover={onHover}
                            glyph={Glyph ? <Glyph className="size-4 text-muted-foreground" /> : null}
                            title={row.label}
                            trailing={
                              row.value ? (
                                <span className="shrink-0 text-2xs text-muted-foreground">{row.value}</span>
                              ) : undefined
                            }
                          />
                        );
                      }
                      if (row.kind === "action") {
                        const Glyph = commandIcon(row.id);
                        return (
                          <Row
                            key={row.key}
                            id={id}
                            on={on}
                            onPick={() => take(row)}
                            onHover={onHover}
                            glyph={<Glyph className="size-4 text-muted-foreground" />}
                            title={row.label}
                            trailing={<KeyHint command={row.id} always />}
                          />
                        );
                      }
                      if (row.kind === "project") {
                        return (
                          <Row
                            key={row.key}
                            id={id}
                            on={on}
                            onPick={() => take(row)}
                            onHover={onHover}
                            glyph={
                              <ProjectAvatar
                                name={row.target.name}
                                {...(row.target.hostId ? {} : { projectId: row.target.id })}
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
                          key={row.key}
                          id={id}
                          on={on}
                          onPick={() => take(row)}
                          onHover={onHover}
                          glyph={<SessionGlyph className="size-4 text-muted-foreground" />}
                          title={row.session.title}
                          hint={[row.session.projectName, row.session.hostName].filter(Boolean).join(" · ")}
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
          ) : page === "looks" ? (
            <QuickPage
              title="Wear a look"
              placeholder="Search your looks"
              {...(notice ? { notice } : {})}
              rows={quick.looks.map((look) => ({
                key: look.id,
                glyph: <ShirtIcon className="size-4 text-muted-foreground" />,
                title: look.label,
                on: look.id === quick.wornLookId,
              }))}
              onPick={(id) => {
                const look = quick.looks.find((entry) => entry.id === id);
                if (look) setNotice(quick.wearLook(look));
              }}
              onBack={() => walk("root")}
            />
          ) : page === "accent" ? (
            <QuickPage
              title="Accent colour"
              placeholder="Search accents"
              rows={ACCENTS.map((accent) => ({
                key: accent,
                glyph: <span data-accent={accent} className="size-3.5 rounded-full bg-primary" />,
                title: ACCENT_LABELS[accent],
                on: accent === quick.accent,
              }))}
              onPick={(accent) => quick.setAccent(accent as (typeof ACCENTS)[number])}
              onBack={() => walk("root")}
            />
          ) : (
            <ProjectPalettePages
              page={page}
              targets={targets}
              onChoose={(target) => {
                onOpenChange(false);
                onChooseProject(target);
              }}
              onClose={() => onOpenChange(false)}
              onBack={() => walk("root")}
              onRegistered={(registered) => {
                setToast(registered);
                onRegistered();
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      <RegisteredToast toast={toast} onDismiss={() => setToast(undefined)} onChanged={onRegistered} />
    </>
  );
}

function QuickPage({
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
