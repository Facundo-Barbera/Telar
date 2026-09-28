// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { projectDraftModel, sessionModelSelection } from "./models";

test("a project's default seeds the composer with its driver, model and options", () => {
  expect(projectDraftModel({ instanceId: "codex", model: "gpt-5-codex", effort: "high" })).toEqual({
    driver: "codex",
    choice: { model: "gpt-5-codex", effort: "high" },
  });
  expect(projectDraftModel({ instanceId: "claude", effort: "medium", fastMode: true })).toEqual({
    driver: "claude",
    choice: { effort: "medium", fastMode: true },
  });
  // No default, or one on a login the canvas cannot create a session on.
  expect(projectDraftModel(undefined)).toBeUndefined();
  expect(projectDraftModel({ instanceId: "claude_work", model: "opus" })).toBeUndefined();
});

test("a browser draft with provider defaults does not send an instance-only model selection", () => {
  expect(sessionModelSelection("provider_claude", {})).toBeUndefined();
  expect(sessionModelSelection("provider_claude", { model: "", effort: "" })).toBeUndefined();
});

test("model, effort and explicit fast-mode false survive draft creation independently", () => {
  expect(sessionModelSelection("provider_claude", { model: "claude-fable-5-1" })).toEqual({ instanceId: "provider_claude", model: "claude-fable-5-1" });
  expect(sessionModelSelection("provider_claude", { effort: "medium" })).toEqual({ instanceId: "provider_claude", effort: "medium" });
  expect(sessionModelSelection("provider_claude", { fastMode: false })).toEqual({ instanceId: "provider_claude", fastMode: false });
});
