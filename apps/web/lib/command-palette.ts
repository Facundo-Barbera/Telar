/**
 * WHAT THE COMMAND PALETTE IS LOOKING AT — the fold from three lists into one,
 * with none of the dialog around it (issue #402).
 *
 * THREE SECTIONS, ALWAYS IN THIS ORDER: Actions, Projects, Recent
 * conversations. It is the order of how specific the answer is — a verb, a
 * place, a thing — and it is fixed rather than ranked, because a list that
 * reorders itself under a query is a list you cannot learn the shape of. What a
 * query changes is which rows survive, never where a section sits.
 *
 * AN EMPTY SECTION IS NOT DRAWN. A heading over nothing is a heading that says
 * "you found nothing here", three times, on the way to the one row that matched.
 *
 * THE ACTIONS ARE THE REGISTRY, FILTERED BY WHAT CAN ACTUALLY RUN. Every row is
 * a `Command` from the shared table (`apps/desktop/command-keys.js`) — the same
 * list the application menu and the keybindings pane read — and `paletteActions`
 * drops the ones nothing is bound to and that go nowhere. That check is what
 * keeps the palette honest on two fronts: a contextual command (Send, Stop turn,
 * Open Data) appears only where its surface is mounted, and a command shipped
 * ahead of its surface (`search-project-contents`) stays out of the list instead
 * of sitting in it as a row that does nothing when pressed.
 *
 * PURE, AND THAT IS THE POINT: sections, ordering, the recency cut and the back
 * rule are the parts worth pinning, and none of them needs a DOM to be true.
 */

import type { NewConversationTarget } from "@/components/project-palette";
import { matchTargets } from "@/components/project-palette";
import type { Command, CommandId, Keymap } from "@/lib/commands";

/**
 * How many conversations the last section carries.
 *
 * EIGHT, AND ACROSS EVERY PROJECT. The palette is the answer to "take me back to
 * the thing I was doing", which is a short list by definition — the rail is
 * where the whole list lives, and a palette that reprinted it would be a rail
 * with a dialog over it. A query searches every conversation and still shows the
 * eight best-matching, so typing is how you reach the ninth.
 */
export const RECENT_CONVERSATION_LIMIT = 8;

/** The two pages the palette can WALK to, which are the project palette's own
 *  lists (#395). Spelled here rather than imported so this module stays free of
 *  the component; `command-palette.tsx` assigns these into `PalettePage`, which
 *  is what checks the two have not drifted. */
export type PaletteSubPage = "projects" | "sources";

/**
 * WHICH ACTIONS ARE DOORS RATHER THAN VERBS.
 *
 * Two commands do not run and finish — they open a second page of this same
 * dialog, and the project palette already has both pages built. Naming them here
 * keeps the palette's rows and the rail's buttons agreeing about what
 * "Add project" does, since both go through the command id.
 */
export const PALETTE_SUB_PAGES: Partial<Record<CommandId, PaletteSubPage>> = {
  "new-conversation-in": "projects",
  "add-project": "sources",
};

/** One row of the Actions section: a command, at whatever chord it is bound to
 *  now. `chord` is "" for the many that ship unbound — the row draws no caps
 *  rather than a key that does nothing. */
export type PaletteAction = {
  id: CommandId;
  label: string;
  chord: string;
  /** Set when this row walks to a sub-page instead of running. */
  page?: PaletteSubPage;
};

/** The least a session must be for this module to file and match it. The
 *  palette is handed the rail's own rows, which carry far more. */
export type PaletteSessionLike = {
  id: string;
  title: string;
  hostId?: string;
  hostName?: string;
  projectName?: string;
  updatedAt: number;
};

export type PaletteSectionId = "actions" | "projects" | "sessions";

export type PaletteRow<S extends PaletteSessionLike> =
  | ({ kind: "action"; key: string } & PaletteAction)
  | { kind: "project"; key: string; target: NewConversationTarget }
  | { kind: "session"; key: string; session: S };

export type PaletteSection<S extends PaletteSessionLike> = {
  id: PaletteSectionId;
  title: string;
  rows: PaletteRow<S>[];
};

const SECTION_TITLES: Record<PaletteSectionId, string> = {
  actions: "Actions",
  projects: "Projects",
  sessions: "Recent conversations",
};

function needleOf(query: string): string {
  return query.trim().toLocaleLowerCase();
}

/**
 * The registry as palette rows.
 *
 * `runnable` is asked per command and is the whole of the "no dead rows" rule —
 * see the note at the top of this file. `exclude` is for the one command a
 * palette must not offer: the one that opened it.
 *
 * THE JUMPS ARE NEVER ACTIONS. ⌘1..⌘9 are nine generated commands whose whole
 * subject is the recent list this palette already draws underneath, so listing
 * them would be the third section again, spelled as verbs.
 */
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

/** An action matches on what it SAYS and on what it is CALLED — the label a
 *  reader can see, and the id they may know from the keybindings pane. */
export function matchActions(actions: readonly PaletteAction[], query: string): PaletteAction[] {
  const needle = needleOf(query);
  if (!needle) return [...actions];
  return actions.filter((action) => `${action.label} ${action.id}`.toLocaleLowerCase().includes(needle));
}

/**
 * The conversations this query is about, most recent first, cut to `limit`.
 *
 * FILTERED BEFORE IT IS CUT, which is the only order that makes the section
 * searchable: cutting first would mean a query could only ever find the eight
 * most recent conversations, and the one you are trying to get back to is
 * usually older than that — it is why you are typing.
 */
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

/** A session's row key. The same shape `sessionKey` mints, because two Macs can
 *  mint one session id and React would reconcile the two rows into one. */
export function paletteSessionKey(session: PaletteSessionLike): string {
  return session.hostId ? `${session.hostId}:${session.id}` : session.id;
}

/**
 * THE WHOLE LIST, AS DRAWN — the one thing the dialog renders and the arrows
 * walk.
 */
export function paletteSections<S extends PaletteSessionLike>({
  actions,
  targets,
  sessions,
  query,
  limit = RECENT_CONVERSATION_LIMIT,
}: {
  actions: readonly PaletteAction[];
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

/** Every row, in the order they are drawn — what an index into the list means. */
export function paletteRows<S extends PaletteSessionLike>(sections: readonly PaletteSection<S>[]): PaletteRow<S>[] {
  return sections.flatMap((section) => section.rows);
}

/**
 * WHERE BACKSPACE GOES from a sub-page — "projects", back to the palette's own
 * list ("root"), or nowhere at all.
 *
 * ONLY ON AN EMPTY FIELD, which is the project palette's own rule and the
 * reason it is stated once here for both: the field is the dialog's title, so
 * Backspace is a text key first, and taking it while somebody deletes a typo
 * would throw their page away mid-word.
 *
 * `root` IS THE PAGE THIS OPENING STARTED ON. Walking sources → projects and
 * pressing Backspace again leaves the palette's pages altogether; a Sources page
 * that was itself the door still goes to Projects first, because both ways in
 * converge there and Projects is a legitimate place to arrive at from either.
 */
export function paletteBack(
  page: PaletteSubPage,
  query: string,
  root: PaletteSubPage,
): PaletteSubPage | "root" | undefined {
  if (query !== "") return undefined;
  if (page === "sources" && root !== "sources") return "projects";
  return "root";
}
