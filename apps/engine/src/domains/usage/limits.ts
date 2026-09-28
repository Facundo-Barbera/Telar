import type { ProviderDriverKind, UsageLimitAccount, UsageLimitWindow } from "@telar/engine-client";

const HUB_TIMEOUT_MS = 15_000;

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

const ACCOUNT_CONCURRENCY = 4;

export type HubConfig = {
  url: string;
  managementKey: string;
};

export type HubDeps = {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
};

export class UsageLimitSourceError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = "UsageLimitSourceError";
  }
}

export type HubAuthFile = {
  id: string;
  auth_index: string;
  provider: string;
  email?: string;
  disabled?: boolean;
  id_token?: { chatgpt_account_id?: string; chatgpt_plan_type?: string };
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function managementUrl(base: string, path: string): string {
  let origin: URL;
  try {
    origin = new URL(base);
  } catch {
    throw new UsageLimitSourceError("The hub URL is not valid.");
  }
  if (origin.protocol !== "http:" && origin.protocol !== "https:") {
    throw new UsageLimitSourceError("The hub URL must be http or https.");
  }
  return new URL(`/v0/management/${path}`, origin).toString();
}

async function management(config: HubConfig, path: string, body: unknown, deps: HubDeps): Promise<unknown> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const url = managementUrl(config.url, path);
  let response: Response;
  try {
    response = await doFetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${config.managementKey}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
    });
  } catch {
    throw new UsageLimitSourceError("The hub did not answer.");
  }
  if (response.status === 401 || response.status === 403) {
    throw new UsageLimitSourceError("The hub refused the management key.");
  }
  if (!response.ok) {
    throw new UsageLimitSourceError(`The hub management request failed (HTTP ${response.status}).`);
  }
  try {
    return await response.json();
  } catch {
    throw new UsageLimitSourceError("The hub answered with something that is not JSON.");
  }
}

export async function listAuthFiles(config: HubConfig, deps: HubDeps = {}): Promise<HubAuthFile[]> {
  const payload = asRecord(await management(config, "auth-files", undefined, deps));
  const files = payload?.["files"];
  if (!Array.isArray(files)) throw new UsageLimitSourceError("The hub could not list accounts.");
  const out: HubAuthFile[] = [];
  for (const entry of files) {
    const record = asRecord(entry);
    if (!record) continue;
    const id = asString(record["id"]);
    const authIndex = asString(record["auth_index"]);
    const provider = asString(record["provider"]);
    if (!id || !authIndex || !provider) continue;
    const idToken = asRecord(record["id_token"]);
    out.push({
      id,
      auth_index: authIndex,
      provider,
      ...(asString(record["email"]) ? { email: asString(record["email"])! } : {}),
      ...(typeof record["disabled"] === "boolean" ? { disabled: record["disabled"] } : {}),
      ...(idToken
        ? {
            id_token: {
              ...(asString(idToken["chatgpt_account_id"]) ? { chatgpt_account_id: asString(idToken["chatgpt_account_id"])! } : {}),
              ...(asString(idToken["chatgpt_plan_type"]) ? { chatgpt_plan_type: asString(idToken["chatgpt_plan_type"])! } : {}),
            },
          }
        : {}),
    });
  }
  return out;
}

// The hub replaces `$TOKEN$` with the account's live token, so no subscription credential enters this process.
export async function apiCall(config: HubConfig, account: HubAuthFile, url: string, deps: HubDeps = {}): Promise<string> {
  const header =
    account.provider === "codex"
      ? {
          Authorization: "Bearer $TOKEN$",
          "Content-Type": "application/json",
          "OpenAI-Beta": "codex-1",
          Originator: "Codex Desktop",
          ...(account.id_token?.chatgpt_account_id ? { "Chatgpt-Account-Id": account.id_token.chatgpt_account_id } : {}),
        }
      : { Authorization: "Bearer $TOKEN$", "anthropic-beta": "oauth-2025-04-20" };
  const payload = asRecord(
    await management(config, "api-call", { auth_index: account.auth_index, method: "GET", url, header }, deps),
  );
  const status = asNumber(payload?.["status_code"]);
  const responseBody = payload?.["body"];
  if (status === undefined || typeof responseBody !== "string") {
    throw new UsageLimitSourceError("The hub answered an api-call in a shape this build does not know.");
  }
  if (status < 200 || status >= 300) {
    throw new UsageLimitSourceError(`The provider refused the hub request (HTTP ${status}).`);
  }
  return responseBody;
}

function parseJson(body: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new UsageLimitSourceError("The provider's usage answer is not JSON.");
  }
  const record = asRecord(value);
  if (!record) throw new UsageLimitSourceError("The provider's usage answer is not an object.");
  return record;
}

function resetMillis(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Codex sends epoch seconds, Claude ISO-8601.
    return value > 1e11 ? Math.round(value) : Math.round(value * 1000);
  }
  const text = asString(value);
  if (!text) return undefined;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function window(key: string, label: string, usedPercent: number, resetsAt: number | undefined): UsageLimitWindow {
  return { key, label, usedPercent: clampPercent(usedPercent), ...(resetsAt === undefined ? {} : { resetsAt }) };
}

