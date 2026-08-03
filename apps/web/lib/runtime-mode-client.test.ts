// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_RUNTIME_MODE as CORE_DEFAULT_RUNTIME_MODE,
  RUNTIME_MODES as CORE_RUNTIME_MODES,
  RUNTIME_MODE_OPTIONS as CORE_RUNTIME_MODE_OPTIONS,
} from "@telar/core/runtime-mode";
import {
  DEFAULT_RUNTIME_MODE,
  RUNTIME_MODES,
  RUNTIME_MODE_OPTIONS,
} from "@/lib/runtime-mode-client";

describe("the client-safe runtime-mode vocabulary", () => {
  test("stays identical to the harness-owned core contract", () => {
    expect(RUNTIME_MODES).toEqual(CORE_RUNTIME_MODES);
    expect(DEFAULT_RUNTIME_MODE).toBe(CORE_DEFAULT_RUNTIME_MODE);
    expect(RUNTIME_MODE_OPTIONS).toEqual(CORE_RUNTIME_MODE_OPTIONS);
  });
});
