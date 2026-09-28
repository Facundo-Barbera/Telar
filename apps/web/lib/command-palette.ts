import { MAX_FONT_SIZE, MIN_FONT_SIZE } from "@telar/engine-client";
import type { NewConversationTarget } from "@/components/project-palette";
import { matchTargets } from "@/components/project-palette";
import type { Command, CommandId, Keymap } from "@/lib/commands";

export const RECENT_CONVERSATION_LIMIT = 8;

/** Spelled here rather than imported to keep this module free of the component;
 *  `command-palette.tsx` assigns these into `PalettePage`, which checks for drift. */
export type PaletteSubPage = "projects" | "sources";

export const PALETTE_SUB_PAGES: Partial<Record<CommandId, PaletteSubPage>> = {
  "new-conversation-in": "projects",
  "add-project": "sources",
};

/** Kept separate from `PaletteSubPage` so `PALETTE_SUB_PAGES` values stay limited
 *  to the project palette's pages. */
export type PaletteQuickPage = "looks" | "accent";

/** Commands whose Actions row moved to Quick settings; excluded from Actions. */
export const PALETTE_QUICK_COMMANDS: readonly CommandId[] = ["toggle-rail"];

export type QuickSettingId =
  | "quick-colour-scheme"
  | "quick-look"
  | "quick-accent"
  | "quick-font-size-smaller"
  | "quick-font-size-larger"
  | "quick-translucency"
  | "quick-rail";

export type PaletteQuickSetting = {
  id: QuickSettingId;
  label: string;
  value: string;
  /** A lucide name, resolved through `lib/command-icons.ts`. */
  icon: string;
  page?: PaletteQuickPage;
};

export type QuickSettingsState = {
  scheme: "light" | "dark" | "system";
  /** "" when the appearance is not recognisably a Look. */
  look: string;
  accent: string;
  fontSize: number;
  translucent: boolean;
  /** False in a browser tab and off macOS; the row is then omitted. */
  translucency: boolean;
  railOpen: boolean;
};

const SCHEME_LABELS = { light: "Light", dark: "Dark", system: "System" } as const;

/** Text-size rows are omitted at the min/max font size. */
export function quickSettings(state: QuickSettingsState): PaletteQuickSetting[] {
  const rows: PaletteQuickSetting[] = [
    {
      id: "quick-colour-scheme",
      label: "Colour scheme",
      value: SCHEME_LABELS[state.scheme],
      icon: "sun-moon",
    },
    {
      id: "quick-look",
      label: "Wear look…",
      value: state.look,
      icon: "shirt",
      page: "looks",
    },
    {
      id: "quick-accent",
      label: "Accent colour",
      value: state.accent,
      icon: "swatch-book",
      page: "accent",
    },
  ];
  if (state.fontSize > MIN_FONT_SIZE) {
    rows.push({
      id: "quick-font-size-smaller",
      label: "Text size: smaller",
      value: `${state.fontSize} px`,
      icon: "a-arrow-down",
    });
  }
  if (state.fontSize < MAX_FONT_SIZE) {
    rows.push({
      id: "quick-font-size-larger",
      label: "Text size: larger",
      value: `${state.fontSize} px`,
      icon: "a-arrow-up",
    });
  }
  if (state.translucency) {
    rows.push({
      id: "quick-translucency",
      label: "Translucency",
      value: state.translucent ? "On" : "Off",
      icon: "blend",
    });
  }
  rows.push({
    id: "quick-rail",
    label: "Rail",
    value: state.railOpen ? "Shown" : "Hidden",
    icon: "panel-left",
  });
  return rows;
}

/** Matches on label, id and current value. */
export function matchQuick(rows: readonly PaletteQuickSetting[], query: string): PaletteQuickSetting[] {
  const needle = needleOf(query);
  if (!needle) return [...rows];
  return rows.filter((row) => `${row.label} ${row.id} ${row.value}`.toLocaleLowerCase().includes(needle));
}

export type PaletteAction = {
  id: CommandId;
  label: string;
  /** "" when the command is unbound. */
  chord: string;
  page?: PaletteSubPage;
};

export type PaletteSessionLike = {
  id: string;
  title: string;
  hostId?: string;
  hostName?: string;
  projectName?: string;
  updatedAt: number;
};

export type PaletteSectionId = "actions" | "quick" | "projects" | "sessions";

export type PaletteRow<S extends PaletteSessionLike> =
  | ({ kind: "action"; key: string } & PaletteAction)
  | ({ kind: "quick"; key: string } & PaletteQuickSetting)
  | { kind: "project"; key: string; target: NewConversationTarget }
  | { kind: "session"; key: string; session: S };

