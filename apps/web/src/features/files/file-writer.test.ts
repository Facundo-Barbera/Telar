import { describe, expect, test } from "bun:test";
import { createFileWriter, type FileWriteAnswer } from "./file-writer";

/** Holds bytes and a hash, and refuses any write whose precondition does not match. */
function disk(text = "start") {
  let held = text;
  let version = 0;
  const writes: { text: string; expected: string; refused: boolean }[] = [];
  /** Held until `settle()`, so a test can keep a write open. */
  const open: (() => void)[] = [];
  return {
    get text() {
      return held;
    },
    get sha256() {
      return `sha_${version}`;
    },
    writes,
    /** Polls until a write is open (queued writes start a microtask later), then releases all. */
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
    // The hash must be read when the write goes out, not when `persist` was handed over.
    const file = disk();
    const writer = createFileWriter({ send: file.write() });
    writer.rebase({ sha256: file.sha256 });
    const persist = writer.persist;

    expect(await persist("one")).toEqual({ status: "saved" });
    expect(await persist("two")).toEqual({ status: "saved" });
    expect(file.writes.map((write) => write.expected)).toEqual(["sha_0", "sha_1"]);
  });

  test("two writes asked for at once go out one at a time, the second behind the first's hash", async () => {
    const file = disk();
    const writer = createFileWriter({ send: file.write(true) });
    writer.rebase({ sha256: file.sha256 });

    const first = writer.persist("one");
    const second = writer.persist("two");
    // Only one write is on the wire; the second starts after the first answers.
    await file.settle();
    expect(file.writes).toHaveLength(1);
    await file.settle();

    expect(await first).toEqual({ status: "saved" });
    expect(await second).toEqual({ status: "saved" });
    expect(file.writes.map((write) => write.expected)).toEqual(["sha_0", "sha_1"]);
    expect(file.text).toBe("two");
  });

  test("a real conflict is still refused", async () => {
    const file = disk();
    const writer = createFileWriter({ send: file.write() });
    writer.rebase({ sha256: file.sha256 });
    await file.write()("the agent's version", "sha_0");

    expect(await writer.persist("mine")).toEqual({ status: "refused", reason: "conflict" });
    expect(file.text).toBe("the agent's version");
  });

  test("a refusal leaves the baseline where it was", async () => {
    // Advancing the baseline on refusal would let a re-open overwrite the agent's edit.
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
    const file = disk();
    const writer = createFileWriter({ send: file.write() });
    writer.rebase({ sha256: "sha_9" });
    writer.rebase({ sha256: file.sha256 });
    expect(await writer.persist("one")).toEqual({ status: "saved" });
  });

  test("`writes` counts only the ones that landed", async () => {
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
    // The editor works in LF; without this one keystroke rewrites every line ending.
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
