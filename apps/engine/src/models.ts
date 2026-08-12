/**
 * WHICH MODELS A PROVIDER ACTUALLY HAS — asked, not assumed.
 *
 * The cockpit shipped a hand-written catalogue and it was wrong almost
 * immediately: it offered Codex a `gpt-5.5-codex` that does not exist, and
 * defaulted to `gpt-5.5` when the installed harness defaults to something two
 * generations newer. Every id in such a list is a guess whose failure mode is a
 * 404 at the provider, discovered by a person mid-turn.
 *
 * CODEX ANSWERS `model/list`, and it answers with everything the picker needs:
 * ids, display names, which one is default, which are hidden, and the reasoning
 * levels EACH model supports — a per-model fact that the previous per-provider
 * guess could not express at all.
 *
 * CLAUDE HAS NO EQUIVALENT AND SAYS SO. The Agent SDK exposes `supportedModels()`
 * only on a live `query()`, which means spawning a session and paying for it to
 * populate a menu. Until there is a cheaper seam, Claude's list is this
 * cockpit's own and is reported as `source: "builtin"` so no surface can imply
 * otherwise.
 *
 * SPAWNING A SUBPROCESS TO FILL A MENU IS EXPENSIVE, so this is cached, and the
 * cache is what makes it acceptable to call from a popover.
 */
import type { ModelCatalogue, ProviderDriverKind, ProviderModel } from "@telar/engine-client";
import { CodexAppServer, resolveCodexBinary } from "./codex/app-server";

/**
 * Claude's list, hand-maintained, and the only part of this module that is a
 * guess. Kept deliberately short: the picker splits older generations behind a
 * "legacy" fold on its own, so this needs the current family plus the previous
 * one, not an archive.
 */
const CLAUDE_BUILTIN: ProviderModel[] = [
  {
    id: "claude-opus-5",
    label: "Opus 5",
    description: "Deepest reasoning and long-horizon agentic work.",
    isDefault: true,
    hidden: false,
    efforts: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "claude-sonnet-5",
    label: "Sonnet 5",
    description: "Near-Opus quality on coding, at Sonnet speed.",
    isDefault: false,
    hidden: false,
    efforts: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "claude-opus-4-8",
    label: "Opus 4.8",
    description: "The previous Opus. Pin it when a change in 5 regressed you.",
    isDefault: false,
    hidden: false,
    efforts: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "claude-haiku-4-5",
    label: "Haiku 4.5",
    description: "Fastest and cheapest. Good for short, scoped work.",
    isDefault: false,
    hidden: false,
    efforts: ["low", "medium", "high"],
  },
];

/**
 * `model/list`'s rows, narrowed to what a picker needs.
 *
 * DEFENSIVE ABOUT EVERY FIELD, because this crosses a version boundary: the
 * installed `codex` is upgraded by its own updater on its own schedule, and a
 * row that has grown a field or lost one must degrade to a usable entry rather
 * than to an exception inside a menu.
 */
export function parseCodexModels(payload: unknown): ProviderModel[] {
  const rows = (payload as { data?: unknown })?.data;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((entry) => {
    const row = entry as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id : typeof row.model === "string" ? row.model : "";
    if (!id) return [];
    const efforts = Array.isArray(row.supportedReasoningEfforts)
      ? row.supportedReasoningEfforts.flatMap((level) => {
          const value = (level as { reasoningEffort?: unknown })?.reasoningEffort;
          return typeof value === "string" && value ? [value] : [];
        })
      : [];
    return [
      {
        id,
        label: typeof row.displayName === "string" && row.displayName ? row.displayName : id,
        ...(typeof row.description === "string" && row.description ? { description: row.description } : {}),
        isDefault: row.isDefault === true,
        hidden: row.hidden === true,
        efforts,
        ...(typeof row.defaultReasoningEffort === "string" && row.defaultReasoningEffort
          ? { defaultEffort: row.defaultReasoningEffort }
          : {}),
      },
    ];
  });
}

/**
 * Ask the installed Codex what it can run.
 *
 * ONE SHORT-LIVED SUBPROCESS. The app-server is not kept warm for this: a menu
 * read happens seconds apart at most and holding a Codex process open for the
 * life of the daemon to answer it would trade a real resource for a saved
 * spawn. The cache above is what makes the spawn rare.
 */
export async function readCodexModels(
  spawnServer: () => CodexAppServer = () => new CodexAppServer(resolveCodexBinary(), dropUndefined(process.env)),
): Promise<{ models: ProviderModel[]; message?: string }> {
  let client: CodexAppServer;
  try {
    client = spawnServer();
  } catch (error) {
    // Codex is not installed. A real answer, and not this engine's problem.
    return { models: [], message: error instanceof Error ? error.message : "codex is not available" };
  }
  try {
    await client.request("initialize", {
      clientInfo: { name: "telar", title: "Telar", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    client.notify("initialized");
    const models = parseCodexModels(await client.request("model/list", {}));
    return { models };
  } catch (error) {
    return { models: [], message: error instanceof Error ? error.message : "codex did not answer model/list" };
  } finally {
    client.kill();
  }
}

export async function readModelCatalogue(
  driver: ProviderDriverKind,
  now: () => number,
  readCodex: typeof readCodexModels = readCodexModels,
): Promise<ModelCatalogue> {
  if (driver === "claude") {
    return { driver, models: structuredClone(CLAUDE_BUILTIN), source: "builtin", readAt: now() };
  }
  const answer = await readCodex();
  // A provider that could not be asked falls back to NOTHING rather than to an
  // invented list — an empty picker that says why beats a picker full of ids
  // that 404.
  return {
    driver,
    models: answer.models,
    source: answer.models.length > 0 ? "provider" : "builtin",
    ...(answer.message ? { message: answer.message } : {}),
    readAt: now(),
  };
}

function dropUndefined(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = value;
  return out;
}
