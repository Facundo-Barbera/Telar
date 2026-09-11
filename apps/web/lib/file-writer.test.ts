/**
 * THE FALSE CONFLICT, stated as the rule it broke: a write carries the hash of
 * the last write that LANDED, and the editor's own saves can never be a conflict
 * with themselves.
 *
 * The engine here is a real one in miniature — it holds bytes and a hash,
 * refuses any write whose precondition does not match, and can be made to answer
 * slowly so two writes overlap. That is the whole machine the bug lived in.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { createFileWriter, type FileWriteAnswer } from "./file-writer";

/** A file on disk, with the engine's precondition rule and nothing else. */
function disk(text = "start") {
  let held = text;
  let version = 0;
  const writes: { text: string; expected: string; refused: boolean }[] = [];
  /** Answers that do not resolve until `settle()` is called, so a test can hold
   *  a write open and type underneath it. */
  const open: (() => void)[] = [];
  return {
    get text() {
      return held;
    },
    get sha256() {
      return `sha_${version}`;
    },
    writes,
    /** Wait until a write is actually open, then let every held one answer.
     *  Polled rather than assumed: a queued write only reaches the wire a
     *  microtask after the one in front of it answers. */
    async settle() {
      while (open.length === 0) await Promise.resolve();
      const waiting = open.splice(0);
      for (const release of waiting) release();
    },
    write(slow = false) {
      return async (text: string, expected: string): Promise<FileWriteAnswer> => {
        if (slow) await new Promise<void>((resolve) => open.push(resolve));
        const refused = expected !== `sha_${version}`;
        writes.push({ text, expected, refused });
        if (refused) return { written: false, refusal: "conflict" };
        held = text;
        version += 1;
        return { written: true, sha256: `sha_${version}` };
      };
    },
  };
}

