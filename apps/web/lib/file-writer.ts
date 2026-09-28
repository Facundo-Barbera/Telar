/**
 * Holds the baseline hash every write carries, read at send time so our own saves never conflict
 * with themselves. Writes are serialised so two in flight cannot race on the same hash.
 */
import { withNewline, type Newline } from "./line-endings";
import type { SaveOutcome } from "./save-coordinator";

/** A refusal is an answer, not an error. */
export type FileWriteAnswer = { written: true; sha256: string } | { written: false; refusal: string };

/** Both facts come from the same read, so they are adopted together. */
export type FileRead = {
  sha256: string | undefined;
  /** The editor works in LF (a textarea cannot hold a CR); the write restores this. Defaults to LF. */
  newline?: Newline;
};

export type FileWriter = {
  /** `undefined` until a read has landed. */
  readonly baseline: string | undefined;
  /** A read issued before this changed holds stale bytes; see `FileViewSurface.load`. */
  readonly writes: number;
  /** The one thing that may move the baseline backwards: a deliberate re-read. */
  rebase(read: FileRead): void;
  /** Carries the baseline at send time, not at hand-over time. */
  persist(text: string): Promise<SaveOutcome>;
};

export function createFileWriter(options: {
  /** `expected` is the precondition the engine checks against disk. */
  send: (text: string, expected: string) => Promise<FileWriteAnswer>;
  /** For the header's byte count. */
  onWritten?: (sha256: string) => void;
  describe?: (cause: unknown) => string;
}): FileWriter {
  let baseline: string | undefined;
  let newline: Newline = "\n";
  let writes = 0;
  let queue: Promise<unknown> = Promise.resolve();

  const describe = options.describe ?? ((cause: unknown) => (cause instanceof Error ? cause.message : "The save could not be sent."));

  async function send(text: string): Promise<SaveOutcome> {
    // Read at the front of the actual request, after any queued write moved it.
    const expected = baseline;
    if (expected === undefined) return { status: "failed", reason: "This file has not been read yet." };
    try {
      // See lib/line-endings.ts.
      const answer = await options.send(withNewline(text, newline), expected);
      if (!answer.written) return { status: "refused", reason: answer.refusal };
      baseline = answer.sha256;
      writes += 1;
      options.onWritten?.(answer.sha256);
      return { status: "saved" };
    } catch (cause) {
      return { status: "failed", reason: describe(cause) };
    }
  }

  return {
    get baseline() {
      return baseline;
    },
    get writes() {
      return writes;
    },
    rebase(read) {
      baseline = read.sha256;
      newline = read.newline ?? "\n";
    },
    persist(text) {
      // `queue` never rejects (failures are outcomes), so the chain cannot break.
      const mine = queue.then(() => send(text));
      queue = mine;
      return mine;
    },
  };
}
