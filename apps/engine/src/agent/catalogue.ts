/**
 * WHAT OPENCODE GO SERVES, DESCRIBED — ids from Go, words from models.dev, and
 * the route each one answers on (#551).
 *
 * ── THE PROBLEM THIS SOLVES ─────────────────────────────────────────────────
 * `GET https://opencode.ai/zen/go/v1/models` answers 38 ids and nothing else:
 * `{ id, object, created, owned_by }`. Go is not withholding models — the docs
 * table lists the same set — but a picker built on that answer is a flat list
 * of raw strings in arbitrary order, with no names, no families and nothing to
 * search. Everything a reader needs in order to CHOOSE is missing.
 *
 * So three sources are merged here, and each is the authority on exactly one
 * question:
 *
 *   GO'S `/models`   which ids exist. Live, every read, never cached: it is a
 *                    3 KB call and it is the only source that can say a model
 *                    was withdrawn this morning.
 *   models.dev       what each one IS — display name, release date, context and
 *                    output limits, reasoning, tool calls, attachments. Fetched
 *                    at most once a day and cached, because `api.json` is 4.6 MB
 *                    of every provider on earth and none of it changes hourly.
 *                    The opencode CLI reads the same file for the same purpose.
 *   THE TABLE BELOW  which ENDPOINT an id answers on. Transcribed by hand from
 *                    opencode.ai/docs/go, because nothing serves it.
 *
 * ── WHY THE ROUTE IS THE LOAD-BEARING FIELD ─────────────────────────────────
 * Telar's Agent talks to Go through `@langchain/openai`, which speaks
 * `POST /chat/completions` and only that. Go publishes three shapes:
 * chat/completions, an Anthropic-shaped `/messages`, and OpenAI's `/responses`.
 * A model on `/responses` cannot be reached by this client at all; the
 * `/messages` ones reach it through Go's own translation and then reject fields
 * the OpenAI shape carries (#549). Either way the picker has to SAY SO, because
 * the alternative is a person choosing a name they recognise and finding out
 * from a 400 halfway through a turn.
 *
 * ── FAIL-SOFT, IN TWO INDEPENDENT HALVES ────────────────────────────────────
 * models.dev failing costs the descriptions and nothing else: the ids still
 * list, marked `described: false`, and the routes still come from the table,
 * which is code. Go failing costs the whole list, and the answer carries Go's
 * own words rather than a guess — `readOpenCodeGoModels`' rule, unchanged.
 */
import fs from "node:fs";
import path from "node:path";
import { atomicWrite } from "../atomic";
import { DEFAULT_GO_MODEL, readOpenCodeGoModels } from "./go";

/**
 * THE THREE SHAPES GO SERVES, plus the honest fourth.
 *
 * `unknown` is an id Go serves that the table below has never heard of — which
 * happens the day Go adds a model and before anybody updates this file. It is
 * NOT a fourth endpoint; it is this build admitting it does not know.
 */
export type GoRoute = "chat" | "messages" | "responses" | "unknown";

/** One model, as a picker needs it. */
export type AgentModel = {
  /** The string that goes on the wire. Go's own id, untouched. */
  id: string;
  /** What to call it. models.dev's display name, or the id when nobody said. */
  name: string;
  /**
   * WHICH FAMILY IT BELONGS TO, FOR GROUPING — "GLM", "Kimi", "DeepSeek".
   *
   * DERIVED HERE RATHER THAN TAKEN FROM models.dev, whose own `family` field
   * cannot group: it files `qwen3.7-max`, `qwen3.7-plus` and `qwen3.8-max` as
   * three separate families while calling `qwen3.8-flash` plain `qwen`, spells
   * Hy's as `Hy` and leaves `omen-alpha` without one at all. Grouping a picker
   * by that produces twenty sections of one row, which is the flat list again
   * with headings on it. See `FAMILIES`.
   */
  family: string;
  route: GoRoute;
  /**
   * Whether THIS CLIENT can actually run it — see the header. `chat` yes,
   * `messages` and `responses` no.
   *
   * `unknown` IS SUPPORTED, and that is the deliberate half of this field. A
   * model Go added yesterday would otherwise be greyed out until somebody
   * transcribed a docs row, and locking a person out of a model that probably
   * works is worse than letting them try one that might 400 — Go's base is
   * OpenAI-compatible, so chat/completions is the right guess. `goRouteGaps`
   * and its test exist so this state is rare and loud rather than permanent.
   */
  supported: boolean;
  /** Whether models.dev had anything to say. False leaves every field below
   *  absent, and the row still lists — an id you can run is worth showing
   *  whether or not a third party has described it. */
  described: boolean;
  reasoning?: boolean;
  toolCall?: boolean;
  attachment?: boolean;
  /** Tokens in, tokens out. Absent rather than zero when undescribed. */
  context?: number;
  output?: number;
  /** `YYYY-MM-DD`, models.dev's own. What "newest first" is sorted on. */
  releaseDate?: string;
};

