/**
 * The stash queue.
 *
 * The claim this file exists to hold down is the one in `writeStash`'s header:
 * a refused write must be REPORTED, because the composer clears itself on the
 * strength of the answer. Everything else here is arithmetic; that one is the
 * difference between setting a paragraph aside and losing it.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import {
  MAX_ENTRY_CHARS,
  MAX_STASH_CHARS,
  STASH_LIMIT,
  appendPrompt,
  commitStash,
  dropEntry,
  entrySummary,
  fitStash,
  mergeAttachments,
  pushEntry,
  readStash,
  splitImages,
  takeEntry,
  writeStash,
  type StashEntry,
} from "./prompt-stash";

const KEY = "telar:prompt-stash:v1";

function storage(initial?: string) {
  const slots = new Map<string, string>();
  if (initial !== undefined) slots.set(KEY, initial);
  return {
    getItem: (key: string) => slots.get(key) ?? null,
    setItem: (key: string, value: string) => void slots.set(key, value),
    read: () => slots.get(KEY),
  };
}

/** A storage whose `setItem` throws for the first `failures` calls. `Infinity`
 *  is a quota nothing fits in — the case the boolean exists for. */
function tightStorage(initial: StashEntry[], failures: number) {
  const slots = new Map<string, string>([[KEY, JSON.stringify(initial)]]);
  let thrown = 0;
  return {
    getItem: (key: string) => slots.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (thrown < failures) {
        thrown += 1;
        throw new Error("QuotaExceededError");
      }
      slots.set(key, value);
    },
    read: () => slots.get(KEY),
  };
}

function entry(id: string, prompt = id, images: StashEntry["images"] = []): StashEntry {
  return { id, at: 1_000, prompt, images };
}

function picture(chars: number, name = "shot.webp") {
  return { name, type: "image/webp", dataUrl: `data:image/webp;base64,${"A".repeat(chars)}` };
}

describe("reading", () => {
  test("nothing stored is an empty stash, not a failure", () => {
    expect(readStash(storage())).toEqual([]);
    expect(readStash(storage("not json"))).toEqual([]);
    expect(readStash(storage('{"entries":[]}'))).toEqual([]);
  });

  test("A BAD ROW COSTS ONE PROMPT, NEVER THE STASH", () => {
    // The whole reason this validates per entry instead of per document. A
    // stash you cannot trust to survive one bad byte is one nobody puts
    // anything important into.
    const stored = JSON.stringify([entry("a"), { id: "b" }, null, entry("c")]);
    expect(readStash(storage(stored)).map((row) => row.id)).toEqual(["a", "c"]);
  });

  test("round-trips", () => {
    const store = storage();
    expect(writeStash([entry("a"), entry("b")], store)?.map((row) => row.id)).toEqual(["a", "b"]);
    expect(readStash(store).map((row) => row.id)).toEqual(["a", "b"]);
  });
});

describe("pushEntry", () => {
  test("newest first, oldest off the end, and never mutates its input", () => {
    const before = [entry("a")];
    expect(pushEntry(before, entry("b")).map((row) => row.id)).toEqual(["b", "a"]);
    expect(before.map((row) => row.id)).toEqual(["a"]);

    const full = Array.from({ length: STASH_LIMIT }, (_, at) => entry(`old-${at}`));
    const pushed = pushEntry(full, entry("new"));
    expect(pushed).toHaveLength(STASH_LIMIT);
    expect(pushed[0]?.id).toBe("new");
    expect(pushed.at(-1)?.id).toBe(`old-${STASH_LIMIT - 2}`);
  });
});

describe("fitStash", () => {
  test("an oversized entry is refused BEFORE it can evict anything", () => {
    // Without that order one huge screenshot walks the whole stash off the end
    // and then fails to fit anyway: twenty prompts lost to save nothing.
    const huge = entry("huge", "", [picture(MAX_ENTRY_CHARS + 1)]);
    expect(fitStash([huge, entry("a"), entry("b")]).map((row) => row.id)).toEqual(["a", "b"]);
  });

  test("drops oldest until the document fits", () => {
    const each = picture(Math.floor(MAX_STASH_CHARS / 3.5));
    const kept = fitStash([entry("a", "", [each]), entry("b", "", [each]), entry("c", "", [each]), entry("d", "", [each])]);
    expect(kept.map((row) => row.id)).toEqual(["a", "b", "c"]);
  });
});

