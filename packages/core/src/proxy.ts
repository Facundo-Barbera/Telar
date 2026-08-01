// CLIProxyAPI: an OPTIONAL local gateway that Telar can route accounts through.
//
// WHAT IT IS. CLIProxyAPI (github.com/router-for-me/CLIProxyAPI) holds harness
// OAuth logins — Claude Code, Codex, Gemini, Grok — and re-exposes them as
// OpenAI/Anthropic-compatible HTTP APIs on localhost. It inverts where
// multi-account lives: the proxy owns the credentials and pools them, and a
// client presents one bearer token. It also TRANSLATES between harness
// protocols, which is why an Anthropic-shaped request naming `gpt-5.4` returns
// an Anthropic-shaped response — measured, not assumed, against a live instance.
//
// OPTIONAL IS STRUCTURAL, NOT A PROMISE. Nothing in Telar assumes a proxy
// exists. An account routes through one only by declaring `proxy` on its
// profile, and `accountEnv` DELETES every routing/credential env var before
// anything sets one (providers.ts `ownedEnv`), so an account that does not
// declare it is provably direct no matter what the server was launched with.
// A machine with no proxy — or a registry copied to one — behaves exactly as it
// did before this file existed.
//
// WHAT TELAR STORES. The URL and an enabled flag, here. The two keys live in
// the secret store (secrets.ts), never in this file:
//   · the API key   — what a routed account presents as its bearer token
//   · the management key — read-only access to the credential pool
// The management key is the more dangerous of the two by a wide margin: the
// management API can send arbitrary outbound requests using stored credentials
// (`POST /api-call`) and install plugin executables. Telar only ever GETs from
// it, and it is optional — without it, everything except the pool listing works.
//
// The management key CANNOT be auto-discovered: the proxy bcrypt-hashes it at
// startup and rewrites its own config, so the plaintext exists only wherever the
// user kept it. That is why it is an input, not a probe.
import fs from "node:fs";
import path from "node:path";
import { atomicWrite, telarDir } from "./manifest";
import { readSecret, writeSecret, deleteSecret } from "./secrets";

export const PROXY_DEFAULT_URL = "http://127.0.0.1:8317";

// Secret-store keys. Namespaced under `proxy:` so they cannot collide with an
// account name (accounts key the store by bare name).
export const PROXY_API_KEY = "proxy:api-key";
export const PROXY_MANAGEMENT_KEY = "proxy:management-key";

export interface ProxyConfig {
  enabled: boolean;
  url: string;
}

// One upstream credential the proxy holds. Field names are normalized from the
// management API's snake_case; every field is optional there in practice, so
// every field here tolerates absence rather than inventing a value.
export interface ProxyUpstream {
  id: string;
  name: string;
  // RUNTIME identifier, not a durable one: the gateway derives it from the
  // credential's metadata and does not persist it, so it is read fresh on every
  // listing and never stored. The auth-file NAME is the durable key.
  authIndex: string | null;
  provider: string | null;
  label: string | null;
  email: string | null;
  accountType: string | null;
  status: string | null;
  // The routing selector, when this credential has been pinned. Its models are
  // additionally registered as `<prefix>/<model>`, which is how a Telar account
  // addresses this specific login instead of the gateway's pooled choice.
  prefix: string | null;
  disabled: boolean;
  unavailable: boolean;
  success: number | null;
  failed: number | null;
}

export interface ProxyStatus {
  enabled: boolean;
  url: string;
  // Root endpoint answered and identified itself as CLIProxyAPI. No auth needed.
  reachable: boolean;
  // Whether each key is present — never the key itself.
  hasApiKey: boolean;
  hasManagementKey: boolean;
  // Models the proxy will serve (needs the API key).
  models: string[];
  // The management lockout's state. The POOL IS NOT PART OF STATUS: fetching it
  // is a management auth attempt, and bundling one into every status read made
  // each settings-page load spend an attempt against the hardcoded lockout.
  // Callers ask for the pool explicitly, via proxyPool().
  management: ManagementBreaker;
  // Human-readable reason the last probe fell short, if it did.
  error: string | null;
  checkedAt: string;
}

const proxyFile = () => path.join(telarDir(), "proxy.json");

const DEFAULT_CONFIG: ProxyConfig = { enabled: false, url: PROXY_DEFAULT_URL };

