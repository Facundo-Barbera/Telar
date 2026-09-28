import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadRates, normalizeModelName, priceTokens, resetRatesMemo, type RatesTable } from "./pricing";

const roots: string[] = [];

afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  resetRatesMemo();
});

const RATES: RatesTable = {
  status: "fresh",
  rates: new Map([["claude-opus-5", { inputPerTok: 1e-5, outputPerTok: 5e-5, cacheReadPerTok: 1e-6, cacheCreatePerTok: 1.25e-5 }]]),
};

test("one-hour cache writes cost double input, not the 5-minute rate", () => {
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreate: 1_000_000 };
  expect(priceTokens(RATES, "claude-opus-5", tokens)).toBeCloseTo(1_000_000 * 1.25e-5);
  expect(priceTokens(RATES, "claude-opus-5", tokens, { cacheCreate1h: 1_000_000 })).toBeCloseTo(1_000_000 * 2 * 1e-5);
  expect(priceTokens(RATES, "claude-opus-5", tokens, { cacheCreate1h: 400_000 })).toBeCloseTo(600_000 * 1.25e-5 + 400_000 * 2e-5);
});

test("a prefixed duplicate row without cache rates cannot shadow the complete one", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-pricing-"));
  roots.push(directory);
  const payload = {
    "claude-x": { input_cost_per_token: 1e-5, output_cost_per_token: 5e-5, cache_read_input_token_cost: 1e-6 },
    "anthropic/claude-x": { input_cost_per_token: 1e-5, output_cost_per_token: 5e-5 },
  };
  const table = await loadRates(path.join(directory, "rates.json"), () => Promise.resolve(payload));
  expect(priceTokens(table, "claude-x", { input: 0, output: 0, cacheRead: 1_000_000, cacheCreate: 0 })).toBeCloseTo(1);
});

test("names normalize and bare aliases stay unpriceable", () => {
  expect(normalizeModelName("anthropic/Claude-Opus-5")).toBe("claude-opus-5");
  const tokens = { input: 10, output: 10, cacheRead: 0, cacheCreate: 0 };
  expect(priceTokens(RATES, "haiku", tokens)).toBeUndefined();
  expect(priceTokens(RATES, "default", tokens)).toBeUndefined();
  expect(priceTokens(RATES, "unknown-model", tokens)).toBeUndefined();
  expect(priceTokens(RATES, "Anthropic/claude-opus-5", tokens)).toBeCloseTo(10 * 1e-5 + 10 * 5e-5);
});
