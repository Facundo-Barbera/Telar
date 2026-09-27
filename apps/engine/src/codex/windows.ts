/**
 * CODEX'S CONTEXT WINDOWS, AND THE LONG ONE IT KEEPS OFF BY DEFAULT (#587).
 *
 * `model/list` carries no window at all, so they are read from Codex's own
 * catalog: `codex debug models` prints each model's `context_window` (what it
 * runs by default — 272k on codex-cli 0.157.0) and `max_context_window` (what
 * `model_context_window` may raise it to — 872k on the GPT-6 and 5.6 families,
 * 272k on gpt-5.5, which has no long window).
 *
 * THE LONG WINDOW IS A SECOND ROW, spelled with Claude's `[1m]` suffix, so the
 * pickers that already offer 200k / 1M for Claude (#986) offer it for Codex
 * with no second vocabulary. The driver strips the suffix and sets
 * `model_context_window` from the same catalog.
 *
 * THE LIMIT IS `model_auto_compact_token_limit`, an absolute token count on the
 * thread's config overlay — the channel the driver already uses, never argv.
 * Codex has no verified switch that turns auto-compaction off, so Never writes
 * nothing and the settings card says so.
 */
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

/** Per binary, once per process. A Codex that cannot answer has no long rows
 *  and no known windows, which is the menu and the thread it had before. */
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

/** The long row after each standard row whose model has one. The standard row
 *  stays the default window, which is Codex's own default. */
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

/**
 * The slug Codex runs, and the config the thread carries for it: the long
 * window where the row asked for one, and the login's limit for the window
 * the thread ends up with. A long row whose model has no long window runs its
 * standard one rather than a number nobody verified.
 */
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