export type AgentModelCatalogue = {
  models: AgentModel[];
  /**
   * WHEN EACH HALF WAS READ. `go: null` means Go did not answer, which is the
   * only way `models` is empty; `modelsDev: null` means the descriptions are
   * missing and every row is `described: false`. A surface that wants to say
   * "names unavailable" reads this rather than inferring it from a row.
   */
  source: { go: number | null; modelsDev: number | null };
  /** The service's own words when a half failed. Never invented. */
  message?: string;
};

/**
 * ── THE ROUTE TABLE, TRANSCRIBED FROM opencode.ai/docs/go ────────────────────
 *
 * IT IS CODE, NOT DATA, and that is the point. There is no endpoint that serves
 * this mapping; it exists in one HTML table on one docs page. A JSON file
 * fetched at runtime would be a second network dependency for a fact that
 * changes when a human publishes a docs edit, and a file in `<engineRoot>` would
 * be a cache nobody could review. In a source file it goes through a diff.
 *
 * The docs table's "Endpoint" column, verbatim, on 2026-09-16:
 *   …/v1/chat/completions  →  "chat"
 *   …/v1/messages          →  "messages"   (@ai-sdk/anthropic)
 *   …/v1/responses         →  "responses"  (@ai-sdk/openai)
 */
const DOCUMENTED_ROUTES: Record<string, GoRoute> = {
  "grok-4.6": "responses",
  "gpt-5.6-luna": "responses",
  "glm-5.3-flash": "chat",
  "glm-5.3": "chat",
  "glm-5.2": "chat",
  "glm-5.1": "chat",
  "kimi-k3": "chat",
  "kimi-k2.7-code": "chat",
  "kimi-k2.6": "chat",
  "longcat-2.0": "chat",
  "deepseek-v4.1-flash": "chat",
  "deepseek-v4-pro": "chat",
  "deepseek-v4-flash": "chat",
  "deepseek-v4-flash-vision-exp": "chat",
  "mimo-v2.5": "chat",
  "mimo-v2.5-pro": "chat",
  "minimax-m3": "messages",
  "minimax-m2.7": "messages",
  "minimax-m2.5": "messages",
  "muse-spark-1.3-contributor": "responses",
  "muse-spark-1.2-contributor": "responses",
  "qwen3.8-max": "messages",
  "qwen3.8-flash": "messages",
  "qwen3.7-max": "messages",
  "qwen3.7-plus": "messages",
  "qwen3.6-plus": "messages",
  "hy4-preview": "chat",
  hy3: "chat",
  "union-alpha": "messages",
};

/**
 * ── THE NINE GO SERVES AND THE DOCS TABLE DOES NOT ──────────────────────────
 *
 * Go's `/models` answers 38 ids; the docs table maps 29. The other nine are
 * older or newer siblings of models that ARE in the table, and their route is
 * read off the family rather than off a row nobody published:
 *
 *   kimi-k2.5, glm-5, deepseek-flash, mimo-v2-pro, mimo-v2-omni, hy3-preview
 *       → chat. Every documented GLM, Kimi, DeepSeek, MiMo and Hy is chat.
 *   qwen3.5-plus, omen-alpha
 *       → messages. Every documented Qwen is Anthropic-shaped, and #551 names
 *         omen-alpha with the `/messages` set.
 *   grok-4.5
 *       → responses. Grok 4.6 is, and they are one model a version apart.
 *
 * KEPT SEPARATE FROM THE TRANSCRIPTION ABOVE so a reader can tell what was read
 * off a published table from what was inferred from its neighbours. When the
 * docs grow a row for one of these, it moves up rather than being edited here.
 */
const INFERRED_ROUTES: Record<string, GoRoute> = {
  "kimi-k2.5": "chat",
  "glm-5": "chat",
  "deepseek-flash": "chat",
  "mimo-v2-pro": "chat",
  "mimo-v2-omni": "chat",
  "hy3-preview": "chat",
  "qwen3.5-plus": "messages",
  "omen-alpha": "messages",
  "grok-4.5": "responses",
};

