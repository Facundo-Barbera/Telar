// Dispatcher: fire-and-forget seam between request handlers and the executor.
// Persistence is wired here (looms.ts); abort handles live only in this
// process's memory — cancel works while the loom's process is alive.
import fs from "node:fs";
import path from "node:path";
import { ModelPolicy, type AccountProfile } from "./schemas";
import { getProject, telarDir } from "./manifest";
import { createLoom, saveLoom, appendEvent, type Loom, type LoomKind } from "./looms";
import { executeLoom } from "./executor";

export type StartLoomInput = {
  project: string;
  kind: LoomKind;
  title: string;
  prompt: string;
  acceptanceCriteria?: string[];
  maxAttempts?: number;
  target?: "dev" | "preview" | "prod";
};
export type DispatcherDeps = { accounts: Record<string, AccountProfile>; policy?: ModelPolicy };

const active = new Map<string, AbortController>();

export function startLoom(input: StartLoomInput, deps: DispatcherDeps): Loom {
  const { manifest } = getProject(input.project);
  const loom = createLoom({
    project: input.project,
    kind: input.kind,
    title: input.title,
    prompt: input.prompt,
    account: manifest.account,
  });
  loom.acceptanceCriteria = input.acceptanceCriteria;
  loom.target = input.target;
  const abort = new AbortController();
  active.set(loom.id, abort);
  executeLoom(loom, manifest, {
    policy: deps.policy ?? loadPolicy(),
    accounts: deps.accounts,
    maxAttempts: input.maxAttempts,
    abort,
    onState: saveLoom,
    onEvent: (ev) => appendEvent(loom.id, ev),
  })
    .catch((err: unknown) => {
      // executeLoom contractually never rejects — guard persistence anyway.
      loom.state = "failed";
      loom.error = err instanceof Error ? err.message : String(err);
      // Persistence may share the fs failure that caused the rejection — a
      // throw here would surface as an unhandled rejection and crash the
      // server. Attempt each write independently.
      try {
        appendEvent(loom.id, { type: "error", message: loom.error });
      } catch {}
      try {
        saveLoom(loom);
      } catch {}
    })
    .finally(() => active.delete(loom.id));
  return loom;
}

export function cancelLoom(id: string): boolean {
  const ctl = active.get(id);
  if (!ctl) return false;
  ctl.abort();
  return true;
}

export const activeLoomIds = (): string[] => [...active.keys()];

export function loadPolicy(): ModelPolicy {
  try {
    const raw = fs.readFileSync(path.join(telarDir(), "policy.json"), "utf8");
    return ModelPolicy.parse(JSON.parse(raw));
  } catch {
    return ModelPolicy.parse({});
  }
}
