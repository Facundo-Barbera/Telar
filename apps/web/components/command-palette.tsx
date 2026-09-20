"use client";

/**
 * ONE ⌘K SURFACE OVER COMMANDS, PROJECTS AND CONVERSATIONS — issue #402, T3
 * Code's palette.
 *
 * WHAT IT REPLACED. ⌘K used to put the cursor in the rail's search field, which
 * could find one kind of thing (a conversation) and only while the rail was
 * open. Everything else this app can do was reachable by knowing where it lived:
 * a button in the rail's header, a pane behind Settings' nav, a chord you had
 * either memorised or not. A palette is the answer to "I know what I want and
 * not where it is", and it is the one surface that can say what the chord for it
 * would have been.
 *
 * THE REGISTRY IS THE SOURCE, NOT A LIST BESIDE IT. Every Actions row is a
 * `Command` from `apps/desktop/command-keys.js` — the same table the Electron
 * menu builds accelerators from and the keybindings pane rebinds — so a command
 * added there appears here, at whatever chord the person has it on, without
 * anybody remembering to. `paletteActions` is what drops the ones nothing can
 * run: a palette full of rows that do nothing when pressed is worse than a
 * shorter palette.
 *
 * THE FIELD AND THE PALETTE ARE DIFFERENT THINGS, DELIBERATELY. The rail's
 * search field stays a filter over the rows in front of you — type in it and the
 * list narrows, exactly as before — and ⌘K opens this. The one bridge between
 * them is that ⌘K carries whatever the field holds into the palette's query, so
 * a search that turned out to be a bigger question than the rail can answer
 * walks in here without being retyped.
 *
 * THE SUB-PAGES ARE THE PROJECT PALETTE'S OWN PAGES (#395/#413), embedded rather
 * than re-implemented: "New conversation in…" is its Projects page and "Add
 * project" its Sources page, folder browser and clone flow and all. Backspace on
 * an empty field walks back out of them to this list — `paletteBack` is that
 * rule, shared with the palette it came from.
 *
 * NO ⌘1..⌘9 HERE, unlike the project palette. Those digits are the rail's jump
 * commands, the window dispatcher answers them wherever focus is, and a palette
 * that quietly meant something else by them would be a palette that navigates
 * out from under you.
 *
 * A GLYPH PER ROW, NOT PER SECTION (#479). This drew one icon per GROUP, which
 * made the list scannable by section and not by row — the wrong unit for a
 * surface whose whole job is finding one verb among twenty-odd. The glyph is
 * the registry's own `icon` name now, resolved through `lib/command-icons.ts`;
 * a name that map has not got still falls back to the group's, so a command
 * added to the table is never a row with a hole in it.
 *
 * AND IT FLIPS SETTINGS, NOT ONLY DOORS TO THEM (#479). "Quick settings" sits
 * under Actions: the scheme, the accent, a Look, one step of text size,
 * translucency, the rail. Each row applies on Enter and says what it is set to
 * at its right edge. Every one of those writes goes through
 * `lib/quick-settings.ts` — the one adapter over the stores the Settings pane
 * uses — so the palette and the pane cannot disagree about what a setting is.
 */

import { useState } from "react";
// The conversation rows' own glyph — a kind of row, not a command, so it is
// named here rather than looked up through the registry's icon map.
import { CheckIcon, MessageSquareIcon as SessionGlyph, SearchIcon, ShirtIcon } from "lucide-react";
import { ProjectAvatar } from "@/components/projects/project-avatar";
import {
  PaletteRow as Row,
  ProjectPalettePages,
  RegisteredToast,
  targetPlace,
  type NewConversationTarget,
  type PalettePage,
  type Registered,
} from "@/components/project-palette";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { KeyHint } from "@/components/ui/key-hint";
import {
  PALETTE_QUICK_COMMANDS,
  paletteActions,
  paletteRows,
  paletteSections,
  type PaletteQuickPage,
  type PaletteSubPage,
} from "@/lib/command-palette";
import { commandIcon, iconByName } from "@/lib/command-icons";
import { commandDestination } from "@/lib/command-keys";
import { COMMANDS, commandHandler, type CommandId } from "@/lib/commands";
import { ACCENTS, ACCENT_LABELS, useQuickSettings } from "@/lib/quick-settings";
import { useKeymap } from "@/lib/use-command-keys";
import type { SidebarSession } from "@/lib/session-list";

/**
 * WHICH PAGE THE PALETTE IS SHOWING. "root" is the list, two are the project
 * palette's (the `PalettePage` annotation is what keeps the two files' idea of
 * "a page" from drifting), and two are this palette's own appearance lists.
 */