/** Every id this build can place, documented or inferred. */
export const GO_ROUTES: Record<string, GoRoute> = { ...DOCUMENTED_ROUTES, ...INFERRED_ROUTES };

/** Which endpoint an id answers on, or `unknown` when this build has not been
 *  told. */
export function goRouteOf(id: string): GoRoute {
  return GO_ROUTES[id] ?? "unknown";
}

/**
 * THE IDS GO SERVES THAT THE TABLE LACKS.
 *
 * The whole reason the table is code: `catalogue.test.ts` runs this over the
 * recorded live list and fails on a non-empty answer, so the day Go adds a
 * model the suite says which one and the table gets a row. Exported rather than
 * inlined into the test so the live smoke can ask the real endpoint the same
 * question.
 */
export function goRouteGaps(ids: readonly string[]): string[] {
  return ids.filter((id) => !(id in GO_ROUTES));
}

/**
 * Whether this build's Agent client can run a model on that route.
 *
 * ONE FUNCTION, because "what Telar speaks" is a single fact and three surfaces
 * ask it. When `go.ts` learns `/responses`, this is the line that changes.
 */
export function routeSupported(route: GoRoute): boolean {
  return route === "chat" || route === "unknown";
}

/**
 * WHY A ROUTE CANNOT BE RUN, in the words the picker shows. `undefined` for the
 * two that can.
 */
export function routeObstacle(route: GoRoute): string | undefined {
  if (route === "messages") {
    return "Anthropic-shaped — Telar's Agent sends chat/completions, which this route rejects.";
  }
  if (route === "responses") {
    return "OpenAI Responses — Telar's Agent cannot form that request yet.";
  }
  return undefined;
}

/**
 * ── FAMILIES, BY ID PREFIX ───────────────────────────────────────────────────
 *
 * Longest prefix wins, so `mimo-v2.5-pro` and `mimo-v2` land together and
 * `qwen3.8-flash` does not become its own section. An id matching nothing keeps
 * its own leading word, which is what a brand-new vendor would want anyway.
 */
const FAMILIES: [prefix: string, label: string][] = [
  ["glm", "GLM"],
  ["kimi", "Kimi"],
  ["deepseek", "DeepSeek"],
  ["longcat", "LongCat"],
  ["mimo", "MiMo"],
  ["minimax", "MiniMax"],
  ["qwen", "Qwen"],
  ["hy", "Hy"],
  ["grok", "Grok"],
  ["gpt", "GPT"],
  ["muse", "Muse Spark"],
  ["union", "Union"],
  ["omen", "Omen"],
  ["ox", "Ox"],
];

export function familyOf(id: string): string {
  const lower = id.toLowerCase();
  for (const [prefix, label] of FAMILIES) if (lower.startsWith(prefix)) return label;
  // The leading word, minus any version digits glued to it: `foo3.1-bar` → `foo`.
  const head = lower.split(/[-_]/)[0]?.replace(/[\d.]+$/, "") ?? lower;
  return head ? head.charAt(0).toUpperCase() + head.slice(1) : id;
}

/**
 * WHAT RUNS WHEN NOBODY HAS PICKED — `DEFAULT_GO_MODEL`, checked against the
 * list rather than asserted (#551).
 *
 * `go.ts` names `kimi-k3` and that is still the answer: it is on
 * chat/completions, it is current, and it is what every existing conversation
 * has been running. What changes is that the name is now CHECKED. If Go stops
 * serving it, or it moves to a route this client cannot speak, the default
 * becomes the first supported model in the catalogue's own order — which is
 * newest-first, so it lands on something current rather than something
 * alphabetical.
 *
 * AN EMPTY OR UNREADABLE CATALOGUE STILL ANSWERS `DEFAULT_GO_MODEL`. A turn
 * has to name a model, and a Go that did not answer its model list is not
 * evidence that the model a conversation has been running has gone away.
 */
export function defaultAgentModel(models: readonly Pick<AgentModel, "id" | "supported">[]): string {
  const named = models.find((model) => model.id === DEFAULT_GO_MODEL);
  if (!named || named.supported) return DEFAULT_GO_MODEL;
  return models.find((model) => model.supported)?.id ?? DEFAULT_GO_MODEL;
}

/** What models.dev says about one model, narrowed to what a picker uses. */
export type ModelsDevEntry = {
  name?: string;
  reasoning?: boolean;
  toolCall?: boolean;
  attachment?: boolean;
  context?: number;
  output?: number;
  releaseDate?: string;
};

/** The cache document. Versioned so a shape change can be discarded rather than
 *  half-read. */