export type PaletteSection<S extends PaletteSessionLike> = {
  id: PaletteSectionId;
  title: string;
  rows: PaletteRow<S>[];
};

const SECTION_TITLES: Record<PaletteSectionId, string> = {
  actions: "Actions",
  quick: "Quick settings",
  projects: "Projects",
  sessions: "Recent conversations",
};

function needleOf(query: string): string {
  return query.trim().toLocaleLowerCase();
}

/** `runnable` drops commands that cannot run here; `exclude` drops the command
 *  that opened the palette. Jump commands are never listed. */
export function paletteActions(
  commands: readonly Command[],
  keymap: Keymap,
  runnable: (id: CommandId) => boolean,
  exclude: readonly CommandId[] = [],
): PaletteAction[] {
  const actions: PaletteAction[] = [];
  for (const command of commands) {
    if (command.jump) continue;
    if (exclude.includes(command.id)) continue;
    if (!runnable(command.id)) continue;
    const page = PALETTE_SUB_PAGES[command.id];
    actions.push({
      id: command.id,
      label: command.label,
      chord: keymap[command.id] ?? "",
      ...(page ? { page } : {}),
    });
  }
  return actions;
}

export function matchActions(actions: readonly PaletteAction[], query: string): PaletteAction[] {
  const needle = needleOf(query);
  if (!needle) return [...actions];
  return actions.filter((action) => `${action.label} ${action.id}`.toLocaleLowerCase().includes(needle));
}

/** Filters before cutting to `limit`, so a query can reach older conversations. */
export function recentSessions<S extends PaletteSessionLike>(
  sessions: readonly S[],
  query: string,
  limit: number = RECENT_CONVERSATION_LIMIT,
): S[] {
  const needle = needleOf(query);
  const matched = needle
    ? sessions.filter((session) =>
        `${session.title} ${session.projectName ?? ""} ${session.hostName ?? ""}`.toLocaleLowerCase().includes(needle),
      )
    : [...sessions];
  return matched.sort((left, right) => right.updatedAt - left.updatedAt).slice(0, limit);
}

/** Host-prefixed because two Macs can mint the same session id. */
export function paletteSessionKey(session: PaletteSessionLike): string {
  return session.hostId ? `${session.hostId}:${session.id}` : session.id;
}

/** Sections in fixed order; empty sections are dropped. */
export function paletteSections<S extends PaletteSessionLike>({
  actions,
  quick = [],
  targets,
  sessions,
  query,
  limit = RECENT_CONVERSATION_LIMIT,
}: {
  actions: readonly PaletteAction[];
  quick?: readonly PaletteQuickSetting[];
  targets: readonly NewConversationTarget[];
  sessions: readonly S[];
  query: string;
  limit?: number;
}): PaletteSection<S>[] {
  const sections: PaletteSection<S>[] = [
    {
      id: "actions",
      title: SECTION_TITLES.actions,
      rows: matchActions(actions, query).map((action) => ({ kind: "action" as const, key: action.id, ...action })),
    },
    {
      id: "quick",
      title: SECTION_TITLES.quick,
      rows: matchQuick(quick, query).map((setting) => ({ kind: "quick" as const, key: setting.id, ...setting })),
    },
    {
      id: "projects",
      title: SECTION_TITLES.projects,
      rows: matchTargets(targets, query).map((target) => ({
        kind: "project" as const,
        key: `${target.hostId ?? "local"}:${target.id}`,
        target,
      })),
    },
    {
      id: "sessions",
      title: SECTION_TITLES.sessions,
      rows: recentSessions(sessions, query, limit).map((session) => ({
        kind: "session" as const,
        key: paletteSessionKey(session),
        session,
      })),
    },
  ];
  return sections.filter((section) => section.rows.length > 0);
}

export function paletteRows<S extends PaletteSessionLike>(sections: readonly PaletteSection<S>[]): PaletteRow<S>[] {
  return sections.flatMap((section) => section.rows);
}

/** Where Backspace goes from a sub-page; only on an empty field. `root` is the
 *  page this opening started on — sources walks back to projects unless it was
 *  the entry point. */
export function paletteBack(
  page: PaletteSubPage,
  query: string,
  root: PaletteSubPage,
): PaletteSubPage | "root" | undefined {
  if (query !== "") return undefined;
  if (page === "sources" && root !== "sources") return "projects";
  return "root";
}
