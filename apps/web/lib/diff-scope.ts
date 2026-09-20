/**
 * WHAT A DIFF TAB IS LOOKING AT — issue #694, §3b of the design on #49.
 *
 * THIS IS THE FIX FOR §3a RATHER THAN A FEATURE ON TOP OF IT. The surface used
 * to answer exactly one question — `base…worktree`, the session's own starting
 * point — and print it as "everything this session changed". In a `local`
 * session that shares the project checkout with the editor and every other
 * local session, that was false: a conversation which had written no code was
 * shown ninety-two files and a banner accusing it of running a formatter. #690
 * made the SENTENCE honest. This removes the need for the sentence, by making
 * the default question one whose honest answer is the same in both modes:
 *
 *   unstaged  what is uncommitted in this checkout, right now. THE DEFAULT.
 *             Claims nothing about who wrote it, so there is nothing to be
 *             wrong about in a shared tree.
 *   branch    everything since a base you choose — the old question, now
 *             asked deliberately, with the session's own base as the default
 *             choice rather than as the only one.
 *   turn      what ONE turn reported writing. The question the surface was
 *             reaching for all along: "what did the agent just do".
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE DEFAULT CHANGES WHAT AN EXISTING TAB SHOWS, and that is intended. A tab
 * persisted before this has no `scope` key and comes back on `unstaged`
 * instead of the session's base. It is the same checkout either way; what
 * changes is the claim over it, which is the whole point of the issue.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * ONE FUNCTION OWNS THE WHOLE PARAM SET, INCLUDING THE FILTER, and that is not
 * tidiness — it is a bug that would otherwise be certain. `setPanelTabParams`
 * is a REPLACE, not a merge (lib/right-panel-tabs.ts says so at length: params
 * are the whole of what identifies an instance). So a filter handler writing
 * `{ filter }` erases the scope, and a scope handler writing `{ scope }` erases
 * the filter. Neither would look broken until somebody typed in the filter
 * field and watched their scope silently reset.
 *
 * FLAT STRINGS, following `forge-workspace.ts`: `PanelTabParams` is flat
 * strings and deliberately so. A tab nobody has touched writes NO keys, so it
 * persists exactly as plainly as it did before any of this existed.
 */

import type { DiffBaseOption } from "@telar/engine-client";
import type { PanelTabParams } from "@/lib/right-panel-tabs";

export type DiffScopeKind = "unstaged" | "branch" | "turn";

/**
 * A Diff tab instance, whole.
 *
 * `base` AND `turn` SURVIVE A SCOPE CHANGE, which is the small thing that
 * makes the selector usable: you pick a base, glance at the working tree, come
 * back, and the base you chose is still there. Remembering them only while
 * their scope is active would make every flip a re-choice.
 */
export type DiffTab = {
  kind: DiffScopeKind;
  /** The chosen branch base. Absent means the session's OWN recorded base,
   *  which is the honest default and the only one a canvas has. */
  base?: string;
  /** The chosen turn, by run id. Absent means the most recent one that wrote
   *  anything — "what did the agent just do" needs no picking to be useful. */
  turn?: string;
  /** A folder or one file (#335). The tab's identity, unchanged by any of
   *  this, and carried through here only so writing a scope cannot erase it. */
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

/**
 * What a tab instance is carrying.
 *
 * VALIDATED, NOT TRUSTED — the same rule `readForgeOpen` states. This comes
 * back out of localStorage where a previous build, a hand edit or a half-write
 * can leave anything, and an unrecognised scope must land on the default
 * rather than on a surface that renders nothing and explains nothing.
 */
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

/** The params to persist. The default scope writes NO key, so an untouched tab
 *  stores what it always did — see the note on flat strings above. */
export function diffTabParams(tab: DiffTab): PanelTabParams {
  return {
    ...(tab.kind === "unstaged" ? {} : { [KIND_KEY]: tab.kind }),
    ...(tab.base?.trim() ? { [BASE_KEY]: tab.base.trim() } : {}),
    ...(tab.turn?.trim() ? { [TURN_KEY]: tab.turn.trim() } : {}),
    ...(tab.filter?.trim() ? { [FILTER_KEY]: tab.filter } : {}),
  };
}

/**
 * WHAT TO ASK THE ENGINE FOR — the one place a scope becomes a request.
 *
 * ── `turn` USED TO BE REFUSED HERE, AND THE CONDITIONS IT CAN NOW MEET ──────
 *
 * The comment this replaces said `turn` "IS NOT HERE AND CANNOT BE", because a
 * turn had no commit to diff against and so no base that would express it.
 * That was true and is no longer: #741 stamps `Turn.anchor` — the shas the
 * ENGINE observed when the turn started and ended — so a turn with an anchor is
 * a range, and `to` on `DiffBaseOption` is the right-hand side that says so.
 *
 * IT IS STILL REFUSED WHEN IT CANNOT BE ANSWERED, which is three cases and not
 * one. A turn that ran before anchoring existed has no shas at all; a turn
 * whose probe never answered has `read` and no shas; and a turn whose `before`
 * is absent ran in a repository with no commits. In every one of them the
 * journal is still the only witness there is, so this returns `undefined` and
 * the caller keeps the route it always had. `undefined` rather than `{}`:
 * `{}` is a legitimate git request meaning "the session's own base", and
 * answering a turn with it would compare something nobody asked about.
 *
 * NOTE THE THREE-WAY RETURN for the other two scopes, which is the whole reason
 * `DiffBaseOption` has a `null`: `unstaged` must send an EMPTY base rather than
 * no base, because no base means "use the one you have on file" and would
 * quietly answer a different question.
 */
export function diffBaseFor(tab: DiffTab, anchor?: TurnAnchor): DiffBaseOption | undefined {
  if (tab.kind === "unstaged") return { base: null };
  if (tab.kind === "turn") {
    // BOTH SIDES OR NEITHER. `before` alone would be "from where this turn
    // started to wherever the disk is now", which includes every later turn's
    // work and is not what the picker says it is showing.
    if (!anchor?.before || !anchor.after) return undefined;
    return { base: anchor.before, to: anchor.after };
  }
  // `branch` with no chosen ref is the session's own base: absent, not empty.
  return tab.base?.trim() ? { base: tab.base.trim() } : {};
}

/** The engine's own anchor shape, named here so this module's signature does
 *  not depend on the whole `Turn`. */
export type TurnAnchor = { before?: string; after?: string; read?: "timeout" | "failed" };

/** The scope a canvas can have. A project with no session has no recorded base
 *  and no turns, so `branch` without an explicit ref and `turn` are not offers
 *  it can keep — the selector hides what it cannot answer rather than showing
 *  a control that reports nothing. */
export function scopesFor(hasSession: boolean): readonly DiffScopeKind[] {
  return hasSession ? ["unstaged", "branch", "turn"] : ["unstaged", "branch"];
}
