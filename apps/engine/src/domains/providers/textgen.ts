import { defaultInstanceIdForDriver, type Item, type ProviderDriverKind, type TextGenPolicy } from "@telar/engine-client";
import { EngineStateError } from "../../platform/kernel";
import { providerProcessEnv } from "./instances";
import { runStructured, type TextGenDriverInput, type TextGenEffort } from "./textgen-run";
import { titleContext, titleMessages } from "./title-context";
import { buildRegenerateTitlePrompt, buildTitlePrompt } from "./title-prompts";

export function textGenDisabledByEnv(): boolean {
  return (process.env.TELAR_TEXTGEN ?? "").trim().toLowerCase() === "off";
}

function effectiveTextGenPolicy(policy: TextGenPolicy): TextGenPolicy {
  return textGenDisabledByEnv() ? { ...policy, titles: false, renameBranches: false } : policy;
}

function oneStringSchema(key: string): object {
  return {
    type: "object",
    properties: { [key]: { type: "string" } },
    required: [key],
    additionalProperties: false,
  };
}

export function sanitizeTitle(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const line = raw.split("\n")[0]!.replace(/\s+/g, " ").trim().replace(/^["'`]+|["'`.]+$/g, "").trim();
  if (!line) return undefined;
  return line.slice(0, 80);
}

export function titleIsSeed(title: string, firstMessage: string): boolean {
  const current = title.trim();
  if (current === "New session") return true;
  const seed = firstMessage.replace(/\s+/g, " ").trim().slice(0, 80).trim();
  return seed.length > 0 && current === seed;
}

export async function generateSessionTitle(input: TextGenDriverInput & { message: string }): Promise<string | undefined> {
  const result = await runStructured(input, buildTitlePrompt(input.message), oneStringSchema("title"));
  return sanitizeTitle(result?.["title"]);
}

type TextGenInstance = { enabled: boolean; binaryPath?: string; configDir?: string; env: { name: string; value: string }[] };

type TextGenStore = {
  settings: { textGen(): TextGenPolicy };
  providers: { resolve(instanceId: string, driver: ProviderDriverKind): TextGenInstance };
  catalogues?: { cachedRows(driver: ProviderDriverKind): readonly { id: string }[] | undefined };
};

const CHEAP_MODEL_HINTS = ["haiku", "luna", "flash", "mini", "nano"];

export function cheapModel(ids: readonly string[]): string | undefined {
  const plain = ids.filter((id) => !id.includes("["));
  for (const hint of CHEAP_MODEL_HINTS) {
    const found = plain.find((id) => new RegExp(`(^|[-/_.])${hint}([-_.]|$)`).test(id));
    if (found) return found;
  }
  return undefined;
}

function driverInput(store: TextGenStore, policy: TextGenPolicy, model?: string): TextGenDriverInput | undefined {
  const instance = store.providers.resolve(defaultInstanceIdForDriver(policy.driver), policy.driver);
  if (!instance.enabled) return undefined;
  const env = providerProcessEnv({ ...instance, driver: policy.driver });
  const configured = model ?? policy.model;
  const usable = configured && (policy.driver !== "opencode" || configured.includes("/")) ? configured : undefined;
  const chosen = usable ?? cheapModel(store.catalogues?.cachedRows(policy.driver)?.map((row) => row.id) ?? []);
  return {
    driver: policy.driver,
    env,
    ...(instance.binaryPath ? { binaryPath: instance.binaryPath } : {}),
    ...(chosen ? { model: chosen } : {}),
    ...(policy.effort ? { effort: policy.effort } : {}),
  };
}

export async function runStructuredForPolicy(
  store: TextGenStore,
  input: { prompt: string; schema: object; model?: string; effort?: TextGenEffort; signal?: AbortSignal },
): Promise<Record<string, unknown> | undefined> {
  if (textGenDisabledByEnv()) return undefined;
  let driver: TextGenDriverInput | undefined;
  try {
    driver = driverInput(store, store.settings.textGen(), input.model);
  } catch {
    return undefined;
  }
  if (!driver) return undefined;
  return runStructured(
    { ...driver, ...(input.effort ? { effort: input.effort } : {}), ...(input.signal ? { signal: input.signal } : {}) },
    input.prompt,
    input.schema,
  );
}

export type RetitleStore = TextGenStore & {
  records: { get(sessionId: string): { title: string; state: string } };
  lifecycle: {
    updateSession(sessionId: string, patch: { title: string }): unknown;
    refreshWorktreeBranchFromTitle(sessionId: string): string | undefined | Promise<string | undefined>;
  };
};

export async function maybeRetitleSession(
  store: RetitleStore,
  sessionId: string,
  firstMessage: string,
  generate: typeof generateSessionTitle = generateSessionTitle,
): Promise<void> {
  const policy = effectiveTextGenPolicy(store.settings.textGen());
  if (!policy.titles) return;
  if (!firstMessage.trim()) return;
  let session: ReturnType<RetitleStore["records"]["get"]>;
  try {
    session = store.records.get(sessionId);
  } catch {
    return;
  }
  if (session.state !== "active" || !titleIsSeed(session.title, firstMessage)) return;
  const driver = driverInput(store, policy);
  if (!driver) return;
  const title = await generate({ ...driver, message: firstMessage });
  if (title === undefined) return;
  try {
    const current = store.records.get(sessionId);
    if (current.state !== "active" || !titleIsSeed(current.title, firstMessage) || current.title === title) return;
    store.lifecycle.updateSession(sessionId, { title });
  } catch {
    return;
  }
  if (policy.renameBranches) await Promise.resolve().then(() => store.lifecycle.refreshWorktreeBranchFromTitle(sessionId)).catch(() => undefined);
}

export type RegenerateStore = RetitleStore & { queries: { items(sessionId: string): Item[] } };

export async function regenerateSessionTitle(
  store: RegenerateStore,
  sessionId: string,
  run: typeof runStructured = runStructured,
): Promise<{ title: string; changed: boolean } | undefined> {
  const previous = store.records.get(sessionId).title;
  const context = titleContext(titleMessages(store.queries.items(sessionId)));
  if (!context) throw new EngineStateError("conflict", "the session has no messages to title");
  if (textGenDisabledByEnv()) throw new EngineStateError("conflict", "text generation is switched off on this engine");
  const policy = store.settings.textGen();
  const driver = driverInput(store, policy);
  if (!driver) throw new EngineStateError("conflict", "the text generation provider is disabled");
  const result = await run(driver, buildRegenerateTitlePrompt(previous, context), oneStringSchema("title"));
  const title = sanitizeTitle(result?.["title"]);
  if (title === undefined) return undefined;
  if (title === previous) return { title, changed: false };
  if (store.records.get(sessionId).title !== previous) throw new EngineStateError("conflict", "the session was renamed while its title was regenerated");
  store.lifecycle.updateSession(sessionId, { title });
  if (policy.renameBranches) await Promise.resolve(store.lifecycle.refreshWorktreeBranchFromTitle(sessionId)).catch(() => undefined);
  return { title, changed: true };
}
