/**
 * Everything the daemon needs to serve runs, behind one object.
 *
 * WHY THIS FILE EXISTS: TO MAKE THE SHARED HUNK TINY. Mounting Run used to mean
 * a dozen lines inside `daemon.ts`, which is owned by somebody else and moves
 * under us. So all of it lives here, in a file this feature owns and covers,
 * and the daemon keeps three lines it can splice around without understanding.
 *
 * IT STILL DOES NOT IMPORT THE DAEMON. `handle` takes the method, the
 * session-scoped tail and the decoded body, and returns `undefined` when the
 * request is not a run request — so the caller falls through to its own
 * routing. Refusals are thrown as `RunError`, whose `code` the caller maps to
 * its own HTTP shape.
 */
import fs from "node:fs";
import path from "node:path";
import { RunJournalFile } from "./journal";
import { terminalLauncher } from "./launcher";
import { RunManager, type RunStatusEvent } from "./manager";
import { matchRunRoute } from "./routes";
import { RunStore } from "./store";
import { storeRunCapability, type RunSessionContext } from "./store-capability";
import { RunTerminalClient, terminalChannelFromEnv } from "./terminal-client";
import type { RunView } from "./types";

export type RunMount = {
  store: RunStore;
  manager: RunManager;
  /**
   * Serve one request, or answer `undefined` when it is not ours.
   *
   * `context` resolves "which session, project and worktree is this" — the
   * daemon's knowledge, read per request rather than captured.
   */
  handle(method: string, tail: string, input: Record<string, unknown>, context: () => RunSessionContext): Promise<unknown> | undefined;
  /**
   * Every terminal transition, for ONE SESSION. THE ROUTE THAT USES THIS IS AN
   * SSE ARM RATHER THAN A TABLE ENTRY, because `RunRoute` returns a value and a
   * stream does not have one — see `daemon.ts`.
   *
   * SCOPED TO THE SESSION: a terminal belongs to the session whose panel it is
   * in, and a connection that saw every session's terminals would be a read
   * granted by a typo.
   */
  watch(sessionId: string, listener: (event: RunStatusEvent) => void): () => void;
  /**
   * The terminals a previous engine opened that the host still holds,
   * re-listed. Resolves once the host has been asked; nothing waits on it,
   * because nothing is blocked by it.
   */
  recovered: Promise<RunView[]>;
  /** Whether runs go on a real pseudo-terminal the desktop shell holds. */
  terminalChannel: boolean;
  shutdown(): Promise<void>;
};

/** The one sentence an agent reads on its next turn after the person closed
 *  one of its terminals. */
export function personClosedNote(run: RunView): string {
  return `The person closed terminal "${run.title}" (${run.terminalId}). Do not reopen it unless they ask.`;
}

/**
 * Build the run surface under an engine home.
 *
 * A RUN IS A TERMINAL IN THE SESSION'S PANEL WHEN THERE IS A PANEL TO PUT IT
 * IN. The desktop shell exports the channel to its PTY host into this
 * process's environment. When it is absent — `bun run src/main.ts`, a test, a
 * headless deployment — a run is a detached child with pipes: multiple
 * instances, no chip, the same byte path.
 */
export function createRunMount(options: {
  root: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Leave a note for a session's next turn. Called when the person closes a
   * terminal its agent opened or waited on, so the agent does not reopen it
   * thinking it crashed.
   */
  noteForNextTurn?: (sessionId: string, note: string) => void;
}): RunMount {
  const dir = path.join(options.root, "run");
  fs.mkdirSync(dir, { recursive: true });
  // The liveness journal a previous build kept. Nothing reads it any more, and
  // left behind it would describe runs as "still running" for ever.
  fs.rmSync(path.join(dir, "open-runs.json"), { force: true });
  const store = new RunStore(dir);
  const channel = terminalChannelFromEnv(options.env ?? process.env);
  const client = channel ? new RunTerminalClient(channel) : undefined;
  const manager = new RunManager({
    journal: new RunJournalFile(dir),
    ...(client ? { launcher: terminalLauncher(client) } : {}),
    ...(options.noteForNextTurn ? { personClosed: (run: RunView) => options.noteForNextTurn!(run.sessionId, personClosedNote(run)) } : {}),
  });
  const recovered = manager
    .recover({
      configFor: (projectId, configId) => {
        try {
          return store.get(projectId, configId);
        } catch {
          return undefined;
        }
      },
    })
    .catch(() => []);

  return {
    store,
    manager,
    recovered,
    terminalChannel: channel !== undefined,
    handle(method, tail, input, context) {
      const matched = matchRunRoute(method, tail);
      if (!matched) return undefined;
      return matched.route.handle({
        params: matched.params,
        input,
        capability: storeRunCapability({ store, manager, context }),
      });
    },
    watch(sessionId, listener) {
      return manager.watch((event) => {
        if (event.sessionId === sessionId) listener(event);
      });
    },
    shutdown: () => manager.shutdown(),
  };
}