export function claudeWindows(body: string): UsageLimitWindow[] {
  const usage = parseJson(body);
  const out: UsageLimitWindow[] = [];
  for (const [field, key, label] of [
    ["five_hour", "five_hour", "5-hour"],
    ["seven_day", "seven_day", "7-day"],
  ] as const) {
    const entry = asRecord(usage[field]);
    const utilization = asNumber(entry?.["utilization"]);
    if (utilization === undefined) continue;
    out.push(window(key, label, utilization, resetMillis(entry?.["resets_at"])));
  }
  const limits = usage["limits"];
  if (Array.isArray(limits)) {
    for (const entry of limits) {
      const limit = asRecord(entry);
      if (limit?.["kind"] !== "weekly_scoped") continue;
      const percent = asNumber(limit["percent"]);
      const model = asRecord(asRecord(limit["scope"])?.["model"]);
      const displayName = asString(model?.["display_name"]);
      if (percent === undefined || !displayName) continue;
      out.push(window(`model:${displayName}`, `${displayName} weekly`, percent, resetMillis(limit["resets_at"])));
    }
  }
  return out;
}

export function codexUsage(body: string, account?: HubAuthFile): { plan?: string; windows: UsageLimitWindow[] } {
  const usage = parseJson(body);
  const rateLimit = asRecord(usage["rate_limit"]);
  const windows: UsageLimitWindow[] = [];
  for (const [field, key, label] of [
    ["primary_window", "primary", "Primary"],
    ["secondary_window", "secondary", "Secondary"],
  ] as const) {
    const entry = asRecord(rateLimit?.[field]);
    const used = asNumber(entry?.["used_percent"]);
    if (used === undefined) continue;
    windows.push(window(key, label, used, resetMillis(entry?.["reset_at"])));
  }
  const plan = asString(usage["plan_type"]) ?? account?.id_token?.chatgpt_plan_type;
  return { ...(plan ? { plan: codexPlanLabel(plan) } : {}), windows };
}

export function codexPlanLabel(planType: string): string {
  return planType
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((word) => (word.toLowerCase() === "chatgpt" ? "ChatGPT" : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()))
    .join(" ");
}

export function driverOf(provider: string): ProviderDriverKind | undefined {
  if (provider === "claude") return "claude";
  if (provider === "codex") return "codex";
  return undefined;
}

async function readAccount(config: HubConfig, account: HubAuthFile, deps: HubDeps = {}): Promise<UsageLimitAccount> {
  const driver = driverOf(account.provider) ?? "claude";
  const base: UsageLimitAccount = {
    id: account.id,
    driver,
    ...(account.email ? { email: account.email } : {}),
    windows: [],
  };
  try {
    if (driver === "claude") {
      return { ...base, plan: "Claude subscription", windows: claudeWindows(await apiCall(config, account, CLAUDE_USAGE_URL, deps)) };
    }
    const usage = codexUsage(await apiCall(config, account, CODEX_USAGE_URL, deps), account);
    return { ...base, ...(usage.plan ? { plan: usage.plan } : {}), windows: usage.windows };
  } catch (error) {
    return { ...base, error: error instanceof UsageLimitSourceError ? error.detail : "The hub could not read this account's usage." };
  }
}

async function mapLimited<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let index = next++; index < items.length; index = next++) out[index] = await run(items[index]!);
  });
  await Promise.all(workers);
  return out;
}

export async function readHubAccounts(config: HubConfig, deps: HubDeps = {}): Promise<UsageLimitAccount[]> {
  const accounts = (await listAuthFiles(config, deps)).filter((account) => !account.disabled && driverOf(account.provider));
  return mapLimited(accounts, ACCOUNT_CONCURRENCY, (account) => readAccount(config, account, deps));
}

export function sourceLabel(id: string, config: { label?: string; url: string }): string {
  if (config.label && config.label.trim()) return config.label.trim();
  try {
    return new URL(config.url).host || id;
  } catch {
    return id;
  }
}

export async function readUsageLimitSource(
  source: { id: string; kind: "cliproxy"; label?: string; url: string; managementKey: string },
  deps: HubDeps = {},
): Promise<{ id: string; kind: "cliproxy"; label: string; checkedAt: number; accounts: UsageLimitAccount[]; error?: string }> {
  const now = deps.now ?? Date.now;
  const base = { id: source.id, kind: source.kind, label: sourceLabel(source.id, source), checkedAt: now() } as const;
  if (!source.managementKey) return { ...base, accounts: [], error: "No management key is stored for this hub." };
  try {
    return { ...base, accounts: await readHubAccounts({ url: source.url, managementKey: source.managementKey }, deps) };
  } catch (error) {
    return { ...base, accounts: [], error: error instanceof UsageLimitSourceError ? error.detail : "The hub could not be read." };
  }
}
