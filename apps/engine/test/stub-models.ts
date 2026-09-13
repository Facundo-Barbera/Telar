/**
 * A CANNED MODEL LIST FOR ENGINE TESTS, so a daemon under test never spawns
 * the real Claude CLI.
 *
 * Without `models`, the first Claude turn that names no model makes the store
 * ask the installed `claude` for its catalogue through the SDK handshake
 * (`readClaudeModels`), and `prepareClaudeCatalogue` gives that two seconds.
 * On a developer's Mac the CLI answers in about five; on the CI Mac mini under
 * several Verify runs it can take longer still. Every test that submitted a
 * Claude turn was paying that, and the ones with a four-second wait were
 * losing the race — the "unblocked by the heartbeat" flake in #266.
 *
 * Long-window rows, because that is what the store requires before it will
 * claim a model-less Claude turn (see `claudeSelectionState`).
 */
import type { ModelCatalogue, ProviderDriverKind, ProviderModel } from "@telar/engine-client";

const row = (id: string, isDefault = false): ProviderModel => ({
  id,
  label: id,
  isDefault,
  hidden: false,
  hiddenByUser: false,
  efforts: [],
  fastMode: false,
  source: "provider",
});

const LISTS: Record<ProviderDriverKind, ProviderModel[]> = {
  claude: [row("claude-opus-5", true), row("claude-sonnet-5")],
  codex: [row("gpt-5-codex", true)],
  opencode: [row("anthropic/claude-sonnet-5", true)],
};

export const stubModels = async (driver: ProviderDriverKind, now: () => number): Promise<ModelCatalogue> => ({
  driver,
  instanceId: driver,
  readAt: now(),
  models: LISTS[driver] ?? [],
});
