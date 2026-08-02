// Server-only harness model discovery.
//
// Model ownership is intentionally narrow:
//   - Claude exposes its stable native slots. The user's Claude configuration
//     may map those slots to concrete models, including through a router.
//   - Codex exposes the selectable models recorded by its own local cache.
//
// An optional transport integration never contributes models here. In
// In particular, a mixed router /v1/models response is not a Claude Code
// capability declaration and must not leak GPT ids into the Claude composer.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { modelsForProvider, type ModelInfo } from "./models";

const CACHE_TTL_MS = 60 * 60 * 1000;
const cache = new Map<string, { at: number; models: ModelInfo[] }>();

function expandHome(value: string): string {
  return value.startsWith("~") ? path.join(os.homedir(), value.slice(1)) : value;
}

type CodexCacheEntry = {
  slug?: string;
  id?: string;
  display_name?: string;
  description?: string;
  context_window?: number;
  visibility?: string;
};

const CODEX_INTERNAL_RE = /(auto-review|internal|eval)/i;

function tokenLabel(tokens?: number): string {
  if (!tokens || !Number.isFinite(tokens)) return "—";
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M`;
  if (tokens >= 1_000 && tokens % 1_000 === 0) return `${tokens / 1_000}K`;
  return tokens.toLocaleString("en-US");
}

// Codex has used an array, { models: [...] }, and a slug-keyed object across
// cache versions. Tolerate all three without inventing entries.
export function extractCodexEntries(data: unknown): CodexCacheEntry[] {
  if (Array.isArray(data)) {
    return data
      .map((entry) =>
        typeof entry === "string" ? { slug: entry } : (entry as CodexCacheEntry),
      )
      .filter((entry) => entry && typeof entry === "object");
  }
  if (data && typeof data === "object") {
    const object = data as Record<string, unknown>;
    if (Array.isArray(object.models)) return extractCodexEntries(object.models);
    return Object.entries(object).flatMap(([slug, value]) =>
      value && typeof value === "object"
        ? [{ slug, ...(value as Omit<CodexCacheEntry, "slug">) }]
        : [],
    );
  }
  return [];
}

function readCodexModels(env: Record<string, string | undefined>): ModelInfo[] {
  const codexHome = expandHome(env.CODEX_HOME || "~/.codex");
  try {
    const raw = fs.readFileSync(path.join(codexHome, "models_cache.json"), "utf8");
    const entries = extractCodexEntries(JSON.parse(raw)).filter((entry) => {
      const id = entry.slug ?? entry.id;
      return Boolean(id && entry.visibility !== "hide" && !CODEX_INTERNAL_RE.test(id));
    });
    if (entries.length === 0) return modelsForProvider("codex");
    return entries.map((entry) => {
      const id = (entry.slug ?? entry.id) as string;
      return {
        id,
        name: entry.display_name ?? id,
        provider: "codex" as const,
        tier: "codex" as const,
        context: tokenLabel(entry.context_window),
        maxOutput: "—",
        inputPerMTok: 0,
        outputPerMTok: 0,
        cacheReadPerMTok: 0,
        blurb: entry.description ?? "",
        note: "ChatGPT subscription.",
      };
    });
  } catch {
    return modelsForProvider("codex");
  }
}

export async function fetchModels(
  provider: "claude" | "codex",
  env: Record<string, string | undefined> = process.env,
): Promise<ModelInfo[]> {
  if (provider === "claude") return modelsForProvider("claude");

  const codexHome = expandHome(env.CODEX_HOME || "~/.codex");
  const cached = cache.get(codexHome);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.models;

  const models = readCodexModels(env);
  cache.set(codexHome, { at: Date.now(), models });
  return models;
}
