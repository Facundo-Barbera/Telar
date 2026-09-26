import { execFile } from "node:child_process";
import { promisify } from "node:util";
/**
 * WHICH MODELS A PROVIDER ACTUALLY HAS — asked, not assumed. BOTH providers.
 *
 * The cockpit shipped a hand-written catalogue and it was wrong almost
 * immediately: it offered Codex a `gpt-5.5-codex` that does not exist, and
 * defaulted to `gpt-5.5` when the installed harness defaults to something two
 * generations newer. Every id in such a list is a guess whose failure mode is a
 * 404 at the provider, discovered by a person mid-turn.
 *
 * CODEX ANSWERS `model/list`. Ids, display names, which one is default, which
 * are hidden, and the reasoning levels EACH model supports — a per-model fact
 * the previous per-provider guess could not express at all.
 *
 * CLAUDE ANSWERS `supportedModels()`, and this module used to say it could not.
 * The claim was that the Agent SDK offers it "only on a live `query()`, which
 * means spawning a session and paying for it to populate a menu". Half right: it
 * is on the query object, but it is served from the INITIALIZE HANDSHAKE, not
 * from a turn. A streaming-input query whose prompt generator never yields
 * brings the CLI up, answers in about a second, and is aborted — no turn, no
 * tokens. The hand-written list it replaces was wrong about nearly everything it
 * asserted: it omitted Fable 5 entirely, offered `claude-opus-4-8` (which this
 * install does not have), used wire ids where the provider offers aliases, and
 * claimed three effort levels for Haiku 4.5, which supports none — a selection
 * that would have failed the turn.
 *
 * SPAWNING A SUBPROCESS TO FILL A MENU IS EXPENSIVE, so both reads are cached,
 * and the cache is what makes them acceptable to call from a popover.
 */
import type { Effort, ModelCatalogue, ProviderDriverKind, ProviderModel } from "@telar/engine-client";
import { refuseCliSpawnUnderTest, requireCli, resolveCliAsync } from "./cli-resolution";
import { CodexAppServer, resolveCodexBinary } from "./codex/app-server";

/**
 * How long to wait for a provider to describe itself.
 *
 * The measured answer is ~1s. Ten is generous enough for a cold CLI start and
 * short enough that a wedged provider — not signed in, waiting on something a
 * daemon cannot see — leaves a menu that says why rather than a spinner that
 * never resolves.
 */
const MODEL_LIST_TIMEOUT_MS = 10_000;

/** The five levels the Agent SDK's own type allows. Anything else a future
 *  build reports is dropped rather than passed through: an effort the harness
 *  does not know fails the turn it is sent on. */
const CLAUDE_EFFORTS = new Set<string>(["low", "medium", "high", "xhigh", "max"]);

/**
 * The provider prices its own rows and this cockpit does not report prices.
 *
 * Descriptions arrive as ` · `-joined clauses ending in the rate — "Opus 5 with
 * 1M context · Best for everyday, complex tasks · $5/$25 per Mtok". Tokens are
 * the unit here (see the usage surface for why money left this app), so the rate
 * clause is dropped at the seam rather than filtered by three surfaces.
 */
export function stripPricing(description: string): string {
  return description
    .split(" · ")
    .filter((clause) => !/\$\s*\d/.test(clause))
    .join(" · ")
    .trim();
}

/** One row of the Agent SDK's `ModelInfo`, narrowed to what a picker needs. */
type ClaudeModelInfo = {
  value?: unknown;
  resolvedModel?: unknown;
  displayName?: unknown;
  description?: unknown;
  supportedEffortLevels?: unknown;
  supportsFastMode?: unknown;
};

/**
 * The control methods this module needs, on the object `query()` returns.
 * `setModel` and `getSettings` are optional because an older SDK lacks the
 * second, and the model list must not depend on it.
 */
type ClaudeModelQuery = {
  supportedModels(): Promise<unknown>;
  setModel?(model?: string): Promise<void>;
  getSettings?(): Promise<unknown>;
};
export type ClaudeModelSdk = {
  query(input: { prompt: AsyncIterable<never>; options: Record<string, unknown> }): ClaudeModelQuery;
};

