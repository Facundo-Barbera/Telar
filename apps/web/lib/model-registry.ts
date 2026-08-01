// Server-only: fetches the live model catalog for each provider, falling back
// to the small curated list in lib/models.ts on any failure. Never imported by
// client code — keep filesystem/network access out of the client bundle.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { modelsForProvider, type ModelInfo } from "./models";

const CACHE_TTL_MS = 60 * 60 * 1000; // 1h
const cache = new Map<string, { at: number; models: ModelInfo[] }>();

// The catalog depends on WHERE we ask, not just which provider: a proxied
// account and a direct one see different model sets from the same provider — a
// CLIProxyAPI gateway serves Claude AND GPT models from one endpoint. Keying the
// cache by provider alone would let whichever account asked first decide the
// picker for every other account.
const cacheKey = (provider: string, env: Record<string, string | undefined>): string =>
  `${provider}::${env.ANTHROPIC_BASE_URL ?? env.OPENAI_BASE_URL ?? "direct"}`;

function expandHome(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

// Best-effort tier inference from a Claude model id, purely for display —
// the live API doesn't return a tier field.
function tierFromId(id: string): ModelInfo["tier"] {
  if (id.includes("opus")) return "opus";
  if (id.includes("haiku")) return "haiku";
  if (id.includes("fable")) return "frontier";
  return "sonnet";
}

// CLAUDE CLOAK MODE. A CLIProxyAPI gateway with `disable-claude-cloak-mode:
// false` (the default) disguises every non-Claude model as a Claude one when
// the caller identifies as an Anthropic client — Claude Code rejects model ids
// that don't look like its own, so the gateway makes them look like its own.
// The disguise is `claude-fable-5-dd-<name reversed>`:
//
//   claude-fable-5-dd-anul-6.5-tpg   → gpt-5.6-luna
//   claude-fable-5-dd-weiver-otua-xedoc → codex-auto-review
//
// Measured against a live gateway, not documented — so the pattern is matched
// strictly and anything that does not fit is left exactly as it came.
//
// THE CLOAKED ID STAYS THE WIRE VALUE. Only the DISPLAY name is decoded: the
// gateway advertised the disguise and expects it back, so rewriting the id
// would send a model the proxy has never heard of. What changes is that a
// human can now tell which model they are picking.
const CLOAK_RE = /^claude-fable-5-dd-(.+)$/;
// A decoded value must LOOK like a model id, or we would be renaming on a
// coincidence. Deliberately NOT a list of known harness names: a PINNED
// credential's models decode to `work/claude-opus-4-6`, which starts with the
// user's own prefix and matches no harness — an earlier version rejected
// exactly those, which is why pinning appeared to do nothing.
const ID_LIKE = /^[a-z0-9][a-z0-9._/-]*$/i;

export function decloakModelId(id: string): string | null {
  const m = id.match(CLOAK_RE);
  if (!m) return null;
  const real = [...m[1]].reverse().join("");
  return ID_LIKE.test(real) ? real : null;
}

// Strip a routing prefix: "work/claude-opus-4-6" → "claude-opus-4-6".
const bareModelId = (id: string): string =>
  id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;

// What a model REALLY is, seen through both disguises the gateway applies at
// once: cloaking (a Claude-shaped alias hiding a foreign id) and the routing
// prefix (a pinned credential's namespace). Everything that classifies, names
// or filters a model has to look through both, because the raw id it was
// advertised under tells you neither.
const modelIdentity = (id: string): string => decloakModelId(id) ?? id;

const FOREIGN_RE = /^(gpt|o[0-9]|codex|gemini|grok|kimi)/i;

// Where to ask for the Claude catalog. A proxied account carries its gateway in
// ANTHROPIC_BASE_URL, and asking Anthropic directly would return a model list
// the session cannot actually use — the gateway's catalog is the true one.
const ANTHROPIC_DIRECT = "https://api.anthropic.com";
const claudeCatalogBase = (env: Record<string, string | undefined>): string =>
  (env.ANTHROPIC_BASE_URL || ANTHROPIC_DIRECT).replace(/\/+$/, "");

async function fetchClaudeModels(env: Record<string, string | undefined>): Promise<ModelInfo[]> {
  const headers: Record<string, string> = { "anthropic-version": "2023-06-01" };
  if (env.ANTHROPIC_AUTH_TOKEN) {
    // A gateway bearer token (CLIProxyAPI's API key). Checked FIRST: a proxied
    // account may also carry an ambient-looking API key, and the token is the
    // credential that matches the endpoint we are about to call.
    headers["Authorization"] = `Bearer ${env.ANTHROPIC_AUTH_TOKEN}`;
  } else if (env.ANTHROPIC_API_KEY) {
    headers["x-api-key"] = env.ANTHROPIC_API_KEY;
  } else if (env.CLAUDE_CODE_OAUTH_TOKEN) {
    // NOTE: whether /v1/models accepts a subscription OAuth token (rather than
    // an API key) is unverified — hence the graceful fallback below on any error.
    headers["Authorization"] = `Bearer ${env.CLAUDE_CODE_OAUTH_TOKEN}`;
  } else {
    return modelsForProvider("claude");
  }

  try {
    const res = await fetch(`${claudeCatalogBase(env)}/v1/models`, {
      headers,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return modelsForProvider("claude");
    const data = (await res.json()) as { data?: Array<{ id: string; display_name?: string }> };
    if (!Array.isArray(data.data) || data.data.length === 0) return modelsForProvider("claude");
    return data.data.map((m) => {
      // A gateway catalog mixes harnesses: `gpt-5.4` alongside `claude-opus-*`,
      // some of it cloaked. Classify by the REAL identity so the picker can
      // group honestly rather than labelling a GPT model as Claude because of
      // which endpoint answered and what disguise it wore.
      const real = decloakModelId(m.id);
      const identity = real ?? m.id;
      // Classify and NAME by the bare id: a pinned GPT model decodes to
      // `work/gpt-5.4`, and reading the prefix as part of the name would both
      // mislabel it as Claude and print the namespace twice in the picker.
      const bare = bareModelId(identity);
      const foreign = FOREIGN_RE.test(bare);
      return {
      id: m.id,
      name: m.display_name ?? bare,
      provider: foreign ? ("codex" as const) : ("claude" as const),
      tier: foreign ? ("codex" as const) : tierFromId(bare),
      context: "—",
      maxOutput: "—",
      inputPerMTok: 0,
      outputPerMTok: 0,
      cacheReadPerMTok: 0,
      blurb: "",
      // Say so on the row: the id being sent is not the model being named.
      ...(real ? { note: `Served as ${m.id} by the gateway.` } : {}),
      };
    });
  } catch {
    return modelsForProvider("claude");
  }
}

type CodexCacheEntry = {
  slug?: string;
  id?: string;
  display_name?: string;
  visibility?: string; // "hide" marks internal/non-selectable models
};

// Slugs that show up in models_cache.json but aren't user-selectable chat
// models (internal review/eval variants etc.) — belt-and-suspenders alongside
// the visibility:"hide" check, in case a future entry omits visibility.
const CODEX_INTERNAL_RE = /(auto-review|internal|eval)/i;

async function fetchCodexModels(env: Record<string, string | undefined>): Promise<ModelInfo[]> {
  const codexHome = expandHome(env.CODEX_HOME || "~/.codex");
  const cacheFile = path.join(codexHome, "models_cache.json");
  try {
    const raw = fs.readFileSync(cacheFile, "utf8");
    const data = JSON.parse(raw) as unknown;
    const entries = extractCodexEntries(data).filter((e) => {
      const id = e.slug ?? e.id;
      if (!id) return false;
      if (e.visibility === "hide") return false;
      return !CODEX_INTERNAL_RE.test(id);
    });
    if (entries.length === 0) return modelsForProvider("codex");
    return entries.map((e) => {
      const id = (e.slug ?? e.id) as string;
      return {
        id,
        name: e.display_name ?? id,
        provider: "codex" as const,
        tier: "codex" as const,
        context: "—",
        maxOutput: "—",
        inputPerMTok: 0,
        outputPerMTok: 0,
        cacheReadPerMTok: 0,
        blurb: "",
        note: "ChatGPT subscription.",
      };
    });
  } catch {
    return modelsForProvider("codex");
  }
}

// The cache file's exact shape isn't documented; tolerate a few plausible
// layouts (array of entries, or { models: [...] } / { <slug>: {...} } map).
function extractCodexEntries(data: unknown): CodexCacheEntry[] {
  if (Array.isArray(data)) {
    return data
      .map((entry) => (typeof entry === "string" ? { slug: entry } : (entry as CodexCacheEntry)))
      .filter((e) => e && typeof e === "object");
  }
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.models)) return extractCodexEntries(obj.models);
    return Object.entries(obj).map(([slug, v]) => ({ slug, ...(v as object) }));
  }
  return [];
}

