import { defaultInstanceIdForDriver, type ProviderDriverKind, type TextGenPolicy } from "@telar/engine-client";
import { runStructured, type TextGenDriverInput, type TextGenEffort } from "./textgen-run";

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

const TITLE_PROMPT = `Generate a title that will help the user recognize this coding session weeks later.
Return JSON with exactly one key: title.

Before answering, silently reduce the request to:
- Subject: What system, feature, or problem is this really about?
- Outcome: What does the user ultimately want to understand or change?
- Incidental instructions: What only describes how the agent should do the work?

Title the subject and outcome. Discard incidental instructions.

Editorial rules:
- 3-8 words, fewer than 40 characters.
- Use a compact noun phrase or clear action phrase.
- Capture the umbrella goal when the request lists several symptoms or steps.
- Name the product change, not the mock, plan, report, branch, or PR used to produce it.
- Models, subagents, tools, output formats, and monitoring instructions do not belong in the title unless they are themselves the topic.
- For reviews, name what is being reviewed and the relevant concern.
- For research, name the question domain rather than the requested research process.
- Do not claim the work is complete.
- Do not copy and truncate the user's message.
- Avoid quotes, labels, filler, and trailing punctuation.`;

const MAX_PROMPT_MESSAGE_CHARS = 8_000;

export function buildTitlePrompt(message: string): string {
  return `${TITLE_PROMPT}\n\nUser message:\n${message.slice(0, MAX_PROMPT_MESSAGE_CHARS)}`;
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

type TextGenInstance = { enabled: boolean; binaryPath?: string; env: { name: string; value: string }[] };

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
  const env: Record<string, string> = {};
  for (const variable of instance.env) if (variable.value) env[variable.name] = variable.value;
  const configured = model ?? policy.model;
  const usable = configured && (policy.driver !== "opencode" || configured.includes("/")) ? configured : undefined;
  const chosen = usable ?? cheapModel(store.catalogues?.cachedRows(policy.driver)?.map((row) => row.id) ?? []);
  return { driver: policy.driver, env, ...(instance.binaryPath ? { binaryPath: instance.binaryPath } : {}), ...(chosen ? { model: chosen } : {}) };
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
  if (policy.renameBranches) {
    try {
      await store.lifecycle.refreshWorktreeBranchFromTitle(sessionId);
    } catch {
      // The new title stands even when the branch rename fails.
    }
  }
}