export function readProxyConfig(): ProxyConfig {
  try {
    const data = JSON.parse(fs.readFileSync(proxyFile(), "utf8"));
    return {
      enabled: data?.enabled === true,
      url: typeof data?.url === "string" && data.url.trim() ? data.url.trim() : PROXY_DEFAULT_URL,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function writeProxyConfig(cfg: Partial<ProxyConfig>): ProxyConfig {
  const next: ProxyConfig = { ...readProxyConfig(), ...cfg };
  next.url = next.url.trim().replace(/\/+$/, "") || PROXY_DEFAULT_URL;
  atomicWrite(proxyFile(), JSON.stringify({ version: 1, ...next }, null, 2));
  return next;
}

// Keys go through the secret store. Passing an empty string CLEARS one, which
// is how the UI removes a key it can never read back.
export function setProxyKey(which: "api" | "management", value: string): void {
  const key = which === "api" ? PROXY_API_KEY : PROXY_MANAGEMENT_KEY;
  if (value.trim()) writeSecret(key, value.trim());
  else deleteSecret(key);
}

export const getProxyKey = (which: "api" | "management"): string | undefined =>
  readSecret(which === "api" ? PROXY_API_KEY : PROXY_MANAGEMENT_KEY);

// --- client ---------------------------------------------------------------
// Every call is short-timeout, failure-tolerant and READ-ONLY. A proxy that is
// down, wedged or of a different version must degrade the surface, never break
// a session or throw into a route.

export type FetchLike = typeof fetch;

const TIMEOUT_MS = 5000;

// --- the management lockout, and why this is a BREAKER and not a retry ------
//
// CLIProxyAPI has a hardcoded, non-configurable brute-force lockout on failed
// management auth. Its behaviour is the part that matters: WHILE BANNED, EVERY
// REQUEST EXTENDS THE BAN — including requests carrying the correct key. So the
// usual instincts are all wrong here. A retry loop never recovers, it digs;
// exponential backoff still digs, just slower; and a timer polling the pool with
// a stale key bans the machine permanently. Observed in practice: a 10-minute
// countdown pushed to 25 by things that kept trying.
//
// The only fast clear is restarting the proxy — the ban is in memory:
//     brew services restart cliproxyapi
//
// So this module FAILS CLOSED. One failed management auth trips the breaker and
// every later management call returns immediately WITHOUT touching the network,
// until a human explicitly acts. That is deliberately stricter than "retry
// less": an automatic second attempt is precisely what makes this unrecoverable.
//
// 401 trips it as well as 403. A rejected key is a failed auth and counts toward
// the same lockout, so treating it as merely "wrong key, try again" is how five
// page loads become a ban.
let managementBreaker: { reason: string; at: string } | null = null;

export interface ManagementBreaker {
  blocked: boolean;
  reason: string | null;
  at: string | null;
  // Handed to the surface so the fix is stated where the failure is shown.
  remedy: string;
}

export const MANAGEMENT_RESTART_HINT = "brew services restart cliproxyapi";

export function managementBreakerState(): ManagementBreaker {
  return {
    blocked: managementBreaker !== null,
    reason: managementBreaker?.reason ?? null,
    at: managementBreaker?.at ?? null,
    remedy: MANAGEMENT_RESTART_HINT,
  };
}

// Cleared ONLY by an explicit human action — saving a different management key,
// or pressing the pool's own load/test control. Each such action buys exactly
// one attempt, because each is a new hypothesis a person chose to test.
export function clearManagementBreaker(): void {
  managementBreaker = null;
}

function tripManagementBreaker(reason: string): void {
  managementBreaker = { reason, at: new Date().toISOString() };
}

// The guard every management call goes through. Returns the refusal to hand
// back, or null to proceed.
function breakerRefusal(): string | null {
  if (!managementBreaker) return null;
  return `${managementBreaker.reason} Further management calls are blocked — retrying would extend the proxy's lockout rather than recover from it. Run \`${MANAGEMENT_RESTART_HINT}\`, then try again.`;
}

async function get(
  url: string,
  headers: Record<string, string>,
  fetchFn: FetchLike,
): Promise<Response | null> {
  try {
    return await fetchFn(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    return null; // unreachable, DNS, timeout — all "we could not ask"
  }
}

// Is a CLIProxyAPI listening here? The root endpoint answers without auth and
// names itself, so detection needs no key at all.
export async function probeProxy(
  url: string,
  fetchFn: FetchLike = fetch,
): Promise<{ reachable: boolean; error: string | null }> {
  const res = await get(url.replace(/\/+$/, "") + "/", {}, fetchFn);
  if (!res) return { reachable: false, error: "No response — is CLIProxyAPI running?" };
  if (!res.ok) return { reachable: false, error: `Responded ${res.status}.` };
  try {
    const body = (await res.json()) as { message?: string };
    // Identify it rather than accepting any 200 — something else on the port
    // answering OK is not a proxy, and saying so beats a false green light.
    if (typeof body?.message === "string" && /proxy/i.test(body.message))
      return { reachable: true, error: null };
    return { reachable: false, error: "Something answered, but it isn't CLIProxyAPI." };
  } catch {
    return { reachable: false, error: "Response was not JSON — probably not CLIProxyAPI." };
  }
}

// Models the proxy will serve, via its OpenAI-compatible catalog. Needs the API
// key (the same one a routed account presents).
export async function proxyModels(
  url: string,
  apiKey: string | undefined,
  fetchFn: FetchLike = fetch,
): Promise<string[]> {
  if (!apiKey) return [];
  const res = await get(
    url.replace(/\/+$/, "") + "/v1/models",
    { Authorization: `Bearer ${apiKey}` },
    fetchFn,
  );
  if (!res?.ok) return [];
  try {
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
    return (body.data ?? [])
      .map((m) => (typeof m.id === "string" ? m.id : null))
      .filter((id): id is string => Boolean(id));
  } catch {
    return [];
  }
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

// The credential pool, via the management API. Returns null when we could not
// ask (no key, unreachable, refused) — distinct from [] meaning "asked, none".
export async function proxyUpstreams(
  url: string,
  managementKey: string | undefined,
  fetchFn: FetchLike = fetch,
): Promise<{ upstreams: ProxyUpstream[] | null; error: string | null }> {
  if (!managementKey) return { upstreams: null, error: null };
  const refused = breakerRefusal();
  if (refused) return { upstreams: null, error: refused };
  const res = await get(
    url.replace(/\/+$/, "") + "/v0/management/auth-files",
    { Authorization: `Bearer ${managementKey}` },
    fetchFn,
  );
  if (!res) return { upstreams: null, error: "Management API did not respond." };
  // 401 and 403 are both FAILED AUTH and both count toward the hardcoded
  // lockout, so both trip the breaker. The proxy hashes its key at startup, so
  // a stale paste fails forever — retrying it is the exact loop that bans you.
  if (res.status === 401) {
    tripManagementBreaker("Management key rejected (401).");
    return { upstreams: null, error: breakerRefusal() };
  }
  if (res.status === 403) {
    tripManagementBreaker(
      "Management refused (403) — the key is wrong, remote management is off, or this IP is temporarily locked out.",
    );
    return { upstreams: null, error: breakerRefusal() };
  }
  if (res.status === 404)
    return {
      upstreams: null,
      error: "Management API is disabled — set remote-management.secret-key and restart the proxy.",
    };
  if (!res.ok) return { upstreams: null, error: `Management API responded ${res.status}.` };
  try {
    const body = (await res.json()) as { files?: unknown[] };
    const files = Array.isArray(body.files) ? body.files : [];
    return {
      upstreams: files.map((raw) => {
        const f = (raw ?? {}) as Record<string, unknown>;
        return {
          id: str(f.id) ?? str(f.name) ?? "",
          name: str(f.name) ?? "",
          authIndex: str(f.auth_index),
          provider: str(f.provider),
          label: str(f.label),
          email: str(f.email),
          accountType: str(f.account_type),
          status: str(f.status),
          prefix: str(f.prefix),
          disabled: f.disabled === true,
          unavailable: f.unavailable === true,
          success: num(f.success),
          failed: num(f.failed),
        };
      }),
      error: null,
    };
  } catch {
    return { upstreams: null, error: "Management API returned something unreadable." };
  }
}

// Cheap SHAPE check before a key is ever stored or sent. Catches the three
// paste mistakes this card actually produced in practice, each with a message
// naming the specific confusion rather than a generic "invalid key":
//
//   · the gateway's own ERROR TEXT pasted into the field (multi-line prose)
//   · the config's bcrypt HASH pasted instead of the plaintext it hashes
//   · the API key pasted into the management field, or vice versa
//
// Returns null when the value looks like a key. Shape only — whether the
// gateway ACCEPTS it is a separate, live question the caller asks next.
export function proxyKeyShapeError(
  which: "api" | "management",
  value: string,
  otherKey?: string,
): string | null {
  const v = value.trim();
  if (!v) return null; // empty = a deliberate clear
  const field = which === "api" ? "API key" : "management key";
  const other = which === "api" ? "management key" : "API key";
  if (/\s/.test(v))
    return `That doesn't look like a ${field} — it contains spaces or line breaks. If you copied an error message from the gateway, paste the key itself instead.`;
  if (v.startsWith("$2"))
    return `That is the bcrypt hash from the gateway's config, not the plaintext it was made from. The gateway hashes the key at startup and cannot turn it back — set a fresh plaintext secret-key, restart, and paste that.`;
  if (otherKey && v === otherKey.trim())
    return `That is your ${other}, which is a different credential. The ${field} goes in this field.`;
  return null;
}

// Pin an upstream credential to a PREFIX, so a Telar account can address that
// one login instead of taking whatever the gateway's routing strategy picks.
//
// VERIFIED AGAINST THE SOURCE, because the docs only ever show `prefix` on
// configured API-key entries and that would have made this design impossible
// for OAuth logins: `sdk/cliproxy/auth/types.go` puts `Prefix` on the GENERIC
// credential struct (`json:"prefix,omitempty"`), and `applyModelPrefixes`
// registers every one of that credential's models a second time as
// `<prefix>/<model>`. So the prefix is a real routing selector for an OAuth
// auth file, and it is a plain JSON field, which is why this PATCH can set it.
//
// THIS IS THE ONE WRITE TELAR MAKES to the gateway. Everything else here is
// read-only. It is deliberate and user-initiated — adopting an upstream as a
// named account — never part of a refresh or a background probe.
export async function setUpstreamPrefix(
  url: string,
  managementKey: string | undefined,
  name: string,
  prefix: string,
  fetchFn: FetchLike = fetch,
): Promise<{ ok: boolean; error: string | null }> {
  if (!managementKey) return { ok: false, error: "A management key is required to pin an upstream." };
  const refused = breakerRefusal();
  if (refused) return { ok: false, error: refused };
  try {
    const res = await fetchFn(url.replace(/\/+$/, "") + "/v0/management/auth-files/fields", {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${managementKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name, prefix }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) {
      tripManagementBreaker(`Management refused (${res.status}).`);
      return { ok: false, error: breakerRefusal() };
    }
    if (!res.ok) return { ok: false, error: `Gateway responded ${res.status}.` };
    return { ok: true, error: null };
  } catch {
    return { ok: false, error: "Could not reach the gateway's management API." };
  }
}

// --- plan usage for gateway-routed accounts --------------------------------
//
// THE GATEWAY DOES NOT KNOW YOUR QUOTA, AND DOES NOT NEED TO. It never parses
// Anthropic's rate-limit headers (grep the Go source: zero matches), exposes no
// usage endpoint, and its `/auth-files` projection carries request counts and
// health but no utilization. Three separate probes said "unavailable" and all
// three were answering the wrong question.
//
// The right question is not "which endpoint returns quota" but "can I reach the
// provider AS this account". `POST /v0/management/api-call` answers yes: it
// performs an outbound request using a stored credential, substituting $TOKEN$
// with that credential's real OAuth token. So Telar asks ANTHROPIC for the
// usage, through the gateway, per credential — and gets back the very shape
// PlanSnapshot already models, with genuinely per-account numbers.
//
// THE URL IS A CONSTANT AND MUST STAY ONE. `/api-call` is a general-purpose
// request forwarder holding your upstream credentials; the only thing keeping
// it from becoming one *inside Telar* is that no caller may choose the target.
// Do not add a parameter for it.
// One endpoint per provider, and BOTH ARE CONSTANTS. Found by reading what the
// gateway's own management panel calls — not from its Go source, which contains
// neither (it never parses usage; it only lends the credential).
export const PROXY_USAGE_URLS: Record<string, string> = {
  claude: "https://api.anthropic.com/api/oauth/usage",
  codex: "https://chatgpt.com/backend-api/wham/usage",
};

export interface ProxyUsageWindow {
  utilization: number;
  resets_at: string | null;
  // How long the window is, when the provider states it. Codex reports
  // `limit_window_seconds` per window, which is what lets a meter name itself
  // after the window it really is instead of the slot it arrived in.
  windowMinutes: number | null;
}
export interface ProxyUsageWindows {
  fiveHour: ProxyUsageWindow | null;
  sevenDay: ProxyUsageWindow | null;
  sevenDayOpus: ProxyUsageWindow | null;
  sevenDaySonnet: ProxyUsageWindow | null;
}

export interface ProxyUsage {
  windows: ProxyUsageWindows;
  // The plan as the provider words it ("prolite"). Anthropic's endpoint does not
  // return one; Codex's does.
  planType: string | null;
  credits: { hasCredits: boolean; unlimited: boolean; balance: string | null } | null;
}

// A day — the boundary between the short rolling window and the long one. A
// threshold rather than equality on 300/10080, so a provider tweaking either
// duration keeps landing in the right meter instead of vanishing. Same rule the
// Codex rollout reader uses, for the same reason.
const LONG_WINDOW_MIN = 24 * 60;

// Anthropic: { utilization, resets_at } under named keys (five_hour, seven_day…).
const anthropicWindow = (v: unknown): ProxyUsageWindow | null => {
  if (!v || typeof v !== "object") return null;
  const w = v as { utilization?: unknown; resets_at?: unknown };
  return typeof w.utilization === "number"
    ? {
        utilization: Math.round(w.utilization),
        resets_at: typeof w.resets_at === "string" ? w.resets_at : null,
        windowMinutes: null, // named, not measured — the key IS the duration
      }
    : null;
};

// Codex: { used_percent, limit_window_seconds, reset_at } under POSITIONAL keys
// (primary_window / secondary_window). Position is not meaning — Codex already
// moved its weekly window into the primary slot once — so these are placed by
// their stated duration below, never by which slot they arrived in.
const codexWindow = (v: unknown): ProxyUsageWindow | null => {
  if (!v || typeof v !== "object") return null;
  const w = v as { used_percent?: unknown; limit_window_seconds?: unknown; reset_at?: unknown };
  if (typeof w.used_percent !== "number") return null;
  return {
    utilization: Math.round(w.used_percent),
    resets_at: typeof w.reset_at === "number" ? new Date(w.reset_at * 1000).toISOString() : null,
    windowMinutes:
      typeof w.limit_window_seconds === "number" ? Math.round(w.limit_window_seconds / 60) : null,
  };
};

function parseAnthropicUsage(u: Record<string, unknown>): ProxyUsage {
  return {
    windows: {
      fiveHour: anthropicWindow(u.five_hour),
      sevenDay: anthropicWindow(u.seven_day),
      sevenDayOpus: anthropicWindow(u.seven_day_opus),
      sevenDaySonnet: anthropicWindow(u.seven_day_sonnet),
    },
    planType: null,
    credits: null,
  };
}

function parseCodexUsage(u: Record<string, unknown>): ProxyUsage {
  const rl = (u.rate_limit ?? {}) as Record<string, unknown>;
  const windows: ProxyUsageWindows = {
    fiveHour: null,
    sevenDay: null,
    sevenDayOpus: null,
    sevenDaySonnet: null,
  };
  const place = (w: ProxyUsageWindow | null, fallbackLong: boolean) => {
    if (!w) return;
    const long = w.windowMinutes == null ? fallbackLong : w.windowMinutes >= LONG_WINDOW_MIN;
    if (long) windows.sevenDay ??= w;
    else windows.fiveHour ??= w;
  };
  place(codexWindow(rl.primary_window), false);
  place(codexWindow(rl.secondary_window), true);

  const c = u.credits as Record<string, unknown> | undefined;
  return {
    windows,
    planType: typeof u.plan_type === "string" ? u.plan_type : null,
    credits: c
      ? {
          hasCredits: c.has_credits === true,
          unlimited: c.unlimited === true,
          balance: typeof c.balance === "string" ? c.balance : null,
        }
      : null,
  };
}

async function managementPost(
  url: string,
  key: string,
  path: string,
  body: unknown,
  fetchFn: FetchLike,
): Promise<{ res: Response | null; refused: string | null }> {
  const refused = breakerRefusal();
  if (refused) return { res: null, refused };
  try {
    const res = await fetchFn(url.replace(/\/+$/, "") + path, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS * 3), // an upstream round-trip, not a local read
    });
    if (res.status === 401 || res.status === 403) {
      tripManagementBreaker(`Management refused (${res.status}).`);
      return { res: null, refused: breakerRefusal() };
    }
    return { res, refused: null };
  } catch {
    return { res: null, refused: "The gateway's management API did not respond." };
  }
}

// Which models a credential serves. Used ONLY to discover which credential a
// prefix belongs to: `/auth-files` does not project `prefix`, but a pinned
// credential's models are registered as `<prefix>/<model>`, so the catalog is
// where the mapping is legible. The answer is persisted by the caller so this
// runs once per account, not once per refresh.
export async function upstreamModels(
  url: string,
  managementKey: string,
  name: string,
  fetchFn: FetchLike = fetch,
): Promise<string[]> {
  const refused = breakerRefusal();
  if (refused) return [];
  const res = await get(
    `${url.replace(/\/+$/, "")}/v0/management/auth-files/models?name=${encodeURIComponent(name)}`,
    { Authorization: `Bearer ${managementKey}` },
    fetchFn,
  );
  if (res && (res.status === 401 || res.status === 403)) {
    tripManagementBreaker(`Management refused (${res.status}).`);
    return [];
  }
  if (!res?.ok) return [];
  try {
    const body = (await res.json()) as { models?: unknown[] };
    return (body.models ?? [])
      .map((m) => (typeof m === "string" ? m : (m as { id?: string; slug?: string })?.id ?? (m as { slug?: string })?.slug))
      .filter((m): m is string => typeof m === "string");
  } catch {
    return [];
  }
}

// Ask the provider, as this credential, what its plan usage is.
export async function proxyAccountUsage(
  url: string,
  managementKey: string,
  authIndex: string,
  provider: string,
  fetchFn: FetchLike = fetch,
): Promise<{ usage: ProxyUsage | null; error: string | null }> {
  const target = PROXY_USAGE_URLS[provider.toLowerCase()];
  if (!target)
    return { usage: null, error: `No usage endpoint is known for "${provider}".` };
  const { res, refused } = await managementPost(
    url,
    managementKey,
    "/v0/management/api-call",
    {
      auth_index: authIndex,
      method: "GET",
      url: target,
      header:
        provider.toLowerCase() === "claude"
          ? { Authorization: "Bearer $TOKEN$", "anthropic-version": "2023-06-01" }
          : { Authorization: "Bearer $TOKEN$" },
    },
    fetchFn,
  );
  if (refused) return { usage: null, error: refused };
  if (!res?.ok) return { usage: null, error: `Gateway responded ${res?.status ?? "nothing"}.` };
  try {
    const envelope = (await res.json()) as { status_code?: number; body?: string };
    // TWO status codes to check, not one: the management call can succeed while
    // the upstream request it performed did not.
    if (envelope.status_code !== 200)
      return { usage: null, error: `The provider returned ${envelope.status_code} for this account.` };
    const u = JSON.parse(envelope.body ?? "{}") as Record<string, unknown>;
    return {
      usage:
        provider.toLowerCase() === "codex" ? parseCodexUsage(u) : parseAnthropicUsage(u),
      error: null,
    };
  } catch {
    return { usage: null, error: "The provider's usage response was unreadable." };
  }
}

// The whole picture in one call, for the settings surface. Never throws.
export async function proxyStatus(fetchFn: FetchLike = fetch): Promise<ProxyStatus> {
  const cfg = readProxyConfig();
  const apiKey = getProxyKey("api");
  const managementKey = getProxyKey("management");
  const base: ProxyStatus = {
    enabled: cfg.enabled,
    url: cfg.url,
    reachable: false,
    hasApiKey: Boolean(apiKey),
    hasManagementKey: Boolean(managementKey),
    models: [],
    management: managementBreakerState(),
    error: null,
    checkedAt: new Date().toISOString(),
  };

  const probe = await probeProxy(cfg.url, fetchFn);
  if (!probe.reachable) return { ...base, error: probe.error };

  // Reachable — read the catalog only. /v1/models uses the API key, which has
  // no lockout, so it is safe on every status read. The pool is not fetched here.
  const models = await proxyModels(cfg.url, apiKey, fetchFn);
  return {
    ...base,
    reachable: true,
    models,
    error: apiKey ? null : "Add the proxy's API key to list models and route accounts.",
  };
}

// THE POOL, fetched only when a human asks for it. This is the one place a
// management auth attempt is spent, and it is always the direct result of a
// click. Clearing the breaker here is what makes that click a fresh hypothesis
// worth one attempt — see managementBreakerState.
export async function proxyPool(
  fetchFn: FetchLike = fetch,
): Promise<{ upstreams: ProxyUpstream[] | null; error: string | null }> {
  const cfg = readProxyConfig();
  if (!cfg.enabled) return { upstreams: null, error: "The gateway is switched off." };
  const key = getProxyKey("management");
  if (!key)
    return { upstreams: null, error: "Add the management key to list the logins this gateway holds." };
  clearManagementBreaker();
  return proxyUpstreams(cfg.url, key, fetchFn);
}

// Plan usage for every gateway-routed account, in as few management calls as
// the lockout deserves: ONE listing, then one usage call per account — plus a
// one-time model-catalog lookup for any account whose credential is not yet
// known. `resolved` hands that discovery back so the caller can persist it and
// never pay for it again.
export async function proxyUsageForAccounts(
  accounts: ReadonlyArray<{ name: string; prefix?: string; upstream?: string }>,
  fetchFn: FetchLike = fetch,
): Promise<{
  usage: Record<string, ProxyUsage>;
  resolved: Record<string, string>;
  errors: Record<string, string>;
}> {
  const out = { usage: {} as Record<string, ProxyUsage>, resolved: {} as Record<string, string>, errors: {} as Record<string, string> };
  if (accounts.length === 0) return out;

  const cfg = readProxyConfig();
  const key = getProxyKey("management");
  if (!cfg.enabled || !key) {
    for (const a of accounts)
      out.errors[a.name] = key
        ? "The gateway is switched off."
        : "Add the gateway's management key to read plan usage for routed accounts.";
    return out;
  }

  const { upstreams, error } = await proxyUpstreams(cfg.url, key, fetchFn);
  if (!upstreams) {
    for (const a of accounts) out.errors[a.name] = error ?? "Could not list the gateway's credentials.";
    return out;
  }
  const byName = new Map(upstreams.map((u) => [u.name, u]));

  // Discover credential↔prefix only for accounts that still need it.
  const unknown = accounts.filter((a) => !a.upstream || !byName.has(a.upstream));
  if (unknown.length > 0) {
    const prefixes = new Map<string, string>(); // prefix -> credential name
    for (const u of upstreams) {
      const models = await upstreamModels(cfg.url, key, u.name, fetchFn);
      for (const m of models) {
        const slash = m.indexOf("/");
        if (slash > 0) prefixes.set(m.slice(0, slash), u.name);
      }
    }
    for (const a of unknown) {
      const found = a.prefix ? prefixes.get(a.prefix) : undefined;
      if (found) out.resolved[a.name] = found;
    }
  }

  for (const a of accounts) {
    const credential = out.resolved[a.name] ?? a.upstream;
    const upstream = credential ? byName.get(credential) : undefined;
    if (!upstream) {
      out.errors[a.name] =
        "Not linked to a gateway login — pin it to an upstream from the Providers card.";
      continue;
    }
    // auth_index is a RUNTIME id: resolved fresh from the listing above rather
    // than stored, because the credential NAME is the durable key and the index
    // is derived. Storing the index would break on a restart that re-derived it.
    if (!upstream.authIndex) {
      out.errors[a.name] = "The gateway reported no auth index for that credential.";
      continue;
    }
    const { usage, error: e } = await proxyAccountUsage(
      cfg.url,
      key,
      upstream.authIndex,
      upstream.provider ?? "claude",
      fetchFn,
    );
    if (usage) out.usage[a.name] = usage;
    else if (e) out.errors[a.name] = e;
  }
  return out;
}