/**
 * `supportedModels()`'s rows, narrowed and corrected.
 *
 * THE `default` ROW IS FOLDED INTO THE MODEL IT RESOLVES TO. Claude Code offers
 * "Default (recommended)" as a row of its own, resolving to `claude-opus-5-5[1m]`
 * — and `opus[1m]` in the same list resolves to exactly that. Showing both is
 * the duplicate a reader has to work out for themselves. So the alias row is
 * dropped and its sibling is marked `isDefault`, which is what "default should
 * not be an option, it should be the default" means in practice: the picker
 * opens on Opus and never asks you to choose the word "default".
 *
 * If nothing matches what `default` resolves to, the row STAYS — losing the
 * default entirely would be worse than showing it under its own name.
 */
export function parseClaudeModels(payload: unknown): ProviderModel[] {
  if (!Array.isArray(payload)) return [];
  const rows = payload as ClaudeModelInfo[];
  const defaultRow = rows.find((row) => row.value === "default");
  const resolvesTo = typeof defaultRow?.resolvedModel === "string" ? defaultRow.resolvedModel : undefined;
  // Only fold the alias away if some other row genuinely covers it.
  const covered = resolvesTo !== undefined && rows.some((row) => row.value !== "default" && row.resolvedModel === resolvesTo);

  return rows.flatMap((row) => {
    const id = typeof row.value === "string" ? row.value : "";
    if (!id) return [];
    if (id === "default" && covered) return [];
    const description = typeof row.description === "string" ? stripPricing(row.description) : "";
    const efforts = Array.isArray(row.supportedEffortLevels)
      ? row.supportedEffortLevels.filter((level): level is Effort => typeof level === "string" && CLAUDE_EFFORTS.has(level))
      : [];
    return [
      {
        id,
        label: typeof row.displayName === "string" && row.displayName ? row.displayName : id,
        ...(description ? { description } : {}),
        isDefault: id === "default" || (covered && row.resolvedModel === resolvesTo),
        // Claude Code publishes nothing it means to hide; the split into current
        // and previous generations is the cockpit's own (see the client's
        // version rule), and it has no `hidden` to honour here.
        hidden: false,
        // A row straight off the provider carries no reader's opinion yet — the
        // overlay is what sets this, downstream of here (./model-overlay.ts).
        hiddenByUser: false,
        legacy: false,
        source: "provider",
        efforts,
        ...(typeof row.resolvedModel === "string" && row.resolvedModel ? { resolves: row.resolvedModel } : {}),
        fastMode: row.supportsFastMode === true,
      },
    ];
  });
}

/** `requireCli` throws its actionable sentence when there is no install; the
 *  model list wants a soft absence instead — the SDK then reports in its own
 *  words, which is what an empty catalogue's `message` carries to the picker. */
function defaultModelListExecutable(): string | undefined {
  try {
    return requireCli("claude", {});
  } catch {
    return undefined;
  }
}

/**
 * Ask the installed Claude Code what it can run.
 *
 * A STREAMING-INPUT QUERY THAT NEVER SPEAKS. The prompt is an async generator
 * that parks until the abort fires, which puts the SDK in streaming-input mode:
 * the CLI starts, completes `initialize`, and answers control requests — while
 * no user message is ever sent, so no turn begins and nothing is billed. The
 * abort in `finally` is what stops the process; without it the parked generator
 * would keep it alive for the life of the daemon.
 */
/**
 * The SDK, behind the test gate — issue #532. Named and exported rather than
 * inlined as a default argument so the gate is something a test can hold this
 * module to directly, instead of inferring it from an empty catalogue that a
 * machine with no install produces too.
 */
export async function loadClaudeModelSdk(): Promise<ClaudeModelSdk> {
  refuseCliSpawnUnderTest("the Claude Agent SDK model probe");
  return (await import("@anthropic-ai/claude-agent-sdk")) as unknown as ClaudeModelSdk;
}

/** The installed Claude Code's `--version`, which the model manifest's
 *  `minVersion` is checked against. Soft, and refused under test like every
 *  other spawn: no version means no row is hidden for being too new. */
