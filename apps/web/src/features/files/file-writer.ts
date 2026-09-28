import { withNewline, type Newline } from "./line-endings";
import type { SaveOutcome } from "./save-coordinator";

export type FileWriteAnswer = { written: true; sha256: string } | { written: false; refusal: string };

type FileRead = {
  sha256: string | undefined;
  newline?: Newline;
};

export type FileWriter = {
  readonly baseline: string | undefined;
  readonly writes: number;
  rebase(read: FileRead): void;
  persist(text: string): Promise<SaveOutcome>;
};

export function createFileWriter(options: {
  send: (text: string, expected: string) => Promise<FileWriteAnswer>;
  onWritten?: (sha256: string) => void;
  describe?: (cause: unknown) => string;
}): FileWriter {
  let baseline: string | undefined;
  let newline: Newline = "\n";
  let writes = 0;
  let queue: Promise<unknown> = Promise.resolve();

  const describe = options.describe ?? ((cause: unknown) => (cause instanceof Error ? cause.message : "The save could not be sent."));

  async function send(text: string): Promise<SaveOutcome> {
    const expected = baseline;
    if (expected === undefined) return { status: "failed", reason: "This file has not been read yet." };
    try {
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
      const mine = queue.then(() => send(text));
      queue = mine;
      return mine;
    },
  };
}
