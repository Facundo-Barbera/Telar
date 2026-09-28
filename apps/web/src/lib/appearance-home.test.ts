// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { mergeById } from "./appearance-home";

describe("merging the home into the browser's copy", () => {
  const mine = [
    { id: "a", label: "Mine A" },
    { id: "b", label: "Mine B" },
  ];

  test("an id in both takes the home's copy — the file is what was said most recently", () => {
    expect(mergeById(mine, [{ id: "b", label: "Home B" }])).toEqual([
      { id: "a", label: "Mine A" },
      { id: "b", label: "Home B" },
    ]);
  });

  test("an id in only one side survives, because both authors are real", () => {
    expect(mergeById(mine, [{ id: "c", label: "Home C" }])).toEqual([
      { id: "a", label: "Mine A" },
      { id: "b", label: "Mine B" },
      { id: "c", label: "Home C" },
    ]);
  });

  test("order is stable: mine keep their places and the home's newcomers append", () => {
    const merged = mergeById(mine, [
      { id: "z", label: "Home Z" },
      { id: "a", label: "Home A" },
    ]);
    expect(merged.map((entry) => entry.id)).toEqual(["a", "b", "z"]);
    expect(merged[0]).toEqual({ id: "a", label: "Home A" });
  });

  test("an empty home changes nothing, which is what a machine with no engine sees", () => {
    expect(mergeById(mine, [])).toEqual(mine);
  });

  test("an empty local copy adopts the home wholesale", () => {
    expect(mergeById([], [{ id: "c", label: "Home C" }])).toEqual([{ id: "c", label: "Home C" }]);
  });
});
