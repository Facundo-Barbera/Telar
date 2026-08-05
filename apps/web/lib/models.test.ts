// What a fresh session opens on, per provider. This existed as a ternary in
// three unrelated files — the composer's provider switch, the chat route's model
// fallback and /api/models' advertised default — and the point of collapsing it
// into `defaultModelFor` is that all three now give the same answer by
// construction rather than by three people remembering.
//
// The Record inside `defaultModelFor` is exhaustive over the provider union, so
// the type checker already refuses a missing provider. What it cannot check is
// whether the id it hands back is a model that EXISTS, and belongs to the
// provider that asked — a default naming a deleted model, or a Claude id
// returned for Codex, type-checks perfectly and opens a session on a model the
// harness will reject. That is the gap below.
//
// No DOM, no disk, no core import. bun provides "bun:test" at runtime;
// @types/bun isn't a dependency of this Next app, so the web tsconfig can't
// resolve it — suppress just the import, exactly as spend-readout.test.ts does.
// @ts-expect-error no @types/bun in this workspace
import { describe, expect, test } from "bun:test";
import { DEFAULT_CODEX_MODEL, DEFAULT_MODEL, defaultModelFor, modelById, modelsForProvider } from "./models";

const PROVIDERS = ["claude", "codex"] as const;

describe("defaultModelFor — one answer to what a new session opens on", () => {
  test("every provider's default is a real model in the catalog", () => {
    for (const p of PROVIDERS) {
      const id = defaultModelFor(p);
      expect(modelById(id), `${p}'s default "${id}" is not in MODELS`).toBeDefined();
    }
  });

  test("and it belongs to the provider that asked", () => {
    for (const p of PROVIDERS) {
      const id = defaultModelFor(p);
      const own = modelsForProvider(p).map((m) => m.id);
      expect(own, `${p}'s default "${id}" belongs to the other harness`).toContain(id);
    }
  });

  // The two constants stay exported (ui-prefs and the composer's own
  // "is this still the shipped default?" check read them), so they must not
  // become a second, drifting answer to the same question.
  test("the named constants and the table agree", () => {
    expect(defaultModelFor("claude")).toBe(DEFAULT_MODEL);
    expect(defaultModelFor("codex")).toBe(DEFAULT_CODEX_MODEL);
  });

  // A default is only a default if it is not shared. Two providers pointing at
  // one id would mean switching harness left the model alone, which is the bug
  // `selectProvider` calls this function to avoid.
  test("no two providers open on the same model", () => {
    const ids = PROVIDERS.map(defaultModelFor);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
