"use client";

/**
 * WHICH PROJECTS THE RAIL IS SHOWING — the multi-select filter at the head of
 * the search field (#470).
 *
 * THIS IS THE THIRD SHAPE OF ONE CONTROL, and the differences matter. #395 put
 * a single-select scope chip in the field ("All projects", or exactly one);
 * #400 removed it, on the argument that the collapsible project groups already
 * answer "fewer rows". They do — for one project at a time. What they cannot do
 * is "these three and not the other eleven", which is the whole request here, so
 * the control is back as a SET rather than a mode: nothing selected is every
 * project, and n selected is those n.
 *
 * A SET, NOT A SCOPE, is also why the old chip's other half did not come back.
 * A single scope let the rail say "the project at hand" and narrow New
 * conversation and Reveal to it; a set of three has no such answer, so this
 * filter narrows WHAT IS DRAWN and nothing else. Every other guess in the rail
 * is exactly what it was with no filter set.
 *
 * HOST-QUALIFIED KEYS, like `useCollapsedGroups`. Project ids are minted per
 * engine, so this Mac's `project_9f…` and the mini's are different projects that
 * can share an id — a bare id in the set would filter one and hide the other.
 * `local:` rather than an empty prefix so the two halves cannot collide.
 *
 * PER CLIENT, IN LOCAL STORAGE, for the reason `sidebar-layout.ts` gives for
 * splitting the two: where a group SITS is about the work and lives on the
 * engine, but which rows you have narrowed to right now is about the window you
 * are in — the same argument that keeps the fold state here.
 */

import { useCallback, useEffect, useState } from "react";

const FILTER_KEY = "telar:sidebar-project-filter";

/**
 * A PROJECT'S IDENTITY FOR THE FILTER — the pair the palette already keys its
 * rows by (`${hostId ?? "local"}:${id}`), spelled once so the picker, the
 * sessions and the drafts cannot come to disagree about what "the same project"
 * means.
 */
export function projectFilterKey(projectId: string | undefined, hostId?: string): string {
  return `${hostId ?? "local"}:${projectId ?? ""}`;
}

/**
 * THE SELECTION AS IT ACTUALLY APPLIES: the stored keys, narrowed to the
 * projects this cockpit can currently see.
 *
 * A SELECTION NOTHING ON SCREEN CAN SATISFY IS NOT A FILTER, IT IS A STALE
 * NOTE. A project can leave the registry, and a paired Mac can be away — and in
 * both cases the stored key names something the popover cannot list. Applying
 * it anyway would empty the rail and offer no checked row to explain why, which
 * is the "where did my sessions go" failure #400 was right about. So an empty
 * intersection means no filter, and the badge counts this set rather than the
 * stored one, which is what keeps the trigger and the popover saying the same
 * thing.
 *
 * THE STORE IS NOT PRUNED, deliberately — same rule as `foldedAfter`'s unseen
 * keys. A Mac that is away comes back, and its projects should come back
 * selected rather than silently dropped by the pass that could not reach it.
 */
export function appliedProjectFilter(selected: ReadonlySet<string>, known: readonly string[]): Set<string> {
  return new Set(known.filter((key) => selected.has(key)));
}

/** The rows the filter leaves: everything when nothing applies. */
export function filterSessionsToProjects<T extends { projectId?: string; hostId?: string }>(
  sessions: readonly T[],
  applied: ReadonlySet<string>,
): T[] {
  if (applied.size === 0) return [...sessions];
  return sessions.filter((session) => applied.has(projectFilterKey(session.projectId, session.hostId)));
}

/** The set after a row is pressed. Pure, so the hook below only has to persist. */
export function toggledProjectFilter(current: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(current);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

export type ProjectFilter = {
  /** The stored selection. Read `appliedProjectFilter` before narrowing anything. */
  selected: Set<string>;
  toggle: (key: string) => void;
  clear: () => void;
};

/** Which projects the rail is narrowed to, persisted per client. */
export function useProjectFilter(): ProjectFilter {
  /**
   * SEEDED EMPTY, like `useCollapsedGroups` and the rail's drafts: localStorage
   * does not exist during the server render, so reading it into the initial
   * state would make the two renders disagree about which rows are in the rail.
   * The effect below fills it a tick later.
   */
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    const task = window.setTimeout(() => {
      try {
        const raw = window.localStorage.getItem(FILTER_KEY);
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        if (Array.isArray(parsed)) setSelected(new Set(parsed.filter((key): key is string => typeof key === "string")));
      } catch {
        // Unreadable store: the rail starts on every project, which is the
        // state that hides nothing.
      }
    }, 0);
    return () => window.clearTimeout(task);
  }, []);
  const write = useCallback((next: Set<string>) => {
    try {
      window.localStorage.setItem(FILTER_KEY, JSON.stringify([...next]));
    } catch {
      // Quota or private mode: the filter lives for this page only.
    }
    return next;
  }, []);
  return {
    selected,
    toggle: useCallback((key: string) => setSelected((current) => write(toggledProjectFilter(current, key))), [write]),
    clear: useCallback(() => setSelected(() => write(new Set())), [write]),
  };
}
