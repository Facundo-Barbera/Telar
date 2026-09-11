/**
 * THE HASH EVERY WRITE CARRIES — ONE LIVE CELL, NOT A CAPTURED VALUE.
 *
 * THE BUG THIS EXISTS FOR, because it is not obvious and it cost real edits.
 * A write carries the `sha256` of the read it was made from, and the engine
 * refuses it if disk has moved since (`writeWorkspaceFile`). That is what stops
 * an autosave from silently overwriting whatever the agent wrote mid-turn. It
 * only works if the hash advances the instant OUR OWN write lands: the second
 * keystroke after a save has to carry the hash of the save, or the engine
 * correctly reports that the file changed under us — and it did, because we
 * changed it.
 *
 * The editor used to hold that hash in a variable captured by the closure it
 * gave its save coordinator, and to rebuild the coordinator whenever the hash
 * changed. So every successful write rebuilt the thing that writes, and the
 * rebuilt one captured the hash from BEFORE the write that rebuilt it. Type
 * through one save and there are two writers in the air holding two different
 * ideas of what is on disk; the second one's write is refused, and the panel
 * says the file changed on disk while you were editing — about writes that were
 * nobody's but yours.
 *
 * So the hash lives HERE, in one object that outlives any coordinator, and every
 * write reads it at SEND time. Rebuilding the caller changes nothing, because
 * there is nothing in the caller to rebuild.
 *
 * SERIALISED, for the same reason. Two writes open at once against the same path
 * is two versions of a file racing to land, and the loser carries a hash the
 * winner has already invalidated — the same false conflict by a different route.
 * The coordinator above this also coalesces, and this is the guarantee that does
 * not depend on it being the only caller.
 *
 * PURE AND FRAMEWORK-FREE, so the ordering rules can be tested without a
 * component, a browser or a real file.
 */
import type { SaveOutcome } from "./save-coordinator";

/** What the engine answers a write with. A refusal is an ANSWER, not an error —
 *  the same shape `WorkspaceWriteResult` has, narrowed to what this needs. */
export type FileWriteAnswer = { written: true; sha256: string } | { written: false; refusal: string };

export type FileWriter = {
  /** The hash the NEXT write will carry. `undefined` until a read has landed. */
  readonly baseline: string | undefined;
  /** How many writes have landed. A read issued before this changed is holding
   *  bytes we have already replaced — see `FileViewSurface.load`. */
  readonly writes: number;
  /** Adopt the hash from a read. The one thing that may move the baseline
   *  BACKWARDS, and only because a re-read is a deliberate re-baselining. */
  rebase(sha256: string | undefined): void;
  /** Write, carrying whatever the baseline is when this write actually goes
   *  out — never what it was when this function was handed to somebody. */
  persist(text: string): Promise<SaveOutcome>;
};

export function createFileWriter(options: {
  /** Send it. `expected` is the precondition the engine checks against disk. */
  send: (text: string, expected: string) => Promise<FileWriteAnswer>;
  /** A write landed, with the file as the engine now sees it. For the header's
   *  byte count, which otherwise keeps reporting the size at open time. */
  onWritten?: (sha256: string) => void;
  /** Turn a thrown transport error into the sentence a reader sees. */
  describe?: (cause: unknown) => string;
}): FileWriter {
  let baseline: string | undefined;
  let writes = 0;
  /** The tail of the write queue. Awaiting it is what makes "one at a time"
   *  true even when two callers ask at once. */
  let queue: Promise<unknown> = Promise.resolve();

  const describe = options.describe ?? ((cause: unknown) => (cause instanceof Error ? cause.message : "The save could not be sent."));

  async function send(text: string): Promise<SaveOutcome> {
    // READ HERE, at the front of the actual request. Everything above this line
    // may have been queued behind another write that moved it.
    const expected = baseline;
    if (expected === undefined) return { status: "failed", reason: "This file has not been read yet." };
    try {
      const answer = await options.send(text, expected);
      if (!answer.written) return { status: "refused", reason: answer.refusal };
      // The next write must carry the hash of what we just wrote, or the second
      // keystroke after a save is refused as a conflict with itself.
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
    rebase(sha256) {
      baseline = sha256;
    },
    persist(text) {
      // Chained rather than fired: `queue` never rejects (every failure above is
      // an outcome), so this cannot leave the queue permanently broken.
      const mine = queue.then(() => send(text));
      queue = mine;
      return mine;
    },
  };
}