async function installedClaudeVersion(): Promise<string | undefined> {
  try {
    refuseCliSpawnUnderTest("claude --version");
    return (await resolveCliAsync("claude")).version;
  } catch {
    return undefined;
  }
}

export async function readClaudeModels(
  loadSdk: () => Promise<ClaudeModelSdk> = loadClaudeModelSdk,
  timeoutMs = MODEL_LIST_TIMEOUT_MS,
  resolveExecutable: () => string | undefined = defaultModelListExecutable,
  readVersion: () => Promise<string | undefined> = installedClaudeVersion,
): Promise<{ models: ProviderModel[]; message?: string; cliVersion?: string }> {
  let sdk: ClaudeModelSdk;
  try {
    sdk = await loadSdk();
  } catch (error) {
    return { models: [], message: error instanceof Error ? error.message : "the Claude Agent SDK is not available" };
  }
  const controller = new AbortController();
  async function* silent(): AsyncGenerator<never> {
    await new Promise<void>((resolve) => controller.signal.addEventListener("abort", () => resolve(), { once: true }));
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    /**
     * THE USER'S OWN CLAUDE, EXACTLY AS A TURN RESOLVES IT. Without
     * `pathToClaudeCodeExecutable` the SDK falls back to its own optional
     * ~272MB platform package — present in a dev checkout, EXCLUDED from the
     * packaged app — so the handshake failed there with "Native CLI binary not
     * found", the picker went empty, and the app read as "not detecting Claude
     * Code" while turns (which do pass the path) worked fine. Resolution is
     * soft: with no install the SDK's own lookup and its own sentence stand.
     */
    const executable = resolveExecutable();
    const session = sdk.query({
      prompt: silent(),
      options: {
        cwd: process.cwd(),
        permissionMode: "default",
        abortController: controller,
        /**
         * NO TRANSCRIPT FOR A HANDSHAKE — issue #532. A query that never sends
         * a message still opens a session, and an opened session is ~250 KB
         * written under `~/.claude/projects/<slug-of-cwd>/` and kept forever.
         * This probe exists to fill a menu; there is nothing here anybody would
         * ever resume.
         */
        persistSession: false,
        ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
      },
    });
    /**
     * A DEADLINE, because this is a subprocess handshake reached from a menu.
     * `claude` waiting on a login it cannot complete without a human is a real
     * state, and it must cost the reader a sentence rather than the popover.
     */
    const models = await Promise.race([
      session.supportedModels(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("claude did not answer with its models in time")), timeoutMs);
      }),
    ]);
    const rows = await withClaudeDefaultEfforts(session, parseClaudeModels(models), timeoutMs);
    // Cached by `cli-resolution` per binary, so this is one spawn per update.
    const cliVersion = await readVersion();
    return { models: rows, ...(cliVersion ? { cliVersion } : {}) };
  } catch (error) {
    return { models: [], message: error instanceof Error ? error.message : "claude did not answer with its models" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}

/**
 * THE EFFORT EACH MODEL RUNS AT WHEN NONE IS PASSED, as the CLI itself resolves
 * it — so the reasoning pill can name a level instead of saying "Auto".
 *
 * `supportedModels()` carries no default, and it is not one fixed number: the
 * CLI resolves it per model from the user's settings (`effortLevel`,
 * `modelSettings`), `CLAUDE_CODE_EFFORT_LEVEL`, organisation caps and what the
 * model supports. Rather than re-implement that, this asks the same handshake
 * for each model in turn: `setModel`, then `getSettings().applied.effort`, which
 * the SDK documents as the effort the session will send on its next request.
 * Turns load the same settings sources, so it is the level a turn runs at.
 *
 * BEST EFFORT, INSIDE THE SAME DEADLINE. A model the CLI will not switch to, an
 * SDK without `getSettings`, or a `null` answer leaves that row without a
 * default, and the pill says "Auto" — never a guessed level.
 */
async function withClaudeDefaultEfforts(session: ClaudeModelQuery, rows: ProviderModel[], timeoutMs: number): Promise<ProviderModel[]> {
  if (!session.setModel || !session.getSettings) return rows;
  const deadline = Date.now() + timeoutMs;
  const out: ProviderModel[] = [];
  for (const row of rows) {
    const left = deadline - Date.now();
    if (row.efforts.length === 0 || left <= 0) {
      out.push(row);
      continue;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const settings = await Promise.race([
        session.setModel(row.id).then(() => session.getSettings!()),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), left);
        }),
      ]);
      const effort = (settings as { applied?: { effort?: unknown } } | undefined)?.applied?.effort;
      out.push(typeof effort === "string" && CLAUDE_EFFORTS.has(effort) ? { ...row, defaultEffort: effort } : row);
    } catch {
      out.push(row);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  return out;
}

