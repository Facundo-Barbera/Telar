/**
 * WHICH ISSUES ARE OPEN INSIDE THE ISSUES SURFACE — and the same for pull
 * requests (#693, §2 Move 1 of the design on #49).
 *
 * WHY THIS EXISTS AT ALL. An issue used to be a top-level panel tab: the strip
 * read `Diff · Issues · #675 · Pull requests · #666`, four Git tabs of which two
 * were not surfaces but documents. That is the argument the Editor already made
 * about files (components/right-panel.tsx, "Files are not surfaces"), and issues
 * arrive by the dozen in exactly the same way — you open five while triaging and
 * the surfaces you had arranged are off the end of the strip. So a detail opens
 * INSIDE its list, in a sub-strip of the list's own, and the panel's strip goes
 * back to holding surfaces.
 *
 * WHY THE STATE IS THE TAB'S `params` AND NOT A STORE OF ITS OWN. The Editor
 * needed a store because a file carries unsaved text, a preview pin and a
 * scroll position — state with a life of its own. An open issue carries a
 * NUMBER and nothing else; everything else about it is on GitHub and is re-read
 * on every mount. `params` already persists per tab instance, per session, and
 * is already what `setPanelTabParams` writes — so the open set survives a
 * reload for free, and two windows on one session keep their own (each holds
 * its own `PanelTabState`, which is what makes "one issue here, another one
 * there" still possible after the collapse).
 *
 * FLAT STRINGS, because `PanelTabParams` is flat strings and deliberately so.
 * `{ open: "675,666", at: "675" }`. Nothing open writes NO keys rather than
 * empty ones, so a tab nobody has drilled into persists as plainly as it did
 * before this existed.
 */

import type { PanelTabParams } from "@/lib/right-panel-tabs";

/**
 * The open detail set of ONE list surface.
 *
 * `at` ABSENT IS THE LIST, and that is a state rather than a gap: the list is
 * what the surface is for, and "no detail chosen" has to be expressible or
 * there would be no way back to it once you opened one.
 */
export type ForgeOpen = {
  /** In strip order, left to right. */
  numbers: readonly number[];
  /** Always one of `numbers`, or absent for the list. */
  at?: number;
};

export function emptyForge(): ForgeOpen {
  return { numbers: [] };
}

const OPEN_KEY = "open";
const AT_KEY = "at";

/** A positive integer, or nothing. The same strictness `issue:12abc` got as a
 *  tab id: a number the surface cannot ask `gh` about must not survive a
 *  round trip through storage as one it will try. */
function forgeNumber(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const number = Number(value);
  return number > 0 ? number : undefined;
}

/**
 * The open set a tab instance is carrying.
 *
 * VALIDATED, NOT TRUSTED. This comes back out of localStorage, where a previous
 * build, a hand edit or a half-written value can leave anything. Duplicates
 * collapse, unparseable numbers are dropped, and an `at` naming a number that
 * is not open falls back to the list rather than to a detail that would render
 * a spinner forever.
 */
export function readForgeOpen(params: PanelTabParams): ForgeOpen {
  const numbers: number[] = [];
  for (const part of (params[OPEN_KEY] ?? "").split(",")) {
    const number = forgeNumber(part.trim());
    if (number !== undefined && !numbers.includes(number)) numbers.push(number);
  }
  const at = forgeNumber((params[AT_KEY] ?? "").trim());
  return { numbers, ...(at !== undefined && numbers.includes(at) ? { at } : {}) };
}

/** The params to persist. Empty for an untouched list — see the note on flat
 *  strings above. */
export function forgeParams(open: ForgeOpen): PanelTabParams {
  if (open.numbers.length === 0) return {};
  return {
    [OPEN_KEY]: open.numbers.join(","),
    ...(open.at !== undefined && open.numbers.includes(open.at) ? { [AT_KEY]: String(open.at) } : {}),
  };
}

/**
 * Open a detail, or focus the one already open.
 *
 * NO PREVIEW SLOT, unlike the Editor's strip, and the difference is the
 * gesture's volume. You click nine files to find one, so the Editor lends a tab
 * and takes it back; you click an issue because you decided to read that issue.
 * Every open here is deliberate, which is also exactly what a top-level
 * `issue:675` tab meant before this — so nothing about the old behaviour
 * changes except which strip the chip lands in.
 */
export function openForge(open: ForgeOpen, number: number): ForgeOpen {
  if (open.numbers.includes(number)) return { ...open, at: number };
  return { numbers: [...open.numbers, number], at: number };
}