type CatalogueCache = { version: number; fetchedAt: number; entries: Record<string, ModelsDevEntry> };

const CACHE_VERSION = 1;

/** models.dev is a third party's 4.6 MB file, and the picker must not hang on
 *  it — the descriptions are a nicety and the ids are the answer. */
const MODELS_DEV_TIMEOUT_MS = 15_000;

/** ONCE A DAY. Release dates and context limits move on the scale of weeks;
 *  a per-open fetch would be megabytes for a field that changed last month. */
export const CATALOGUE_TTL_MS = 24 * 60 * 60 * 1000;

export const MODELS_DEV_URL = "https://models.dev/api.json";

/** Where the cached descriptions live. `agentPaths` does not own this one
 *  because it is a CACHE, not state: deleting it costs a refetch and nothing
 *  else, which is not true of anything else in that directory. */
export function catalogueCacheFile(agentDir: string): string {
  return path.join(agentDir, "catalogue.json");
}

/**
 * models.dev's `["opencode-go"].models`, narrowed.
 *
 * TOLERANT OF EVERY FIELD, because this is somebody else's document and a
 * missing `limit` must cost one number rather than the whole read. Anything
 * that is not the type it should be is simply left out, and the row lists with
 * the fields that did parse.
 */
export function parseModelsDev(payload: unknown): Record<string, ModelsDevEntry> {
  const provider = (payload as { "opencode-go"?: { models?: unknown } } | null)?.["opencode-go"];
  const models = provider?.models;
  if (typeof models !== "object" || models === null) return {};
  const out: Record<string, ModelsDevEntry> = {};
  for (const [id, value] of Object.entries(models as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const row = value as Record<string, unknown>;
    const limit = (typeof row.limit === "object" && row.limit !== null ? row.limit : {}) as Record<string, unknown>;
    const entry: ModelsDevEntry = {
      ...(typeof row.name === "string" && row.name.trim() ? { name: row.name.trim() } : {}),
      ...(typeof row.reasoning === "boolean" ? { reasoning: row.reasoning } : {}),
      ...(typeof row.tool_call === "boolean" ? { toolCall: row.tool_call } : {}),
      ...(typeof row.attachment === "boolean" ? { attachment: row.attachment } : {}),
      ...(typeof limit.context === "number" ? { context: limit.context } : {}),
      ...(typeof limit.output === "number" ? { output: limit.output } : {}),
      ...(typeof row.release_date === "string" && row.release_date.trim() ? { releaseDate: row.release_date.trim() } : {}),
    };
    out[id] = entry;
  }
  return out;
}

/** The cache, or nothing. A file that will not parse is nothing — it is a
 *  cache, and re-fetching is cheaper than reasoning about a half-read one. */
function readCache(agentDir: string): CatalogueCache | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(catalogueCacheFile(agentDir), "utf8")) as Partial<CatalogueCache>;
    if (parsed.version !== CACHE_VERSION) return undefined;
    if (typeof parsed.fetchedAt !== "number" || typeof parsed.entries !== "object" || parsed.entries === null) return undefined;
    return { version: CACHE_VERSION, fetchedAt: parsed.fetchedAt, entries: parsed.entries };
  } catch {
    return undefined;
  }
}

/**
 * The descriptions, from the cache when it is fresh and from models.dev when it
 * is not.
 *
 * A STALE CACHE BEATS NO CACHE. When the fetch fails and a day-old file is
 * sitting there, the old descriptions are served and `modelsDev` carries their
 * ORIGINAL timestamp — a reader can see the answer is from yesterday, which is
 * a different and far better state than every name reverting to a raw id
 * because a third party had a bad minute.
 */
