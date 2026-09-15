/**
 * The one thing `TELAR_ENGINE_VERSION` needs guarding: that it still says what
 * the package says. It is sent to a third-party API as this build's identity,
 * and a stale constant is a lie nothing else in the process could notice.
 */
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { TELAR_ENGINE_VERSION } from "../src/version";

describe("engine version", () => {
  test("matches the package it ships as", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "..", "package.json"), "utf8")) as { version?: string };
    expect(TELAR_ENGINE_VERSION).toBe(manifest.version);
  });
});
