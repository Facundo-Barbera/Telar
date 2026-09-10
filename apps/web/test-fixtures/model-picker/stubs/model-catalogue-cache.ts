/**
 * The fixture's stand-in for lib/model-catalogue-cache: same exports, no
 * engine. Catalogues are REAL captures from this machine (2026-09-10) — the
 * installed Codex's `model/list` answer with GPT-6-Astra as default, the full
 * 201-row `opencode models` output including the duplicate
 * gpt-5.6-luna-on-two-connections case — plus a Claude list shaped like the
 * installed harness's (aliases + resolves). Overlays (stars) live in memory
 * with a subscription so the real picker's optimistic re-read works.
 */
import { useSyncExternalStore } from "react";
import type { ModelCatalogue, ModelOverlay, ProviderDriverKind, ProviderModel } from "@telar/engine-client";
// Bundled as text by build.mjs — the verbatim `opencode models` output.
// @ts-expect-error text import provided by the fixture bundler
import openCodeList from "../opencode-models.txt";

export type ModelTarget = { driver: ProviderDriverKind; instanceId?: string };

const row = (id: string, extra: Partial<ProviderModel> = {}): ProviderModel => ({
  id,
  label: id,
  isDefault: false,
  hidden: false,
  hiddenByUser: false,
  source: "provider",
  efforts: [],
  fastMode: false,
  ...extra,
});

const CLAUDE: ProviderModel[] = [
  row("sonnet", { label: "Sonnet", isDefault: true, resolves: "claude-sonnet-5", efforts: ["low", "medium", "high"] }),
  row("sonnet[1m]", { label: "Sonnet 5 (1M context)", resolves: "claude-sonnet-5[1m]", efforts: ["low", "medium", "high"] }),
  row("opus[1m]", { label: "Opus", resolves: "claude-opus-5[1m]", efforts: ["low", "medium", "high"], fastMode: true, defaultWindow: true }),
  row("fable", { label: "Fable", resolves: "claude-fable-5-1", efforts: ["low", "medium", "high", "xhigh"] }),
  row("haiku", { label: "Haiku", resolves: "claude-haiku-4-5-20251001", efforts: ["low", "medium", "high"] }),
];

/** Verbatim from the installed Codex on this machine — Astra is the default. */
const CODEX: ProviderModel[] = [
  row("gpt-6-astra", { label: "GPT-6-Astra", isDefault: true, efforts: ["minimal", "low", "medium", "high", "xhigh", "ultra"], defaultEffort: "medium" }),
  row("gpt-5.6-sol", { label: "GPT-5.6-Sol", efforts: ["minimal", "low", "medium", "high", "xhigh"], defaultEffort: "medium" }),
  row("gpt-5.6-terra", { label: "GPT-5.6-Terra", efforts: ["minimal", "low", "medium", "high", "xhigh"] }),
  row("gpt-5.6-luna", { label: "GPT-5.6-Luna", efforts: ["minimal", "low", "medium", "high"] }),
  row("gpt-5.5", { label: "GPT-5.5", efforts: ["low", "medium", "high"] }),
  row("gpt-5.3-codex-spark", { label: "GPT-5.3-Codex-Spark", efforts: ["low", "medium", "high"] }),
];

const OPENCODE: ProviderModel[] = (openCodeList as string)
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => /^[A-Za-z0-9_.-]+\/\S+$/.test(line))
  .map((id) => row(id));

const CATALOGUES: Record<ProviderDriverKind, ModelCatalogue> = {
  claude: { driver: "claude", models: CLAUDE, source: "provider", readAt: 0 },
  codex: { driver: "codex", models: CODEX, source: "provider", readAt: 0 },
  opencode: { driver: "opencode", models: OPENCODE, source: "provider", readAt: 0 },
};

// ── overlays (stars), in memory with subscribers ──────────────────────────

const overlays = new Map<string, ModelOverlay>();
const listeners = new Set<() => void>();
let generation = 0;
const emptyOverlay = (instanceId: string): ModelOverlay =>
  ({ instanceId, favorites: [], hidden: [], custom: [], labels: {} }) as unknown as ModelOverlay;

function overlayFor(key: string): ModelOverlay {
  const existing = overlays.get(key);
  if (existing) return existing;
  const fresh = emptyOverlay(key);
  overlays.set(key, fresh);
  return fresh;
}

let catalogueSnapshot: { key: string; value: Map<ProviderDriverKind, ModelCatalogue> } | undefined;

export function useModelCatalogueGeneration(): number {
  return 0;
}

export function forgetModelCatalogues(): void {}

export function useModelCatalogues(targets: readonly ModelTarget[]): ReadonlyMap<ProviderDriverKind, ModelCatalogue> {
  const key = targets.map((target) => target.driver).join("|");
  return useSyncExternalStore(
    (notify) => {
      listeners.add(notify);
      return () => listeners.delete(notify);
    },
    () => {
      // Referentially stable per key so the consumer's memo deps hold.
      if (catalogueSnapshot?.key !== key) {
        catalogueSnapshot = { key, value: new Map(targets.map((target) => [target.driver, CATALOGUES[target.driver]])) };
      }
      return catalogueSnapshot.value;
    },
  );
}

// The instance argument the real hook takes is irrelevant here: the fixture
// serves one captured catalogue per driver.
export function useModelCatalogue(driver: ProviderDriverKind): ModelCatalogue | undefined {
  return CATALOGUES[driver];
}

let overlaySnapshot: { generation: number; key: string; value: Map<ProviderDriverKind, ModelOverlay> } | undefined;

export function useModelOverlays(targets: readonly ModelTarget[]): ReadonlyMap<ProviderDriverKind, ModelOverlay> {
  const key = targets.map((target) => `${target.driver}:${target.instanceId ?? target.driver}`).join("|");
  return useSyncExternalStore(
    (notify) => {
      listeners.add(notify);
      return () => listeners.delete(notify);
    },
    () => {
      if (!overlaySnapshot || overlaySnapshot.generation !== generation || overlaySnapshot.key !== key) {
        overlaySnapshot = {
          generation,
          key,
          value: new Map(targets.map((target) => [target.driver, overlayFor(target.instanceId ?? target.driver)])),
        };
      }
      return overlaySnapshot.value;
    },
  ) as ReadonlyMap<ProviderDriverKind, ModelOverlay>;
}

export async function patchModelOverlay(owner: string, patch: { favorites?: string[] }): Promise<void> {
  const overlay = overlayFor(owner);
  if (patch.favorites) (overlay as { favorites: string[] }).favorites = patch.favorites;
  generation += 1;
  for (const notify of listeners) notify();
}

export async function importLocalFavorites(): Promise<void> {}