describe("commitStash", () => {
  test("a quota that clears after shedding reports what actually landed", () => {
    // NOT just `ok: true`. Shedding changes the list, and a caller told only
    // "yes" would go on counting a prompt that is no longer on disk.
    const store = tightStorage([entry("old"), entry("older")], 1);
    const result = commitStash((current) => pushEntry(current, entry("new")), store);
    expect(result.ok).toBe(true);
    expect(result.entries.map((row) => row.id)).toEqual(["new", "old"]);
    expect(readStash(store).map((row) => row.id)).toEqual(["new", "old"]);
  });

  test("A REFUSED WRITE SAYS SO, AND REPORTS THE LIST AS IT WAS", () => {
    // The single most load-bearing assertion in this file. The composer clears
    // itself only when `ok` is true; a false success here is a destroyed
    // paragraph, and repainting the change that did not happen is a stash that
    // lies about what it holds.
    const store = tightStorage([entry("kept")], Number.POSITIVE_INFINITY);
    const result = commitStash((current) => pushEntry(current, entry("new")), store);
    expect(result.ok).toBe(false);
    expect(result.entries.map((row) => row.id)).toEqual(["kept"]);
    expect(readStash(store).map((row) => row.id)).toEqual(["kept"]);
  });

  test("reads before it writes, so one composer never discards the other's", () => {
    // Two composers can be mounted at once and each holds its own copy of this
    // list. A write built from stale state is the lost update this guards.
    const store = storage(JSON.stringify([entry("from-the-other-window")]));
    commitStash((current) => pushEntry(current, entry("mine")), store);
    expect(readStash(store).map((row) => row.id)).toEqual(["mine", "from-the-other-window"]);
  });
});

describe("takeEntry", () => {
  test("with room, it is a plain pop", () => {
    const current = [entry("a"), entry("b")];
    const taken = takeEntry(current, "a", 16);
    expect(taken?.prompt).toBe("a");
    expect(taken?.left).toBe(0);
    expect(taken?.next.map((row) => row.id)).toEqual(["b"]);
  });

  test("an id that is gone takes nothing", () => {
    // The other window got there first, which is also what stops a click and
    // an Enter landing on the same row twice.
    expect(takeEntry([entry("a")], "b", 16)).toBeUndefined();
  });

  test("WHAT WILL NOT FIT STAYS BEHIND rather than being lost", () => {
    const stashed = entry("a", "words", [picture(10, "one.webp"), picture(10, "two.webp"), picture(10, "three.webp")]);
    const none = takeEntry([stashed], "a", 0);
    expect(none?.prompt).toBe("words");
    expect(none?.images).toEqual([]);
    expect(none?.left).toBe(3);
    expect(none?.next[0]?.images).toHaveLength(3);
    // The prompt came out, so the remainder is images only — restoring it
    // again must not paste the same sentence a second time.
    expect(none?.next[0]?.prompt).toBe("");

    const one = takeEntry([stashed], "a", 1);
    expect(one?.images.map((image) => image.name)).toEqual(["one.webp"]);
    expect(one?.left).toBe(2);
    expect(one?.next[0]?.images.map((image) => image.name)).toEqual(["two.webp", "three.webp"]);
  });
});

describe("dropEntry", () => {
  test("removes one and leaves the rest in order", () => {
    expect(dropEntry([entry("a"), entry("b"), entry("c")], "b").map((row) => row.id)).toEqual(["a", "c"]);
  });
});

describe("appendPrompt", () => {
  test("lands after a blank line and never eats what is in the box", () => {
    expect(appendPrompt("abc  \n ", "def")).toBe("abc\n\ndef");
    expect(appendPrompt("", "def")).toBe("def");
    expect(appendPrompt("   ", "def")).toBe("def");
  });

  test("an image-only entry adds nothing, not two newlines", () => {
    expect(appendPrompt("abc", "")).toBe("abc");
    expect(appendPrompt("", "")).toBe("");
  });
});

describe("splitImages", () => {
  test("partitions on the mime type, and an untyped file is not an image", () => {
    // A `.heic` the browser declined to identify is not something a canvas can
    // open; calling it an image only moves the failure later.
    const files = [
      new File(["a"], "shot.png", { type: "image/png" }),
      new File(["b"], "notes.pdf", { type: "application/pdf" }),
      new File(["c"], "mystery.heic"),
    ];
    const split = splitImages(files);
    expect(split.images.map((file) => file.name)).toEqual(["shot.png"]);
    expect(split.rest.map((file) => file.name)).toEqual(["notes.pdf", "mystery.heic"]);
  });
});

describe("mergeAttachments", () => {
  test("existing first, duplicates dropped, sliced to the cap", () => {
    const held = new File(["aaa"], "shot.webp", { type: "image/webp" });
    const same = new File(["aaa"], "shot.webp", { type: "image/webp" });
    const other = new File(["bb"], "other.webp", { type: "image/webp" });
    const merged = mergeAttachments([held], [same, other], 16);
    expect(merged.map((file) => file.name)).toEqual(["shot.webp", "other.webp"]);
    expect(mergeAttachments([held], [other], 1).map((file) => file.name)).toEqual(["shot.webp"]);
  });
});

describe("entrySummary", () => {
  test("the first line with anything on it, not the first eighty characters", () => {
    // A message opening with a blank line would otherwise render an empty row.
    expect(entrySummary(entry("a", "\n\n  fix the parser\nand the tests"))).toBe("fix the parser");
    expect(entrySummary(entry("a", "x".repeat(200)))).toBe(`${"x".repeat(89)}…`);
  });

  test("an entry with no text is named by what it does have", () => {
    expect(entrySummary(entry("a", "", [picture(4), picture(4)]))).toBe("2 images");
    expect(entrySummary(entry("a", "", [picture(4)]))).toBe("1 image");
    expect(entrySummary(entry("a", ""))).toBe("Empty");
  });
});
