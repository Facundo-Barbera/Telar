/**
 * THE PROVIDER'S LIST, AS ONE PERSON WANTS TO READ IT.
 *
 * APPLIED AFTER THE CACHE, NEVER INTO IT. `EngineStore.modelCatalogue` caches
 * the provider's own answer — a subprocess handshake — for five minutes, and
 * `force` is the only way past it. Baking a curated list into that cache would
 * mean either five minutes before a hide took effect, or spawning a
 * `codex app-server` in order to hide a row. So the cache keeps holding what the
 * harness said, and this runs on the clone that leaves it. There is, as a
 * consequence, no cache invalidation anywhere in this feature.
 *
 * APPLIED IN THE ENGINE RATHER THAN IN THE COCKPIT because the catalogue already
 * has four readers in the web app alone (the model picker, the reasoning menu,
 * the `/` command list, the title-writer's settings pane) and will have more
 * that are not browsers at all. One merge, one place, and every client sees the
 * same curated list without each learning the rules.
 */
import type { CustomProviderModel, ModelOverlay, ProviderModel } from "@telar/engine-client";
import { claudeSlugOf } from "./model-manifest";

/** The overlay fields that change a LIST. `favorites` is not here: it reorders a
 *  menu in the cockpit and never changes which rows exist. */
type ListOverlay = Pick<ModelOverlay, "hidden" | "order" | "custom" | "default">;

/**
 * The reader's default, when the list carries it. A provider-hidden row does not
 * qualify (the CLI refuses it), and neither does a hand-typed one: `isDefault`
 * is what runs when nobody chose, and a typed id is only as good as the person's
 * spelling. Anything else leaves Telar's own pick standing.
 */
export function chosenDefault(models: readonly ProviderModel[], chosen: string | undefined): ProviderModel | undefined {
  if (!chosen) return undefined;
  return models.find((model) => model.id === chosen && !model.hidden && model.source !== "user");
}

/**
 * Does the provider already cover this hand-typed id?
 *
 * MATCHED IN BOTH DIRECTIONS, which is `rowOf`'s rule in the cockpit: a
 * published row whose own id is this string, or a published ALIAS that resolves
 * to it. So when Claude Code starts publishing `claude-fable-5-1` — or starts
 * publishing `fable` resolving to it — the hand-typed entry stops being listed
 * and the real row wins, with its real label, its real efforts and its real
 * `isDefault`.
 */
function withoutWindowSuffix(id: string): string {
  return id.replace(/\[1m\]$/i, "");
}

/** The manifest's aliases fold too: a typed `claude-fable-5.1` is the
 *  published `claude-fable-5-1`. */
function canonical(id: string): string {
  return claudeSlugOf(id) ?? withoutWindowSuffix(id);
}

function published(models: readonly ProviderModel[], id: string): boolean {
  const requested = canonical(id);
  return models.some((model) => {
    const modelId = canonical(model.id);
    const resolves = model.resolves ? canonical(model.resolves) : undefined;
    return modelId === requested || resolves === requested;
  });
}

/**
 * A row for an id nobody published.
 *
 * Every field here is a decision about what NOT to claim on somebody's behalf.
 */
function customRow(entry: CustomProviderModel, models: readonly ProviderModel[]): ProviderModel {
  return {
    id: entry.id,
    /** No name is invented for a row nobody published — the id is the honest
     *  label, and it is also the string the person typed. */
    label: entry.label ?? entry.id,
    /** NEVER `true`. `isDefault` decides what runs when a session names no
     *  model, and a hand-typed id is the last string that should win that. */
    isDefault: false,
    /** The provider withdrew nothing — it has never heard of this row. */
    hidden: false,
    hiddenByUser: false,
    legacy: false,
    /**
     * THE UNION OF WHAT THIS DRIVER PUBLISHES, NOT THE EMPTY LIST.
     *
     * `[]` looks like the honest answer and is the one wrong one. The composer
     * reads `rowOf(models, id)?.efforts` for its reasoning menu, and `withModel`
     * DROPS any effort the target row does not list — so an empty list would
     * offer only Auto and would silently strip a level the reader had already
     * chosen, on the very row where they typed an id in order to push a new
     * model hard. The union offers every level this harness is known to take; a
     * level this particular model refuses fails at the provider, in the
     * provider's own words, which is the same deal a hand-typed id already makes
     * for the model NAME itself.
     */
    efforts: [...new Set(models.flatMap((model) => model.efforts))],
    /** NOT inherited. Fast mode is an inline Agent SDK setting that only some
     *  Claude rows support; claiming it for a row nobody published would ship
     *  the switch-that-does-nothing this cockpit keeps refusing. */
    fastMode: false,
    /** NO `resolves`. Inventing one would make `familyKey` fold this row into a
     *  family it may not belong to. Absent means the family key is the id, which
     *  is the only string anybody actually asserted. */
    source: "user",
  };
}

/**
 * The provider's rows, marked and extended and reordered as the reader asked.
 *
 * HIDING MARKS, IT DOES NOT DROP. The Models tab has to be able to show a hidden
 * row in order to offer un-hiding it, and a session already running one must
 * still be able to resolve its efforts and its context window. Which surface
 * filters, and which model it makes an exception for, is the cockpit's business
 * (see `visibleModels`) — this function's job is to say what is true.
 */
export function applyModelOverlay(models: readonly ProviderModel[], overlay: ListOverlay): ProviderModel[] {
  const hidden = new Set(overlay.hidden);
  const chosen = chosenDefault(models, overlay.default);
  const marked: ProviderModel[] = models.map((model) => ({
    ...model,
    hiddenByUser: hidden.has(model.id),
    ...(chosen ? { isDefault: model.id === chosen.id } : {}),
  }));

  for (const entry of overlay.custom) {
    if (published(models, entry.id)) continue;
    marked.push({ ...customRow(entry, models), hiddenByUser: hidden.has(entry.id) });
  }

  /**
   * A PARTIAL ORDER. Ids the reader named lead, in the sequence they named them;
   * everything else follows in the provider's own order, which is what puts a
   * model the provider shipped this morning where the provider wanted it rather
   * than last. An id here for a model that has since been withdrawn is skipped
   * rather than thrown over — a stale entry in a preference is not an error.
   */
  const ranked: ProviderModel[] = [];
  const placed = new Set<string>();
  for (const id of overlay.order) {
    const row = marked.find((model) => model.id === id);
    if (row && !placed.has(row.id)) {
      ranked.push(row);
      placed.add(row.id);
    }
  }
  for (const row of marked) if (!placed.has(row.id)) ranked.push(row);
  return ranked;
}
