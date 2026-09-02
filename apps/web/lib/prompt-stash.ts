/**
 * THE STASH: prompts you set aside, shared by every composer in the app.
 *
 * NOT A DRAFT, and the distinction is the whole feature. A draft
 * (`composer-draft.ts`) belongs to ONE session, is written automatically as you
 * type, and is read back implicitly when you return to that session. A stash is
 * global, explicit at both ends — ⌘S puts one in, a pick takes one out — and
 * POPPED on use. The problem it solves is the one the clipboard solves badly:
 * you write a paragraph, realise it belongs in a different session, and the
 * clipboard holds exactly one of them, so a second thought overwrites the first.
 *
 * NO REACT, NO DOM, NO CLOCK, NO ID GENERATION in this file. Everything here is
 * a pure function or a storage call against an injectable `Storage`, which is
 * what lets `bun test` reach all of it — the same reason `model-favorites.ts`
 * takes its storage as a parameter. The pixels live in `stash-images.ts` and the
 * wiring in `use-prompt-stash.ts`, both of which import this.
 */

const KEY = "telar:prompt-stash:v1";

/**
 * A COUNT CAP THAT ONLY EVER BINDS ON TEXT. Twenty entries carrying pictures is
 * several times the origin's whole quota, so the byte budgets below are the real
 * limiter and this one is what stops a hundred one-line prompts accumulating.
 */
export const STASH_LIMIT = 20;
/** One entry can never be more than roughly a third of the budget, so making
 *  room for a single screenshot can never evict the whole stash. */
export const MAX_ENTRY_CHARS = 1_200_000;
/** The whole document. Well under the ~5 MB origin quota, which is shared with
 *  every other `telar:` key — the drafts especially. */
export const MAX_STASH_CHARS = 3_500_000;

export type StashedImage = {
  /** The name it was picked under. A restored file is the file you picked. */
  name: string;
  /** What the canvas encoded TO, never what came in. */
  type: string;
  dataUrl: string;
};

export type StashEntry = {
  id: string;
  at: number;
  prompt: string;
  images: StashedImage[];
};

/**
 * VALIDATED PER ENTRY, NOT PER DOCUMENT.
 *
 * `model-favorites` can afford all-or-nothing because losing the stars is a
 * gesture. One malformed row here must cost ONE prompt, not the week's worth
 * beside it — a stash you cannot trust to survive a bad byte is a stash nobody
 * puts anything important into.
 */
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

/**
 * RETURNS WHAT IT WROTE, or nothing at all if it could not write.
 *
 * This is the one place the stash breaks `composer-draft.ts`'s rule of
 * swallowing every storage failure in silence, and the reason is not symmetry
 * but consequence. A draft write that fails is invisible and harmless: the text
 * is still in the box. A STASH write that fails and is treated as success is
 * followed immediately by clearing the box, which destroys the paragraph.
 *
 * It returns the LIST rather than a boolean because shedding for quota changes
 * it: a caller told only "yes" would repaint a stash one entry longer than the
 * one on disk, and the badge would keep counting a prompt that is gone.
 */
export function writeStash(
  entries: readonly StashEntry[],
  storage: Pick<Storage, "setItem"> | undefined = safeStorage(),
): StashEntry[] | undefined {
  if (!storage) return undefined;
  // Newest first, so eviction is always from the END of the list.
  let candidate = [...entries];
  for (;;) {
    try {
      storage.setItem(KEY, JSON.stringify(candidate));
      return candidate;
    } catch {
      // Quota, and the number the browser reports is not one we can plan
      // against — it counts every other key in the origin. Shed the oldest and
      // ask again, down to the newest entry alone.
      if (candidate.length <= 1) return undefined;
      candidate = candidate.slice(0, -1);
    }
  }
}

/**
 * READ, CHANGE, WRITE — never write from React state.
 *
 * Two composers can be mounted at once (a session cockpit and a Spool stance),
 * and each holds its own `useState` copy of this list. A write built from one
 * component's copy silently discards whatever the other one stashed a second
 * ago. The list in state is a VIEW; storage is the source, and every mutation
 * re-reads it first.
 *
 * `ok: false` returns the list AS READ, so a refused write repaints the truth
 * rather than the change that did not happen.
 */
