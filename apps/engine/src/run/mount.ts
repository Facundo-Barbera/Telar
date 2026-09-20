/**
 * Everything the daemon needs to serve runs, behind one object.
 *
 * WHY THIS FILE EXISTS: TO MAKE THE SHARED HUNK TINY. Mounting Run used to mean
 * a dozen lines inside `daemon.ts` — construct a store, construct a manager,
 * recover, match a route, build a capability, adapt the error — and `daemon.ts`
 * is owned by somebody else and moves under us. A dozen lines of somebody else's
 * file is a dozen lines nobody tests and one careless splice deletes; that is
 * not hypothetical, it is what happened. So all of it lives here, in a file this
 * milestone owns and covers, and the daemon keeps three lines it can splice
 * around without understanding.
 *
 * IT STILL DOES NOT IMPORT THE DAEMON. `handle` takes the method, the
 * session-scoped tail and the decoded body, and returns `undefined` when the
 * request is not a run request — so the caller falls through to its own routing
 * exactly as before. Refusals are thrown as `RunError`, whose `code` the caller
 * maps to its own HTTP shape; nothing here knows what an HttpError is.
 */
import fs from "node:fs";
import path from "node:path";
import { RunJournalFile } from "./journal";
import { terminalLauncher } from "./launcher";
import { RunManager } from "./manager";
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
   * `context` resolves "which project and which worktree is this session" — the
   * daemon's knowledge, read per request rather than captured, so a session that
   * moves between worktrees is not answered from a stale one.
   */
  handle(method: string, tail: string, input: Record<string, unknown>, context: () => RunSessionContext): Promise<unknown> | undefined;
  /** Runs the last daemon did not see end. Reported, never adopted. */
  recovered: RunView[];
  /** Whether runs go on a real pseudo-terminal the desktop shell holds. */
  terminalChannel: boolean;
  shutdown(): Promise<void>;
};

/**
 * Build the run surface under an engine home.
 *
 * `recover()` RUNS HERE, before this function returns, so a caller cannot bind a
 * port in front of a manager that has not yet read its own journal. What it
 * recovers is honest: a run the last daemon did not see end becomes `unknown`,
 * holds its project's slot, and is signalled by nobody.
 */
export function createRunMount(options: { root: string; env?: NodeJS.ProcessEnv }): RunMount {
  const dir = path.join(options.root, "run");
  fs.mkdirSync(dir, { recursive: true });
  const store = new RunStore(dir);
  /**
   * A RUN IS A TERMINAL SESSION WHEN THERE IS A TERMINAL TO PUT IT ON.
   *
   * The desktop shell exports the channel to its PTY host into this process's
   * environment, the same way it already exports the browser control port. When
   * it is absent — `bun run src/main.ts`, a test, a headless deployment — a run
   * is a detached child with pipes, which is what it was before #198 and is not
   * a fallback in any apologetic sense: there is genuinely no pseudo-terminal
   * over there to be a client of.
   */
  const channel = terminalChannelFromEnv(options.env ?? process.env);
  const client = channel ? new RunTerminalClient(channel) : undefined;
  const manager = new RunManager({
    journal: new RunJournalFile(dir),
    ...(client ? { launcher: terminalLauncher(client) } : {}),
  });
  const recovered = manager.recover();

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
    shutdown: () => manager.shutdown(),
  };
}
