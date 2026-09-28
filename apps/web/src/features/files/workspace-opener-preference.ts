
export const SYSTEM_OPENER_ID = "system";
export const REVEAL_OPENER_ID = "reveal";

export type OpenerLike = { id: string; label: string; path?: string; icon?: string; iconDataUrl?: string };

type WorkspaceOpenerEntryKind =
  | "opener"
  | "reveal"
  | "empty";

export type WorkspaceOpenerEntry = {
  id: string;
  label: string;
  primaryLabel?: string;
  kind: WorkspaceOpenerEntryKind;
  icon?: string;
  iconDataUrl?: string;
  openerId?: string;
  path?: string;
  preferred?: boolean;
  separatorBefore?: boolean;
  shortcut?: string;
};

const KEY_PREFIX = "telar:workspace-opener:v1";
const LOCAL = "local";

export function workspaceOpenerPreferenceKey(hostId?: string): string {
  return `${KEY_PREFIX}:${hostId || LOCAL}`;
}

export function readPreferredOpener(hostId: string | undefined, storage: Pick<Storage, "getItem"> | undefined = safeStorage()): string | undefined {
  try {
    const raw = storage?.getItem(workspaceOpenerPreferenceKey(hostId));
    return raw ? raw : undefined;
  } catch {
    return undefined;
  }
}

export function writePreferredOpener(
  hostId: string | undefined,
  id: string,
  storage: Pick<Storage, "setItem"> | undefined = safeStorage(),
): void {
  try {
    storage?.setItem(workspaceOpenerPreferenceKey(hostId), id);
  } catch {
  }
  cached.set(workspaceOpenerPreferenceKey(hostId), id);
  for (const listener of listeners) listener();
}

const listeners = new Set<() => void>();
const cached = new Map<string, string | undefined>();

export function subscribePreferredOpener(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function preferredOpenerSnapshot(hostId?: string): string | undefined {
  const key = workspaceOpenerPreferenceKey(hostId);
  if (!cached.has(key)) cached.set(key, readPreferredOpener(hostId));
  return cached.get(key);
}

export function serverPreferredOpenerSnapshot(): string | undefined {
  return undefined;
}

export function workspaceOpenerEntries(input: {
  openers: readonly OpenerLike[];
  preferred?: string | undefined;
  shortcut?: string | undefined;
  revealIconDataUrl?: string | undefined;
}): WorkspaceOpenerEntry[] {
  const apps: WorkspaceOpenerEntry[] = input.openers.map((opener) => ({
    id: opener.id,
    label: opener.label,
    primaryLabel: `Open in ${opener.label}`,
    kind: "opener",
    openerId: opener.id,
    ...(opener.icon ? { icon: opener.icon } : {}),
    ...(opener.iconDataUrl ? { iconDataUrl: opener.iconDataUrl } : {}),
    ...(opener.path ? { path: opener.path } : {}),
  }));

  const natural: WorkspaceOpenerEntry[] = [
    ...(apps.length > 0 ? apps : [{ id: "none", label: "No installed editors found", kind: "empty" as const }]),
    {
      id: REVEAL_OPENER_ID,
      label: "Reveal in Finder",
      primaryLabel: "Reveal in Finder",
      kind: "reveal",
      ...(input.revealIconDataUrl ? { iconDataUrl: input.revealIconDataUrl } : {}),
    },
  ];

  const chosen = natural.find((entry) => entry.id === input.preferred && remembersOpener(entry));
  const ordered = chosen ? [chosen, ...natural.filter((entry) => entry !== chosen)] : natural;

  return ordered.map((entry, index) => ({
    ...entry,
    ...(entry === chosen ? { preferred: true } : {}),
    ...(entry === chosen && input.shortcut ? { shortcut: input.shortcut } : {}),
    ...(index > 0 && ((index === 1 && Boolean(chosen)) || groupOf(entry) !== groupOf(ordered[index - 1]!)) ? { separatorBefore: true } : {}),
  }));
}

export function remembersOpener(entry: Pick<WorkspaceOpenerEntry, "kind">): boolean {
  return entry.kind === "opener";
}

export function workspaceOpenerPrimary(entries: readonly WorkspaceOpenerEntry[]): WorkspaceOpenerEntry | undefined {
  const first = entries[0];
  if (first?.preferred) return first;
  return entries.find((entry) => entry.kind === "reveal");
}

export function workspaceOpenerPrimaryLabel(entries: readonly WorkspaceOpenerEntry[]): string {
  return workspaceOpenerPrimary(entries)?.primaryLabel ?? "Open";
}

function groupOf(entry: WorkspaceOpenerEntry): "app" | "tool" {
  return entry.kind === "opener" || entry.kind === "empty" ? "app" : "tool";
}

function safeStorage(): Storage | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}