// A gateway registers each credential's models TWICE — bare, and as
// `<prefix>/<model>` (CLIProxyAPI's applyModelPrefixes). An account pinned to
// one upstream must see only its own: the bare ids route to whatever the
// gateway's strategy picks, which is precisely what pinning exists to avoid,
// and showing both would double a 25-model picker into 50 with half of them
// silently going to the wrong login.
//
// The prefixed id stays the WIRE value — that is what the gateway resolves —
// while the display name drops the prefix, because the account row already says
// which upstream this is.
// GATEWAY ID FIXUPS. CLIProxyAPI's catalog carries DATED ids only for the 4.5
// generation: `claude-haiku-4-5-20251001` resolves, while the bare alias
// `claude-haiku-4-5` returns `502 unknown provider for model`. Newer undated ids
// (`claude-opus-5`, `claude-sonnet-5`, `claude-opus-4-8`) resolve fine.
//
// This only matters on the FALLBACK path. When the live catalog is reachable we
// use the ids it actually returned, which is always the right answer. But if the
// fetch fails for a proxied account we hand back the curated list from
// models.ts — which names the bare alias, because that alias is correct when
// talking to Anthropic directly. Through a gateway it is a 502 at turn time,
// which reads as "Telar is broken" rather than "that id needs a date".
const GATEWAY_ID_FIXUPS: Record<string, string> = {
  "claude-haiku-4-5": "claude-haiku-4-5-20251001",
};

