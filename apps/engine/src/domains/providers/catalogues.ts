import { z } from "zod";
import {
  CustomProviderModel,
  DEFAULT_MODEL_OVERLAY,
  defaultInstanceIdForDriver,
  ModelCatalogue as ModelCatalogueSchema,
  ModelOverlay as ModelOverlaySchema,
  type ModelCatalogue,
  type ModelOverlay,
  type ModelSelection,
  type ProviderDriverKind,
} from "@telar/engine-client";
import { EngineStateError, STATE_VERSION, type Kernel } from "../../platform/kernel";
import { refuseCliSpawnUnderTest, resolveCliAsync } from "./cli";
import { applyModelManifest, longDefaultOf, type ModelManifest } from "./manifest";
import type { readModelCatalogue } from "./models";
import { applyModelOverlay, chosenDefault } from "./overlay";
import { assertInstanceId } from "./registry";

const MODEL_CACHE_MS = 5 * 60_000;
const MODEL_VERSION_CHECK_MS = 60_000;
// Loose on purpose: it refuses only what can't be an id (blank, overlong, whitespace, quotes, control characters).
const MODEL_ID = /^[^\s"'`\\]{1,200}$/;
const isModelId = (value: string): boolean => MODEL_ID.test(value) && ![...value].some((char) => char.charCodeAt(0) < 0x20);
const MAX_OVERLAY_IDS = 200;
const MAX_CUSTOM_MODELS = 64;

/** Which provider CLI is installed, and at which version. */
export type InstalledCli = { installed: boolean; version?: string };

/** The real version probe, cached per binary; under test it reads as "installed, version unknown". */
export async function installedCli(driver: ProviderDriverKind): Promise<InstalledCli> {
  try {
    refuseCliSpawnUnderTest(`${driver} --version`);
  } catch {
    return { installed: true };
  }
  try {
    const resolution = await resolveCliAsync(driver);
    return resolution.status === "missing" ? { installed: false } : { installed: true, ...(resolution.version ? { version: resolution.version } : {}) };
  } catch {
    return { installed: false };
  }
}

const StoredCatalogueSchema = z.object({ catalogue: ModelCatalogueSchema, cliVersion: z.string().min(1).optional() });
type StoredCatalogue = z.infer<typeof StoredCatalogueSchema>;

/** Deduped, first occurrence winning: a repeated favourite is a double-click, not a bad request. */
function readModelIds(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_OVERLAY_IDS) {
    throw new EngineStateError("invalid_request", `${field} must be an array of at most ${MAX_OVERLAY_IDS} model ids`);
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !isModelId(entry)) throw new EngineStateError("invalid_request", `${field} must contain only model ids`);
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

/** A duplicate id is refused: two labels for one id are two answers the engine can't choose between. */
function readCustomModels(value: unknown): CustomProviderModel[] {
  if (!Array.isArray(value) || value.length > MAX_CUSTOM_MODELS) {
    throw new EngineStateError("invalid_request", `custom must be an array of at most ${MAX_CUSTOM_MODELS} models`);
  }
  const out: CustomProviderModel[] = [];
  for (const entry of value) {
    const parsed = CustomProviderModel.safeParse(entry);
    if (!parsed.success || !isModelId(parsed.data.id)) {
      throw new EngineStateError("invalid_request", "each custom model needs a model id, and an optional label");
    }
    if (out.some((existing) => existing.id === parsed.data.id)) throw new EngineStateError("invalid_request", `${parsed.data.id} is listed twice`);
    out.push(parsed.data);
  }
  return out;
}

type CatalogueDeps = {
  readModels: typeof readModelCatalogue;
  cliVersion: (driver: ProviderDriverKind) => Promise<InstalledCli>;
  manifest: ModelManifest;
};

/**
 * Each provider's model list, stale-while-revalidate from `model-catalogues.json`; a failed read never
 * replaces a good answer, and refreshes run one at a time. Manifest and overlay apply per answer.
 */
export class ModelCatalogues {
  private cache: Map<ProviderDriverKind, StoredCatalogue> | undefined;
  private readonly failures = new Map<ProviderDriverKind, ModelCatalogue>();
  private readonly refreshes = new Map<ProviderDriverKind, Promise<ModelCatalogue>>();
  private refreshChain: Promise<unknown> = Promise.resolve();
  private readonly versionCheckedAt = new Map<ProviderDriverKind, number>();
  private readonly attemptedAt = new Map<ProviderDriverKind, number>();
  private claudePrepare: Promise<void> | undefined;
  private claudeFailedAt: number | undefined;
  // `""` means read, and absent.
  private claudeDefaultMemo: string | undefined;

  constructor(
    private readonly kernel: Kernel,
    private readonly deps: CatalogueDeps,
  ) {}

  get manifest(): ModelManifest {
    return this.deps.manifest;
  }

  async catalogue(driver: ProviderDriverKind, options: { force?: boolean; instanceId?: string } = {}): Promise<ModelCatalogue> {
    if (driver !== "claude" && driver !== "codex" && driver !== "opencode") throw new EngineStateError("invalid_request", "unknown provider driver");
    let raw: ModelCatalogue;
    const known = this.stored().get(driver);
    if (options.force) {
      raw = await this.refresh(driver);
    } else if (known) {
      raw = known.catalogue;
      const checkedAt = this.versionCheckedAt.get(driver);
      const attemptedAt = this.attemptedAt.get(driver);
      const retrying = attemptedAt !== undefined && this.kernel.now() - attemptedAt < MODEL_VERSION_CHECK_MS;
      if (this.kernel.now() - known.catalogue.readAt >= MODEL_CACHE_MS && !retrying) void this.refresh(driver).catch(() => undefined);
      else if (checkedAt === undefined || this.kernel.now() - checkedAt >= MODEL_VERSION_CHECK_MS) void this.revalidate(driver).catch(() => undefined);
    } else {
      const failed = this.failures.get(driver);
      raw = failed && this.kernel.now() - failed.readAt < MODEL_CACHE_MS ? failed : await this.refresh(driver);
    }
    raw = structuredClone(raw);
    if (this.refreshes.has(driver)) raw.refreshing = true;
    const instanceId = options.instanceId ?? defaultInstanceIdForDriver(driver);
    const listed = driver === "claude" ? applyModelManifest(raw.models, this.deps.manifest, raw.cliVersion) : raw.models;
    // From the provider's list, before the reader's curation.
    if (driver === "claude") this.rememberClaudeDefault(raw.models, raw.cliVersion);
    return { ...raw, instanceId, models: applyModelOverlay(listed, this.overlay(instanceId)) };
  }

  /** Reads each provider once soon after start, only where the stored answer is missing, old or from another CLI. */
  async prefetch(drivers: readonly ProviderDriverKind[] = ["claude", "codex", "opencode"]): Promise<void> {
    for (const driver of drivers) {
      try {
        await this.revalidate(driver);
      } catch {
        // One unreadable provider must not stop the next.
      }
    }
  }

  /** The cached rows for a driver, manifest applied; synchronous, so cold is `undefined`. */
  cachedRows(driver: ProviderDriverKind): ModelCatalogue["models"] | undefined {
    const cached = this.stored().get(driver)?.catalogue;
    if (!cached) return undefined;
    return driver === "claude" ? applyModelManifest(cached.models, this.deps.manifest, cached.cliVersion) : cached.models;
  }

  /** A malformed overlay document costs the curation, never the picker. */
  overlay(instanceId: string): ModelOverlay {
    assertInstanceId(instanceId);
    const empty = (): ModelOverlay => ({ instanceId, ...DEFAULT_MODEL_OVERLAY, updatedAt: 0 });
    try {
      const stored = this.kernel.readDocument(this.kernel.paths.modelOverlays) as { overlays?: unknown } | undefined;
      const parsed = ModelOverlaySchema.array().safeParse(stored?.overlays ?? []);
      if (!parsed.success) return empty();
      return parsed.data.find((entry) => entry.instanceId === instanceId) ?? empty();
    } catch {
      return empty();
    }
  }

  /** A submitted list replaces its list whole; `default: null` returns to Telar's own pick. */
  setOverlay(instanceId: string, patch: { favorites?: unknown; hidden?: unknown; order?: unknown; custom?: unknown; default?: unknown }): ModelOverlay {
    assertInstanceId(instanceId);
    const next: ModelOverlay = { ...this.overlay(instanceId), updatedAt: this.kernel.now() };
    for (const key of ["favorites", "hidden", "order"] as const) {
      if (patch[key] !== undefined) next[key] = readModelIds(patch[key], key);
    }
    if (patch.custom !== undefined) next.custom = readCustomModels(patch.custom);
    if (patch.default === null) delete next.default;
    else if (patch.default !== undefined) next.default = readModelIds([patch.default], "default")[0]!;
    let stored: ModelOverlay[];
    try {
      const raw = this.kernel.readDocument(this.kernel.paths.modelOverlays) as { overlays?: unknown } | undefined;
      const parsed = ModelOverlaySchema.array().safeParse(raw?.overlays ?? []);
      stored = parsed.success ? parsed.data : [];
    } catch {
      // An unparsable document is replaced by this write rather than blocking it.
      stored = [];
    }
    const overlays = [...stored.filter((entry) => entry.instanceId !== instanceId), next];
    this.kernel.writeDocument(this.kernel.paths.modelOverlays, { version: STATE_VERSION, overlays });
    return structuredClone(next);
  }

  /**
   * The default Claude row, synchronously or not at all: the reader's choice,
   * else the manifest's long default from the cached list, else the default
   * remembered on disk from the last list this machine read.
   */
  defaultClaudeModelId(instanceId: string = defaultInstanceIdForDriver("claude")): string | undefined {
    let chosen: string | undefined;
    try {
      chosen = this.overlay(instanceId).default;
    } catch {
      chosen = undefined;
    }
    const listed = this.cachedRows("claude");
    if (listed) return chosenDefault(listed, chosen)?.id ?? longDefaultOf(listed);
    return chosen ?? this.rememberedClaudeDefault();
  }

  /**
   * For a Claude turn that named no model: `ready` when a default is known,
   * `pending` (not claimable) until it is, `failed` while the last probe's failure is current.
   */
  claudeSelectionState(driver: ProviderDriverKind, selection: ModelSelection | undefined): "ready" | "pending" | "failed" {
    if (driver !== "claude" || selection?.model) return "ready";
    if (this.defaultClaudeModelId() !== undefined) return "ready";
    const failedFor = this.claudeFailedAt === undefined ? undefined : this.kernel.now() - this.claudeFailedAt;
    return failedFor !== undefined && failedFor < MODEL_CACHE_MS ? "failed" : "pending";
  }

  /** Learns the long-window default, one probe in flight; a probe that never answers is a bounded, retried failure. */
  async prepareClaude(timeoutMs = 2_000): Promise<void> {
    if (this.defaultClaudeModelId() !== undefined) return;
    if (this.claudeFailedAt !== undefined && this.kernel.now() - this.claudeFailedAt < MODEL_CACHE_MS) return;
    const unusable = (reason: string) => {
      this.claudeFailedAt = this.kernel.now();
      console.error(`[engine] no long-window Claude model could be resolved, so a session that named no model cannot run: ${reason}`);
    };
    this.claudePrepare ??= this.catalogue("claude").then(
      () => {
        if (this.defaultClaudeModelId() !== undefined) this.claudeFailedAt = undefined;
        else unusable("the provider listed no long-window model");
      },
      (error) => unusable(error instanceof Error ? error.message : String(error)),
    );
    const probe = this.claudePrepare;
    void probe.finally(() => {
      if (this.claudePrepare === probe) this.claudePrepare = undefined;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    await Promise.race([
      probe,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
    if (timedOut && this.defaultClaudeModelId() === undefined) unusable(`the provider did not answer within ${timeoutMs}ms`);
  }

  private async revalidate(driver: ProviderDriverKind): Promise<void> {
    this.versionCheckedAt.set(driver, this.kernel.now());
    const known = this.stored().get(driver);
    const installed = await this.deps.cliVersion(driver);
    if (!installed.installed) return;
    const changed = known !== undefined && known.cliVersion !== installed.version;
    const attemptedAt = this.attemptedAt.get(driver);
    const retrying = attemptedAt !== undefined && this.kernel.now() - attemptedAt < MODEL_VERSION_CHECK_MS;
    if (changed || ((!known || this.kernel.now() - known.catalogue.readAt >= MODEL_CACHE_MS) && !retrying)) await this.refresh(driver);
  }

  // Shared by concurrent readers and queued behind other providers' reads.
  private refresh(driver: ProviderDriverKind): Promise<ModelCatalogue> {
    const running = this.refreshes.get(driver);
    if (running) return running;
    this.attemptedAt.set(driver, this.kernel.now());
    const work = this.refreshChain.then(async (): Promise<ModelCatalogue> => {
      const installed = await this.deps.cliVersion(driver).catch((): InstalledCli => ({ installed: false }));
      const read = await this.deps.readModels(driver, this.kernel.now);
      const known = this.stored().get(driver);
      if (read.models.length > 0) {
        this.store(driver, { catalogue: read, ...(installed.version ? { cliVersion: installed.version } : {}) });
        this.failures.delete(driver);
        return read;
      }
      if (known) return known.catalogue;
      this.failures.set(driver, read);
      return read;
    });
    const shared = work.finally(() => {
      if (this.refreshes.get(driver) === shared) this.refreshes.delete(driver);
    });
    this.refreshes.set(driver, shared);
    this.refreshChain = shared.catch(() => undefined);
    return shared;
  }

  private stored(): Map<ProviderDriverKind, StoredCatalogue> {
    if (this.cache) return this.cache;
    const loaded = new Map<ProviderDriverKind, StoredCatalogue>();
    try {
      const stored = this.kernel.readDocument(this.kernel.paths.modelCatalogues) as { entries?: unknown } | undefined;
      const parsed = StoredCatalogueSchema.array().safeParse(stored?.entries ?? []);
      if (parsed.success) for (const entry of parsed.data) loaded.set(entry.catalogue.driver, entry);
    } catch {
      // A torn file costs the head start; the next read refills it.
    }
    this.cache = loaded;
    return loaded;
  }

  // Persisted without the per-answer flag or an overlay: the file holds what the provider said.
  private store(driver: ProviderDriverKind, entry: StoredCatalogue): void {
    const all = this.stored();
    const { refreshing: _refreshing, instanceId: _instance, ...catalogue } = entry.catalogue;
    all.set(driver, { ...entry, catalogue });
    try {
      this.kernel.writeDocument(this.kernel.paths.modelCatalogues, { version: STATE_VERSION, entries: [...all.values()] });
    } catch (error) {
      console.error(`[engine] could not persist the ${driver} model catalogue: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private rememberedClaudeDefault(): string | undefined {
    if (this.claudeDefaultMemo !== undefined) return this.claudeDefaultMemo || undefined;
    let remembered: string | undefined;
    try {
      const stored = this.kernel.readDocument(this.kernel.paths.claudeDefault) as { model?: unknown } | undefined;
      if (typeof stored?.model === "string" && /\[1m\]$/i.test(stored.model)) remembered = stored.model;
    } catch {
      remembered = undefined;
    }
    this.claudeDefaultMemo = remembered ?? "";
    return remembered;
  }

  // Written only on change, and only for a row Telar would publish.
  private rememberClaudeDefault(models: ModelCatalogue["models"], cliVersion: string | undefined): void {
    const model = longDefaultOf(applyModelManifest(models, this.deps.manifest, cliVersion));
    if (!model || model === this.rememberedClaudeDefault()) return;
    this.claudeDefaultMemo = model;
    try {
      this.kernel.writeDocument(this.kernel.paths.claudeDefault, { model, at: this.kernel.now() });
    } catch {
      // Unwritable: the default is re-learned after each restart instead.
    }
  }
}
