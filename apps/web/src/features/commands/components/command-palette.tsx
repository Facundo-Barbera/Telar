"use client";

import { useListNav } from "@/ui/hooks/use-list-nav";
import { useState } from "react";
import { ShirtIcon } from "lucide-react";
import {
  ProjectPalettePages,
  RegisteredToast,
  type NewConversationTarget,
  type PalettePage,
  type Registered,
} from "@/features/projects";
import { Dialog, DialogContent } from "@/ui/dialog";
import { PaletteQuickPage as QuickPage } from "./palette-quick-page";
import { PaletteRootPage } from "./palette-root-page";
import {
  PALETTE_QUICK_COMMANDS,
  paletteActions,
  paletteRows,
  paletteSections,
  type PaletteQuickPage,
  type PaletteSubPage,
} from "../palette-model";
import { commandDestination } from "../command-keys";
import { COMMANDS, commandHandler, type CommandId } from "../commands";
import { ACCENTS, ACCENT_LABELS, useQuickSettings } from "../quick-settings";
import { useKeymap } from "../use-command-keys";
import type { SidebarSession } from "@/features/sessions";

export type CommandPalettePage = "root" | PalettePage | PaletteQuickPage;

const SUB_PAGE: Record<PaletteSubPage, PalettePage> = { projects: "projects", sources: "sources" };

function useResetOnReopen(
  open: boolean,
  openOn: CommandPalettePage,
  onOpened: (page: CommandPalettePage) => void,
  onPageChanged: (page: CommandPalettePage) => void,
) {
  const [wasOpen, setWasOpen] = useState(open);
  const [wasPage, setWasPage] = useState(openOn);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setWasPage(openOn);
      onOpened(openOn);
    }
  } else if (open && openOn !== wasPage) {
    setWasPage(openOn);
    onPageChanged(openOn);
  }
}

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
  const [toast, setToast] = useState<Registered>();
  const [notice, setNotice] = useState<string>();

  const actions = paletteActions(
    COMMANDS,
    keymap,
    (id) => Boolean(commandHandler(id)) || commandDestination(id, []).kind !== "noop",
    ["search-sessions", ...PALETTE_QUICK_COMMANDS],
  );
  const sections = paletteSections({ actions, quick: quick.rows, targets, sessions, query });
  const rows = paletteRows(sections);
  const nav = useListNav({ count: rows.length, onPick: (at) => take(rows[at]), idPrefix: "command-palette" });
  const setIndex = nav.setActive;

  const reset = (to: CommandPalettePage, text: string) => {
    setPage(to);
    setQuery(text);
    setIndex(0);
    setNotice(undefined);
  };
  const walk = (to: CommandPalettePage) => reset(to, "");
  useResetOnReopen(open, openOn, (to) => reset(to, seed), (to) => walk(to));

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

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent showCloseButton={false} className="top-[18%] max-w-lg translate-y-0 gap-0 p-0 sm:max-w-lg">
          {page === "root" ? (
            <PaletteRootPage
              query={query}
              onQuery={(next) => {
                setQuery(next);
                setIndex(0);
              }}
              sections={sections}
              nav={nav}
              notice={notice}
              onTake={take}
            />
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