/**
 * Close a detail and choose what shows next — the NEIGHBOUR to the right, or
 * the new last one, which is the rule the panel's own strip and the Editor's
 * both follow.
 *
 * CLOSING THE LAST ONE SHOWS THE LIST. It cannot show nothing: this surface
 * always has something to draw, and the list is what you were going back to
 * anyway.
 */
export function closeForge(open: ForgeOpen, number: number): ForgeOpen {
  const index = open.numbers.indexOf(number);
  if (index === -1) return open;
  const numbers = open.numbers.filter((entry) => entry !== number);
  if (numbers.length === 0) return { numbers };
  // Closing a chip you are not reading must not move what you are reading.
  const at = open.at === number ? (numbers[index] ?? numbers[numbers.length - 1]!) : open.at;
  return { numbers, ...(at !== undefined ? { at } : {}) };
}

/** Show a detail that is already open. Unknown numbers are left alone, so a
 *  stale click cannot select a chip that has gone. */
export function activateForge(open: ForgeOpen, number: number): ForgeOpen {
  return open.numbers.includes(number) ? { ...open, at: number } : open;
}

/** Back to the list, keeping every chip open. The sub-strip's first chip.
 *  Rebuilt rather than spread-minus-`at`, so `at` is genuinely ABSENT — an
 *  explicit `undefined` would survive into `params` as a key naming nothing. */
export function showForgeList(open: ForgeOpen): ForgeOpen {
  return { numbers: open.numbers };
}

/**
 * WHICH NUMBERS A "CLOSE OTHERS" OR "CLOSE TO THE RIGHT" MEANS — names, not a
 * second close, for the same reason `otherEditorPaths` is names (see
 * lib/editor-workspace.ts). Here nothing can be lost by closing, so the rule is
 * about having ONE close path rather than about discarded text; a stale menu
 * whose chip has since gone sweeps nothing.
 */
export function otherForgeNumbers(open: ForgeOpen, number: number): number[] {
  if (!open.numbers.includes(number)) return [];
  return open.numbers.filter((entry) => entry !== number);
}

/** Every chip to the RIGHT of this one — see `otherForgeNumbers`. */
export function forgeNumbersAfter(open: ForgeOpen, number: number): number[] {
  const index = open.numbers.indexOf(number);
  if (index === -1) return [];
  return open.numbers.slice(index + 1);
}

/**
 * WHAT A PANEL SAVED BY THE PREVIOUS BUILD MEANT.
 *
 * Before this, an open issue was the top-level tab `issue:675` and an open pull
 * request `pull:666`. Those ids are in localStorage for every session anybody
 * has used, and `migratePanelTab` folds them into `issues` and `pulls` — which
 * on its own would silently close every issue somebody left open, the exact
 * thing this change exists to stop happening to the STRIP. So the ids are read
 * for their numbers first, in their original order, and seeded as the list
 * surface's open set.
 *
 * `activeTab` DECIDES WHICH ONE SHOWS, and only for the matching kind: a panel
 * left on `issue:675` restores with Issues showing #675, while Pull requests —
 * which was not what you were reading — restores on its LIST with #666 a click
 * away. Falling back to the list rather than to the last chip is the honest
 * answer for a surface that was in the background: nothing says you were
 * reading it.
 */
export function forgeFromLegacyTabs(
  tabs: readonly string[],
  activeTab?: string,
): { issues?: ForgeOpen; pulls?: ForgeOpen } {
  const seen: { issues: number[]; pulls: number[] } = { issues: [], pulls: [] };
  const at: { issues?: number; pulls?: number } = {};
  for (const tab of tabs) {
    for (const [prefix, key] of [["issue:", "issues"], ["pull:", "pulls"]] as const) {
      if (!tab.startsWith(prefix)) continue;
      const number = forgeNumber(tab.slice(prefix.length));
      if (number === undefined) break;
      if (!seen[key].includes(number)) seen[key].push(number);
      if (tab === activeTab) at[key] = number;
      break;
    }
  }
  return {
    ...(seen.issues.length > 0 ? { issues: { numbers: seen.issues, ...(at.issues !== undefined ? { at: at.issues } : {}) } } : {}),
    ...(seen.pulls.length > 0 ? { pulls: { numbers: seen.pulls, ...(at.pulls !== undefined ? { at: at.pulls } : {}) } } : {}),
  };
}
