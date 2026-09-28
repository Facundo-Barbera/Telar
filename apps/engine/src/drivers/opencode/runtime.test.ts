import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AutoCompact } from "@telar/engine-client";
import { openCodeServerIdentity } from "./driver";
import {
  openCodeCompactionConfig,
  openCodeCompactionEnv,
  openCodeCompactionThreshold,
  openCodeConfigContent,
  openCodeModelLimits,
  parseOpenCodeModelLimits,
  type OpenCodeModelLimits,
} from "./runtime";
import type { DriverRun } from "../contract";

const OPUS_200K: OpenCodeModelLimits = { context: 200_000, output: 64_000 };
const GPT_1M: OpenCodeModelLimits = { context: 1_050_000, output: 128_000, input: 922_000 };
const LIMITS: AutoCompact = { mode: "limits", standard: 150_000, long: 400_000 };

const run = (overrides: Partial<DriverRun> = {}): DriverRun => ({
  sessionId: "s", cwd: "/tmp", prompt: "hi", signal: new AbortController().signal, onObservations: async () => {}, ...overrides,
});

const triggerFor = (limits: OpenCodeModelLimits, written: Partial<OpenCodeModelLimits>, reserved?: number) =>
  openCodeCompactionThreshold({ ...limits, ...written }, reserved);

test("Never is the disable env var; Limits clears an inherited one; Default writes nothing", () => {
  expect(openCodeCompactionEnv({ mode: "never" })).toEqual({ OPENCODE_DISABLE_AUTOCOMPACT: "1" });
  expect(openCodeCompactionEnv(LIMITS)).toEqual({ OPENCODE_DISABLE_AUTOCOMPACT: undefined });
  expect(openCodeCompactionEnv(undefined)).toEqual({});
  expect(openCodeCompactionConfig({ mode: "never" }, "opencode", "x", OPUS_200K)).toBeUndefined();
  expect(openCodeCompactionConfig(undefined, "opencode", "x", OPUS_200K)).toBeUndefined();
});

test("a 200k-class model without limit.input compacts at exactly the standard limit", () => {
  const limit = openCodeCompactionConfig(LIMITS, "opencode", "claude-opus-4-5", OPUS_200K)!.provider.opencode!.models["claude-opus-4-5"]!.limit;
  expect(limit).toEqual({ context: 200_000, output: 64_000, input: 170_000 });
  expect(triggerFor(OPUS_200K, limit)).toBe(150_000);
});

test("a 1M-class model with a native limit.input compacts at exactly the long limit", () => {
  const limit = openCodeCompactionConfig(LIMITS, "opencode", "gpt-5.5", GPT_1M)!.provider.opencode!.models["gpt-5.5"]!.limit;
  expect(limit.context).toBe(1_050_000);
  expect(limit.output).toBe(128_000);
  expect(triggerFor(GPT_1M, limit)).toBe(400_000);
});

test("a person's compaction.reserved is the reserve the override is computed against", () => {
  const limit = openCodeCompactionConfig(LIMITS, "opencode", "m", OPUS_200K, 5_000)!.provider.opencode!.models.m!.limit;
  expect(limit.input).toBe(155_000);
  expect(triggerFor(OPUS_200K, limit, 5_000)).toBe(150_000);
});

test("a limit at or past OpenCode's own threshold writes nothing — it only lowers", () => {
  expect(openCodeCompactionThreshold(OPUS_200K)).toBe(168_000);
  expect(openCodeCompactionConfig({ mode: "limits", standard: 168_000, long: 400_000 }, "opencode", "m", OPUS_200K)).toBeUndefined();
  expect(openCodeCompactionConfig({ mode: "limits", standard: 190_000, long: 400_000 }, "opencode", "m", OPUS_200K)).toBeUndefined();
  expect(openCodeCompactionConfig({ mode: "limits", standard: 150_000, long: 950_000 }, "opencode", "m", GPT_1M)).toBeUndefined();
});

test("unknown limits, or a model OpenCode never compacts, writes nothing", () => {
  expect(openCodeCompactionConfig(LIMITS, "opencode", "m", undefined)).toBeUndefined();
  expect(openCodeCompactionConfig(LIMITS, "opencode", "m", { context: 0, output: 0 })).toBeUndefined();
  const content = JSON.parse(openCodeConfigContent(run({ autoCompact: LIMITS }), undefined, OPUS_200K));
  expect(content.provider).toBeUndefined(); // no model on the run
});

test("the override merges into the inherited config without clobbering the person's provider settings", () => {
  const inherited = {
    theme: "dark",
    provider: {
      opencode: { options: { baseURL: "https://example" }, models: { "claude-opus-4-5": { name: "Mine", limit: { context: 200_000, output: 64_000 } }, other: { name: "Other" } } },
      openai: { options: { timeout: 1 } },
    },
  };
  const content = JSON.parse(openCodeConfigContent(run({ autoCompact: LIMITS, model: "opencode/claude-opus-4-5",
    env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(inherited) } }), undefined, OPUS_200K));
  expect(content.theme).toBe("dark");
  expect(content.provider.openai).toEqual({ options: { timeout: 1 } });
  expect(content.provider.opencode.options).toEqual({ baseURL: "https://example" });
  expect(content.provider.opencode.models.other).toEqual({ name: "Other" });
  expect(content.provider.opencode.models["claude-opus-4-5"]).toEqual({ name: "Mine", limit: { context: 200_000, output: 64_000, input: 170_000 } });
  expect(content.permission).toBe("ask");
});

test("model limits are read from the CLI's verbose listing, and a CLI that fails costs only the limit", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telar-opencode-models-"));
  const listing = [
    "fake/big", JSON.stringify({ id: "big", limit: GPT_1M }, null, 2),
    "fake/small", JSON.stringify({ id: "small", limit: OPUS_200K, variants: { high: {} } }, null, 2), "",
  ].join("\n");
  expect(parseOpenCodeModelLimits(listing).get("fake/big")).toEqual(GPT_1M);
  const binary = path.join(dir, "opencode");
  fs.writeFileSync(path.join(dir, "listing.txt"), listing);
  fs.writeFileSync(binary, `#!/bin/sh\n[ "$1 $2 $3" = "models fake --verbose" ] && cat "${dir}/listing.txt"\n`, { mode: 0o755 });
  expect(await openCodeModelLimits(binary, "fake/small")).toEqual(OPUS_200K);
  expect(await openCodeModelLimits(binary, "fake/missing")).toBeUndefined();
  expect(await openCodeModelLimits(path.join(dir, "absent"), "fake/small")).toBeUndefined();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the server identity changes with the compaction setting, and with the model only under Limits", () => {
  const base = run({ model: "opencode/a" });
  expect(openCodeServerIdentity(run({ ...base, autoCompact: LIMITS }))).not.toBe(openCodeServerIdentity(base));
  expect(openCodeServerIdentity(run({ ...base, autoCompact: LIMITS })))
    .not.toBe(openCodeServerIdentity(run({ ...base, autoCompact: { ...LIMITS, standard: 100_000 } })));
  expect(openCodeServerIdentity(run({ ...base, autoCompact: { mode: "never" } }))).not.toBe(openCodeServerIdentity(base));
  expect(openCodeServerIdentity(run({ ...base, autoCompact: LIMITS })))
    .not.toBe(openCodeServerIdentity(run({ ...base, model: "opencode/b", autoCompact: LIMITS })));
  expect(openCodeServerIdentity(base)).toBe(openCodeServerIdentity(run({ ...base, model: "opencode/b" })));
});
