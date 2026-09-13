/**
 * CLIProxyAPI hubs, read for quota.
 *
 * A hub holds several Claude/Codex subscription logins and routes turns across
 * them. The windows that actually gate that work belong to accounts THIS Mac
 * never signs in as, so no amount of transcript scanning can report them — the
 * hub has to be asked, over its management API.
 *
 * PURE FUNCTIONS OVER `fetch`, WITH NO STORE AND NO TIMERS. Everything here
 * takes its configuration as an argument and its transport as one too, which is
 * what lets the whole protocol be tested against a stub rather than a running
 * hub. Who caches the answer and how often is `daemon.ts`'s decision; where the
 * key lives is `state.ts`'s.
 *
 * THE MANAGEMENT KEY IS NEVER LOGGED AND NEVER RETURNED. It appears in exactly
 * one place — the `Authorization` header this module builds — and every error
 * raised here carries a sentence, never a request echo.
 *
 * The protocol, all under `<url>/v0/management/` with a bearer key:
 *   GET  auth-files  → the accounts the hub holds
 *   POST api-call    → one request made AS one of them; the hub substitutes
 *                      the literal `$TOKEN$` in the header with a live token,
 *                      which is the whole reason this works without Telar ever
 *                      holding a subscription credential.
 */

import type { ProviderDriverKind, UsageLimitAccount, UsageLimitWindow } from "@telar/engine-client";

/** 15 s, t3's own bound. A hub is a loopback service in the ordinary case; a
 *  slow one must not hold the usage page open longer than a person will wait. */
const HUB_TIMEOUT_MS = 15_000;

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

/** How many accounts are read at once. Each is a round trip THROUGH the hub to
 *  a provider, so the ceiling is about not stampeding the hub, not about us. */
const ACCOUNT_CONCURRENCY = 4;

/** What one source needs to be read. The id and label are carried so a failure
 *  can name itself; nothing here is persisted by this module. */
export type HubConfig = {
  url: string;
  managementKey: string;
};

export type HubDeps = {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
};

/**
 * A failure with a sentence a person can act on.
 *
 * `detail` IS THE WHOLE ERROR SURFACE. It lands on the snapshot row and from
 * there on screen, so it says what went wrong in the register the rest of the
 * app uses — never a stack, never a URL with a key in it.
 */
export class UsageLimitSourceError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = "UsageLimitSourceError";
  }
}

/** One account as the hub describes it. Only the fields this module reads are
 *  named; a hub that grows more is not a hub this breaks on. */
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

/**
 * `<base>/v0/management/<path>`.
 *
 * RESOLVED AGAINST THE ORIGIN, not appended to the base's path: a hub
 * configured as `http://localhost:8317/` and one configured as
 * `http://localhost:8317` are the same hub, and string concatenation would make
 * one of them `//v0/management/...`.
 */
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

/**
 * One management call.
 *
 * A NON-2xx IS AN ERROR HERE, unlike `apiCall` below where the hub answers 200
 * carrying the provider's own status. 401 is the one worth naming: it is what
 * a hub says to a missing or wrong key, and "check the key" is the only useful
 * next step — so the sentence says it rather than printing a number.
 */
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
    // Deliberately one sentence for refused, DNS-less, timed out and aborted
    // alike: they are the same instruction to the reader, and the underlying
    // message is a Node error string carrying the URL.
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

/** The accounts a hub holds. Malformed entries are dropped rather than failing
 *  the read: one unrecognisable row must not cost the other five their bars. */
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

/**
 * One request made AS an account, through the hub.
 *
 * `$TOKEN$` IS NOT A PLACEHOLDER WE FILL — it is the hub's, substituted on its
 * side with a live access token for `auth_index`. It is what keeps a
 * subscription credential out of this process entirely.
 */
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

/** ISO-8601 or epoch SECONDS — Claude sends the first, Codex the second, and
 *  both land in the same field on the way out. */
function resetMillis(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Codex's `reset_at` is seconds. A value already in milliseconds would be
    // ~1e12; anything below that threshold is seconds and is scaled.
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

/**
 * Claude's `/api/oauth/usage`: the two standing windows plus whatever
 * model-scoped weekly limits the plan carries.
 *
 * A WINDOW THE ANSWER DID NOT MENTION IS OMITTED, never zeroed — "no seven-day
 * limit on this plan" and "seven-day limit untouched" are different facts, and
 * a 0% bar says the second.
 */
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

/** Codex's `backend-api/wham/usage`: two rate-limit windows, and a plan name
 *  the account record may also carry. */
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

/** `pro` → `Pro`, `chatgpt_plus` → `ChatGPT Plus`. The hub reports the raw
 *  enum; a settings page should not. */
export function codexPlanLabel(planType: string): string {
  return planType
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((word) => (word.toLowerCase() === "chatgpt" ? "ChatGPT" : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()))
    .join(" ");
}

/** Which Telar driver an auth file belongs to, or undefined for a provider
 *  this page has nothing to draw for (Gemini, Qwen, a raw API key). */
export function driverOf(provider: string): ProviderDriverKind | undefined {
  if (provider === "claude") return "claude";
  if (provider === "codex") return "codex";
  return undefined;
}

/**
 * One account's quota, as a row that is always drawable.
 *
 * A PROVIDER-SIDE FAILURE BECOMES `error` ON THE ROW rather than throwing: a
 * revoked login among five good ones is a fact about that login, and taking the
 * other four off screen to report it would be the wrong trade every time.
 */
export async function readAccount(config: HubConfig, account: HubAuthFile, deps: HubDeps = {}): Promise<UsageLimitAccount> {
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

/** Bounded-concurrency map. Small enough not to want a dependency, and the
 *  bound is the point — see `ACCOUNT_CONCURRENCY`. */
async function mapLimited<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let index = next++; index < items.length; index = next++) out[index] = await run(items[index]!);
  });
  await Promise.all(workers);
  return out;
}

/**
 * Every account a hub pools, with its windows.
 *
 * DISABLED ACCOUNTS ARE DROPPED and so is every provider Telar has no driver
 * for: a hub that also fronts Gemini is a perfectly good hub, and its Gemini
 * rows would be bars this page cannot label.
 */
export async function readHubAccounts(config: HubConfig, deps: HubDeps = {}): Promise<UsageLimitAccount[]> {
  const accounts = (await listAuthFiles(config, deps)).filter((account) => !account.disabled && driverOf(account.provider));
  return mapLimited(accounts, ACCOUNT_CONCURRENCY, (account) => readAccount(config, account, deps));
}

/** The label a source shows when nobody named it: the hub's host, which is what
 *  distinguishes two of them, and the id only when the URL cannot be parsed. */
export function sourceLabel(id: string, config: { label?: string; url: string }): string {
  if (config.label && config.label.trim()) return config.label.trim();
  try {
    return new URL(config.url).host || id;
  } catch {
    return id;
  }
}

/**
 * One source, read into a snapshot that is always renderable.
 *
 * NEVER THROWS. A hub that is off, misconfigured or refusing the key keeps its
 * row with `error` set — the page's whole job here is to distinguish "you have
 * not set this up" from "you set it up and it is broken", and an exception
 * escaping to the route would collapse the second into the first.
 */
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