function fixupForGateway(models: ModelInfo[]): ModelInfo[] {
  return models.map((m) => {
    const dated = GATEWAY_ID_FIXUPS[m.id];
    return dated ? { ...m, id: dated } : m;
  });
}

export function narrowToPrefix(models: ModelInfo[], prefix: string): ModelInfo[] {
  const p = `${prefix}/`;
  // Match on the IDENTITY, not the advertised id. With cloak mode on, a pinned
  // model arrives as `claude-fable-5-dd-<reversed>` whose decoded form is
  // `work/claude-…` — comparing the raw id here matched nothing, so every
  // pinned account silently fell through to the unnarrowed catalog and showed
  // each model twice: once pooled, once pinned, under identical names.
  const mine = models.filter((m) => modelIdentity(m.id).startsWith(p));
  // A prefix that matches nothing means it is not set on the gateway side (or
  // is misspelled). Falling back to the full list beats an empty picker, and
  // the pinned account then behaves like an unpinned one until it is fixed.
  if (mine.length === 0) return models;
  // Names are already bare — the mapping above strips the prefix before it ever
  // reaches a label, so there is nothing left to trim here.
  return mine;
}

export async function fetchModels(
  provider: "claude" | "codex",
  env: Record<string, string | undefined> = process.env,
  opts: { prefix?: string } = {},
): Promise<ModelInfo[]> {
  const key = `${cacheKey(provider, env)}::${opts.prefix ?? ""}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.models;

  const proxied = Boolean(env.ANTHROPIC_BASE_URL || env.OPENAI_BASE_URL);
  const fetched = provider === "claude" ? await fetchClaudeModels(env) : await fetchCodexModels(env);
  const all = proxied ? fixupForGateway(fetched) : fetched;
  const models = opts.prefix ? narrowToPrefix(all, opts.prefix) : all;
  cache.set(key, { at: Date.now(), models });
  return models;
}