export type CommandPalettePage = "root" | PalettePage | PaletteQuickPage;

/** An identity map that exists to FAIL TO COMPILE if the fold's idea of a
 *  sub-page and the project palette's idea of a page ever drift apart. The lib
 *  names the two without importing the component; this is where that claim is
 *  checked. */
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
  /** The page this opening starts on. The rail's Add-project verb says
   *  "sources"; ⌘K says nothing and gets the list. */
  page?: CommandPalettePage;
  /** What the rail's search field held when ⌘K was pressed. */
  query?: string;
  onOpenChange: (open: boolean) => void;
  targets: readonly NewConversationTarget[];
  /** The rail's own rows — so the palette can never offer a conversation the
   *  rail does not have, and costs no read of its own. */
  sessions: readonly SidebarSession[];
  /** Whether the rail is showing — the readout on the Quick settings row that
   *  toggles it. The rail is what knows, so the rail says. */
  railOpen: boolean;
  /** Run a command the way a chord would. The rail owns the dispatcher. */
  onRun: (id: CommandId) => void;
  onChooseProject: (target: NewConversationTarget) => void;
  onOpenSession: (session: SidebarSession) => void;
  /** A project joined the registry — re-read whatever list you draw. */
  onRegistered: () => void;
}) {
  const keymap = useKeymap();
  const quick = useQuickSettings({ railOpen });
  const [page, setPage] = useState<CommandPalettePage>(openOn);
  const [query, setQuery] = useState(seed);
  const [index, setIndex] = useState(0);
  const [toast, setToast] = useState<Registered>();
  /** What a quick change could not do — in practice a Look whose wallpaper will
   *  not fit in storage. Shown on the page it happened on, which is why the
   *  page stays up rather than closing on a partial success. */
  const [notice, setNotice] = useState<string>();

  /**
   * A FRESH PALETTE EVERY TIME, seeded with whatever the rail's field held —
   * the project palette's own rule and, as there, adjusted during render rather
   * than in an effect, which is React's answer for state derived from a prop
   * change and what this app's lint rule insists on.
   *
   * AND A PAGE ASKED FOR WHILE IT IS ALREADY UP IS STILL A PAGE ASKED FOR. The
   * New-conversation row closes the palette and runs the command, and on a
   * cockpit with several projects that command opens the palette again on
   * Projects — both writes land in one render, so `open` never actually flips
   * and the page would otherwise have been ignored: a row that visibly did
   * nothing. `wasPage` mirrors the PROP, so walking between pages from inside
   * the palette is untouched by this.
   */
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

  /**
   * WHAT CAN ACTUALLY RUN, asked at the moment the list is built — which is the
   * only moment the answer is knowable. A command is runnable when a mounted
   * component has claimed it (`commandHandler`) or when it is pure navigation
   * with a destination. The empty list is what a jump would resolve against, and
   * the jumps are not actions here anyway.
   */
  const actions = paletteActions(
    COMMANDS,
    keymap,
    (id) => Boolean(commandHandler(id)) || commandDestination(id, []).kind !== "noop",
    // The command that opened this dialog is not a row in it — and neither are
    // the ones whose row moved down into Quick settings, where they wear the
    // state they are about to change.
    ["search-sessions", ...PALETTE_QUICK_COMMANDS],
  );
  const sections = paletteSections({ actions, quick: quick.rows, targets, sessions, query });
  const rows = paletteRows(sections);
  const at = rows.length === 0 ? -1 : Math.min(index, rows.length - 1);
  /** Where each section starts in that flat list — because the highlight is one
   *  number over the whole palette, not one per section. */
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
    /**
     * A QUICK ROW LEAVES THE PALETTE OPEN, which is the one place these rows
     * behave unlike every other. They are knobs, not verbs: stepping the text
     * size twice, or looking at what Dark did before choosing System, is the
     * ordinary way to use them, and a dialog that shut after each step would
     * make the second press a whole ⌘K again. The readout at the row's right
     * edge updates in place, so the list stays honest while you work it.
     */
    if (row.kind === "quick") {
      if (row.page) {
        walk(row.page);
        return;
      }
      setNotice(quick.apply(row.id));
      return;
    }
    // A door walks; everything else runs and the dialog is done.
    if (row.page) {
      walk(SUB_PAGE[row.page]);
      return;
    }
    onOpenChange(false);
    onRun(row.id);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    // An IME's own Enter commits a candidate; it is not a selection.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (rows.length === 0) return;
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      // FROM THE ROW THAT IS HIGHLIGHTED, not from the counter — they differ
      // whenever the list has shrunk under a counter nobody has touched since
      // (the rail polls, a conversation lands), and moving from the invisible
      // one is how an arrow key appears to skip a row or do nothing at all.
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

              {/* THE FIELD IS THE TITLE, as on every page of the palette this
                  one borrows its sub-pages from. */}
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
                    {/* THE CAPTION NAMES THE SECTION, which the field cannot:
                        it says what you may TYPE, and three kinds of answer come
                        back under it. */}
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
                            // WHAT IT IS SET TO, where a command's chord would
                            // be. The two ends say different things and both
                            // are the row's right edge: a verb promises a key,
                            // a knob reports a state.
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
                            // THE CHORD AT THE ROW'S RIGHT, from the live keymap
                            // — `KeyHint` reads the same store `paletteActions`
                            // took `chord` from, so the row and the key it
                            // promises cannot disagree. `always`, because a
                            // palette that only showed its chords while ⌘ was
                            // held would be teaching nobody.
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

              {/* What a quick change could not finish — a Look whose wallpaper
                  will not fit, in practice. Everything else still applied. */}
              {notice && <p className="border-t px-3 py-2 text-2xs text-muted-foreground">{notice}</p>}

              {/* THE LEGEND, as T3 draws it: a palette whose keys are
                  undiscoverable is a list people click. */}
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
            /* THE SHELF, worn from here. Wearing leaves the palette open on
               this page: trying two Looks is the ordinary way to pick one, and
               a partial wear has a line to show. */
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
                // The swatch wears the attribute it sets, so its hue comes from
                // the same globals.css block choosing it would use.
                glyph: <span data-accent={accent} className="size-3.5 rounded-full bg-primary" />,
                title: ACCENT_LABELS[accent],
                on: accent === quick.accent,
              }))}
              onPick={(accent) => quick.setAccent(accent as (typeof ACCENTS)[number])}
              onBack={() => walk("root")}
            />
          ) : (
            /* THE SUB-PAGE, WHICH IS THE PROJECT PALETTE'S OWN. Mounted fresh
               on arrival — that is what resets its query and its page — and
               `onBack` is what turns its first page's Backspace into the way
               back to the list above. */
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

/**
 * ONE OF THE PALETTE'S OWN APPEARANCE PAGES — the Looks shelf, and the eight
 * accents (#479).
 *
 * The same SHAPE as the project palette's pages, deliberately: the field is the
 * title, the arrows walk the list, Enter takes the row, and Backspace on an
 * empty field is the way back. It is a separate component because what those
 * pages list is the project registry and these list appearance stores — sharing
 * the chrome is worth it, sharing the data path is not.
 *
 * BACKSPACE GOES STRAIGHT TO THE LIST, with none of `paletteBack`'s branching.
 * That rule exists because the project palette's two pages can be reached from
 * each other; these two are leaves, so there is only ever one place back.
 */
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
  const [index, setIndex] = useState(0);
  const needle = query.trim().toLocaleLowerCase();
  const shown = needle ? rows.filter((row) => `${row.title} ${row.hint ?? ""}`.toLocaleLowerCase().includes(needle)) : [...rows];
  const at = shown.length === 0 ? -1 : Math.min(index, shown.length - 1);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (shown.length === 0) return;
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setIndex(((at < 0 ? 0 : at) + delta + shown.length) % shown.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const row = shown[at];
      if (row) onPick(row.key);
      return;
    }
    // Only on an empty field: the field is the dialog's title, so Backspace is
    // a text key first and taking it mid-word would throw the page away.
    if (event.key === "Backspace" && query === "") {
      event.preventDefault();
      onBack();
    }
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
            setIndex(0);
          }}
          placeholder={placeholder}
          aria-label={placeholder}
          role="combobox"
          aria-expanded={shown.length > 0}
          aria-controls="command-palette-quick-results"
          aria-activedescendant={at >= 0 ? `command-palette-quick-${at}` : undefined}
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>
      <div id="command-palette-quick-results" role="listbox" aria-label={title} className="max-h-80 overflow-y-auto p-1.5">
        {shown.length === 0 && <p className="px-2 py-6 text-center text-xs text-muted-foreground">Nothing matches that.</p>}
        {shown.map((row, rowAt) => (
          <Row
            key={row.key}
            id={`command-palette-quick-${rowAt}`}
            on={rowAt === at}
            onPick={() => onPick(row.key)}
            onHover={() => setIndex(rowAt)}
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
