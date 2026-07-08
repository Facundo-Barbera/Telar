// Dispatcher: fire-and-forget seam between request handlers and the executor.
// Persistence is wired here (runs.ts); abort handles live only in this
// process's memory — cancel works while the run's process is alive.
import fs from "node:fs";
import path from "node:path";
import { ModelPolicy, type AccountProfile } from "./schemas";
import { getProject, telarDir } from "./manifest";
import { createRun, saveRun, appendEvent, type Run, type RunKind } from "./runs";
import { executeRun } from "./executor";

export type StartRunInput = { project: string; kind: RunKind; title: string; prompt: string };
export type DispatcherDeps = { accounts: Record<string, AccountProfile>; policy?: ModelPolicy };

const active = new Map<string, AbortController>();

export function startRun(input: StartRunInput, deps: DispatcherDeps): Run {
  const { manifest } = getProject(input.project);
  const run = createRun({
    project: input.project,
    kind: input.kind,
    title: input.title,
    prompt: input.prompt,
    account: manifest.account,
  });
  const abort = new AbortController();
  active.set(run.id, abort);
  executeRun(run, manifest, {
    policy: deps.policy ?? loadPolicy(),
    accounts: deps.accounts,
    abort,
    onState: saveRun,
    onEvent: (ev) => appendEvent(run.id, ev),
  })
    .catch((err: unknown) => {
      // executeRun contractually never rejects — guard persistence anyway.
      run.state = "failed";
      run.error = err instanceof Error ? err.message : String(err);
      // Persistence may share the fs failure that caused the rejection — a
      // throw here would surface as an unhandled rejection and crash the
      // server. Attempt each write independently.
      try {
        appendEvent(run.id, { type: "error", message: run.error });
      } catch {}
      try {
        saveRun(run);
      } catch {}
    })
    .finally(() => active.delete(run.id));
  return run;
}

export function cancelRun(id: string): boolean {
  const ctl = active.get(id);
  if (!ctl) return false;
  ctl.abort();
  return true;
}

export const activeRunIds = (): string[] => [...active.keys()];

export function loadPolicy(): ModelPolicy {
  try {
    const raw = fs.readFileSync(path.join(telarDir(), "policy.json"), "utf8");
    return ModelPolicy.parse(JSON.parse(raw));
  } catch {
    return ModelPolicy.parse({});
  }
}
