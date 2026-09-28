/**
 * A TERMINAL THAT OPENS PUTS ITSELF IN THE PANEL — never the panel in front of
 * you ("Run = a new terminal", PR 5).
 *
 * An agent's `terminal_open`, a `run_start`, or the person's own Run menu each
 * open an engine terminal, and every one arrives on the session's run feed as a
 * new `RunView`. It used to get a chip only while the Terminal surface happened
 * to be MOUNTED: with the panel hidden, or showing the Diff, an agent could
 * start a dev server and nothing anywhere said so. Now the Terminal tab and the
 * terminal's chip exist whatever the panel is doing.
 *
 * THE ITEM, NEVER THE PANEL. This is `revealPanelTab`'s rule (#989) applied to
 * terminals: the tab is ADDED if missing and never selected, and `open` is
 * never touched. Which tab is active, and whether the panel shows at all, are
 * the person's alone. Nothing here focuses anything, so a person typing in the
 * composer or in another shell keeps their keyboard.
 *
 * NOR THE CHIP, ONE LEVEL DOWN. The terminal's chip joins the Terminal's inner
 * strip without becoming the active chip (`upsertRunShell` without `focus`).
 * THE ONE EXCEPTION IS AN EMPTY STRIP, and it is `upsertRunShell`'s existing
 * rule kept rather than a new one: a strip with no active chip gets the new chip
 * as its active one, because "no chip selected" is not a state the Terminal can
 * draw — the restore would pick the first chip anyway. That moves nobody's view:
 * the Terminal tab itself stays unselected.
 *
 * A PURE MODULE, so the rule is testable without a cockpit. The cockpit owns the
 * two guards that decide WHICH terminals count (`freshTerminals` below reads
 * them): only ones started after it mounted, and each only once.
 */
import { isOpenTerminal } from "./run/presentation";
import type { RunView } from "./run/types";
import { findPanelTab, nextPanelTabId, revealPanelTab, setPanelTabParams, type PanelTabState } from "./right-panel-tabs";
import { readWorkspace, upsertRunShell, workspaceParams } from "./terminal-workspace";

/** The panel's Terminal kind — the one tab every shell and run lives in. */
export const TERMINAL_PANEL_KIND = "terminal";

/**
 * A terminal in the strip's own vocabulary.
 *
 * THE LABEL IS THE TERMINAL'S TITLE, copied at launch ("web dev #2"), so
 * renaming or deleting the recipe does not rewrite a chip already open. A
 * terminal the agent opened with a command of its own has no recipe, and says
 * so with an empty `configId` (see `runOf` in terminal-workspace.ts).
 *
 * THE TERMINAL ID IS HANDED ON ONLY WHILE IT IS OPEN. The engine keeps the id
 * on an ended record because it is the record's identity; the pane reads it as
 * "attach to this live terminal", which an ended one no longer is.
 */
export function runAsChip(run: RunView): { runId: string; configId: string; terminalId?: string; title?: string } {
  return {
    runId: run.runId,
    configId: run.configId ?? "",
    ...(isOpenTerminal(run) ? { terminalId: run.terminalId } : {}),
    ...(run.title ? { title: run.title } : {}),
  };
}

/**
 * The terminals on this feed answer that should appear, oldest first.
 *
 * TWO GUARDS, AND THEY ARE `display_open`'s. `since` is when the cockpit
 * mounted: the first thing the feed does is read `/run/status`, which lists
 * every terminal the session has, and treating those as news would put back,
 * on every reload, a Terminal tab the person had closed. `seen` keeps one
 * terminal from acting twice as its frames keep arriving — its `ready`, its
 * exit, the person closing it — so a chip somebody closed is not re-added by
 * the frame that reports the close.
 *
 * ONLY AN OPEN ONE. A terminal first seen already ended has nothing to show
 * that its opener does not already know, and the one way that happens in
 * practice is a person closing it faster than this feed reported it.
 */
export function freshTerminals(terminals: readonly RunView[], since: number, seen: ReadonlySet<string>): RunView[] {
  return terminals
    .filter((run) => run.startedAt >= since && !seen.has(run.terminalId) && isOpenTerminal(run))
    .sort((a, b) => a.startedAt - b.startedAt);
}

/**
 * Put one terminal in the panel: the Terminal tab if it is missing, and the
 * terminal's chip inside it — neither of them selected, and the panel's
 * visibility untouched.
 *
 * THE CHIP IS WRITTEN INTO THE TAB'S PARAMS, which is where the Terminal keeps
 * its whole inner strip (`workspaceParams`). That is what makes it exist while
 * the surface is not mounted: the surface seeds itself from those params when
 * it next mounts. While it IS mounted, the surface folds the same terminal in
 * from its own feed, by the same run id, so the two arrive at one chip.
 *
 * SAME OBJECT WHEN NOTHING CHANGES — a terminal already in the strip — because
 * the caller persists every new panel state it is handed.
 */
export function revealTerminal<Kind extends string>(state: PanelTabState<Kind>, run: RunView, kind: Kind): PanelTabState<Kind> {
  const existing = state.tabs.find((tab) => tab.kind === kind);
  const id = existing?.id ?? nextPanelTabId(state, kind);
  const withTab = existing ? state : revealPanelTab(state, { id, kind, params: {} });
  const tab = findPanelTab(withTab, id)!;
  const workspace = readWorkspace(tab.params);
  const next = upsertRunShell(workspace, runAsChip(run));
  if (next === workspace && existing) return state;
  return setPanelTabParams(withTab, id, workspaceParams(next));
}
