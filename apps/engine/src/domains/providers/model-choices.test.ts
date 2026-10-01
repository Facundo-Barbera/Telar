import { expect, test } from "bun:test";
import type { ProviderInstance, ProviderModel, Session } from "@telar/engine-client";
import { chosenModel, offeredRows, sessionCapabilities, turnModelChoice } from "./model-choices";

const row = (id: string, extra: Partial<ProviderModel> = {}): ProviderModel => ({
  id,
  label: id,
  isDefault: false,
  hidden: false,
  hiddenByUser: false,
  legacy: false,
  source: "provider",
  efforts: ["low", "medium", "high"],
  fastMode: false,
  ...extra,
});

const ROWS: ProviderModel[] = [
  row("claude-opus-5-5[1m]", { resolves: "claude-opus-5-5[1m]", isDefault: true, defaultWindow: true }),
  row("claude-opus-5-5", { resolves: "claude-opus-5-5" }),
  row("claude-sonnet-5", { resolves: "claude-sonnet-5", defaultWindow: true }),
  row("claude-sonnet-5[1m]", { resolves: "claude-sonnet-5[1m]" }),
  row("claude-haiku-4-5", { legacy: true, efforts: [] }),
  row("claude-opus-4-8[1m]", { legacy: true }),
  row("claude-fable-5-1", { hidden: true }),
];

const session = (model?: Session["model"]): Session =>
  ({ id: "session_one", driver: "claude", providerInstanceId: "claude", runtimeMode: "auto", ...(model ? { model } : {}) }) as Session;

test("the offer keeps current models and the cheapest legacy tier, never a hidden one", () => {
  expect(offeredRows("claude", ROWS).map((each) => each.id)).toEqual([
    "claude-opus-5-5[1m]",
    "claude-opus-5-5",
    "claude-sonnet-5",
    "claude-sonnet-5[1m]",
    "claude-haiku-4-5",
  ]);
});

test("an alias resolves to the model's default window, and an effort it lists is kept", () => {
  expect(chosenModel("claude", "claude", { model: "sonnet", effort: "medium" }, ROWS)).toEqual({
    instanceId: "claude",
    model: "claude-sonnet-5",
    effort: "medium",
  });
  expect(chosenModel("claude", "claude", { model: "claude-opus-5-5[1m]" }, ROWS)).toEqual({ instanceId: "claude", model: "claude-opus-5-5[1m]" });
});

test("a model the Mac does not offer is refused with the ones it does", () => {
  expect(() => chosenModel("claude", "claude", { model: "claude-fable-5-1" }, ROWS)).toThrow(
    '"claude-fable-5-1" is not a model claude offers. Offered: claude-opus-5-5[1m], claude-opus-5-5, claude-sonnet-5, claude-sonnet-5[1m], claude-haiku-4-5. sessions_capabilities lists each with its efforts.',
  );
});

test("an effort the model does not take is refused, and a model with none says to omit it", () => {
  expect(() => chosenModel("claude", "claude", { model: "claude-sonnet-5", effort: "ludicrous" }, ROWS)).toThrow(
    'claude-sonnet-5 takes effort low, medium, high, not "ludicrous".',
  );
  expect(() => chosenModel("claude", "claude", { model: "haiku", effort: "low" }, ROWS)).toThrow("claude-haiku-4-5 takes no effort; omit it.");
});

test("an effort alone is checked against the default model, and nothing named is nothing chosen", () => {
  expect(chosenModel("claude", "claude", { effort: "low" }, ROWS)).toEqual({ instanceId: "claude", effort: "low" });
  expect(() => chosenModel("claude", "claude", { effort: "max" }, ROWS)).toThrow("claude-opus-5-5[1m] takes effort");
  expect(chosenModel("claude", "claude", {}, ROWS)).toBeUndefined();
});

test("with no catalogue read yet the choice passes as named", () => {
  expect(chosenModel("codex", "codex", { model: "gpt-9", effort: "high" }, undefined)).toEqual({ instanceId: "codex", model: "gpt-9", effort: "high" });
});

test("a turn's effort alone keeps the session's model and options; a new model drops them", () => {
  const worker = session({ instanceId: "claude", model: "claude-sonnet-5", effort: "medium", fastMode: true });
  expect(turnModelChoice(worker, { effort: "high" }, ROWS)).toEqual({ model: "claude-sonnet-5", effort: "high", fastMode: true });
  expect(turnModelChoice(worker, { model: "haiku" }, ROWS)).toEqual({ model: "claude-haiku-4-5" });
  expect(turnModelChoice(worker, {}, ROWS)).toBeUndefined();
});

test("capabilities name the caller's model, tier and access, the defaults, and each enabled provider's offer", () => {
  const instances = [
    { id: "claude", driver: "claude", enabled: true, env: [], createdAt: 1, updatedAt: 1 },
    { id: "codex", driver: "codex", enabled: false, env: [], createdAt: 1, updatedAt: 1 },
  ] as ProviderInstance[];
  const answer = sessionCapabilities(
    {
      instances: () => instances,
      rows: () => ROWS,
      defaultModel: () => "claude-opus-5-5[1m]",
      sessionDefaults: () => ({ envMode: "worktree", runtimeMode: "auto" }),
      session: () => ({ ...session(), projectId: "project_one" }),
      project: () => ({ defaultModel: { instanceId: "claude", effort: "high" } }) as never,
    },
    "session_one",
  );
  expect(answer.you).toEqual({ sessionId: "session_one", driver: "claude", instanceId: "claude", model: "claude-opus-5-5[1m]", tier: 3, access: "auto" });
  expect(answer.defaults).toEqual({ envMode: "worktree", access: "auto", project: { effort: "high" } });
  expect(answer.providers.map((provider) => provider.instanceId)).toEqual(["claude"]);
  const models = answer.providers[0]!.models;
  expect(models[0]).toEqual({ id: "claude-opus-5-5[1m]", label: "claude-opus-5-5[1m]", tier: 3, efforts: ["low", "medium", "high"], window: 1_000_000, default: true });
  expect(models.find((each) => each.id === "claude-haiku-4-5")).toMatchObject({ tier: 1, efforts: [], window: 200_000 });
});

test("capabilities report the calling session's project mode before the app default", () => {
  const deps = (envMode?: "local" | "worktree") => ({
    instances: () => [],
    rows: () => ROWS,
    defaultModel: () => undefined,
    sessionDefaults: () => ({ envMode: "worktree" as const }),
    session: () => ({ ...session(), projectId: "project_one" }),
    project: () => (envMode ? { envMode } : {}) as never,
  });
  expect(sessionCapabilities(deps("local"), "session_one").defaults.envMode).toBe("local");
  expect(sessionCapabilities(deps(), "session_one").defaults.envMode).toBe("worktree");
  expect(sessionCapabilities(deps("local")).defaults.envMode).toBe("worktree");
});
