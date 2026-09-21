/**
 * THE TERMINAL'S OWN TABS — the shells open inside one Terminal surface.
 *
 * WHY THIS IS NOT `right-panel-tabs.ts`, and it is the Editor's argument
 * (lib/editor-workspace.ts) applied to a second surface. A shell used to be a
 * top-level panel tab: three of them wrote "Terminal", "Terminal", "Terminal"
 * across the strip and pushed Diff and Issues off the edge, so opening a second
 * shell cost you the surfaces you were working with. Shells are not surfaces.
 * They arrive in numbers, they are the thing every terminal emulator ever
 * written has given its own strip, and they belong INSIDE one Terminal.
 *
 * A PURE MODULE WITH NO EMULATOR IN IT, deliberately. What is hard about a
 * strip of shells is the bookkeeping — which one has focus after a close, which
 * PTY belongs to which chip, what survives a remount — and none of that needs a
 * document. The surface keeps what genuinely does: xterm, its addons, and the
 * bytes.
 *
 * THE PTY ID IS THE ONLY DURABLE THING HERE. A shell's `id` names the chip; its
 * `terminalId` names a process in the Electron host. The first is ours to mint,
 * the second is the host's to answer, and remembering the pair is what lets a
 * remounted Terminal re-adopt every running shell instead of stranding them and
 * opening a fresh set.
 */

/** The params a panel tab carries — the same flat-string record
 *  `right-panel-tabs.ts` defines, restated so this module does not depend on
 *  the panel to describe a shell. */
type Params = Readonly<Record<string, string>>;

export type TerminalShell = {
  /** Ours, stable for as long as the chip exists, and never a PTY id — a shell
   *  whose process died and was replaced is still the same chip. */
  id: string;
  /** The PTY in the host, once it has answered. Absent while a shell is still
   *  opening, and absent forever for one whose spawn was refused. */
  terminalId?: string;
  /** What the shell called itself through OSC 0/2 — `~/code/telar`, `nvim`,
   *  whatever the person's prompt sets. Absent until it says something, which
   *  is what `shellLabel` falls back for. */
  title?: string;
};

export type TerminalWorkspace = {
  shells: TerminalShell[];
  /** A shell id, not an index — closing the third shell must not silently move
   *  focus to whatever slides into slot three. */
  active?: string;
};

/**
 * The params key a terminal tab carries its PTY's id in — the shape written by
 * every build BEFORE shells became inner tabs, and still the whole of what
 * `collapseTerminalTabs` has to read to keep somebody's running shells alive
 * across the upgrade.
 *
 * DECLARED HERE rather than in `terminal-bridge.ts` (which re-exports it, so
 * every existing importer is unaffected) because the reaper over there now
 * needs this module's list, and the dependency has to point one way.
 */
export const TERMINAL_ID_PARAM = "terminal";

/** The params key the whole inner workspace is JSON-encoded under. ONE key: a
 *  panel tab's params are flat strings, and a shell list is not flat. */
export const TERMINAL_WORKSPACE_PARAM = "shells";

export function emptyWorkspace(): TerminalWorkspace {
  return { shells: [] };
}

/**
 * The id a new shell would take: `shell`, then `shell#2`, `shell#3` — the
 * panel's own `nextPanelTabId` spelling, for the same reason it uses it.
 * Exposed because a caller sometimes wants the id before the shell exists.
 */
export function nextShellId(state: TerminalWorkspace): string {
  const taken = (id: string) => state.shells.some((shell) => shell.id === id);
  if (!taken("shell")) return "shell";
  for (let n = 2; ; n += 1) {
    const id = `shell#${n}`;
    if (!taken(id)) return id;
  }
}

/** Open a shell at the end of the strip, focused — what `+` and ⌘T do. An id
 *  that is already open is a no-op but still takes focus, so a caller cannot
 *  mint two chips for one shell by asking twice. */
export function addShell(state: TerminalWorkspace, id: string = nextShellId(state)): TerminalWorkspace {
  if (state.shells.some((shell) => shell.id === id)) return { ...state, active: id };
  return { shells: [...state.shells, { id }], active: id };
}