export function commitStash(
  mutate: (current: StashEntry[]) => StashEntry[],
  storage: Pick<Storage, "getItem" | "setItem"> | undefined = safeStorage(),
): { ok: boolean; entries: StashEntry[] } {
  const current = readStash(storage);
  const written = writeStash(fitStash(mutate(current)), storage);
  if (!written) return { ok: false, entries: current };
  return { ok: true, entries: written };
}

/** Newest first. The oldest falls off the end at the cap. */
export function pushEntry(current: readonly StashEntry[], entry: StashEntry): StashEntry[] {
  return [entry, ...current].slice(0, STASH_LIMIT);
}

export function dropEntry(current: readonly StashEntry[], id: string): StashEntry[] {
  return current.filter((entry) => entry.id !== id);
}

/**
 * Trim the list to something a quota can hold.
 *
 * AN OVERSIZED ENTRY IS REFUSED BEFORE IT CAN EVICT ANYTHING. Without that
 * order, one four-megabyte screenshot walks the whole stash off the end and
 * then fails to fit anyway — the user loses twenty prompts to save nothing.
 */
export function fitStash(entries: readonly StashEntry[]): StashEntry[] {
  const kept = entries.filter((entry) => weigh(entry) <= MAX_ENTRY_CHARS).slice(0, STASH_LIMIT);
  let total = kept.reduce((sum, entry) => sum + weigh(entry), 0);
  while (kept.length > 1 && total > MAX_STASH_CHARS) {
    const evicted = kept.pop();
    total -= evicted ? weigh(evicted) : 0;
  }
  return kept;
}

/**
 * POP — with the one amendment that stops it losing pictures.
 *
 * Restoring takes the prompt and as many images as the destination box has room
 * for. If some do not fit, the entry does not vanish: what is left stays behind
 * as an image-only remainder. `room` is large enough in every ordinary restore
 * that this is exactly the plain pop it looks like; the remainder exists for the
 * two states where a plain pop would silently throw pictures away — a composer
 * already holding sixteen attachments, and one that accepts none at all.
 */
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

/**
 * A RESTORE NEVER EATS WHAT IS ALREADY IN THE BOX.
 *
 * The stashed prompt lands after a blank line, and the half-sentence someone was
 * typing survives — replacing the draft would make restoring the wrong row
 * unrecoverable, which is the one thing `composer-draft.ts`'s header says a
 * composer must never do. An image-only entry adds no blank lines, because it
 * has nothing to separate.
 */
export function appendPrompt(draft: string, prompt: string): string {
  if (!prompt) return draft;
  const before = draft.replace(/\s+$/, "");
  return before ? `${before}\n\n${prompt}` : prompt;
}

/**
 * What the stash can carry, and what has to stay in the box.
 *
 * A file with an EMPTY type stays behind: a `.heic` the browser declined to
 * identify is not something a canvas can open, and calling it an image only
 * moves the failure later.
 */
export function splitImages(files: readonly File[]): { images: File[]; rest: File[] } {
  return {
    images: files.filter((file) => file.type.startsWith("image/")),
    rest: files.filter((file) => !file.type.startsWith("image/")),
  };
}

/**
 * Existing attachments first, then the restored ones, deduped on name and size.
 *
 * THE DEDUPE DOES NOT CATCH "the original is still attached" — a canvas
 * re-encode changes the size, so a restored image never matches the file it came
 * from. It catches the case that actually happens: two entries stashed from the
 * same screenshot, both restored into one box.
 */
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

/**
 * The one line a row shows.
 *
 * A prompt's FIRST line, not its first eighty characters: a message that opens
 * with a blank line or a `@path` on its own reads as an empty row otherwise.
 * An entry with no text is named by what it does have.
 */
export function entrySummary(entry: StashEntry): string {
  const line = entry.prompt
    .split("\n")
    .map((part) => part.trim())
    .find(Boolean);
  if (line) return line.length > 90 ? `${line.slice(0, 89)}…` : line;
  if (entry.images.length > 0) return entry.images.length === 1 ? "1 image" : `${entry.images.length} images`;
  return "Empty";
}

/** Roughly the characters this entry costs in the serialized document. The
 *  data URLs dominate by orders of magnitude, so the JSON overhead is noise. */
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
