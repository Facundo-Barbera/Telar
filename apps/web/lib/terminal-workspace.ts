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
   *  is what `shellLabel` falls back for. A RUN's chip carries its
   *  configuration's name here instead, because a run does not name itself. */
  title?: string;
  /**
   * A RUN, WHEN THIS CHIP IS ONE (#890; "Run = a new terminal").
   *
   * A run and a person's shell are the same kind of thing — a terminal the
   * desktop holds, owned by this session — so they belong in one strip. What
   * differs is WHO ENDS IT: a shell is ended by the host directly, a run by the
   * engine, which started it, keeps its record and tells the agent who closed
   * it. That is the whole of why this field exists rather than a `kind`:
   *
   *   - closing the chip ends the run through the engine (`lib/terminal-close.ts`),
   *     with a question first when something is still running in it;
   *   - `terminalIds` lists the SHELLS only, the ids the host may close for the
   *     renderer; the tab's reaper reads runs off `run` instead;
   *   - an open run with no chip gets one back on the next mount.
   *
   * `configId` rides along with `runId` so the chip can draw the recipe's glyph
   * without a second read: the run answers which configuration it came from,
   * and a recipe deleted mid-run simply has no glyph.
   */
  run?: { runId: string; configId: string };
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

/** The chip showing this run, if the strip has one. */
export function shellForRun(state: TerminalWorkspace, runId: string): TerminalShell | undefined {
  return state.shells.find((shell) => shell.run?.runId === runId);
}

/**
 * Put a run in the strip, or update the chip it already has.
 *
 * IDEMPOTENT BY RUN ID, and that is load-bearing rather than tidy. This is
 * called from a status feed and from the mount that adopts whatever was already
 * running, so the same run arrives more than once by construction; minting a
 * chip per arrival would give one deployment three chips reading the same PTY.
 *
 * IT DOES NOT TAKE FOCUS, unlike `addShell`. A run can start from an agent's
 * tool call or another session's button, and a strip that jumped to it would
 * move the shell out from under whatever somebody was typing. `focus: true` is
 * for the one case where a person asked — pressing play themselves.
 *
 * THE TERMINAL ID MAY ARRIVE LATE OR GO. A run is `starting` before the host
 * has named its PTY, and stops naming one once the handle is gone, so this
 * writes what it was given and never invents or keeps a stale id.
 */
export function upsertRunShell(
  state: TerminalWorkspace,
  run: { runId: string; configId: string; terminalId?: string; title?: string },
  options: { focus?: boolean } = {},
): TerminalWorkspace {
  const existing = shellForRun(state, run.runId);
  const shape = (id: string): TerminalShell => ({
    id,
    ...(run.terminalId ? { terminalId: run.terminalId } : {}),
    ...(run.title ? { title: run.title } : {}),
    run: { runId: run.runId, configId: run.configId },
  });
  if (existing) {
    const next = shape(existing.id);
    const unchanged = existing.terminalId === next.terminalId && existing.title === next.title && existing.run?.configId === next.run?.configId;
    // Identity-stable when nothing moved: this runs on every frame of a status
    // feed, and a new object each time would write the tab's params back to
    // storage — and re-render every pane in the strip — for no change at all.
    if (unchanged && !options.focus) return state;
    return {
      ...state,
      shells: state.shells.map((shell) => (shell.id === existing.id ? next : shell)),
      ...(options.focus ? { active: existing.id } : {}),
    };
  }
  const id = nextRunShellId(state);
  return {
    shells: [...state.shells, shape(id)],
    ...(options.focus || state.active === undefined ? { active: id } : { active: state.active }),
  };
}

/**
 * The chip id for a run: `run`, then `run#2`, in `nextShellId`'s own spelling.
 *
 * NOT THE RUN ID ITSELF. A chip id is written into the tab's params and read
 * back by a build that may be older or newer; keeping it in the same vocabulary
 * as every other chip means nothing downstream has to know which chips are runs
 * to be able to address one.
 */
function nextRunShellId(state: TerminalWorkspace): string {
  const taken = (id: string) => state.shells.some((shell) => shell.id === id);
  if (!taken("run")) return "run";
  for (let n = 2; ; n += 1) {
    const id = `run#${n}`;
    if (!taken(id)) return id;
  }
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

/** Every chip that is a run, in strip order. */
export function runShells(state: TerminalWorkspace): TerminalShell[] {
  return state.shells.filter((shell) => shell.run !== undefined);
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
    shells: state.shells.map((shell) =>
      shell.id === id
        ? {
            id: shell.id,
            ...(shell.terminalId ? { terminalId: shell.terminalId } : {}),
            ...(wanted ? { title: wanted } : {}),
            // A run keeps being a run whatever its program calls itself.
            ...(shell.run ? { run: shell.run } : {}),
          }
        : shell,
    ),
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
  const shell = state.shells.find((entry) => entry.id === id);
  if (!shell) return "Shell";
  if (shell.title) return shell.title;
  // A RUN IS NOT NUMBERED WITH THE SHELLS, and it is not counted among them
  // either: its label is its configuration's name, which the surface writes as
  // the title, and numbering the person's shells around it would make "Shell 2"
  // mean the first shell you can see. Counting only shells keeps that phrase
  // true whatever else is in the strip.
  if (shell.run) return "Run";
  const shells = state.shells.filter((entry) => entry.run === undefined);
  return `Shell ${shells.findIndex((entry) => entry.id === id) + 1}`;
}

/**
 * Every SHELL's PTY in this workspace, in strip order — the ids the host lets
 * the renderer close itself. Shells still waiting on a spawn contribute
 * nothing, because there is nothing yet to close.
 *
 * A RUN'S TERMINAL IS NOT ON THIS LIST, and not because it is spared: closing
 * the Terminal tab ends runs too (`closeTerminalTab`), but through the ENGINE,
 * which started them and records who closed them. The host would refuse a
 * renderer's close of a terminal the engine owns.
 */
export function terminalIds(state: TerminalWorkspace): string[] {
  return state.shells
    .filter((shell) => shell.run === undefined)
    .map((shell) => shell.terminalId)
    .filter((id): id is string => typeof id === "string" && id !== "");
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
      const shell = entry as { id?: unknown; terminalId?: unknown; title?: unknown; run?: unknown };
      if (typeof shell.id !== "string" || !shell.id || shells.some((other) => other.id === shell.id)) continue;
      shells.push({
        id: shell.id,
        ...(typeof shell.terminalId === "string" && shell.terminalId ? { terminalId: shell.terminalId } : {}),
        ...(typeof shell.title === "string" && shell.title ? { title: shell.title } : {}),
        ...(runOf(shell.run) ? { run: runOf(shell.run)! } : {}),
      });
    }
    if (shells.length === 0) return undefined;
    const active = shells.some((shell) => shell.id === record.active) ? (record.active as string) : shells[0]!.id;
    return { shells, active };
  } catch {
    return undefined;
  }
}

/**
 * A stored `run`, validated — BOTH IDS OR NEITHER.
 *
 * A half-written pair is not a run chip that is missing a field, it is a chip
 * nothing can address: with no `runId` there is no deployment to stop and no
 * status to follow, so it would draw as a permanently blank run. Refusing it
 * here restores it as an ordinary (empty) shell instead, which a person can
 * close.
 */
function runOf(value: unknown): { runId: string; configId: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const run = value as { runId?: unknown; configId?: unknown };
  if (typeof run.runId !== "string" || !run.runId) return undefined;
  if (typeof run.configId !== "string" || !run.configId) return undefined;
  return { runId: run.runId, configId: run.configId };
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
