// A3 (de-flag cut, owner D5) — the DB-clone seam is dependency injection driven
// by a project FACT, not a behavior env gate. resolveDbCloner picks the real
// LiveDbCloner ONLY when the project declares a template DB in its telar.yaml
// (manifest.templateDb); absent, the no-op NullDbCloner. No TELAR_FROZEN_LANE_DB
// env, never implicit. Tests inject FakeDbCloner via the existing seam and never
// touch a real Postgres/network.
import { describe, expect, test } from "bun:test";
import { FakeDbCloner, LiveDbCloner, NullDbCloner, resolveDbCloner } from "../src/db-clone";

describe("DB-clone seam — DI, no real Postgres", () => {
  test("NullDbCloner clones nothing (no DATABASE_URL override)", async () => {
    const c = new NullDbCloner();
    expect(await c.clone("t", "id")).toBe("");
    await c.drop("x"); // no-op, no throw
  });

  test("FakeDbCloner scripts a url and records the drop", async () => {
    const c = new FakeDbCloner();
    const url = await c.clone("tmpl", "L1");
    expect(url).toBe("postgres://fake/telar_frozen_L1");
    await c.drop(url);
    expect(c.dropped).toEqual([url]);
  });
});

describe("resolveDbCloner — selection is a project FACT (templateDb)", () => {
  test("returns NullDbCloner when no template DB is declared", () => {
    expect(resolveDbCloner()).toBeInstanceOf(NullDbCloner);
    expect(resolveDbCloner(undefined)).toBeInstanceOf(NullDbCloner);
    expect(resolveDbCloner("")).toBeInstanceOf(NullDbCloner);
  });

  test("returns the real LiveDbCloner when the project declares a template DB", () => {
    expect(resolveDbCloner("app_template")).toBeInstanceOf(LiveDbCloner);
  });

  test("LiveDbCloner clone/drop stay DEFERRED (throw, never a blind pretend-clone)", async () => {
    const c = new LiveDbCloner();
    await expect(c.clone()).rejects.toThrow(/not implemented/);
    await expect(c.drop()).rejects.toThrow(/not implemented/);
  });
});
