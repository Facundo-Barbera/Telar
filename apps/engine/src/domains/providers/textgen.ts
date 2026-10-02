import { defaultInstanceIdForDriver, type Item, type ProviderDriverKind, type TextGenPolicy } from "@telar/engine-client";
import { EngineStateError } from "../../platform/kernel";
import { providerProcessEnv } from "./instances";
import { runStructured, runStructuredOrThrow, TextGenFailure, type TextGenDriverInput, type TextGenEffort } from "./textgen-run";
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
  records: { get(sessionId: string): { title: string; state: string; autoTitle?: "first" | "second" } };
  lifecycle: {
    updateSession(sessionId: string, patch: { title: string; autoTitle?: "first" | "second" }): unknown;
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
    if (current.state !== "active" || !titleIsSeed(current.title, firstMessage)) return;
    store.lifecycle.updateSession(sessionId, { title, autoTitle: "first" });
  } catch {
    return;
  }
  if (policy.renameBranches) await Promise.resolve().then(() => store.lifecycle.refreshWorktreeBranchFromTitle(sessionId)).catch(() => undefined);
}

export type RegenerateStore = RetitleStore & { queries: { items(sessionId: string): Item[] } };

export async function regenerateSessionTitle(
  store: RegenerateStore,
  sessionId: string,
  run: typeof runStructuredOrThrow = runStructuredOrThrow,
): Promise<{ title: string; changed: boolean }> {
  const previous = store.records.get(sessionId).title;
  const context = titleContext(titleMessages(store.queries.items(sessionId)));
  if (!context) throw new EngineStateError("conflict", "the session has no messages to title");
  if (textGenDisabledByEnv()) throw new EngineStateError("conflict", "text generation is switched off on this engine");
  const policy = store.settings.textGen();
  const driver = driverInput(store, policy);
  if (!driver) throw new EngineStateError("conflict", "the text generation provider is disabled");
  const result = await run(driver, buildRegenerateTitlePrompt(previous, context), oneStringSchema("title")).catch((error: unknown) => {
    throw new TextGenFailure(`the title model returned an error: ${error instanceof Error ? error.message : String(error)}`);
  });
  const title = sanitizeTitle(result?.["title"]);
  if (title === undefined) throw new TextGenFailure("the title model answered without a title");
  if (title === previous) return { title, changed: false };
  if (store.records.get(sessionId).title !== previous) throw new EngineStateError("conflict", "the session was renamed while its title was regenerated");
  store.lifecycle.updateSession(sessionId, { title });
  if (policy.renameBranches) await Promise.resolve(store.lifecycle.refreshWorktreeBranchFromTitle(sessionId)).catch(() => undefined);
  return { title, changed: true };
}

const WORK_ITEMS = new Set<Item["detail"]["type"]>([
  "command_execution",
  "file_change",
  "file_read",
  "mcp_tool_call",
  "dynamic_tool_call",
  "web_search",
  "browser_action",
]);

function worthRetitling(items: readonly Item[]): boolean {
  if (!items.some((item) => item.detail.type === "assistant_message")) return false;
  return items.filter((item) => item.detail.type === "user_message").length >= 2 || items.some((item) => WORK_ITEMS.has(item.detail.type));
}

export async function maybeRetitleWithContext(
  store: RegenerateStore,
  sessionId: string,
  run: typeof runStructured = runStructured,
): Promise<void> {
  const policy = effectiveTextGenPolicy(store.settings.textGen());
  if (!policy.titles) return;
  const session = store.records.get(sessionId);
  if (session.state !== "active" || session.autoTitle !== "first") return;
  const items = store.queries.items(sessionId);
  if (!worthRetitling(items)) return;
  const driver = driverInput(store, policy);
  if (!driver) return;
  const previous = session.title;
  // Claimed before the call, so a failure or a restart never asks twice.
  store.lifecycle.updateSession(sessionId, { title: previous, autoTitle: "second" });
  const result = await run(driver, buildRegenerateTitlePrompt(previous, titleContext(titleMessages(items))), oneStringSchema("title"));
  const title = sanitizeTitle(result?.["title"]);
  if (title === undefined) {
    console.error(`[engine] the second title for ${sessionId} got no answer; keeping "${previous}"`);
    return;
  }
  const current = store.records.get(sessionId);
  if (title === previous || current.state !== "active" || current.title !== previous || current.autoTitle !== "second") return;
  store.lifecycle.updateSession(sessionId, { title, autoTitle: "second" });
  if (policy.renameBranches) await Promise.resolve(store.lifecycle.refreshWorktreeBranchFromTitle(sessionId)).catch(() => undefined);
}
