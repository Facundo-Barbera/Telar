
const KEY = "telar:prompt-stash:v1";

export const STASH_LIMIT = 20;
export const MAX_ENTRY_CHARS = 1_200_000;
export const MAX_STASH_CHARS = 3_500_000;

export type StashedImage = {
  name: string;
  type: string;
  dataUrl: string;
};

export type StashEntry = {
  id: string;
  at: number;
  prompt: string;
  images: StashedImage[];
};

export function readStash(storage: Pick<Storage, "getItem"> | undefined = safeStorage()): StashEntry[] {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEntry);
  } catch {
    return [];
  }
}

export function writeStash(
  entries: readonly StashEntry[],
  storage: Pick<Storage, "setItem"> | undefined = safeStorage(),
): StashEntry[] | undefined {
  if (!storage) return undefined;
  let candidate = [...entries];
  for (;;) {
    try {
      storage.setItem(KEY, JSON.stringify(candidate));
      return candidate;
    } catch {
      if (candidate.length <= 1) return undefined;
      candidate = candidate.slice(0, -1);
    }
  }
}

export function commitStash(
  mutate: (current: StashEntry[]) => StashEntry[],
  storage: Pick<Storage, "getItem" | "setItem"> | undefined = safeStorage(),
): { ok: boolean; entries: StashEntry[] } {
  const current = readStash(storage);
  const written = writeStash(fitStash(mutate(current)), storage);
  if (!written) return { ok: false, entries: current };
  return { ok: true, entries: written };
}

export function pushEntry(current: readonly StashEntry[], entry: StashEntry): StashEntry[] {
  return [entry, ...current].slice(0, STASH_LIMIT);
}

export function dropEntry(current: readonly StashEntry[], id: string): StashEntry[] {
  return current.filter((entry) => entry.id !== id);
}

export function fitStash(entries: readonly StashEntry[]): StashEntry[] {
  const kept = entries.filter((entry) => weigh(entry) <= MAX_ENTRY_CHARS).slice(0, STASH_LIMIT);
  let total = kept.reduce((sum, entry) => sum + weigh(entry), 0);
  while (kept.length > 1 && total > MAX_STASH_CHARS) {
    const evicted = kept.pop();
    total -= evicted ? weigh(evicted) : 0;
  }
  return kept;
}

export function takeEntry(
  current: readonly StashEntry[],
  id: string,
  room: number,
): { prompt: string; images: StashedImage[]; left: number; next: StashEntry[] } | undefined {
  const entry = current.find((candidate) => candidate.id === id);
  if (!entry) return undefined;
  const images = entry.images.slice(0, Math.max(0, room));
  const rest = entry.images.slice(images.length);
  const next =
    rest.length === 0
      ? dropEntry(current, id)
      : current.map((candidate) => (candidate.id === id ? { ...candidate, prompt: "", images: rest } : candidate));
  return { prompt: entry.prompt, images, left: rest.length, next };
}

export function appendPrompt(draft: string, prompt: string): string {
  if (!prompt) return draft;
  const before = draft.replace(/\s+$/, "");
  return before ? `${before}\n\n${prompt}` : prompt;
}

export function splitImages(files: readonly File[]): { images: File[]; rest: File[] } {
  return {
    images: files.filter((file) => file.type.startsWith("image/")),
    rest: files.filter((file) => !file.type.startsWith("image/")),
  };
}

export function mergeAttachments(current: readonly File[], incoming: readonly File[], cap: number): File[] {
  const seen = new Set(current.map((file) => `${file.name}:${file.size}`));
  const added = incoming.filter((file) => {
    const id = `${file.name}:${file.size}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return [...current, ...added].slice(0, cap);
}

export function entrySummary(entry: StashEntry): string {
  const line = entry.prompt
    .split("\n")
    .map((part) => part.trim())
    .find(Boolean);
  if (line) return line.length > 90 ? `${line.slice(0, 89)}…` : line;
  const count = entry.images.length;
  const noun = entry.images.every((image) => image.type.startsWith("image/")) ? "image" : "file";
  if (count > 0) return count === 1 ? `1 ${noun}` : `${count} ${noun}s`;
  return "Empty";
}

function weigh(entry: StashEntry): number {
  return entry.prompt.length + entry.images.reduce((sum, image) => sum + image.dataUrl.length, 0);
}

function isEntry(value: unknown): value is StashEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<StashEntry>;
  return (
    typeof entry.id === "string" &&
    typeof entry.at === "number" &&
    typeof entry.prompt === "string" &&
    Array.isArray(entry.images) &&
    entry.images.every(isImage)
  );
}

function isImage(value: unknown): value is StashedImage {
  if (typeof value !== "object" || value === null) return false;
  const image = value as Partial<StashedImage>;
  return typeof image.name === "string" && typeof image.type === "string" && typeof image.dataUrl === "string";
}

function safeStorage(): Pick<Storage, "getItem" | "setItem"> | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}
