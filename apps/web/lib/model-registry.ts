// Server-only: fetches the live model catalog for each provider, falling back
// to the small curated list in lib/models.ts on any failure. Never imported by
// client code — keep filesystem/network access out of the client bundle.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { modelsForProvider, type ModelInfo } from "./models";

const CACHE_TTL_MS = 60 * 60 * 1000; // 1h
const cache = new Map<string, { at: number; models: ModelInfo[] }>();

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

async function fetchClaudeModels(env: Record<string, string | undefined>): Promise<ModelInfo[]> {
  const headers: Record<string, string> = { "anthropic-version": "2023-06-01" };
  if (env.ANTHROPIC_API_KEY) {
    headers["x-api-key"] = env.ANTHROPIC_API_KEY;
  } else if (env.CLAUDE_CODE_OAUTH_TOKEN) {
    // NOTE: whether /v1/models accepts a subscription OAuth token (rather than
    // an API key) is unverified — hence the graceful fallback below on any error.
    headers["Authorization"] = `Bearer ${env.CLAUDE_CODE_OAUTH_TOKEN}`;
  } else {
    return modelsForProvider("claude");
  }

  try {
    const res = await fetch("https://api.anthropic.com/v1/models", { headers });
    if (!res.ok) return modelsForProvider("claude");
    const data = (await res.json()) as { data?: Array<{ id: string; display_name?: string }> };
    if (!Array.isArray(data.data) || data.data.length === 0) return modelsForProvider("claude");
    return data.data.map((m) => ({
      id: m.id,
      name: m.display_name ?? m.id,
      provider: "claude" as const,
      tier: tierFromId(m.id),
      context: "—",
      maxOutput: "—",
      inputPerMTok: 0,
      outputPerMTok: 0,
      cacheReadPerMTok: 0,
      blurb: "",
    }));
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

export async function fetchModels(
  provider: "claude" | "codex",
  env: Record<string, string | undefined> = process.env,
): Promise<ModelInfo[]> {
  const cached = cache.get(provider);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.models;

  const models = provider === "claude" ? await fetchClaudeModels(env) : await fetchCodexModels(env);
  cache.set(provider, { at: Date.now(), models });
  return models;
}
