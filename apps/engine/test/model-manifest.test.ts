import { describe, expect, test } from "bun:test";
import type { ProviderModel } from "@telar/engine-client";
import { applyModelManifest, BUNDLED_MANIFEST, type ModelManifest } from "../src/model-manifest";

/** The bundled manifest without its declarations — for tests about the
 *  window-synthesis half alone, where an appended Fable 5.1 would be noise. */
const WINDOWS_ONLY: ModelManifest = { version: 1, claude: { profiles: BUNDLED_MANIFEST.claude!.profiles, models: BUNDLED_MANIFEST.claude!.models } };

const row = (id: string, extra: Partial<ProviderModel> = {}): ProviderModel => ({
  id,
  label: id,
  isDefault: false,
  hidden: false,
  hiddenByUser: false,
  source: "provider",
  efforts: ["high"],
  fastMode: false,
  ...extra,
});

describe("the model manifest", () => {
  test("synthesizes the [1m] row the CLI leaves out — the Fable 5.1 gap, measured", () => {
    /**
     * Claude Code 2.1.259 lists `claude-fable-5[1m]` and `claude-fable-5-1`
     * but no `claude-fable-5-1[1m]`, even though the id is accepted and
     * reports a 1M window. The cockpit's window toggle exists only where a
     * `[1m]` row does, so Fable 5.1 offered no 1M at all.
     */
    const listed = [row("claude-fable-5[1m]", { resolves: "claude-fable-5[1m]" }), row("claude-fable-5-1", { resolves: "claude-fable-5-1", isDefault: true })];
    const out = applyModelManifest(listed, BUNDLED_MANIFEST);
    expect(out.map((m) => m.id)).toEqual(["claude-fable-5[1m]", "claude-fable-5-1", "claude-fable-5-1[1m]"]);
    const synthesized = out[2]!;
    expect(synthesized.resolves).toBe("claude-fable-5-1[1m]");
    // A variant of the default, never the default in its own right.
    expect(synthesized.isDefault).toBe(false);
    // Everything else — efforts, fast mode, label — copied from the sibling.
    expect(synthesized.efforts).toEqual(["high"]);
  });

  test("the CLI wins: a listed [1m] row is never duplicated", () => {
    const listed = [row("sonnet", { resolves: "claude-sonnet-5" }), row("sonnet[1m]", { resolves: "claude-sonnet-5[1m]" })];
    expect(applyModelManifest(listed, WINDOWS_ONLY).map((m) => m.id)).toEqual(["sonnet", "sonnet[1m]"]);
  });

  test("a profile without a long window, or a model the manifest does not know, is left alone", () => {
    const listed = [row("haiku", { resolves: "claude-haiku-4-5-20251001" }), row("claude-mystery-9", { resolves: "claude-mystery-9" })];
    expect(applyModelManifest(listed, WINDOWS_ONLY).map((m) => m.id)).toEqual(["haiku", "claude-mystery-9"]);
  });

  test("keys on the canonical id: a dated build and an alias both find their profile", () => {
    const manifest: ModelManifest = { version: 1, claude: { profiles: { p: { longWindow: true } }, models: { "claude-x-1": "p" } } };
    const listed = [row("x", { resolves: "claude-x-1-20260101" })];
    const out = applyModelManifest(listed, manifest);
    expect(out.map((m) => m.id)).toEqual(["x", "x[1m]"]);
    expect(out[1]!.resolves).toBe("claude-x-1-20260101[1m]");
  });

  test("the bundled manifest is well-formed: every model points at a profile that exists", () => {
    const claude = BUNDLED_MANIFEST.claude!;
    for (const [id, profile] of Object.entries(claude.models)) {
      expect(claude.profiles[profile], `${id} → ${profile}`).toBeDefined();
    }
  });
});

describe("declared models", () => {
  test("a model the CLI does not list is declared, with its [1m] variant — Fable 5.1, measured", () => {
    /**
     * The same 2.1.259 binary listed `claude-fable-5-1` in the morning and not
     * in the afternoon; a session on it kept running. The list is served from
     * an entitlement lookup, so a model the provider runs can be absent from
     * it — and the person running it still needs a row to pick.
     */
    const listed = [row("claude-fable-5", { resolves: "claude-fable-5" })];
    const out = applyModelManifest(listed, BUNDLED_MANIFEST);
    expect(out.map((m) => m.id)).toEqual(["claude-fable-5", "claude-fable-5[1m]", "claude-fable-5-1", "claude-fable-5-1[1m]"]);
    const declared = out[2]!;
    expect(declared).toMatchObject({ label: "Fable 5.1", source: "provider", isDefault: false, resolves: "claude-fable-5-1" });
    expect(declared.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  test("the CLI wins: a listed row suppresses its declaration, including under an alias", () => {
    // Listed by alias, resolving to the canonical id the manifest declares.
    const listed = [row("fable", { resolves: "claude-fable-5-1", label: "Fable (live)" })];
    const out = applyModelManifest(listed, BUNDLED_MANIFEST);
    expect(out.map((m) => m.id)).toEqual(["fable", "fable[1m]"]);
    expect(out[0]!.label).toBe("Fable (live)");
  });
});

test("a profile shipped 1M by default marks its synthesized [1m] row as the default WINDOW — a fact, not a choice", () => {
  // The picker shows `Default` beside 1M for Fable 5.1 (per Claude Code's own
  // changelog) and still sends whichever row you pick; `isDefault` — which
  // decides what runs when no model is named — stays on the standard row.
  const listed = [row("claude-fable-5-1", { resolves: "claude-fable-5-1", isDefault: true })];
  const out = applyModelManifest(listed, BUNDLED_MANIFEST);
  const long = out.find((m) => m.id === "claude-fable-5-1[1m]")!;
  expect(long.defaultWindow).toBe(true);
  expect(long.isDefault).toBe(false);
  expect(out.find((m) => m.id === "claude-fable-5-1")!.defaultWindow).toBeUndefined();
  // A long-window profile NOT shipped 1M by default gets no mark.
  const sonnet = applyModelManifest([row("sonnet", { resolves: "claude-sonnet-5" })], BUNDLED_MANIFEST).find((m) => m.id === "sonnet[1m]")!;
  expect(sonnet.defaultWindow).toBeUndefined();
});
