"use client";

/**
 * HOW YOU LIKE TO READ A DIFF — three toggles, remembered.
 *
 * NOT IN THE TAB'S PARAMS, and that is the distinction this module exists to
 * draw. A Diff tab's FILTER is its identity: it is what the strip names the tab
 * after, what makes two Diff tabs different, and it is persisted with the
 * panel's arrangement for exactly that reason (#335). Stacked-vs-split is not
 * an identity — it is how this person reads code, and somebody who chose split
 * chose it for every diff they will ever open, in both tabs, in every session.
 * Putting it in the params would mean re-choosing it per tab and per project.
 *
 * SO: localStorage, the same place the Look and the keymap live, under the same
 * `telar:` prefix. This is a preference about a person, not about a document.
 *
 * A PURE PARSE WITH A TOTAL FALLBACK. A corrupt record is a first run, never a
 * surface that will not paint — the rule `readOverrides` and `parseAppearance`
 * already follow.
 */

import { useCallback, useMemo, useSyncExternalStore } from "react";

import type { DiffLayout } from "@/components/session/diff-code-view";

const STORAGE_KEY = "telar:diff-view";

export type DiffView = {
  /** Stacked is unified, which is what a narrow panel and a code review both
   *  default to. Split is opt-in and, once opted into, permanent. */
  layout: DiffLayout;
  /**
   * OFF, AND NOT BECAUSE OF WIDTH. Wrapping destroys the column alignment that
   * makes a split diff readable, and a long line scrolls perfectly well. The
   * measured line lengths in this repository (p50 49, p90 82, p99 136) are
   * documentation of what you will see at a given width — never a gate (#694).
   */
  wrap: boolean;
  /**
   * OFF, because a whitespace-only change is still a change until somebody says
   * otherwise, and a diff that silently hid one would be the surface lying
   * about the commit that is about to happen.
   */
  ignoreWhitespace: boolean;
};

export const DEFAULT_DIFF_VIEW: DiffView = { layout: "stacked", wrap: false, ignoreWhitespace: false };

/** Total: anything unrecognised is the default for that field alone, so one bad
 *  key cannot cost the other two. */
export function parseDiffView(raw: string | null): DiffView {
  if (!raw) return DEFAULT_DIFF_VIEW;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return DEFAULT_DIFF_VIEW;
    const record = parsed as Record<string, unknown>;
    return {
      layout: record.layout === "split" ? "split" : "stacked",
      wrap: record.wrap === true,
      ignoreWhitespace: record.ignoreWhitespace === true,
    };
  } catch {
    return DEFAULT_DIFF_VIEW;
  }
}

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * CACHED BY RAW STRING, because `useSyncExternalStore` compares snapshots by
 * identity and a fresh object per read is an infinite render loop — the same
 * note `readAppearance` carries, and the same failure its docs warn about.
 */
let cache: { raw: string | null; value: DiffView } | undefined;

function read(): DiffView {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Private browsing: the defaults, not an error.
  }
  if (!cache || cache.raw !== raw) cache = { raw, value: parseDiffView(raw) };
  return cache.value;
}

function write(patch: Partial<DiffView>): void {
  const next = { ...read(), ...patch };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Persistence lost; this tab keeps the choice through the listeners below.
    cache = { raw: null, value: next };
  }
  for (const listener of listeners) listener();
}

export function useDiffView(): { view: DiffView; setView: (patch: Partial<DiffView>) => void } {
  const view = useSyncExternalStore(subscribe, read, () => DEFAULT_DIFF_VIEW);
  const setView = useCallback((patch: Partial<DiffView>) => write(patch), []);
  return useMemo(() => ({ view, setView }), [view, setView]);
}
