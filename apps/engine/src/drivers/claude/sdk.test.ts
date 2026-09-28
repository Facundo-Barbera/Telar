import { expect, test } from "bun:test";
import { selectedContextMaxFromModel } from "./sdk";

test("selectedContextMaxFromModel assumes 1M for a [1m] Claude row or a fixed-1M model only", () => {
  expect(selectedContextMaxFromModel("opus[1m]")).toBe(1_000_000);
  expect(selectedContextMaxFromModel("claude-fable-5-1[1m]")).toBe(1_000_000);
  expect(selectedContextMaxFromModel("claude-opus-4-8")).toBe(1_000_000);
  expect(selectedContextMaxFromModel("claude-opus-4-7")).toBe(1_000_000);
  expect(selectedContextMaxFromModel("claude-haiku-4-5")).toBe(200_000);
  expect(selectedContextMaxFromModel("opus")).toBeUndefined();
  expect(selectedContextMaxFromModel("claude-opus-5")).toBeUndefined();
  expect(selectedContextMaxFromModel(undefined)).toBeUndefined();
  expect(selectedContextMaxFromModel("claude-mystery-9[1m]")).toBeUndefined();
});
