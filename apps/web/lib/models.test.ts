// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { sessionModelSelection } from "./models";

test("a browser draft with provider defaults does not send an instance-only model selection", () => {
  expect(sessionModelSelection("provider_claude", {})).toBeUndefined();
  expect(sessionModelSelection("provider_claude", { model: "", effort: "" })).toBeUndefined();
});

test("model, effort and explicit fast-mode false survive draft creation independently", () => {
  expect(sessionModelSelection("provider_claude", { model: "claude-fable-5-1" })).toEqual({ instanceId: "provider_claude", model: "claude-fable-5-1" });
  expect(sessionModelSelection("provider_claude", { effort: "medium" })).toEqual({ instanceId: "provider_claude", effort: "medium" });
  expect(sessionModelSelection("provider_claude", { fastMode: false })).toEqual({ instanceId: "provider_claude", fastMode: false });
});