/**
 * Close a shell and choose the next active one.
 *
 * THE NEIGHBOUR TAKES FOCUS — the shell to the right, or the new last one when
 * the closed shell was rightmost. Exactly what `closePanelTab` does one level
 * up, and for the same reason: falling back to "the first shell" would jump the
 * eye across the strip on every close.
 *
 * CLOSING THE LAST SHELL LEAVES AN EMPTY WORKSPACE rather than seeding a fresh
 * one. The surface is what decides that an empty Terminal is a Terminal that
 * should close (⌘W on the last shell closes the outer tab) — a reducer that
 * refilled itself could never say it.
 */
export function closeShell(state: TerminalWorkspace, id: string): TerminalWorkspace {
  const index = state.shells.findIndex((shell) => shell.id === id);
  if (index === -1) return state;
  const shells = state.shells.filter((shell) => shell.id !== id);
  if (shells.length === 0) return { shells };
  // Closing an inactive shell must not steal focus from the one you are using.
  const active = state.active === id ? (shells[index]?.id ?? shells[shells.length - 1]!.id) : state.active;
  return { shells, ...(active ? { active } : {}) };
}

export function activateShell(state: TerminalWorkspace, id: string): TerminalWorkspace {
  return state.shells.some((shell) => shell.id === id) ? { ...state, active: id } : state;
}

/** Remember which PTY this chip is attached to — the one fact that has to
 *  survive a remount, since it is the difference between re-adopting a running
 *  shell and opening a second one beside it. */
export function setShellTerminal(state: TerminalWorkspace, id: string, terminalId: string): TerminalWorkspace {
  if (!state.shells.some((shell) => shell.id === id && shell.terminalId !== terminalId)) return state;
  return { ...state, shells: state.shells.map((shell) => (shell.id === id ? { ...shell, terminalId } : shell)) };
}

/**
 * What the shell calls itself (xterm's `onTitleChange`, i.e. OSC 0/2).
 *
 * AN EMPTY TITLE CLEARS IT rather than being stored as "". A program that exits
 * and resets the title is saying "I am nothing in particular now", and the
 * chip should go back to `Shell N` instead of showing a blank.
 */
export function setShellTitle(state: TerminalWorkspace, id: string, title: string): TerminalWorkspace {
  const wanted = title.trim();
  const current = state.shells.find((shell) => shell.id === id);
  if (!current || (current.title ?? "") === wanted) return state;
  return {
    ...state,
    shells: state.shells.map((shell) => (shell.id === id ? { id: shell.id, ...(shell.terminalId ? { terminalId: shell.terminalId } : {}), ...(wanted ? { title: wanted } : {}) } : shell)),
  };
}

/**
 * Move a shell to a position in the strip. `toIndex` is an index in the RESULT
 * — the strip as it reads once the shell has left its old place — and is
 * clamped rather than refused, which is `movePanelTab`'s contract exactly.
 * Focus does not move with it: reordering says where a chip sits, not what you
 * are looking at.
 */
export function moveShell(state: TerminalWorkspace, id: string, toIndex: number): TerminalWorkspace {
  const from = state.shells.findIndex((shell) => shell.id === id);
  if (from === -1) return state;
  const moved = state.shells[from]!;
  const rest = state.shells.filter((shell) => shell.id !== id);
  const to = Math.max(0, Math.min(Math.trunc(toIndex), rest.length));
  if (to === from) return state;
  return { ...state, shells: [...rest.slice(0, to), moved, ...rest.slice(to)] };
}

export function activeShell(state: TerminalWorkspace): TerminalShell | undefined {
  return state.shells.find((shell) => shell.id === state.active);
}

/**
 * What a chip says: the shell's own title, or `Shell N` where N is its place in
 * the strip, counting from one.
 *
 * BY POSITION, NOT BY A STORED NUMBER. "Shell 2" should mean the second chip
 * you can see; a number minted at open time and kept would leave a strip
 * reading "Shell 1, Shell 3, Shell 7" after two closes, which is a puzzle
 * rather than a label.
 */
export function shellLabel(state: TerminalWorkspace, id: string): string {
  const index = state.shells.findIndex((shell) => shell.id === id);
  if (index === -1) return "Shell";
  return state.shells[index]!.title || `Shell ${index + 1}`;
}