describe("the baseline a write carries", () => {
  test("the second write carries the hash the first one produced", async () => {
    // Without this every save after the first is a conflict with the save
    // before it — the file changed on disk, and we are what changed it.
    const file = disk();
    const writer = createFileWriter({ send: file.write() });
    writer.rebase({ sha256: file.sha256 });

    expect(await writer.persist("one")).toEqual({ status: "saved" });
    expect(await writer.persist("two")).toEqual({ status: "saved" });
    expect(file.text).toBe("two");
    expect(file.writes.map((write) => write.expected)).toEqual(["sha_0", "sha_1"]);
    expect(file.writes.some((write) => write.refused)).toBe(false);
  });

  test("`persist` captured before a save still carries the hash that save produced", async () => {
    // THE BUG, EXACTLY. The save coordinator is handed `persist` once and keeps
    // it for the life of the file; the hash it sends must be read when the write
    // goes out, not when the function was handed over. The editor used to hold
    // that hash in a closure variable and REBUILD the closure on every save, so
    // the rebuilt one carried the hash from before the write that rebuilt it.
    const file = disk();
    const writer = createFileWriter({ send: file.write() });
    writer.rebase({ sha256: file.sha256 });
    const persist = writer.persist;

    expect(await persist("one")).toEqual({ status: "saved" });
    expect(await persist("two")).toEqual({ status: "saved" });
    expect(file.writes.map((write) => write.expected)).toEqual(["sha_0", "sha_1"]);
  });

  test("two writes asked for at once go out one at a time, the second behind the first's hash", async () => {
    // Typing through a save asks for a second write while the first is open.
    // Both used to go out against the same hash and the loser was refused as a
    // conflict — a conflict between two of the user's own keystrokes.
    const file = disk();
    const writer = createFileWriter({ send: file.write(true) });
    writer.rebase({ sha256: file.sha256 });

    const first = writer.persist("one");
    const second = writer.persist("two");
    // Only ONE write is on the wire: the second is still queued. Releasing the
    // first is what lets it start, and it starts by reading the hash the first
    // produced.
    await file.settle();
    expect(file.writes).toHaveLength(1);
    await file.settle();

    expect(await first).toEqual({ status: "saved" });
    expect(await second).toEqual({ status: "saved" });
    expect(file.writes.map((write) => write.expected)).toEqual(["sha_0", "sha_1"]);
    expect(file.text).toBe("two");
  });

  test("a real conflict is still refused", async () => {
    // The precondition is the point. Somebody else moving the file — the agent,
    // mid-turn — must still stop the write rather than overwrite it.
    const file = disk();
    const writer = createFileWriter({ send: file.write() });
    writer.rebase({ sha256: file.sha256 });
    await file.write()("the agent's version", "sha_0");

    expect(await writer.persist("mine")).toEqual({ status: "refused", reason: "conflict" });
    expect(file.text).toBe("the agent's version");
  });

  test("a refusal leaves the baseline where it was", async () => {
    // The stash keeps the refused text WITH the hash it was edited against, so
    // re-opening the file is refused again rather than winning. Advancing the
    // baseline on a refusal would turn "your edit was refused" into "your edit
    // silently destroyed the agent's".
    const file = disk();
    const writer = createFileWriter({ send: file.write() });
    writer.rebase({ sha256: "sha_0" });
    await file.write()("moved", "sha_0");

    expect(await writer.persist("mine")).toEqual({ status: "refused", reason: "conflict" });
    expect(writer.baseline).toBe("sha_0");
  });

  test("a transport failure leaves the baseline where it was, and retrying works", async () => {
    let fail = true;
    const file = disk();
    const send = file.write();
    const writer = createFileWriter({
      send: (text, expected) => {
        if (fail) throw new Error("The engine did not answer.");
        return send(text, expected);
      },
    });
    writer.rebase({ sha256: file.sha256 });

    expect(await writer.persist("one")).toEqual({ status: "failed", reason: "The engine did not answer." });
    expect(writer.baseline).toBe("sha_0");
    fail = false;
    expect(await writer.persist("one")).toEqual({ status: "saved" });
    expect(writer.baseline).toBe("sha_1");
  });

  test("a write before any read is a failure, not a write against nothing", async () => {
    const file = disk();
    const writer = createFileWriter({ send: file.write() });
    const outcome = await writer.persist("one");
    expect(outcome.status).toBe("failed");
    expect(file.writes).toHaveLength(0);
  });

  test("a re-read re-baselines, including backwards", async () => {
    // "Re-read from disk" after a refusal: the panel deliberately adopts what is
    // on disk now, and the next write is owed against THAT.
    const file = disk();
    const writer = createFileWriter({ send: file.write() });
    writer.rebase({ sha256: "sha_9" });
    writer.rebase({ sha256: file.sha256 });
    expect(await writer.persist("one")).toEqual({ status: "saved" });
  });

  test("`writes` counts only the ones that landed", async () => {
    // What tells a read that raced a write that its bytes are already stale.
    const file = disk();
    const writer = createFileWriter({ send: file.write() });
    writer.rebase({ sha256: file.sha256 });
    expect(writer.writes).toBe(0);
    await writer.persist("one");
    expect(writer.writes).toBe(1);
    writer.rebase({ sha256: "sha_nope" });
    await writer.persist("two");
    expect(writer.writes).toBe(1);
  });

  test("a CRLF file gets its carriage returns back", async () => {
    // The editor works in LF because a textarea cannot hold anything else, so
    // without this one keystroke rewrites every line ending in the file — a
    // one-line change arriving in review as a whole-file diff.
    const file = disk();
    const writer = createFileWriter({ send: file.write() });
    writer.rebase({ sha256: file.sha256, newline: "\r\n" });

    expect(await writer.persist("alpha\nbeta\n")).toEqual({ status: "saved" });
    expect(file.text).toBe("alpha\r\nbeta\r\n");
  });

  test("an LF file is written back exactly as the editor holds it", async () => {
    const file = disk();
    const writer = createFileWriter({ send: file.write() });
    writer.rebase({ sha256: file.sha256 });

    await writer.persist("alpha\nbeta\n");
    expect(file.text).toBe("alpha\nbeta\n");
  });

  test("a re-read that finds different endings changes what the next write sends", async () => {
    const file = disk();
    const writer = createFileWriter({ send: file.write() });
    writer.rebase({ sha256: file.sha256, newline: "\r\n" });
    await writer.persist("a\nb");
    expect(file.text).toBe("a\r\nb");

    writer.rebase({ sha256: file.sha256, newline: "\n" });
    await writer.persist("a\nb");
    expect(file.text).toBe("a\nb");
  });

  test("the queue survives a failing write", async () => {
    // A rejected promise left in the chain would deadlock every later write.
    const file = disk();
    const send = file.write();
    const writer = createFileWriter({
      send: (text, expected) => (text === "one" ? Promise.reject(new Error("boom")) : send(text, expected)),
    });
    writer.rebase({ sha256: file.sha256 });
    const first = writer.persist("one");
    const second = writer.persist("two");
    expect((await first).status).toBe("failed");
    expect(await second).toEqual({ status: "saved" });
  });
});
