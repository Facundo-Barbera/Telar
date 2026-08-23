import { describe, expect, test } from "bun:test";
import { normalizeRemote } from "../src/id.ts";

describe("normalizeRemote", () => {
  test("ssh and https forms of the same repo normalize identically", () => {
    const forms = [
      "git@github.com:Facundo-Barbera/Telar.git",
      "https://github.com/Facundo-Barbera/Telar.git",
      "https://github.com/facundo-barbera/telar",
      "ssh://git@github.com/Facundo-Barbera/Telar.git",
      "git+ssh://git@github.com/Facundo-Barbera/Telar.git",
    ];
    const normalized = new Set(forms.map(normalizeRemote));
    expect([...normalized]).toEqual(["github.com/facundo-barbera/telar"]);
  });

  test("distinct repos stay distinct", () => {
    expect(normalizeRemote("git@github.com:a/x.git")).not.toBe(normalizeRemote("git@github.com:a/y.git"));
  });
});
