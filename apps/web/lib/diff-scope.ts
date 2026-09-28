/**
 * A Diff tab's scope: `unstaged` (the default), `branch` (since a chosen base) or `turn`.
 * One function owns the whole param set because `setPanelTabParams` replaces rather than merges;
 * writing the scope alone would erase the filter. An untouched tab writes no keys.
 */

import type { DiffBaseOption } from "@telar/engine-client";
import type { PanelTabParams } from "@/lib/right-panel-tabs";

export type DiffScopeKind = "unstaged" | "branch" | "turn";

/** `base` and `turn` survive a scope change, so flipping scopes never needs a re-choice. */
export type DiffTab = {
  kind: DiffScopeKind;
  /** Absent means the session's own recorded base. */
  base?: string;
  /** By run id; absent means the most recent turn that wrote anything. */
  turn?: string;
  /** A folder or one file; carried so writing a scope cannot erase it. */
  filter?: string;
};

export const DEFAULT_DIFF_TAB: DiffTab = { kind: "unstaged" };

const KIND_KEY = "scope";
const BASE_KEY = "base";
const TURN_KEY = "turn";
const FILTER_KEY = "filter";

function scopeKind(value: string | undefined): DiffScopeKind {
  return value === "branch" || value === "turn" ? value : "unstaged";
}

/** Validated, not trusted: localStorage may hold anything, and unknown scopes fall to the default. */
export function readDiffTab(params: PanelTabParams): DiffTab {
  const base = (params[BASE_KEY] ?? "").trim();
  const turn = (params[TURN_KEY] ?? "").trim();
  const filter = params[FILTER_KEY] ?? "";
  return {
    kind: scopeKind(params[KIND_KEY]),
    ...(base ? { base } : {}),
    ...(turn ? { turn } : {}),
    ...(filter.trim() ? { filter } : {}),
  };
}

/** The default scope writes no key. */
export function diffTabParams(tab: DiffTab): PanelTabParams {
  return {
    ...(tab.kind === "unstaged" ? {} : { [KIND_KEY]: tab.kind }),
    ...(tab.base?.trim() ? { [BASE_KEY]: tab.base.trim() } : {}),
    ...(tab.turn?.trim() ? { [TURN_KEY]: tab.turn.trim() } : {}),
    ...(tab.filter?.trim() ? { [FILTER_KEY]: tab.filter } : {}),
  };
}

/**
 * `unstaged` sends `{ base: null }` (empty base); no base would mean the session's own base.
 * `turn` is a range only with both anchor shas; otherwise `undefined`, never `{}`, which is a
 * real request for the session's base. Callers then fall back to the journal.
 */
export function diffBaseFor(tab: DiffTab, anchor?: TurnAnchor): DiffBaseOption | undefined {
  if (tab.kind === "unstaged") return { base: null };
  if (tab.kind === "turn") {
    // Both sides or neither: `before` alone would include every later turn's work.
    if (!anchor?.before || !anchor.after) return undefined;
    return { base: anchor.before, to: anchor.after };
  }
  // `branch` with no chosen ref is the session's own base: absent, not empty.
  return tab.base?.trim() ? { base: tab.base.trim() } : {};
}

/** Named here so the signature doesn't depend on the whole `Turn`. */
export type TurnAnchor = { before?: string; after?: string; read?: "timeout" | "failed" };

/** A canvas has no recorded base or turns, so it gets no `turn` scope. */
export function scopesFor(hasSession: boolean): readonly DiffScopeKind[] {
  return hasSession ? ["unstaged", "branch", "turn"] : ["unstaged", "branch"];
}
