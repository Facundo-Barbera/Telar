import fs from "node:fs";
import path from "node:path";
import { RunJournalFile } from "./journal";
import { terminalLauncher } from "./launcher";
import { RunManager } from "./manager";
import { type RunStatusEvent } from "./live-run";
import { matchRunRoute } from "./routes";
import { RunStore } from "./store";
import { storeRunCapability, type RunSessionContext } from "./store-capability";
import { RunTerminalClient, terminalChannelFromEnv } from "./terminal-client";
import type { RunView } from "./types";

export type RunMount = {
  store: RunStore;
  manager: RunManager;
  handle(method: string, tail: string, input: Record<string, unknown>, context: () => RunSessionContext): Promise<unknown> | undefined;
  watch(sessionId: string, listener: (event: RunStatusEvent) => void): () => void;
  recovered: Promise<RunView[]>;
  terminalChannel: boolean;
  shutdown(): Promise<void>;
};

export function personClosedNote(run: RunView): string {
  return `The person closed terminal "${run.title}" (${run.terminalId}). Do not reopen it unless they ask.`;
}

export function createRunMount(options: {
  root: string;
  env?: NodeJS.ProcessEnv;
  noteForNextTurn?: (sessionId: string, note: string) => void;
}): RunMount {
  const dir = path.join(options.root, "run");
  fs.mkdirSync(dir, { recursive: true });
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