/**
 * The service tiers a Codex row is sold at — `serviceTiers` and
 * `defaultServiceTier` on `model/list`. A tier needs an id and a name to be
 * offered; the list is omitted when there is nothing to choose.
 */
function codexServiceTiers(row: Record<string, unknown>): Pick<ProviderModel, "serviceTiers" | "defaultServiceTier"> {
  const tiers = Array.isArray(row.serviceTiers)
    ? row.serviceTiers.flatMap((entry) => {
        const tier = entry as { id?: unknown; name?: unknown; description?: unknown };
        if (typeof tier?.id !== "string" || !tier.id || typeof tier.name !== "string" || !tier.name) return [];
        return [{ id: tier.id, name: tier.name, ...(typeof tier.description === "string" && tier.description ? { description: tier.description } : {}) }];
      })
    : [];
  return {
    ...(tiers.length > 0 ? { serviceTiers: tiers } : {}),
    ...(typeof row.defaultServiceTier === "string" && row.defaultServiceTier ? { defaultServiceTier: row.defaultServiceTier } : {}),
  };
}

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
        // As in the Claude parser: the reader's own hide arrives later, from the
        // overlay, and must never be confused with the provider's `hidden`.
        hiddenByUser: false,
        legacy: false,
        source: "provider",
        efforts,
        ...(typeof row.defaultReasoningEffort === "string" && row.defaultReasoningEffort
          ? { defaultEffort: row.defaultReasoningEffort }
          : {}),
        ...codexServiceTiers(row),
        // Codex has no fast mode. Reported as false rather than omitted so the
        // field means the same thing on both providers: "this model does not
        // offer it", not "nobody said".
        fastMode: false,
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

export async function readOpenCodeModels(): Promise<{ models: ProviderModel[]; message?: string }> {
  try {
    const executable = requireCli("opencode");
    const { stdout } = await promisify(execFile)(executable, ["models"], { timeout: MODEL_LIST_TIMEOUT_MS, maxBuffer: 2_000_000 });
    const ids = [...new Set(stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^[A-Za-z0-9_.-]+\/\S+$/.test(line)))];
    return { models: ids.map((id) => ({ id, label: id, efforts: [], isDefault: false, hidden: false, fastMode: false, hiddenByUser: false, legacy: false, source: "provider" as const })) };
  } catch (error) { return { models: [], message: error instanceof Error ? error.message : "OpenCode did not answer models" }; }
}

export async function readModelCatalogue(
  driver: ProviderDriverKind,
  now: () => number,
  readCodex: typeof readCodexModels = readCodexModels,
  readClaude: typeof readClaudeModels = readClaudeModels,
): Promise<ModelCatalogue> {
  const answer: { models: ProviderModel[]; message?: string; cliVersion?: string } =
    driver === "claude"
      ? await readClaude()
      : driver === "opencode"
        ? await readOpenCodeModels()
        : await readCodex();
  /**
   * A PROVIDER THAT COULD NOT BE ASKED FALLS BACK TO NOTHING — for both, now.
   *
   * There is no hand-written list left to fall back to, and that is deliberate:
   * an empty picker carrying the provider's own error beats a picker full of ids
   * that 404. `source` stays in the contract because it is the honest label for
   * the difference, and it is now `provider` whenever there is anything to show.
   */
  return {
    driver,
    models: answer.models,
    source: answer.models.length > 0 ? "provider" : "builtin",
    ...(answer.message ? { message: answer.message } : {}),
    ...(answer.cliVersion ? { cliVersion: answer.cliVersion } : {}),
    readAt: now(),
  };
}

function dropUndefined(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = value;
  return out;
}