/** Every PTY this workspace is holding, in strip order — what the reaper kills
 *  when the outer tab closes. Shells still waiting on a spawn contribute
 *  nothing, because there is nothing yet to kill. */
export function terminalIds(state: TerminalWorkspace): string[] {
  return state.shells.map((shell) => shell.terminalId).filter((id): id is string => typeof id === "string" && id !== "");
}

// ── the tab's params ───────────────────────────────────────────────────────

/**
 * The workspace as ONE params value, JSON-encoded.
 *
 * AN EMPTY WORKSPACE WRITES NOTHING — an absent key and "no shells" say the
 * same thing, and a stored `{"shells":[]}` would be a value nobody could tell
 * from a tab that has not started yet.
 */
export function workspaceParams(state: TerminalWorkspace): Record<string, string> {
  if (state.shells.length === 0) return {};
  return { [TERMINAL_WORKSPACE_PARAM]: JSON.stringify(state) };
}

/**
 * The workspace a tab's params describe — VALIDATED, like every other restore
 * in this app, because what is being read is JSON somebody's localStorage has
 * been holding across an upgrade.
 *
 * A TAB WITH ONLY THE OLD `terminal` KEY IS ONE SHELL. That is the whole of the
 * per-tab upgrade path: a Terminal opened by the previous build carries a bare
 * PTY id, and reading it as a single-shell workspace means the shell that was
 * running when the app restarted is still the shell you come back to.
 */
export function readWorkspace(params: Params): TerminalWorkspace {
  const raw = params[TERMINAL_WORKSPACE_PARAM];
  if (raw) {
    const parsed = parseWorkspace(raw);
    if (parsed) return parsed;
  }
  const legacy = params[TERMINAL_ID_PARAM];
  return legacy ? { shells: [{ id: "shell", terminalId: legacy }], active: "shell" } : emptyWorkspace();
}

function parseWorkspace(raw: string): TerminalWorkspace | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return undefined;
    const record = parsed as { shells?: unknown; active?: unknown };
    if (!Array.isArray(record.shells)) return undefined;
    const shells: TerminalShell[] = [];
    for (const entry of record.shells) {
      if (!entry || typeof entry !== "object") continue;
      const shell = entry as { id?: unknown; terminalId?: unknown; title?: unknown };
      if (typeof shell.id !== "string" || !shell.id || shells.some((other) => other.id === shell.id)) continue;
      shells.push({
        id: shell.id,
        ...(typeof shell.terminalId === "string" && shell.terminalId ? { terminalId: shell.terminalId } : {}),
        ...(typeof shell.title === "string" && shell.title ? { title: shell.title } : {}),
      });
    }
    if (shells.length === 0) return undefined;
    const active = shells.some((shell) => shell.id === record.active) ? (record.active as string) : shells[0]!.id;
    return { shells, active };
  } catch {
    return undefined;
  }
}

/** Every PTY a terminal tab's params name, whichever vocabulary they were
 *  written in — the reaper's question, asked without an emulator. */
export function terminalIdsInParams(params: Params): string[] {
  return terminalIds(readWorkspace(params));
}

/**
 * FOLD SEVERAL OUTER TERMINAL TABS INTO ONE TAB'S PARAMS — the upgrade.
 *
 * Every shell of every folded tab arrives in the one workspace, in the order
 * the strip had them, so nobody's running shells are orphaned by an upgrade
 * that turned three outer tabs into one. IDS ARE RE-MINTED: two tabs written by
 * the old build both carry the id `shell`, and keeping them would collapse two
 * live shells into one chip.
 *
 * THE FIRST SHELL TAKES FOCUS, not whichever tab happened to be active. The
 * strip you come back to reads left to right, and its first chip is the one the
 * leftmost of your old Terminal tabs held.
 */
export function foldTerminalParams(each: readonly Params[]): Record<string, string> {
  let folded = emptyWorkspace();
  for (const params of each) {
    for (const shell of readWorkspace(params).shells) {
      const id = nextShellId(folded);
      folded = {
        shells: [...folded.shells, { ...shell, id }],
        ...(folded.active ? { active: folded.active } : { active: id }),
      };
    }
  }
  return workspaceParams(folded);
}