export async function readModelsDev(input: {
  agentDir?: string;
  now?: () => number;
  fetchImpl?: typeof fetch;
  url?: string;
}): Promise<{ entries: Record<string, ModelsDevEntry>; fetchedAt: number | null; message?: string }> {
  const now = input.now ?? Date.now;
  const cached = input.agentDir ? readCache(input.agentDir) : undefined;
  if (cached && now() - cached.fetchedAt < CATALOGUE_TTL_MS) {
    return { entries: cached.entries, fetchedAt: cached.fetchedAt };
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(input.url ?? MODELS_DEV_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(MODELS_DEV_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`models.dev answered ${response.status}.`);
    const entries = parseModelsDev(await response.json());
    // An answer with nothing in it is not an answer — do not overwrite a good
    // cache with an empty one because the provider key was renamed.
    if (Object.keys(entries).length === 0) throw new Error("models.dev listed no OpenCode Go models.");
    const fetchedAt = now();
    if (input.agentDir) {
      try {
        atomicWrite(catalogueCacheFile(input.agentDir), { version: CACHE_VERSION, fetchedAt, entries } satisfies CatalogueCache);
      } catch {
        // An unwritable cache costs a refetch tomorrow, not this answer.
      }
    }
    return { entries, fetchedAt };
  } catch (error) {
    const message = error instanceof Error ? error.message : "models.dev did not answer.";
    if (cached) return { entries: cached.entries, fetchedAt: cached.fetchedAt, message };
    return { entries: {}, fetchedAt: null, message };
  }
}

/**
 * NEWEST FIRST, WITHIN A FAMILY AND BETWEEN THEM.
 *
 * SORTED HERE RATHER THAN IN EACH PICKER, so the phone and the desktop cannot
 * disagree about what "newest" means — and so a surface that only groups by
 * `family` gets the right order for free.
 *
 * A row with no release date sorts LAST inside its family and never decides its
 * family's position: an undescribed id is one models.dev has not got to, not
 * one from before the others.
 */
function orderModels(models: AgentModel[]): AgentModel[] {
  const newest = new Map<string, string>();
  for (const model of models) {
    if (!model.releaseDate) continue;
    const held = newest.get(model.family);
    if (!held || model.releaseDate > held) newest.set(model.family, model.releaseDate);
  }
  const order = new Map<string, number>();
  for (const [index, model] of models.entries()) if (!order.has(model.family)) order.set(model.family, index);
  return [...models].sort((left, right) => {
    if (left.family !== right.family) {
      const byDate = (newest.get(right.family) ?? "").localeCompare(newest.get(left.family) ?? "");
      // Two families nobody dated keep Go's own order rather than an alphabet
      // nobody asked for.
      return byDate !== 0 ? byDate : (order.get(left.family) ?? 0) - (order.get(right.family) ?? 0);
    }
    return (right.releaseDate ?? "").localeCompare(left.releaseDate ?? "");
  });
}

/** The merge itself, with no IO in it — which is what makes every case in
 *  `catalogue.test.ts` a plain function call. */
export function mergeCatalogue(ids: readonly string[], entries: Record<string, ModelsDevEntry>): AgentModel[] {
  return orderModels(
    ids.map((id) => {
      const described = entries[id];
      const route = goRouteOf(id);
      return {
        id,
        name: described?.name ?? id,
        family: familyOf(id),
        route,
        supported: routeSupported(route),
        described: described !== undefined,
        ...(described?.reasoning === undefined ? {} : { reasoning: described.reasoning }),
        ...(described?.toolCall === undefined ? {} : { toolCall: described.toolCall }),
        ...(described?.attachment === undefined ? {} : { attachment: described.attachment }),
        ...(described?.context === undefined ? {} : { context: described.context }),
        ...(described?.output === undefined ? {} : { output: described.output }),
        ...(described?.releaseDate === undefined ? {} : { releaseDate: described.releaseDate }),
      } satisfies AgentModel;
    }),
  );
}

/**
 * THE CATALOGUE `GET /v2/agent/models` ANSWERS.
 *
 * Both reads run TOGETHER, because they are independent services and asking
 * models.dev only after Go answered would add its latency to a picker that has
 * already waited once. A cached models.dev half resolves instantly anyway.
 */
export async function readAgentCatalogue(input: {
  agentDir?: string;
  now?: () => number;
  /** Injected by tests; `readOpenCodeGoModels`' own default is the real one. */
  readGo?: typeof readOpenCodeGoModels;
  fetchImpl?: typeof fetch;
  url?: string;
} = {}): Promise<AgentModelCatalogue> {
  const now = input.now ?? Date.now;
  const readGo = input.readGo ?? readOpenCodeGoModels;
  const [go, described] = await Promise.all([
    readGo(),
    readModelsDev({
      ...(input.agentDir ? { agentDir: input.agentDir } : {}),
      ...(input.now ? { now: input.now } : {}),
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      ...(input.url ? { url: input.url } : {}),
    }),
  ]);
  // GO'S FAILURE IS THE ONE WORTH SAYING OUT LOUD: with no ids there is no
  // picker. models.dev's costs the names, and the message rides along only when
  // there is nothing more important to report.
  const message = go.message ?? described.message;
  return {
    models: mergeCatalogue(go.models.map((model) => model.id), described.entries),
    source: { go: go.message ? null : now(), modelsDev: described.fetchedAt },
    ...(message ? { message } : {}),
  };
}
