import type { DirectoryEntry } from "@telar/engine-client";

export type DirectoryBrowserState = {
  field: string;
  path: string;
  /** `null` at a browsable root. */
  parent: string | null;
  /** The answering engine's home, so `~` means that machine. */
  home: string;
  entries: readonly DirectoryEntry[];
  index: number;
  hidden: boolean;
};

export type DirectoryKey = { key: string; meta?: boolean; ctrl?: boolean };

export type DirectoryAction =
  | { type: "none" }
  | { type: "move"; index: number }
  | { type: "open"; path: string }
  | { type: "complete"; field: string }
  | { type: "hidden"; hidden: boolean }
  | { type: "submit"; path: string };

const SEP = "/";

function trimEnd(target: string): string {
  const trimmed = target.replace(/\/+$/, "");
  return trimmed || SEP;
}

/** `~someone` is left alone for the engine to refuse. */
export function expandTilde(field: string, home: string): string {
  const input = field.trim();
  if (!input || input === "~" || input === "~/") return home;
  if (input.startsWith("~/")) return trimEnd(`${trimEnd(home)}${SEP}${input.slice(2)}`);
  return trimEnd(input);
}

export function foldHome(target: string, home: string): string {
  const root = trimEnd(home);
  if (target === root) return "~";
  return target.startsWith(`${root}${SEP}`) ? `~${target.slice(root.length)}` : target;
}

/** Folded, with a trailing separator so typing continues inside the folder. */
export function directoryField(path: string, home: string): string {
  const folded = foldHome(path, home);
  return folded.endsWith(SEP) ? folded : `${folded}${SEP}`;
}

export function edited(state: DirectoryBrowserState): boolean {
  return state.field !== directoryField(state.path, state.home);
}

export function clampIndex(index: number, length: number): number {
  if (length === 0) return -1;
  return Math.min(Math.max(index, 0), length - 1);
}

function commonPrefix(names: readonly string[]): string {
  if (names.length === 0) return "";
  let prefix = names[0]!;
  for (const name of names.slice(1)) {
    let at = 0;
    while (at < prefix.length && at < name.length && prefix[at] === name[at]) at += 1;
    prefix = prefix.slice(0, at);
  }
  return prefix;
}

/** Completes only against the listing on screen; a unique match descends. */
export function completion(state: DirectoryBrowserState): string | undefined {
  const cut = state.field.lastIndexOf(SEP);
  if (cut === -1) return undefined;
  const directory = state.field.slice(0, cut + 1);
  const seed = state.field.slice(cut + 1);
  if (!seed) return undefined;
  if (expandTilde(directory, state.home) !== trimEnd(state.path)) return undefined;
  const lower = seed.toLocaleLowerCase();
  const matches = state.entries.filter((entry) => entry.name.toLocaleLowerCase().startsWith(lower));
  if (matches.length === 0) return undefined;
  if (matches.length === 1) return `${directory}${matches[0]!.name}${SEP}`;
  const shared = commonPrefix(matches.map((entry) => entry.name));
  return shared.length > seed.length ? `${directory}${shared}` : undefined;
}

/** Enter and Backspace navigate only while the field is still the breadcrumb; ⌘ and Ctrl are the same key. */
export function directoryKey(state: DirectoryBrowserState, key: DirectoryKey): DirectoryAction {
  const command = Boolean(key.meta || key.ctrl);

  if (command && key.key === "Enter") return { type: "submit", path: state.path };
  if (command && key.key === ".") return { type: "hidden", hidden: !state.hidden };

  if (key.key === "ArrowDown" || key.key === "ArrowUp") {
    if (state.entries.length === 0) return { type: "none" };
    const delta = key.key === "ArrowDown" ? 1 : -1;
    const from = clampIndex(state.index, state.entries.length);
    return { type: "move", index: (from + delta + state.entries.length) % state.entries.length };
  }

  if (key.key === "Tab") {
    const completed = completion(state);
    return completed === undefined ? { type: "none" } : { type: "complete", field: completed };
  }

  if (key.key === "Enter") {
    if (edited(state)) return { type: "open", path: expandTilde(state.field, state.home) };
    const row = state.entries[clampIndex(state.index, state.entries.length)];
    return row ? { type: "open", path: row.path } : { type: "none" };
  }

  if (key.key === "Backspace") {
    if (edited(state)) return { type: "none" };
    return state.parent ? { type: "open", path: state.parent } : { type: "none" };
  }

  return { type: "none" };
}

/** Per host: another Mac's paths would start every visit with a refusal. */
export function rememberedDirectoryKey(hostId: string | undefined): string {
  return `telar.directory-browser.${hostId && hostId !== "local" ? hostId : "local"}`;
}
