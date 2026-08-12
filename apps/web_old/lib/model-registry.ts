// Server-only harness model discovery.
//
// Model ownership is intentionally narrow:
//   - Claude exposes the models and concrete alias resolutions reported by its
//     own control protocol after loading the selected configuration stack.
//   - Codex exposes the selectable models recorded by its own local cache.
//
// An optional transport integration never contributes models here. In
// In particular, a mixed router /v1/models response is not a Claude Code
// capability declaration and must not leak GPT ids into the Claude composer.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { query, type ModelInfo as ClaudeModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { claudeExecutableOptions } from "./claude-executable";
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
  default_reasoning_level?: string;
  supported_reasoning_levels?: Array<{ effort?: string; description?: string }>;
  service_tiers?: Array<{ id?: string; name?: string; description?: string }>;
  default_service_tier?: string;
};

const CODEX_INTERNAL_RE = /(auto-review|internal|eval)/i;

function tokenLabel(tokens?: number): string {
  if (!tokens || !Number.isFinite(tokens)) return "—";
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M`;
  if (tokens >= 1_000 && tokens % 1_000 === 0) return `${tokens / 1_000}K`;
  return tokens.toLocaleString("en-US");
}

const effortLabel = (value: string): string =>
  ({ xhigh: "Extra high", max: "Max", ultra: "Ultra" })[value] ??
  value.charAt(0).toUpperCase() + value.slice(1);

function claudeName(model: ClaudeModelInfo): string {
  const resolved = model.resolvedModel?.replace(/\[1m\]$/i, "") ?? "";
  const match = resolved.match(/^claude-(fable|opus|sonnet|haiku)-(\d+)(?:-(\d+))?/i);
  if (!match) return model.displayName.startsWith("Claude ")
    ? model.displayName
    : `Claude ${model.displayName.replace(/ \(.*\)$/, "")}`;
  const family = match[1].charAt(0).toUpperCase() + match[1].slice(1);
  const version = match[3] ? `${match[2]}.${match[3]}` : match[2];
  return `Claude ${family} ${version}`;
}

function claudeTier(model: ClaudeModelInfo): ModelInfo["tier"] {
  const id = `${model.value} ${model.resolvedModel ?? ""}`.toLowerCase();
  if (id.includes("fable")) return "frontier";
  if (id.includes("opus")) return "opus";
  if (id.includes("haiku")) return "haiku";
  return "sonnet";
}

export function mapClaudeModels(rows: ClaudeModelInfo[]): ModelInfo[] {
  const defaultResolved = rows.find((row) => row.value === "default")?.resolvedModel;
  const concrete = rows.filter((row) => row.value !== "default");
  const source = concrete.length > 0 ? concrete : rows;
  const mapped = source.map((row) => ({
    id: row.value,
    resolvedModel: row.resolvedModel,
    name: claudeName(row),
    provider: "claude" as const,
    tier: claudeTier(row),
    context: /\[1m\]/i.test(row.value) || /\[1m\]/i.test(row.resolvedModel ?? "") ? "1M" : "200K",
    maxOutput: "—",
    inputPerMTok: 0,
    outputPerMTok: 0,
    cacheReadPerMTok: 0,
    blurb: row.description,
    supportsFastMode: row.supportsFastMode,
    supportsAdaptiveThinking: row.supportsAdaptiveThinking,
    reasoningOptions: row.supportedEffortLevels?.map((effort) => ({
      id: effort,
      label: effortLabel(effort),
      isDefault: effort === "high",
    })),
    isDefault: Boolean(defaultResolved && row.resolvedModel === defaultResolved),
  }));
  const variants = [...mapped];
  for (const model of mapped) {
    if (!/\[1m\]$/i.test(model.id)) continue;
    const baseId = model.id.replace(/\[1m\]$/i, "");
    if (mapped.some((candidate) => candidate.id === baseId)) continue;
    variants.push({
      ...model,
      id: baseId,
      resolvedModel: model.resolvedModel?.replace(/\[1m\]$/i, ""),
      context: "200K",
      isDefault: false,
    });
  }
  return variants;
}

async function readClaudeModels(
  env: Record<string, string | undefined>,
  cwd: string,
): Promise<ModelInfo[]> {
  async function* emptyPrompt() {
    // Streaming mode lets us initialize the harness without sending a turn.
  }
  const control = query({
    prompt: emptyPrompt(),
    options: {
      ...claudeExecutableOptions(),
      cwd,
      env,
      settingSources: ["user", "project", "local"],
    },
  });
  try {
    const models = mapClaudeModels(await control.supportedModels());
    return models.length > 0 ? models : modelsForProvider("claude");
  } finally {
    control.close();
  }
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
        reasoningOptions: entry.supported_reasoning_levels?.flatMap((option) =>
          option.effort
            ? [{
                id: option.effort,
                label: effortLabel(option.effort),
                blurb: option.description,
                isDefault: option.effort === entry.default_reasoning_level,
              }]
            : [],
        ),
        serviceTiers: [
          {
            id: "standard",
            label: "Standard",
            blurb: "Standard service tier.",
            isDefault: !entry.default_service_tier,
          },
          ...(entry.service_tiers?.flatMap((tier) =>
            tier.id
              ? [{
                  id: tier.id,
                  label: tier.name ?? tier.id,
                  blurb: tier.description,
                  isDefault: tier.id === entry.default_service_tier,
                }]
              : [],
          ) ?? []),
        ],
      };
    });
  } catch {
    return modelsForProvider("codex");
  }
}

export async function fetchModels(
  provider: "claude" | "codex",
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
): Promise<ModelInfo[]> {
  if (provider === "claude") {
    const configDir = expandHome(env.CLAUDE_CONFIG_DIR || "~/.claude");
    const key = `claude:${configDir}:${cwd}`;
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.models;
    try {
      const models = await readClaudeModels(env, cwd);
      cache.set(key, { at: Date.now(), models });
      return models;
    } catch {
      return modelsForProvider("claude");
    }
  }

  const codexHome = expandHome(env.CODEX_HOME || "~/.codex");
  const cached = cache.get(codexHome);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.models;

  const models = readCodexModels(env);
  cache.set(codexHome, { at: Date.now(), models });
  return models;
}
