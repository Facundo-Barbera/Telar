import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type AutoCompact, autoCompactLimitFor, type ProviderModel } from "@telar/engine-client";

export type CodexWindow = { context: number; max: number };

const LONG = /\[1m\]$/i;
const TIMEOUT_MS = 10_000;

export function parseCodexWindows(stdout: string): Map<string, CodexWindow> {
  const windows = new Map<string, CodexWindow>();
  let models: unknown;
  try {
    models = (JSON.parse(stdout) as { models?: unknown }).models;
  } catch {
    return windows;
  }
  if (!Array.isArray(models)) return windows;
  for (const entry of models) {
    const row = entry as Record<string, unknown>;
    const context = row.context_window;
    if (typeof row.slug !== "string" || typeof context !== "number" || !Number.isSafeInteger(context) || context <= 0) continue;
    const max = typeof row.max_context_window === "number" && Number.isSafeInteger(row.max_context_window) ? row.max_context_window : context;
    windows.set(row.slug, { context, max: Math.max(context, max) });
  }
  return windows;
}

const cache = new Map<string, Promise<Map<string, CodexWindow>>>();

export function readCodexWindows(bin: string): Promise<Map<string, CodexWindow>> {
  let windows = cache.get(bin);
  if (!windows) {
    windows = promisify(execFile)(bin, ["debug", "models"], { timeout: TIMEOUT_MS, maxBuffer: 8_000_000 })
      .then(({ stdout }) => parseCodexWindows(stdout))
      .catch(() => new Map<string, CodexWindow>());
    cache.set(bin, windows);
  }
  return windows;
}

export function withCodexLongRows(models: readonly ProviderModel[], windows: ReadonlyMap<string, CodexWindow>): ProviderModel[] {
  return models.flatMap((model) => {
    const window = windows.get(model.id);
    if (!window || window.max <= window.context || LONG.test(model.id)) return [model];
    return [
      { ...model, defaultWindow: true },
      { ...model, id: `${model.id}[1m]`, isDefault: false, ...(model.resolves ? { resolves: `${model.resolves}[1m]` } : {}) },
    ];
  });
}

// Codex's long window is a second model row with Claude's `[1m]` suffix; the driver strips it
// and sets `model_context_window` from `codex debug models`.
export function codexWindowConfig(
  model: string,
  windows: ReadonlyMap<string, CodexWindow>,
  autoCompact: AutoCompact | undefined,
): { model: string; config: Record<string, number> } {
  const slug = model.replace(LONG, "");
  const window = windows.get(slug);
  const long = LONG.test(model) && window !== undefined && window.max > window.context;
  const config: Record<string, number> = {};
  if (long) config.model_context_window = window.max;
  if (autoCompact?.mode === "limits") {
    config.model_auto_compact_token_limit = autoCompactLimitFor(autoCompact, long ? window.max : window?.context);
  }
  return { model: slug, config };
}
